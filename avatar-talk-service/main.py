"""Ditto 实时数字人服务。

与一期的区别：不再生成整段视频，而是 WebSocket 逐帧推流 + 浏览器实时播放，
实现「边说边动」的实时互动（类 Muse 体验）。

接口：
- GET  /            网页
- WS   /ws          对话（发文本，收音频地址 + 逐帧 JPEG）
- GET  /audio/*     TTS 音频
- GET  /api/health  健康检查（引擎状态）

启动：见 start_all.ps1（必须用 D:\\Ditto\\venv 的 Python）
"""

import asyncio
import base64
import json
import os
import struct
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

SERVICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICE_DIR))
sys.path.insert(0, str(SERVICE_DIR / "engine"))

from tts import split_speech_chunks, synth_sentence  # noqa: E402
import tts  # noqa: E402
import websockets  # noqa: E402

STATIC_DIR = SERVICE_DIR / "static"
AUDIO_DIR = SERVICE_DIR / "data" / "tts"
TELEMETRY_PATH = SERVICE_DIR / "data" / "telemetry.jsonl"

MAX_UPLOAD_BYTES = 20 * 1024 * 1024   # 上传图片上限 20MB

# 排查用：设置 DITTO_DUMP_STACKS=1 时每 20 秒打印一次所有线程栈
if os.environ.get("DITTO_DUMP_STACKS"):
    import faulthandler

    faulthandler.dump_traceback_later(20, repeat=True)

def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


MOTION_FPS = 25       # 运动时间轴
RENDER_FPS = 25       # 46 档内部特征 + 精确权重折叠，实测平均 37.6ms/P95 38.8ms
IDLE_FPS = 25         # 空闲最低目标；单帧低于 40ms 时按实际速度连续输出
# 25fps 约 2.3s：40/44/48 帧实测均有多句晚帧，58 是同步余量。
# 首句切短后客户端走「首句帧全齐即开播」的 covered 路径，这里的值主要影响
# 中长首句的开口时间；调低换更早开播（有音频停顿风险），用
# AVATAR_PREBUFFER_FRAMES 环境变量试验。
PREBUFFER_FRAMES = _env_int("AVATAR_PREBUFFER_FRAMES", 58)
# 首句切短的上限字符数：Breeze 合成延迟与文本长度几乎无关（~2.2s 底价），
# 切短首句几乎不亏合成时间，却能让客户端更早凑齐首句帧、提前开播
FIRST_CHUNK_MAX_CHARS = 16
CHUNK_GAP_MS = 0        # 分句连续：不插入额外静音，避免人物定格等下一句
TAIL_FRAMES = 13       # 25fps 约 0.5s，保证说完到空闲连续
IDLE_TS = 0xFFFF      # 空闲帧标记（帧头 ts 字段）

# 流式 TTS（Breeze realtime WS）：音频随合成连续到达，运动逐窗产出、连续推帧。
# 结构性滞后：LMDM 窗口 80 帧（3.2s）凑齐才产第一批运动帧，起播余量靠
# speak_start 报大的 dur_ms 吸收（客户端凑齐该时长的运动帧即开播）。
# AVATAR_TTS_STREAM=0 回退旧的整句合成路径（对比/兜底）。
STREAM_TTS = os.environ.get("AVATAR_TTS_STREAM", "1").strip().lower() \
    not in ("0", "false", "no", "off")
STREAM_START_MARGIN_MS = 1200
STREAM_TURN_MAX_CHARS = 900   # 服务端 turn 上限 1000 字符，留余量

app = FastAPI(title="ditto-avatar")

ENGINE = None
GPU_LOCK = asyncio.Lock()        # 空闲渲染 / 头像校验 / 热切换 互斥
RELOADING = asyncio.Event()      # 置位期间：暂停空闲推帧、拒绝新语音
SPEECH_LOCK = asyncio.Lock()     # 同一时刻只允许一段语音占用引擎
TALKING_ANY = asyncio.Event()    # 任一连接在说话：空闲推帧让出 GPU
CLIENTS: set[WebSocket] = set()  # 在线连接（空闲帧广播 / 头像切换广播）
CLIENT_LOCKS: dict[WebSocket, asyncio.Lock] = {}
JOBS: dict[str, dict] = {}       # 头像重建任务进度
_reload_busy = False             # 是否有上传/重建正在进行
IDLE_TASK = None                 # 全局空闲推帧任务
IDLE_T0 = time.monotonic()       # 空闲微动时间基准（跨连接连续，头姿相位不跳变）


# 埋点文件上限可用环境变量覆盖（12-Factor：部署相关边界值走环境配置）
TELEMETRY_MAX_BYTES = int(os.getenv("TELEMETRY_MAX_BYTES", str(8 * 1024 * 1024)))


def _telemetry(event: dict):
    """统一埋点：追加一行 JSON 到 data/telemetry.jsonl，并打印便于实时观察。

    超过上限（默认 8MB，TELEMETRY_MAX_BYTES 可调）轮转为 .1（只保留一代）：
    埋点文件原本无限增长，小盘机器会被吃满。
    """
    rec = {"ts": round(time.time(), 3), **event}
    try:
        TELEMETRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        try:
            if TELEMETRY_PATH.stat().st_size > TELEMETRY_MAX_BYTES:
                rotated = TELEMETRY_PATH.with_suffix(".jsonl.1")
                os.replace(TELEMETRY_PATH, rotated)
        except FileNotFoundError:
            pass  # 首次写入前不存在，正常
        with open(TELEMETRY_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as exc:  # noqa: BLE001
        print(f"[telemetry] 写入失败: {exc}", flush=True)
    print(f"[telemetry] {json.dumps(rec, ensure_ascii=False)}", flush=True)


def _pcm_payload(res: dict) -> dict:
    """把一句音频打包成前端可直接喂 WebAudio 的 PCM 负载。

    用裸 PCM 而不是 mp3 文件：浏览器拿到就能建 AudioBuffer 并按绝对时间调度，
    时长与采样数严格一致，多句拼接不会因为各句 mp3 编码延迟而逐句漂移。
    """
    return {
        "format": "pcm",
        "sampleRate": res["sample_rate"],
        "data": base64.b64encode(res["pcm"]).decode("ascii"),
    }


def _split_first_chunk(chunks: list[str], max_chars: int) -> list[str]:
    """把首个分块再切成 ≤max_chars 的小块，让首句尽快凑齐开播。

    客户端在「首句帧全齐」时提前开播（covered 路径，不等 prebuffer），
    首句越短开口越早；Breeze 的合成延迟与文本长度几乎无关（~2.2s 底价），
    切短首句几乎不额外亏合成时间。
    """
    if not chunks or len(chunks[0]) <= max_chars:
        return chunks
    head = chunks[0]
    cut = max(
        head.rfind("，", 0, max_chars),
        head.rfind(",", 0, max_chars),
        head.rfind("、", 0, max_chars),
    )
    if cut < 3:
        cut = max_chars - 1
    first = head[:cut + 1].strip()
    rest = head[cut + 1:].strip()
    if not first:
        return chunks
    return [first] + ([rest] if rest else []) + chunks[1:]


def _decode_image(data: bytes):
    """bytes → RGB ndarray；解析失败返回 None。"""
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)   # BGR
    if img is None:
        return None
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def _face_checks(rgb: np.ndarray):
    """上传前的人脸校验：必须恰好一张清晰正脸。

    复用引擎里已加载的 RetinaFace 检测器（GPU），返回 (ok, message, meta)。
    """
    H, W = rgb.shape[:2]
    if min(H, W) < 320:
        return False, f"图片分辨率太低（{W}x{H}），请上传至少 320px 的照片", {"width": W, "height": H}

    det, kpss = ENGINE.registrar.source2info.insightface_det(rgb)
    meta = {"faces": int(len(det)), "width": W, "height": H}
    if len(det) == 0:
        return False, "没有检测到人脸，请上传清晰的正面照", meta
    if len(det) > 1:
        return False, f"检测到 {len(det)} 张人脸，请上传只有一个人的照片", meta

    x1, y1, x2, y2, score = det[0][:5]
    fw, fh = float(x2 - x1), float(y2 - y1)
    face_ratio = min(fw / W, fh / H)
    meta.update({"score": round(float(score), 3), "face_ratio": round(face_ratio, 3)})

    if score < 0.6:
        return False, "人脸不够清晰（置信度偏低），请换一张更清晰的照片", meta
    if face_ratio < 0.15:
        return False, "人脸太小，请上传半身照或头像照（脸部约占画面高度的 1/5 以上）", meta

    # 正脸判断：鼻子到左右眼的水平距离应大致对称；偏离过多说明是侧脸
    if kpss is not None and len(kpss) == 1:
        le, re, nose = kpss[0][0], kpss[0][1], kpss[0][2]
        dl = float(nose[0] - le[0])
        dr = float(re[0] - nose[0])
        if dl <= 0 or dr <= 0:
            meta["yaw_ratio"] = 0.0
            return False, "检测到侧脸，请上传正对镜头的照片", meta
        yaw_ratio = min(dl, dr) / max(dl, dr)
        meta["yaw_ratio"] = round(yaw_ratio, 3)
        if yaw_ratio < 0.45:
            return False, "检测到侧脸，请上传正对镜头的照片", meta

    # 清晰度：脸部区域的拉普拉斯方差
    fx1, fy1 = max(0, int(x1)), max(0, int(y1))
    fx2, fy2 = min(W, int(x2)), min(H, int(y2))
    if fx2 - fx1 > 8 and fy2 - fy1 > 8:
        face = cv2.cvtColor(rgb[fy1:fy2, fx1:fx2], cv2.COLOR_RGB2GRAY)
        blur = float(cv2.Laplacian(face, cv2.CV_64F).var())
        meta["blur"] = round(blur, 1)
        if blur < 30:
            return False, "照片太模糊，请上传更清晰的正脸照", meta

    return True, "校验通过", meta


def _new_engine(avatar: str):
    """引擎构造参数集中在这（_startup 与冷启动上传共用，避免参数漂移）。"""
    from ditto_engine import DittoEngine

    return DittoEngine(
        # max_dim 只影响 warp 特征的内容（warp/decoder 的计算分辨率固定
        # 64×64），实测 768/1280/1920 帧耗时完全一致；1920 相比 768 嘴部
        # 清晰度 +66%（Laplacian 65→108，牙缝/唇缘可见），默认拉满。
        # 注册耗时一次性 +1s，带宽 23KB→32KB/帧（25fps ≈ 0.8MB/s）。
        avatar, max_dim=_env_int("AVATAR_MAX_DIM", 1920), steps=50,
        # pose_alpha：头姿幅度全局系数（LMDM 输出与空闲程序化头姿同乘）。
        # 0.6 时代头部几乎不动；1.0 = 官方自然幅度。
        pose_alpha=_env_float("AVATAR_POSE_ALPHA", 1.0), use_graph=True,
        # gesture_gain：说话手势层总增益（头随说话幅度运动，见 ditto_engine
        # 的 GESTURE_* 常量）。0 关闭手势层。
        gesture_gain=_env_float("AVATAR_GESTURE_GAIN", 1.0),
        # q82 会把牙缝/唇缘压糊（嘴部特写可见块状），q88 基本无损且编码
        # 耗时相同（JPEG 在独立线程池流水，不占渲染预算）。
        dec_size=64, jpeg_quality=_env_int("AVATAR_JPEG_QUALITY", 88),
    )


@app.on_event("startup")
async def _startup():
    global ENGINE, IDLE_TASK
    # 头像完全内存化（用户要求：磁盘不保存任何头像图片）：服务空载启动，
    # 客户端上传头像后按需建引擎（_reload_avatar_job 的冷启动路径）。
    ENGINE = None
    print("[server] 空载启动，等待上传头像", flush=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    IDLE_TASK = asyncio.create_task(_idle_loop())


async def _broadcast(data: dict):
    for ws in list(CLIENTS):
        try:
            await asyncio.wait_for(ws.send_json(data), timeout=2.0)
        except Exception:  # noqa: BLE001
            CLIENTS.discard(ws)
            CLIENT_LOCKS.pop(ws, None)


UPLOAD_PENDING: dict[str, bytes] = {}   # job_id → 原图字节（仅存活到本次加载完成）


def _materialize_avatar_temp(data: bytes) -> str:
    """头像字节 → 临时文件（注册器按路径读图）。磁盘只有这一个瞬时文件，
    加载完成后由调用方立即删除，不落任何持久头像。"""
    import tempfile
    tf = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    try:
        tf.write(data)
        return tf.name
    finally:
        tf.close()


async def _reload_avatar_job(job_id: str):
    """后台热切换头像：独占 GPU → 重建 → 广播。冷启动（引擎未建）时直接建引擎。

    头像完全内存化：原图字节取自 UPLOAD_PENDING，临时文件加载完即删；
    磁盘不保存任何头像图片（用户要求），服务重启后空载、等重新上传。
    """
    global _reload_busy, ENGINE
    job = JOBS[job_id]
    loop = asyncio.get_running_loop()
    cold = ENGINE is None
    prev_bytes = (None if cold
                  else getattr(ENGINE, "avatar_source_bytes", None))
    tmp_path = None
    try:
        raw = UPLOAD_PENDING.pop(job_id, None)
        if not raw:
            raise RuntimeError("上传数据丢失")
        tmp_path = _materialize_avatar_temp(raw)
        if cold:
            job.update(state="rebuilding", progress=40,
                       message="初始化引擎（首次加载头像）…")
            # 空载无语音、无空闲帧渲染，只需 GPU_LOCK（锁序与热路径一致）
            t_build = time.time()
            async with GPU_LOCK:
                ENGINE = await loop.run_in_executor(None, _new_engine, tmp_path)
            await loop.run_in_executor(None, ENGINE.warmup)
            info = {"elapsed_s": round(time.time() - t_build, 1),
                    "size": ENGINE.avatar_size}
        else:
            job.update(state="waiting", progress=20, message="等待当前语音结束…")
            async with SPEECH_LOCK:          # 等正在进行的语音播完
                async with GPU_LOCK:         # 等空闲帧渲染完
                    job.update(state="rebuilding", progress=40,
                               message="重建引擎（注册人脸 + CUDA Graph）…")
                    info = await loop.run_in_executor(
                        None, ENGINE.load_avatar, tmp_path)

        ENGINE.avatar_source_bytes = raw
        job.update(state="ready", progress=100, message="切换完成", info=info)
        _telemetry({"src": "server", "kind": "avatar_reload", "ok": True,
                    "elapsed_s": info["elapsed_s"], "size": info["size"]})
        await _broadcast({
            "type": "avatar_changed",
            "width": ENGINE.avatar_size[0],
            "height": ENGINE.avatar_size[1],
            "mask_rev": ENGINE.mask_rev,
        })
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        # 回滚到旧头像，保证服务仍可用
        prev_tmp = None
        try:
            if prev_bytes:
                prev_tmp = _materialize_avatar_temp(prev_bytes)
                await loop.run_in_executor(None, ENGINE.load_avatar, prev_tmp)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        finally:
            if prev_tmp:
                try:
                    os.remove(prev_tmp)
                except OSError:
                    pass
        job.update(state="error", progress=100, message=f"切换失败：{exc}", ok=False)
        _telemetry({"src": "server", "kind": "avatar_reload", "ok": False,
                    "message": str(exc)})
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        RELOADING.clear()
        _reload_busy = False


def _load_audio_16k(wav_path: str) -> np.ndarray:
    import soundfile as sf

    audio, sr = sf.read(wav_path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import librosa

        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    return audio


def _render_worker(ev_loop, queue, wav_path: str, motion_fps: int, render_fps: int,
                   ts_base_ms: int = 0, idx_base: int = 0, motion_base: int = 0,
                   first: bool = True, last: bool = True,
                   precomputed_motions=None, motion_ready: threading.Event | None = None):
    """在独立线程里跑引擎：音频 → 运动 → 渲染 → JPEG → 事件循环队列。

    抽帧按「输出帧号」驱动，保证每帧时间戳严格等于 i/render_fps，
    否则会累积系统性偏移，导致口型整体跑偏。

    分句流式：ts_base_ms / idx_base / motion_base 是本句在整段回复时间轴上的起点，
    帧时间戳与帧序号都用全局值，前端才能用一个统一时钟连续取帧。
    first=False 时按上一句显示末帧反算首帧锚点，last=False 时不收势。
    """
    import queue as queue_mod

    t_start = time.monotonic()
    audio = _load_audio_16k(wav_path)
    t_load = time.monotonic() - t_start
    dur = len(audio) / 16000
    n_out = max(1, int(round(dur * render_fps)))

    # 输出帧 i → 对应的 25fps 运动帧序号（取整到最近的运动帧）
    plan: dict[int, int] = {}
    for i in range(n_out):
        midx = int(round(i * motion_fps / render_fps))
        plan.setdefault(midx, i)

    first_frame_at = None
    t_first_motion = None
    t_infer = 0.0      # 引擎单帧推理（stitch + warp/decoder）
    t_enc = 0.0        # JPEG 编码
    n_rendered = 0

    failed = True
    motion_stop = threading.Event()
    try:
        # 首句复位；后续分句首帧按上一句实际显示帧反算锚点，避免句界跳变。
        if first:
            # 在渲染线程里复位，避免和全局空闲推帧（另一个线程）同时改 stitch 状态
            ENGINE.reset_stream()
        else:
            ENGINE.continue_speech()
        # 运动生成与 stitch/warp/decoder 用有界队列重叠，避免运动算完才开始渲染。
        motion_q = queue_mod.Queue()
        motion_errors = []
        t_motion = time.monotonic()

        def produce_motions():
            try:
                gen = precomputed_motions
                if gen is None:
                    gen = ENGINE.audio_to_motions(audio, fps=motion_fps)
                for item in gen:
                    while not motion_stop.is_set():
                        try:
                            motion_q.put(item, timeout=0.2)
                            break
                        except queue_mod.Full:
                            continue
            except Exception as exc:  # noqa: BLE001
                motion_errors.append(exc)
            finally:
                while not motion_stop.is_set():
                    try:
                        motion_q.put(None, timeout=0.2)
                        break
                    except queue_mod.Full:
                        continue
                if motion_ready is not None:
                    motion_ready.set()

        producer = threading.Thread(target=produce_motions, daemon=True)
        producer.start()

        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=1) as jpeg_pool:
            pending_jpeg = None

            def encode_frame(frame):
                nonlocal t_enc
                t_enc_start = time.monotonic()
                jpeg = ENGINE.encode_jpeg(frame)
                t_enc += time.monotonic() - t_enc_start
                return jpeg

            def emit_frame(frame, out_i):
                nonlocal pending_jpeg
                if pending_jpeg is not None:
                    previous, previous_i = pending_jpeg
                    jpeg = previous.result()
                    ts_ms = ts_base_ms + int(round(previous_i * 1000 / render_fps))
                    asyncio.run_coroutine_threadsafe(
                        queue.put(("frame", idx_base + previous_i, ts_ms, jpeg)), ev_loop
                    )
                pending_jpeg = (jpeg_pool.submit(encode_frame, frame), out_i)

            def flush_jpeg():
                nonlocal pending_jpeg
                if pending_jpeg is not None:
                    future, out_i = pending_jpeg
                    jpeg = future.result()
                    ts_ms = ts_base_ms + int(round(out_i * 1000 / render_fps))
                    asyncio.run_coroutine_threadsafe(
                        queue.put(("frame", idx_base + out_i, ts_ms, jpeg)), ev_loop
                    )
                    pending_jpeg = None

            while True:
                item = motion_q.get()
                if item is None:
                    break
                idx, x_d_info = item
                if t_first_motion is None:
                    t_first_motion = time.monotonic() - t_motion
                out_i = plan.get(idx)
                if out_i is None:
                    continue

                t_r = time.monotonic()
                # 头部/表情全部走 LMDM + 官方 ctrl 通路，不叠加额外的句首/句尾表情淡变
                frame = ENGINE.render_frame(x_d_info, motion_idx=motion_base + idx)
                t_infer += time.monotonic() - t_r
                n_rendered += 1

                if first_frame_at is None:
                    first_frame_at = time.monotonic() - t_start
                emit_frame(frame, out_i)

            flush_jpeg()

        producer.join(timeout=2.0)
        if motion_errors:
            raise motion_errors[0]

        # ── 收势过渡帧（只在最后一句之后补）──
        # 音频一结束，最后一帧语音画面不能就地冻住等空闲帧，那会明显"卡一下再切走"。
        # 这里用空闲渲染器再补 TAIL_FRAMES 帧，且时间基与全局空闲推帧完全相同
        # （time.monotonic() - IDLE_T0）：表情、头姿、微表情都从说话末尾连续衰减，
        # 客户端按真实时间把这半秒播完再交给空闲，中间没有空档。
        if last:
            ENGINE.end_speech()
            # 通知前端进入收势段；画面继续直接逐帧显示，不做像素叠加。
            asyncio.run_coroutine_threadsafe(queue.put(("marker", "tail")), ev_loop)
            for k in range(TAIL_FRAMES):
                tt = time.monotonic() - IDLE_T0
                frame = ENGINE.render_idle(tt)
                jpeg = ENGINE.encode_jpeg(frame)
                ts_ms = ts_base_ms + int(round((n_out + k) * 1000 / render_fps))
                asyncio.run_coroutine_threadsafe(
                    queue.put(("frame", idx_base + n_out + k, ts_ms, jpeg)), ev_loop
                )

        total = time.monotonic() - t_start
        failed = False
        render_avg = (t_infer + t_enc) / max(n_rendered, 1) * 1000
        print(
            f"[render] 读音频 {t_load:.2f}s | 运动算完 {t_first_motion:.2f}s | 首帧 {first_frame_at:.2f}s "
            f"| {n_rendered} 帧 共 {total:.2f}s | 渲染均 {render_avg:.1f}ms "
            f"(推理 {t_infer / max(n_rendered, 1) * 1000:.1f}"
            f" | 编码 {t_enc / max(n_rendered, 1) * 1000:.1f}) "
            f"| 实时比 {total / max(dur, 0.01):.2f}x",
            flush=True,
        )
        _telemetry({
            "src": "server", "kind": "render_summary",
            "audio_s": round(dur, 3),
            "frames": n_rendered,
            "ts_base_ms": ts_base_ms,
            "first_motion_ms": round(t_first_motion * 1000) if t_first_motion is not None else None,
            "first_frame_ms": round(first_frame_at * 1000) if first_frame_at is not None else None,
            "render_avg_ms": round(render_avg, 1),
            "realtime_ratio": round(total / max(dur, 0.01), 2),
            "motion_fps": motion_fps, "render_fps": render_fps,
        })
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        asyncio.run_coroutine_threadsafe(queue.put(("error", str(exc))), ev_loop)
    finally:
        motion_stop.set()
        # 只有最后一句（或中途出错）才解除锚点；中间句由 continue_speech 接续。
        if last or failed:
            ENGINE.end_speech()
        asyncio.run_coroutine_threadsafe(queue.put(("end",)), ev_loop)


def _stream_motion_step(stream, pcm24: bytes | None, first: bool = False):
    """executor 内执行：追加音频 → 增量运动，返回 [(idx, x_d_info)]。"""
    if first:
        ENGINE.reset_stream()
    if pcm24:
        s24 = np.frombuffer(pcm24, dtype=np.int16)
        stream.append(tts._resample_int16(s24, 24000, 16000))
    return stream.pop_frames()


def _stream_render_one(x_d_info, idx: int):
    """executor 内执行：单帧渲染 + JPEG 编码。逐帧下发用，不攒批。"""
    frame = ENGINE.render_frame(x_d_info, motion_idx=idx)
    return idx, ENGINE.encode_jpeg(frame)


def _stream_idle_one(n_out: int):
    """executor 内执行：收势帧一帧（空闲渲染器、全局时间基）。"""
    tt = time.monotonic() - IDLE_T0
    frame = ENGINE.render_idle(tt)
    return n_out, ENGINE.encode_jpeg(frame)


async def _speak_streaming(sock: WebSocket, send_json, send_lock: asyncio.Lock,
                           text: str, started_at: float):
    """流式链路：Breeze realtime WS 连续出声 → 增量运动 → 连续推帧。

    音频突发（~0.5-1s 一片）随到随下发（客户端按绝对时间轴排队）；
    运动按 LMDM 窗口增量产出并逐帧渲染推送。长回复自动按 900 字符
    分 turn（服务端单 turn 上限 1000 字符），运动状态跨 turn 续算。
    持久连接被服务端断开（空闲超时）时自动重连并整轮重试一次。
    """
    loop = asyncio.get_running_loop()
    rt = tts.get_realtime()
    sentences = split_speech_chunks(text)

    # 分 turn 分组
    groups: list[list[str]] = []
    cur: list[str] = []
    cur_len = 0
    for s in sentences:
        if cur and cur_len + len(s) > STREAM_TURN_MAX_CHARS:
            groups.append(cur)
            cur, cur_len = [], 0
        cur.append(s)
        cur_len += len(s)
    if cur:
        groups.append(cur)

    stream = None
    offset_ms = 0
    chunk_index = 0
    ttfa_ms = None
    spoke = False
    n_frames = 0
    try:
        async with GPU_LOCK:
            TALKING_ANY.set()
            try:
                for attempt in range(2):
                    stream = ENGINE.open_motion_stream()
                    offset_ms = 0
                    chunk_index = 0
                    ttfa_ms = None
                    spoke = False
                    n_frames = 0
                    try:
                        _t0 = time.monotonic()
                        await rt.start_turn()
                        print(f"[stream] turn 开始（含连接）{(time.monotonic() - _t0) * 1000:.0f}ms",
                              flush=True)
                        for s in groups[0]:
                            await rt.say_sentence(s)
                        await rt.end_turn()
                        gi = 1
                        first = True
                        done = False
                        while not done:
                            kind, payload = await rt.recv(timeout=40)
                            now_ms = int((time.monotonic() - started_at) * 1000)
                            _telemetry({"src": "server", "kind": "stream_msg",
                                        "msg": kind,
                                        "bytes": len(payload) if kind == "audio" else 0,
                                        "elapsed_ms": now_ms})
                            if kind == "audio":
                                if ttfa_ms is None:
                                    ttfa_ms = now_ms
                                dur = int(round(len(payload) / 48))   # 24k s16le → 48 B/ms
                                if not spoke:
                                    await send_json({
                                        "type": "speak_start", "fps": RENDER_FPS,
                                        "prebuffer": PREBUFFER_FRAMES,
                                        "tts_ms": ttfa_ms, "chunks": len(sentences),
                                        "index": 0, "offset_ms": 0,
                                        # 报大的首句时长：客户端凑齐 ~1.2s 运动帧才开播，
                                        # 吸收 LMDM 窗口 3.2s 的结构性滞后
                                        "dur_ms": max(dur, STREAM_START_MARGIN_MS),
                                        "audio": _pcm_payload(
                                            {"pcm": payload, "sample_rate": 24000}),
                                        "stream": True,
                                    })
                                    spoke = True
                                else:
                                    await send_json({
                                        "type": "speak_chunk", "index": chunk_index,
                                        "offset_ms": offset_ms, "dur_ms": dur,
                                        "audio": _pcm_payload(
                                            {"pcm": payload, "sample_rate": 24000}),
                                    })
                                chunk_index += 1
                                offset_ms += dur
                                _tm = time.monotonic()
                                motions = await loop.run_in_executor(
                                    None, _stream_motion_step, stream, payload, first)
                                first = False
                                motion_ms = (time.monotonic() - _tm) * 1000
                                _tr0 = time.monotonic()
                                for idx, x_d_info in motions:
                                    idx, jpeg = await loop.run_in_executor(
                                        None, _stream_render_one, x_d_info, idx)
                                    n_frames += 1
                                    header = struct.pack(
                                        "<IH", idx,
                                        int(round(idx * 1000 / RENDER_FPS)) & 0xFFFF)
                                    await _try_send_bytes(sock, send_lock,
                                                          header + jpeg, 3.0)
                                _telemetry({"src": "server", "kind": "stream_step",
                                            "new_frames": len(motions),
                                            "motion_ms": round(motion_ms),
                                            "render_ms": round(
                                                (time.monotonic() - _tr0) * 1000),
                                            "elapsed_ms": now_ms})
                            else:
                                ev = payload
                                etype = ev.get("type")
                                if etype == "turn.done":
                                    if gi < len(groups):
                                        await rt.start_turn()
                                        for s in groups[gi]:
                                            await rt.say_sentence(s)
                                        await rt.end_turn()
                                        gi += 1
                                    else:
                                        done = True
                                elif etype == "error":
                                    raise RuntimeError(
                                        f"Breeze realtime: {ev.get('message', ev)}")
                                # audio.started / session.expiring 等事件忽略

                        _telemetry({
                            "src": "server", "kind": "speak_start",
                            "tts_provider": "breeze_stream", "ttfa_ms": ttfa_ms,
                            "text_len": len(text), "chunks": len(sentences),
                            "turns": len(groups), "audio_ms": offset_ms,
                            "frames": n_frames,
                        })

                        # 尾窗 pad 帧 + 收势 + 结束
                        if spoke:
                            await send_json({"type": "speak_tail"})
                            stream.finish()   # 允许 pad 尾窗：剩余音频的运动帧全部产出
                            motions = await loop.run_in_executor(
                                None, _stream_motion_step, stream, None, False)
                            for idx, x_d_info in motions:
                                idx, jpeg = await loop.run_in_executor(
                                    None, _stream_render_one, x_d_info, idx)
                                header = struct.pack(
                                    "<IH", idx,
                                    int(round(idx * 1000 / RENDER_FPS)) & 0xFFFF)
                                await _try_send_bytes(sock, send_lock,
                                                      header + jpeg, 3.0)
                            await loop.run_in_executor(None, ENGINE.end_speech)
                            n_out = (motions[-1][0] + 1) if motions else 0
                            for k in range(TAIL_FRAMES):
                                n_k, jpeg = await loop.run_in_executor(
                                    None, _stream_idle_one, n_out + k)
                                header = struct.pack(
                                    "<IH", n_k,
                                    int(round(n_k * 1000 / RENDER_FPS)) & 0xFFFF)
                                await _try_send_bytes(sock, send_lock,
                                                      header + jpeg, 3.0)
                            await send_json({"type": "speak_end", "total_ms": offset_ms})
                        break
                    except websockets.exceptions.ConnectionClosed:
                        # 持久连接被服务端断开（空闲超时等）：强制重连整轮重试。
                        # 重试的 speak_start 会让客户端 resetSpeech，时间轴干净重排。
                        await loop.run_in_executor(None, stream.close)
                        stream = None
                        await rt.close()
                        _telemetry({"src": "server", "kind": "stream_error",
                                    "error": f"连接断开，第 {attempt + 1} 次尝试，重连重试"})
                        if attempt == 1:
                            raise
            finally:
                TALKING_ANY.clear()
                if stream is not None:
                    await loop.run_in_executor(None, stream.close)
    except Exception as exc:  # noqa: BLE001
        _telemetry({"src": "server", "kind": "stream_error",
                    "error": f"{type(exc).__name__}: {exc}",
                    "tb": traceback.format_exc()[-1500:]})
        # 异常中断：取消 Breeze 当前 turn，保持持久会话干净可复用
        try:
            await rt.cancel_turn()
        except Exception:  # noqa: BLE001
            pass
        # 客户端必须有结束信号才能释放 UI
        if spoke:
            try:
                await send_json({"type": "speak_end", "total_ms": offset_ms})
            except Exception:  # noqa: BLE001
                pass
        raise


async def _try_send_bytes(ws: WebSocket, lock: asyncio.Lock, payload: bytes,
                          timeout: float = 1.0) -> bool:
    """带超时的发送。

    半死的连接（标签页被冻结、TCP 缓冲写满）会让 send 永远不返回；
    全局推帧循环里只要有一个这样的客户端，所有人都会没帧，所以必须限时并踢掉。
    """
    async def _do():
        async with lock:
            await ws.send_bytes(payload)

    try:
        await asyncio.wait_for(_do(), timeout)
        return True
    except Exception:  # noqa: BLE001
        return False


async def _idle_loop():
    """全局空闲推帧：呼吸 + 轻转头，只渲染一次并广播给所有连接。

    之前是「每个连接一条渲染循环」，多开标签页时会各渲一份、互相抢 GPU，
    帧到达节奏被拖得不均匀。现在渲染只做一份，多开页面也不会增加 GPU 负担，
    时间基准全局连续，头姿相位不跳。
    """
    loop = asyncio.get_running_loop()
    idx = 0
    render_ms = 0.0
    n_log = 0
    t_log = time.monotonic()
    prepared_jpeg = None

    def render_idle_jpeg(tt):
        frame = ENGINE.render_idle(tt)
        return ENGINE.encode_jpeg(frame)

    while True:
        try:
            if ENGINE is None or RELOADING.is_set() or TALKING_ANY.is_set() or not CLIENTS:
                prepared_jpeg = None
                await asyncio.sleep(0.1)
                continue

            t_frame = time.monotonic()
            async with GPU_LOCK:
                if RELOADING.is_set() or TALKING_ANY.is_set() or not CLIENTS:
                    prepared_jpeg = None
                    continue
                try:
                    if prepared_jpeg is None:
                        prepared_jpeg = await loop.run_in_executor(
                            None, render_idle_jpeg, t_frame - IDLE_T0
                        )
                    # 下一帧在发送当前帧时并行渲染，隐藏网络与事件循环调度开销。
                    next_jpeg = loop.run_in_executor(
                        None, render_idle_jpeg, time.monotonic() - IDLE_T0
                    )
                    payload = struct.pack("<IH", idx & 0x7FFFFFFF, IDLE_TS) + prepared_jpeg
                    for ws in list(CLIENTS):
                        lock = CLIENT_LOCKS.get(ws)
                        if lock is None:
                            continue
                        if not await _try_send_bytes(ws, lock, payload):
                            print("[idle] 丢弃无响应的连接", flush=True)
                            CLIENTS.discard(ws)
                            CLIENT_LOCKS.pop(ws, None)
                    prepared_jpeg = await next_jpeg
                except Exception:  # noqa: BLE001
                    prepared_jpeg = None
                    traceback.print_exc()
                    await asyncio.sleep(0.5)
                    continue
            render_ms += (time.monotonic() - t_frame) * 1000
            n_log += 1

            idx += 1
            if n_log >= 200:
                now = time.monotonic()
                print(f"[idle] {n_log / (now - t_log):.1f}fps | 单帧 {render_ms / n_log:.1f}ms "
                      f"| 目标 {IDLE_FPS}fps", flush=True)
                render_ms, n_log, t_log = 0.0, 0, now
        except Exception:  # noqa: BLE001
            prepared_jpeg = None
            # 任何意外都不能让推帧循环退出
            traceback.print_exc()
            await asyncio.sleep(0.3)


@app.websocket("/ws")
async def ws_endpoint(sock: WebSocket):
    await sock.accept()

    if ENGINE is None:
        await sock.send_json({"type": "error", "message": "引擎未就绪"})
        await sock.close()
        return

    await sock.send_json({
        "type": "ready",
        "width": ENGINE.avatar_size[0],
        "height": ENGINE.avatar_size[1],
        "fps": RENDER_FPS,
        "prebuffer": PREBUFFER_FRAMES,
        "mask_rev": ENGINE.mask_rev,
    })

    loop = asyncio.get_running_loop()
    send_lock = asyncio.Lock()
    CLIENTS.add(sock)
    CLIENT_LOCKS[sock] = send_lock

    async def send_json(data: dict):
        async with send_lock:
            await asyncio.wait_for(sock.send_json(data), timeout=2.0)

    try:
        while True:
            raw = await sock.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

            # 倾听态开关：客户端在用户开始/停止说话时推送。
            # 说话期间空闲循环本来就停摆（TALKING_ANY），speak_end 后
            # 若仍处于 listening 则自动回到注视镜头的倾听微动。
            if mtype == "listening":
                if ENGINE is not None and not RELOADING.is_set():
                    ENGINE.set_listening(bool(msg.get("active")))
                continue

            if mtype != "say":
                continue

            text = (msg.get("text") or "").strip()
            if not text:
                continue

            if RELOADING.is_set():
                await send_json({"type": "error", "message": "正在切换头像，请稍后再试"})
                continue

            # 同一时刻只允许一段语音占用引擎（头像热切换也要靠这把锁让位）
            async with SPEECH_LOCK:
                # 流式优先：Breeze realtime WS 连续出声 + 增量运动连续推帧
                if STREAM_TTS and tts.get_realtime() is not None:
                    started_at = time.monotonic()
                    try:
                        await _speak_streaming(
                            sock, send_json, send_lock, text, started_at)
                    except Exception as exc:  # noqa: BLE001
                        traceback.print_exc()
                        await send_json({
                            "type": "error",
                            "message": f"流式语音失败: {exc}",
                        })
                    continue

                sentences = _split_first_chunk(
                    split_speech_chunks(text), FIRST_CHUNK_MAX_CHARS
                )
                voice = msg.get("voice") or "zh-CN-XiaoxiaoNeural"
                tag = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"

                # ① 首句同步合成：合成完立刻开口，不再等整段回复
                try:
                    t_tts = time.time()
                    first = await synth_sentence(sentences[0], str(AUDIO_DIR), voice, f"{tag}_0")
                    tts_ms = int((time.time() - t_tts) * 1000)
                except Exception as exc:  # noqa: BLE001
                    await send_json({"type": "error", "message": f"TTS 失败: {exc}"})
                    continue

                _telemetry({
                    "src": "server", "kind": "speak_start",
                    "tts_ms": tts_ms, "text_len": len(text),
                    "chunks": len(sentences), "first_dur_ms": first["dur_ms"],
                    "tts_provider": first.get("provider", "edge"),
                })
                await send_json({
                    "type": "speak_start",
                    "fps": RENDER_FPS,
                    "prebuffer": PREBUFFER_FRAMES,
                    "tts_ms": tts_ms,
                    "chunks": len(sentences),
                    "index": 0,
                    "offset_ms": 0,
                    "dur_ms": first["dur_ms"],
                    "audio": _pcm_payload(first),
                })

                # ② 后续句子：合成完立即把音频下发（客户端先排进 WebAudio 时间轴），
                #    与首句的渲染/播放并行进行
                synth_q: asyncio.Queue = asyncio.Queue()

                async def _synth_rest():
                    cum = first["dur_ms"] + (CHUNK_GAP_MS if len(sentences) > 1 else 0)
                    try:
                        for i in range(1, len(sentences)):
                            res = await synth_sentence(
                                sentences[i], str(AUDIO_DIR), voice, f"{tag}_{i}"
                            )
                            res["offset_ms"] = cum
                            await send_json({
                                "type": "speak_chunk",
                                "index": i,
                                "offset_ms": cum,
                                "dur_ms": res["dur_ms"],
                                "audio": _pcm_payload(res),
                            })
                            cum += res["dur_ms"]
                            if i < len(sentences) - 1:
                                cum += CHUNK_GAP_MS
                            synth_q.put_nowait((i, res))
                    except Exception as exc:  # noqa: BLE001
                        traceback.print_exc()
                        synth_q.put_nowait((-1, exc))
                    finally:
                        synth_q.put_nowait((len(sentences), None))

                synth_task = asyncio.create_task(_synth_rest())

                # ③ 逐句推理（独占 GPU；全局空闲推帧靠 TALKING_ANY 让位）。
                #    合成与渲染/播放并行：第 i 句在渲染时，第 i+1 句已经在合成。
                TALKING_ANY.set()
                chunk = first
                ci = 0
                ts_base = 0
                idx_base = 0
                precomputed_motions = None

                try:
                    # 和空闲推帧共用 GPU_LOCK：空闲帧和说话帧都会 replay 同一条 CUDA Graph，
                    # 两个线程同时跑会互相踩状态（偶发卡死）。TALKING_ANY 只是让空闲让位，
                    # 仍有「正在渲的这一帧」的竞态，这里用锁彻底串行化。
                    async with GPU_LOCK:
                        while chunk is not None:
                            # 只有「确认没有下一句」时才做收句淡出和收势帧
                            last = (ci == len(sentences) - 1) or (
                                synth_task.done() and synth_q.empty()
                            )
                            q: asyncio.Queue = asyncio.Queue(maxsize=256)
                            motion_base = int(round(ts_base * MOTION_FPS / 1000))
                            motion_ready = threading.Event()
                            task = loop.run_in_executor(
                                None, _render_worker, loop, q, chunk["wav"],
                                MOTION_FPS, RENDER_FPS,
                                ts_base, idx_base, motion_base, ci == 0, last,
                                precomputed_motions, motion_ready,
                            )

                            while True:
                                item = await q.get()
                                if item[0] == "end":
                                    break
                                if item[0] == "error":
                                    await send_json({"type": "error", "message": item[1]})
                                    break
                                if item[0] == "marker":
                                    # 收势段开始，客户端仍直接显示后续模型帧。
                                    await send_json({"type": "speak_tail"})
                                    continue

                                _, frame_idx, ts_ms, jpeg = item
                                header = struct.pack("<IH", frame_idx, ts_ms & 0xFFFF)
                                async with send_lock:
                                    # 客户端卡住时必须超时退出，否则会一直占着 SPEECH_LOCK
                                    await asyncio.wait_for(
                                        sock.send_bytes(header + jpeg), timeout=3.0
                                    )
                            await task

                            ts_base += chunk["dur_ms"]
                            if not last:
                                ts_base += CHUNK_GAP_MS
                            idx_base = int(round(ts_base * RENDER_FPS / 1000))
                            if last:
                                break

                            try:
                                item = await synth_q.get()
                            except Exception as exc:  # noqa: BLE001
                                await send_json({"type": "error", "message": f"运动预取失败: {exc}"})
                                break
                            if item[0] == -1:
                                await send_json({"type": "error", "message": f"TTS 失败: {item[1]}"})
                                break
                            if item[1] is None:
                                break
                            audio = await loop.run_in_executor(
                                None, _load_audio_16k, item[1]["wav"]
                            )
                            precomputed_motions = await loop.run_in_executor(
                                None,
                                lambda: list(ENGINE.audio_to_motions(audio, fps=MOTION_FPS)),
                            )
                            ci, chunk = item
                finally:
                    synth_task.cancel()
                    TALKING_ANY.clear()

                await send_json({"type": "speak_end", "total_ms": ts_base})

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        try:
            await send_json({"type": "error", "message": str(exc)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        CLIENTS.discard(sock)
        CLIENT_LOCKS.pop(sock, None)


@app.get("/api/health")
async def health():
    if ENGINE is None:
        return {"service": "starting", "engine": None}
    return {
        "service": "ok",
        "engine": {
            "ready": True,
            "size": ENGINE.avatar_size,
            "fps": RENDER_FPS,
            "idle_fps": IDLE_FPS,
            "avatar": ENGINE.avatar_path,
        },
    }


@app.post("/api/telemetry")
async def telemetry_ingest(payload: dict):
    """接收前端埋点（真实播放帧率、音画漂移等），落盘 + 打印。"""
    payload = dict(payload or {})
    payload.setdefault("src", "client")
    _telemetry(payload)
    return {"ok": True}


@app.get("/api/avatar")
async def avatar_image():
    """当前头像原图（内存字节）。头像完全内存化，无头像时 404。"""
    data = (getattr(ENGINE, "avatar_source_bytes", None)
            if ENGINE is not None else None)
    if not data:
        raise HTTPException(status_code=404, detail="avatar unavailable")
    return Response(content=data, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/avatar/mask")
async def avatar_mask():
    """人物 alpha 蒙版（RGBA PNG，alpha=羽化人物蒙版，RGB=白）。

    客户端按 ready/avatar_changed 里的 mask_rev 增量拉取一次，
    之后用 BlendMode.dstIn（Flutter）/ canvas destination-in（浏览器）
    给 JPEG 帧流抠背景。蒙版不可用时 404，客户端保持不透明（同旧行为）。
    """
    if ENGINE is None or ENGINE.mask_png is None:
        raise HTTPException(status_code=404, detail="mask unavailable")
    return Response(content=ENGINE.mask_png, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.post("/api/avatar")
async def upload_avatar(file: UploadFile = File(...)):
    """上传头像：校验（恰好一张清晰正脸）→ 后台热切换，返回任务号。

    进度用 GET /api/avatar/status/{job_id} 轮询。
    """
    global _reload_busy

    cold = ENGINE is None          # 空载冷启动：没有现成引擎做预校验
    if _reload_busy:
        return JSONResponse({"ok": False, "message": "正在切换头像，请稍后再试"},
                            status_code=409)

    data = await file.read()
    if not data:
        return JSONResponse({"ok": False, "message": "空文件"}, status_code=400)
    if len(data) > MAX_UPLOAD_BYTES:
        return JSONResponse({"ok": False, "message": "图片太大（上限 20MB）"},
                            status_code=400)

    loop = asyncio.get_running_loop()
    rgb = await loop.run_in_executor(None, _decode_image, data)
    if rgb is None:
        return JSONResponse({"ok": False, "message": "无法解析图片（支持 JPG / PNG / WebP）"},
                            status_code=400)

    _reload_busy = True
    RELOADING.set()
    started = False
    try:
        if cold:
            # 冷启动没有引擎，人脸预校验用的检测器（ENGINE.registrar）也不存在；
            # 跳过预校验，照片质量问题会在后台建引擎任务里以失败形式反馈。
            meta = {}
        else:
            # 校验要用人脸检测器（GPU），与空闲渲染互斥
            async with GPU_LOCK:
                ok, message, meta = await loop.run_in_executor(None, _face_checks, rgb)
            if not ok:
                _telemetry({"src": "server", "kind": "avatar_reject",
                            "message": message, **meta})
                return JSONResponse({"ok": False, "message": message, "meta": meta},
                                    status_code=400)

        # 磁盘不落任何头像文件（用户要求）：原图字节只在内存，
        # 加载时写临时文件、加载完立即删除（见 _reload_avatar_job）。
        job_id = uuid.uuid4().hex[:12]
        JOBS[job_id] = {"state": "queued", "progress": 10,
                        "message": "已接收，准备重建", "ok": True}
        UPLOAD_PENDING[job_id] = data
        if len(JOBS) > 32:                    # 只保留最近的进度记录
            for k in list(JOBS)[:-32]:
                JOBS.pop(k, None)
        asyncio.create_task(_reload_avatar_job(job_id))
        started = True
        return {"ok": True, "job": job_id, "meta": meta}
    finally:
        if not started:        # 校验失败/异常：立即释放占用，由任务自己释放的情况不处理
            RELOADING.clear()
            _reload_busy = False


@app.get("/api/avatar/status/{job_id}")
async def avatar_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"job": job_id, **job}


@app.get("/")
async def index_page():
    return FileResponse(
        STATIC_DIR / "index.html",
        media_type="text/html",
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


app.mount("/audio", StaticFiles(directory=str(AUDIO_DIR)), name="audio")
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(
        app,
        host=os.environ.get("AVATAR_HOST", "127.0.0.1"),
        port=int(os.environ.get("AVATAR_PORT", "8765")),
        log_level="info",
    )

