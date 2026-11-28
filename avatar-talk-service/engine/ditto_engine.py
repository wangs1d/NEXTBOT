"""Ditto 实时流式数字人引擎。

设计要点：
1. LMDM 扩散按 25fps 生成运动序列（保证口型准确）
2. 运动与渲染都按官方 25fps 时间轴输出，保证口型同步不落后
3. warp 走官方 FP32 + autocast，decoder 走半精度，两者直通 CUDA Graph 输出模型画面
4. 对外暴露推流式接口：喂音频 → 逐帧吐 (帧序号, 时间戳, JPEG)

依赖 D:\\Ditto\\repo 的 core 代码与 D:\\Ditto\\checkpoints 权重。
"""

import math
import os
import random
import sys
import time

REPO_DIR = r"D:\Ditto\repo"
CKPT_DIR = r"D:\Ditto\checkpoints"
if REPO_DIR not in sys.path:
    sys.path.insert(0, REPO_DIR)

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torch.nn.utils.spectral_norm import remove_spectral_norm

from core.atomic_components.audio2motion import Audio2Motion
from core.atomic_components.avatar_registrar import AvatarRegistrar
from core.atomic_components.cfg import parse_cfg
from core.atomic_components.condition_handler import ConditionHandler
from core.atomic_components.motion_stitch import MotionStitch, bin66_to_degree
from core.atomic_components.wav2feat import Wav2Feat

# 上传照片的抠像只在内存里做（用户要求：磁盘不保存任何处理后的 PNG）。
# 注册器读图后、人脸检测/特征提取前，把背景替换为中性色——decoder 会
# 忠实重建源图背景，源头替换后所有渲染帧的背景都是中性色，歪头也不露
# 照片背景。原图按用户上传原样落盘，重启/热切换加载时现抠现建。
from core.atomic_components import avatar_registrar as _avatar_registrar_mod

_orig_load_source_frames = _avatar_registrar_mod.load_source_frames


def _load_source_frames_matted(source_path, max_dim=-1, n_frames=-1):
    rgb_list, is_image_flag = _orig_load_source_frames(
        source_path, max_dim=max_dim, n_frames=n_frames)
    for i, rgb in enumerate(rgb_list):
        rgb_list[i] = matte_avatar_photo(rgb)
    return rgb_list, is_image_flag


_avatar_registrar_mod.load_source_frames = _load_source_frames_matted
from core.models.decoder import Decoder
from core.models.warp_network import WarpNetwork

DATA_ROOT = os.path.join(CKPT_DIR, "ditto_pytorch")
CFG_PKL = os.path.join(CKPT_DIR, "ditto_cfg", "v0.4_hubert_cfg_pytorch.pkl")
DEV = "cuda"
SAMPLE_RATE = 16000
MOTION_FPS = 25      # 运动/LMDM 时间轴帧率（模型固定）
IDLE_LIP_KP = (6, 12, 14, 17, 19, 20)     # exp 里属于嘴部的关键点
IDLE_BANK_SEC = 0                         # 静音 LMDM 运动库：0=关闭（实测会带来循环感和面部拉扯）
IDLE_EXPR_EMOS = (("happy", 3), ("surprise", 6), ("sad", 5))   # 官方情绪索引
IDLE_EXPR_BASE_EMO = 4                    # 中性
IDLE_EXPR_MAX_DELTA = 0.006              # 限制空闲表情在关键点空间的最大形变量，避免腮部轮廓伸缩

# ── 说话运动增强：放大 LMDM 自身的运动 ──
# 设计原则（2026-11-28 二次返工）：LMDM 是真实说话视频训练的联合模型，
# 头姿/口型/平移/前伸(scale)天然耦合自然。此前在此之上手搓逐轴轨迹
# （yaw 游走、点头弹簧、roll 跟随等固定参数波形）与模型自身节奏打架，
# 观感"硬编码/晃动不自然"，已全部移除。
# 现在只做一件事：音量越大，模型自己的运动（头姿 + 平移 t + 前伸 scale）
# 按同一倍数均匀放大——放大已有自然运动，不发明新运动。
# 能量在产出端挂在 x_d_info 私有键 "_ges"=(energy, motion_time)，私有键
# 必须在进 stitch 前弹出（_mix_s_d_info 按 d0 逐键相对运算会 KeyError）。
# ctrl_motion 里 delta 先加后乘 alpha，base delta_pitch 按 /alpha 预除。
GESTURE_ALPHA_GAIN = 0.35    # 音量对 LMDM 运动的放大：mult = 1 + gain * e
GESTURE_ALPHA_MAX = 1.35     # 放大倍数上限
GESTURE_TAIL_SEC = 0.35      # 句尾收零时长（收势帧回中性不跳变）

# ── 空闲/倾听微动增强 ──
# 情绪基的嘴部分量比例：0 = 情绪表情（眉眼颊）不动嘴。旧值 0.15 会让
# happy 基的微笑分量慢速淡入，被用户感知为"眨眼时嘴角上扬"（实测眨眼
# 波形对唇 kp 位移仅 ~0.0003，与眨眼无关）；嘴部动态由中性唇姿漂移承担。
IDLE_LIP_MASK_RATIO = 0.0
IDLE_LIP_POSTURE_MAX = 0.0015   # 中性唇姿微漂移上限（微张/抿嘴，不含微笑方向）
IDLE_CARRY_TAU = 1.2            # 说话→空闲姿态接力衰减时间常数（秒）
IDLE_SACC_MIN_DEG = 2.5         # 微扫视幅度（°等效视线偏移）
IDLE_SACC_MAX_DEG = 13.0        # 注视转移扫视幅度（°）
IDLE_SACC_GAIN = 1.0            # 扫视 exp 注入总增益
IDLE_BREATH_SCALE = 0.004       # 呼吸的 scale 起伏（胸廓/整体轻微起伏）
IDLE_BLINK_LONG_EVERY = (6, 12) # 平均每 6-12 次眨眼掺一次长眨眼（闭眼 ~1s）


def _log(msg):
    print(f"[ditto] {msg}", flush=True)


class _GraphLMDM:
    """保持官方 LMDM 采样逻辑，只将每步去噪网络固化为 CUDA Graph。"""

    def __init__(self, base, enabled: bool):
        self.base = base
        self.enabled = enabled
        self.sampling_timesteps = None
        self._graph = None
        self._disabled = False
        self._x = self._kp = self._aud = self._time = None
        self._pred = self._start = None

    def __getattr__(self, name):
        return getattr(self.base, name)

    def setup(self, sampling_timesteps):
        if (self.sampling_timesteps == sampling_timesteps
                and (self._graph is not None or not self.enabled or self._disabled)):
            return
        self._graph = None
        self._x = self._kp = self._aud = self._time = None
        self._pred = self._start = None
        self.base.setup(sampling_timesteps)
        self.sampling_timesteps = sampling_timesteps

    @torch.no_grad()
    def _capture(self, kp_cond, aud_cond):
        model = self.base.model
        self._x = torch.zeros(
            (1, self.base.seq_frames, self.base.motion_feat_dim), device=DEV
        )
        self._kp = torch.zeros_like(torch.from_numpy(kp_cond), device=DEV)
        self._aud = torch.zeros_like(torch.from_numpy(aud_cond), device=DEV)
        self._time = torch.zeros((1,), device=DEV, dtype=torch.long)
        self._pred = torch.empty_like(self._x)
        self._start = torch.empty_like(self._x)

        def one_step():
            with torch.autocast(device_type="cuda", dtype=torch.float16):
                pred, start = model.model_predictions(
                    self._x, self._kp, self._aud, self._time
                )
            self._pred.copy_(pred.float())
            self._start.copy_(start.float())

        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(stream):
            for _ in range(3):
                one_step()
        torch.cuda.current_stream().wait_stream(stream)
        torch.cuda.synchronize()

        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            one_step()
        self._graph = graph
        torch.cuda.synchronize()
        _log(f"LMDM 单步 CUDA Graph 捕获完成（{self.sampling_timesteps} 步）")

    @torch.no_grad()
    def __call__(self, kp_cond, aud_cond, sampling_timesteps):
        if not self.enabled or self._disabled or self.base.model_type != "pytorch":
            return self.base(kp_cond, aud_cond, sampling_timesteps)
        if self.sampling_timesteps != sampling_timesteps:
            self.setup(sampling_timesteps)
        if self._graph is None:
            try:
                self._capture(kp_cond, aud_cond)
            except Exception as exc:  # noqa: BLE001
                self._disabled = True
                _log(f"LMDM CUDA Graph 不可用，回退逐帧: {exc}")
                return self.base(kp_cond, aud_cond, sampling_timesteps)

        model = self.base.model
        self._kp.copy_(torch.from_numpy(kp_cond).to(DEV))
        self._aud.copy_(torch.from_numpy(aud_cond).to(DEV))
        x = torch.randn(
            (1, self.base.seq_frames, self.base.motion_feat_dim), device=DEV
        )
        self._x.copy_(x)

        i = 0
        for _, time_next in model.time_pairs:
            self._time.fill_(int(model.time_cond_list[i].detach().item()))
            self._graph.replay()
            x_start = self._start
            if time_next < 0:
                x = x_start
            else:
                x = (x_start * model.alpha_next_sqrt_list[i]
                     + model.c_list[i] * self._pred
                     + model.sigma_list[i] * model.noise_list[i])
                self._x.copy_(x)
            i += 1
        return x.float().cpu().numpy()


# ── 人物抠像与蒙版（MODNet 真 alpha matting）──
# 二值分割只给硬边界（发丝间隙的原图背景像素无法清理，白边反复复发），
# matting 给逐像素真透明度：发丝半透明、间隙 alpha≈0，白边从机制上消失。
AVATAR_BG_FILL_RGB = (14, 14, 16)   # 背景填充色（RGB），与客户端面板深底同款

_MODNET = None
_MODNET_TRIED = False


def _modnet_session():
    """懒加载 MODNet ONNX（一次性）；缺文件/onnxruntime 不可用返回 None。"""
    global _MODNET, _MODNET_TRIED
    if _MODNET_TRIED:
        return _MODNET
    _MODNET_TRIED = True
    try:
        import onnxruntime as ort

        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "models", "modnet.onnx")
        if not os.path.exists(path):
            _log(f"MODNet 模型缺失，抠像/蒙版停用: {path}")
            return None
        _MODNET = ort.InferenceSession(
            path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        _log("MODNet matting 就绪")
    except Exception as exc:  # noqa: BLE001
        _log(f"MODNet 初始化失败，抠像/蒙版停用: {exc}")
        _MODNET = None
    return _MODNET


def _matte_modnet_alpha(rgb_u8: np.ndarray) -> np.ndarray | None:
    """MODNet 推理：返回原尺寸 [0,1] float alpha；失败返回 None。"""
    sess = _modnet_session()
    if sess is None:
        return None
    h, w = rgb_u8.shape[:2]
    inp = cv2.resize(rgb_u8, (512, 512), interpolation=cv2.INTER_AREA)
    x = (inp.astype(np.float32) / 127.5 - 1.0).transpose(2, 0, 1)[None]
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    alpha = np.clip(np.squeeze(out), 0.0, 1.0)
    if alpha.ndim != 2:
        return None
    return cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LINEAR)


def matte_avatar_photo(rgb: np.ndarray) -> np.ndarray:
    """上传照片预处理：MODNet 真 alpha 抠像 + 背景去污染（despill），
    背景替换为中性填充色。MODNet 不可用/失败时原样返回（绝不挡上传）。

    半透明像素 C = F·α + B0·(1-α)（B0=原图背景色），直接合成会保留
    B0 的亮色成分 → 头发外圈浅色描边。去污染闭式解（无 α 除法，低 alpha
    稳定）：最终 = C + (fill - B0)·(1-α)——背景像素精确变填充色，边缘
    残留的背景色成分被完全扣除，白边/彩边根治。
    """
    try:
        rgb_u8 = np.ascontiguousarray(
            np.clip(rgb, 0, 255).astype(np.uint8)) if rgb.dtype != np.uint8 \
            else np.ascontiguousarray(rgb)
        mod_alpha = _matte_modnet_alpha(rgb_u8)
        if mod_alpha is None:
            _log("MODNet 不可用，跳过抠像，保留原图背景")
            return rgb_u8
        # 低 alpha 抑制：发丝外围的软光晕密度压低（连续曲线避免分层；
        # alpha>0.35 的实体发丝不受影响）
        a = mod_alpha
        alpha_s = a * (0.45 + 0.55 * np.clip(a / 0.35, 0.0, 1.0))
        alpha_s = cv2.GaussianBlur(alpha_s, (3, 3), 0)
        # B0 = 确信背景像素（α<0.05）的中位色；不足则退回图像边框采样
        bg_mask = a < 0.05
        if float(bg_mask.sum()) >= 100:
            b0 = np.median(rgb_u8[bg_mask].astype(np.float32), axis=0)
        else:
            border = np.concatenate([
                rgb_u8[:, :4].reshape(-1, 3), rgb_u8[:, -4:].reshape(-1, 3),
                rgb_u8[:4, :].reshape(-1, 3), rgb_u8[-4:, :].reshape(-1, 3)])
            b0 = np.median(border.astype(np.float32), axis=0)
        shift = (np.array(AVATAR_BG_FILL_RGB, dtype=np.float32) - b0)
        decont = rgb_u8.astype(np.float32) \
            + shift[None, None, :] * (1.0 - alpha_s[..., None])
        # 低 alpha 区硬替换为填充色（despill 公式假设纯色背景；对复杂
        # 背景的场景画/渐变底，α≈0 区域直接换底，过渡带平滑混合）
        fill = np.zeros_like(rgb_u8, dtype=np.float32)
        fill[..., 0] = AVATAR_BG_FILL_RGB[0]
        fill[..., 1] = AVATAR_BG_FILL_RGB[1]
        fill[..., 2] = AVATAR_BG_FILL_RGB[2]
        w_keep = np.clip((alpha_s - 0.02) / 0.23, 0.0, 1.0)[..., None]
        out = decont * w_keep + fill * (1.0 - w_keep)
        return np.clip(out, 0, 255).astype(np.uint8)
    except Exception as exc:  # noqa: BLE001
        _log(f"上传照片抠像失败，保留原图: {exc}")
        return rgb if rgb.dtype == np.uint8 else np.clip(rgb, 0, 255
                                                         ).astype(np.uint8)


def _compute_person_mask(rgb: np.ndarray) -> np.ndarray:
    """客户端合成蒙版（uint8 H×W，255=人物）：渲染中性帧的 MODNet alpha
    + 轻外扩羽化。头动位移多带住的像素是抠像后的中性色，与面板底
    融为一体不可见。失败回退全 255（不透明，同旧行为）。注册期调用
    一次，不占帧预算。
    """
    rgb_u8 = np.ascontiguousarray(
        np.clip(rgb, 0, 255).astype(np.uint8)) if rgb.dtype != np.uint8 \
        else np.ascontiguousarray(rgb)
    alpha = _matte_modnet_alpha(rgb_u8)
    if alpha is None:
        return np.full(rgb_u8.shape[:2], 255, dtype=np.uint8)
    m = (alpha * 255.0 + 0.5).astype(np.uint8)
    m = cv2.dilate(m, np.ones((9, 9), np.uint8))
    m = cv2.GaussianBlur(m, (13, 13), 0)
    return m


def _mask_png_bytes(mask: np.ndarray) -> bytes:
    """蒙版编码为 PNG：RGB=白、alpha=蒙版（客户端 dstIn 合成只看 alpha）。"""
    h, w = mask.shape[:2]
    rgba = np.dstack(
        [np.full((h, w), 255, dtype=np.uint8)] * 3 + [mask])
    ok, buf = cv2.imencode(".png", rgba, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError("mask png 编码失败")
    return buf.tobytes()


def _frame_energy(audio_16k: np.ndarray, total: int, apply_tail: bool = True) -> np.ndarray:
    """25fps 运动帧的音频能量（说话手势层输入）：逐帧 RMS → 快攻慢释包络
    → 按句内 90 分位归一化到 [0,1]。

    offline（整段音频已知）apply_tail=True 直接把句尾收零烧进数组；
    流式（音频陆续到达、句尾未知）传 False，由 emit 端在 finish 后补收零。
    """
    if total <= 0:
        return np.zeros(0, dtype=np.float32)
    win = SAMPLE_RATE // MOTION_FPS          # 640 采样 = 40ms
    audio = np.asarray(audio_16k, dtype=np.float32)
    need = total * win
    if len(audio) >= need:
        frames = audio[:need].reshape(total, win)
    else:
        pad = np.zeros(need - len(audio), dtype=np.float32)
        frames = np.concatenate([audio, pad]).reshape(total, win)
    rms = np.sqrt((frames * frames).mean(axis=1) + 1e-9)
    a_att = 1.0 - math.exp(-1.0 / (0.08 * MOTION_FPS))   # 快攻 ~80ms：跟上音节
    a_rel = 1.0 - math.exp(-1.0 / (0.25 * MOTION_FPS))   # 慢释 ~250ms：不抖
    env = np.empty(total, dtype=np.float32)
    prev = 0.0
    for i, v in enumerate(rms):
        prev += (float(v) - prev) * (a_att if v > prev else a_rel)
        env[i] = prev
    hot = env[env > 1e-4]
    ref = float(np.percentile(hot, 90)) if hot.size else 0.0
    if ref <= 0.0:
        return np.zeros(total, dtype=np.float32)
    e = np.clip(env / ref, 0.0, 1.0)
    if apply_tail:
        tail = int(GESTURE_TAIL_SEC * MOTION_FPS)
        if tail > 0 and total > tail:
            e[total - tail:] *= np.linspace(1.0, 0.0, tail, dtype=np.float32)
    return e


class DittoEngine:
    def __init__(
        self,
        avatar_path: str,
        max_dim: int = 1920,
        steps: int = 50,
        pose_alpha: float = 1.0,
        gesture_gain: float = 1.0,
        smooth_k: int = 1,
        emo=4,               # 中性为底；实际使用官方 cfg 的情绪序列
        use_graph: bool = True,
        jpeg_quality: int = 82,
        dec_size: int = 64,
    ):
        torch.backends.cudnn.benchmark = True

        t0 = time.time()
        (
            avatar_registrar_cfg,
            condition_handler_cfg,
            lmdm_cfg,
            stitch_network_cfg,
            warp_network_cfg,
            decoder_cfg,
            wav2feat_cfg,
            default_kwargs,
        ) = parse_cfg(CFG_PKL, DATA_ROOT)
        self.default_kwargs = default_kwargs

        self.registrar = AvatarRegistrar(**avatar_registrar_cfg)
        self.cond_handler = ConditionHandler(**condition_handler_cfg)
        self.a2m = Audio2Motion(lmdm_cfg)
        self.stitch = MotionStitch(stitch_network_cfg)
        self.warp = WarpNetwork(**warp_network_cfg)
        self.decoder = Decoder(**decoder_cfg)
        self.decoder.model.to(memory_format=torch.channels_last)
        self.wav2feat = Wav2Feat(**wav2feat_cfg)

        self.jpeg_quality = jpeg_quality
        self.dec_size = dec_size
        self.dtype = torch.float32
        self.decoder_dtype = torch.float16
        self.ch_info = default_kwargs.get("ch_info")
        # 头像相关参数留存：热切换时复用，避免重建整个 Engine
        self.max_dim = max_dim
        self.steps = steps
        self.pose_alpha = pose_alpha
        self.gesture_gain = float(gesture_gain)
        self.smooth_k = smooth_k
        # 说话/空闲共用的常量头姿基准（官方 delta_pitch=2），两边必须一致
        self.base_ctrl = {}
        self.emo = emo
        self.use_graph = use_graph
        self.a2m.lmdm = _GraphLMDM(self.a2m.lmdm, enabled=use_graph)
        self.avatar_path = None
        self.source_info = None
        self._graph = None
        self._st_xs = None
        self._st_xd = None
        self._st_out = None
        self.xs_t = None
        self._last_motion = None
        self._speech_continuation_pending = False
        self._last_motion_at = 0.0
        # 官方 cfg 里的 600 帧自然情绪序列游标：跨句连续推进，表情不会每句重来
        self._emo_cursor = 0

        # 空闲微动调度状态（全部按全局时间 t 推进）
        self._idle_last_t = None
        # 头姿两层随机游走：慢层负责整体姿势漂移，快层负责无意识的小调整
        self._pose_slow_now = [0.0, 0.0, 0.0]
        self._pose_slow_from = [0.0, 0.0, 0.0]
        self._pose_slow_to = [0.0, 0.0, 0.0]
        self._pose_slow_t0 = 0.0
        self._pose_slow_dur = 1.0
        self._pose_slow_next = 0.0
        self._pose_fast_now = [0.0, 0.0, 0.0]
        self._pose_fast_from = [0.0, 0.0, 0.0]
        self._pose_fast_to = [0.0, 0.0, 0.0]
        self._pose_fast_t0 = 0.0
        self._pose_fast_dur = 1.0
        self._pose_fast_next = 0.0
        # 呼吸：相位累积，周期和幅度缓慢漂移，避免固定节拍
        self._breath_phase = 0.0
        self._breath_period = 5.2
        self._breath_amp = 0.45
        self._breath_reseed = 0.0
        # 注视转移只驱动头部
        self._look_head_now = [0.0, 0.0, 0.0]
        self._look_head_from = [0.0, 0.0, 0.0]
        self._look_head_to = [0.0, 0.0, 0.0]
        self._look_head_t0 = 0.0
        self._look_head_dur = 0.6
        self._look_next = 0.0
        # 每个人偏好某一侧（约 65%），避免左右对称的机械感
        self._look_side_bias = random.choice((-1.0, 1.0))
        # 眼球扫视：眼睛先动、头后跟（真实注视转移的眼-头时序）
        self._sacc_now = [0.0, 0.0]      # 当前视线偏移（°等效 yaw/pitch）
        self._sacc_from = [0.0, 0.0]
        self._sacc_to = [0.0, 0.0]
        self._sacc_t0 = -1.0
        self._sacc_dur = 0.1
        self._sacc_next = 0.0
        self._force_blink_at = None      # 扫视后强排一次眨眼的时间点
        # 中性唇姿微漂移：微张/抿嘴（不含微笑方向，微笑由说话负责）
        self._lip_part_vec = None        # 唇部"张合方向"单位向量（来自 surprise 唇部差）
        self._lip_p = 0.0
        self._lip_p_from = 0.0
        self._lip_p_to = 0.0
        self._lip_p_t0 = 0.0
        self._lip_p_dur = 2.0
        self._lip_p_next = 0.0
        # 说话→空闲姿态接力：从上一句实际显示姿态出发衰减回中性
        self._idle_carry = None          # [yaw, pitch, roll]（°）
        self._idle_carry_t0 = 0.0
        # 静音 LMDM 生成的微表情库（IDLE_BANK_SEC=0 时不生成）
        self._idle_bank = None
        self._idle_bank_pose = None
        self._idle_bank_n = 0
        self._bank_from = 0.0
        self._bank_to = 0.0
        self._bank_t0 = 0.0
        self._bank_dur = 0.5
        self._bank_next = 0.0
        # 空闲表情基：由静音 LMDM 的不同情绪条件差出来，运行时随机混合
        self._expr_basis = None
        self._expr_w = {}
        self._expr_from = {}
        self._expr_to = {}
        self._expr_t0 = 0.0
        self._expr_dur = 1.0
        self._expr_next = 0.0

        # 倾听态：用户说话时由 WS 控制（set_listening），说话期间随空闲循环停摆
        self.listening = False
        # 倾听点头：0.5~0.8s 一次「下去-回来」的小幅 pitch，sin 半波保证首尾归零
        self._nod_now = 0.0
        self._nod_to = 0.0
        self._nod_t0 = 0.0
        self._nod_dur = 0.6
        self._nod_next = 0.0
        self._nod_half = 1              # 1=单点头，2=双点头（backchannel 多样性）
        # 倾听用户能量钩子（0~1；客户端暂未下发时为 None，节拍纯随机）
        self._listen_energy = None
        # 倾听侧倾：偶尔的小幅度 roll，缓慢收放
        self._tilt_now = 0.0
        self._tilt_from = 0.0
        self._tilt_to = 0.0
        self._tilt_t0 = 0.0
        self._tilt_dur = 1.2
        self._tilt_next = 0.0
        # 倾听表情：挑眉（关注）+ 淡笑为底，缓慢波动；结构与空闲表情层同构
        self._lis_expr_w = {}
        self._lis_expr_from = {}
        self._lis_expr_to = {}
        self._lis_expr_t0 = 0.0
        self._lis_expr_dur = 1.0
        self._lis_expr_next = 0.0

        # 官方眨眼序列定义在 25fps 运动轴上；渲染也必须按运动时间取样，
        # 不能按 render 调用次数推进，否则眨眼会被拉长甚至看不出来。
        self._eye_anchor_idx = 0
        self._eye_anchor_at = time.monotonic()
        self._eye_current_idx = 0
        self._speech_eye_anchor = 0

        # 人物 alpha 蒙版（背景透明化）：load_avatar 时分割一次，
        # /api/avatar/mask 下发给客户端做 dstIn 合成；mask_rev 供增量拉取。
        # 静态蒙版 + 轻外扩容差：源图背景已在内存抠像时替换为中性色，
        # 头动时蒙版带住的只是同色像素，与面板底融为一体。
        self.person_mask = None
        self.mask_png = None
        self.mask_rev = 0

        # 与官方输出平均差低于 0.01/255，用于守住实时帧率。
        # 先触发官方 SpectralNorm 前向钩子生成归一化权重，再静态折叠。
        with torch.no_grad(), torch.autocast(device_type="cuda", dtype=torch.float16):
            self.decoder.model(torch.zeros((1, 256, 64, 64), device=DEV))
        for module in self.decoder.model.modules():
            if hasattr(module, "weight_orig"):
                weight = module.weight.detach().clone()
                remove_spectral_norm(module)
                module.weight.data.copy_(weight)
        self.decoder.model.half()
        self.load_avatar(avatar_path)
        _log(f"引擎就绪 {time.time() - t0:.1f}s，头像 {self.avatar_size[0]}x{self.avatar_size[1]}")

    def load_avatar(self, avatar_path: str) -> dict:
        """加载 / 热切换头像：重新注册人脸并重建 CUDA Graph，模型权重复用。

        调用前需独占 GPU（主服务通过 GPU_LOCK 保证）。
        注册阶段全部先算到局部变量，成功后才切换内部状态，
        因此注册失败时旧头像仍可继续使用（由调用方决定是否回滚）。
        """
        t0 = time.time()
        # 先释放旧的图与中间张量，避免和本轮注册争显存
        self._graph = None
        self._st_xs = self._st_xd = self._st_out = None
        self.xs_t = None

        source_info = self.registrar(
            avatar_path, max_dim=self.max_dim, n_frames=-1,
            crop_scale=self.default_kwargs.get("crop_scale", 2.3),
            crop_vx_ratio=self.default_kwargs.get("crop_vx_ratio", 0),
            crop_vy_ratio=self.default_kwargs.get("crop_vy_ratio", -0.125),
            crop_flag_do_rot=self.default_kwargs.get("crop_flag_do_rot", True),
        )
        frame0 = source_info["img_rgb_lst"][0]
        h0, w0 = frame0.shape[:2]
        f_s = torch.from_numpy(source_info["f_s_lst"][0]).to(DEV).to(self.dtype)

        # ── 注册成功，开始切换 ──
        self.source_info = source_info
        self.avatar_path = avatar_path
        self.avatar_size = (w0, h0)
        self.f_s = f_s

        # 中性表情基底 + 头姿幅度
        self.cond_handler.setup(source_info, emo=self.emo, ch_info=self.ch_info)
        self._setup_a2m()
        # 官方只加一个常量 delta_pitch=2，没有额外的周期性头姿。
        # 注意：idle 每帧会显式传 delta_*，会覆盖 overall 里的同名项，
        # 所以这个基准量必须两边一致（见 render_idle 的 base_ctrl），
        # 否则一开口头会整体下俯 2°、收句又抬回去。
        _ctrl = self.default_kwargs.get("overall_ctrl_info") or {}
        self.base_ctrl = {
            "delta_pitch": float(_ctrl.get("delta_pitch", 2)),
            "delta_yaw": float(_ctrl.get("delta_yaw", 0)),
            "delta_roll": float(_ctrl.get("delta_roll", 0)),
        }
        self.stitch.setup(
            N_d=-1, use_d_keys=None, relative_d=True,
            # 单图输入沿用官方默认，并使用 cfg 自带的眨眼序列与随机睁眼间隔。
            drive_eye=None,
            delta_eye_arr=self.default_kwargs.get("delta_eye_arr"),
            delta_eye_open_n=self.default_kwargs.get("delta_eye_open_n", 0),
            # 官方 cfg 默认 fade_in/fade_out=None，因此不注入 fade_alpha。
            fade_out_keys=self.default_kwargs.get("fade_out_keys", ("exp",)),
            fade_type=self.default_kwargs.get("fade_type", ""),
            flag_stitching=self.default_kwargs.get("flag_stitching", True),
            is_image_flag=source_info["is_image_flag"],
            x_s_info=source_info["x_s_info_lst"][0], d0=None, ch_info=self.ch_info,
            overall_ctrl_info={
                **self.base_ctrl,
                "alpha_pitch": self.pose_alpha, "alpha_yaw": self.pose_alpha,
                "alpha_roll": self.pose_alpha,
            },
        )
        # 眨眼多样化：在官方波形表上扩展长眨眼并重排节奏表（说话/空闲共用）
        try:
            self._install_blink_tables()
        except Exception as exc:  # noqa: BLE001
            _log(f"眨眼多样化表安装失败，沿用官方节奏: {exc}")

        if self.use_graph:
            try:
                self._capture_graph()
            except Exception as exc:  # noqa: BLE001
                _log(f"CUDA Graph 不可用，回退逐帧: {exc}")

        # 静音跑一遍扩散，取其中的微表情作为空闲运动库；失败则退回纯程序化微动
        self._build_idle_bank()
        # 表情基：只用静音 + 不同情绪条件，提取眉眼颊方向的差向量
        self._build_expr_basis()

        # 人物分割蒙版（背景透明化）：渲染管线就绪后渲一帧中性帧做分割。
        # 关键：渲染输出是 decoder 的固定方形裁剪区（512×512），不是整张源图，
        # 所以蒙版必须对「渲染出的中性帧」分割——天然与所有帧同坐标系。
        # 失败时置 None → /api/avatar/mask 404 → 客户端保持不透明（同旧行为）。
        try:
            probe = self.render_frame(self._neutral_motion())
            self.person_mask = _compute_person_mask(probe)
            self.mask_png = _mask_png_bytes(self.person_mask)
            self.mask_rev += 1
            _log(f"人物蒙版已更新 rev={self.mask_rev} "
                 f"person%={100 * float((self.person_mask > 127).mean()):.1f}")
        except Exception as exc:  # noqa: BLE001
            self.person_mask = None
            self.mask_png = None
            _log(f"人物蒙版计算失败，背景保持不透明: {exc}")

        self._last_motion = None
        self.reset_stream(keep_pose=False)
        elapsed = time.time() - t0
        _log(f"头像已加载 {avatar_path} ({w0}x{h0}) {elapsed:.1f}s")
        return {"elapsed_s": round(elapsed, 2), "size": [w0, h0]}

    # ── 图捕获 ──
    def _install_blink_tables(self):
        """眨眼多样化：官方只有固定 15 帧（0.6s）眨眼 + 60-100 帧随机睁眼；
        扩展一张长眨眼波形（~26 帧，闭眼更久、幅度略柔）并重排节奏表，
        平均每 6-12 次眨眼掺一次长眨眼。说话/空闲共用同一套表。"""
        arr = np.asarray(self.stitch.delta_eye_arr, dtype=np.float32)   # (15, 63)
        n_long = 26
        # np.interp 产出 float64——必须 cast 回 float32，否则眨眼增量把
        # stitch 的关键点矩阵污染成 Double，官方 Float 权重直接报 dtype 错
        long_wave = np.stack(
            [np.interp(np.linspace(0, 14, n_long), np.arange(15), arr[:, d])
             for d in range(arr.shape[1])], axis=1).astype(np.float32) * np.float32(0.9)
        ext = np.concatenate([arr, long_wave], axis=0).astype(np.float32)
        normal = list(range(0, 15))
        long_run = list(range(15, 15 + n_long))
        n = 3000
        lst: list[int] = []
        long_every = random.randint(*IDLE_BLINK_LONG_EVERY)
        count = 0
        while len(lst) < n:
            lst.extend([0] * random.randint(60, 100))
            count += 1
            lst.extend(long_run if count % long_every == 0 else normal)
            if count % long_every == 0:
                long_every = random.randint(*IDLE_BLINK_LONG_EVERY)
        self.stitch.delta_eye_arr = ext
        self.stitch.delta_eye_idx_list = lst[:n]
        _log(f"眨眼多样化表就绪（长眨眼比例 1/{long_every}±，总帧 {n}）")

    def _setup_a2m(self):
        """按官方 cfg 初始化 LMDM 条件（fix_kp_cond / 输出裁剪 / 平滑）。

        之前 reset_stream(keep_pose=False) 里只传了 overlap_v2 等三个参数，
        Audio2Motion 会退回自己的默认 fix_kp_cond=0（不重置表情条件），
        于是每个窗口沿用上一窗口预测的表情，逐窗累积 → 说久了脸会"被拉"。
        而且没传 v_min_max_for_clip，LMDM 输出不做官方裁剪，异常值直接把脸拉变形。
        统一走这一份完整参数，避免任何一处漏传。
        """
        dk = self.default_kwargs
        self.a2m.setup(
            self.cond_handler.x_s_info_0,
            overlap_v2=dk.get("overlap_v2", 10),
            fix_kp_cond=dk.get("fix_kp_cond", 0),
            fix_kp_cond_dim=dk.get("fix_kp_cond_dim", None),
            sampling_timesteps=self.steps,
            online_mode=bool(dk.get("online_mode", False)),
            v_min_max_for_clip=dk.get("v_min_max_for_clip"),
            smo_k_d=dk.get("smo_k_d", 3),
        )

    def _warp_features(self, xs_t, xd_t):
        """与官方 WarpingNetwork.forward 等价。"""
        model = self.warp.model
        feature_3d = self.f_s.expand(xs_t.shape[0], -1, -1, -1, -1)
        dense_motion = model.dense_motion_network(feature_3d, xd_t, xs_t)
        deformation = dense_motion["deformation"]
        out = model.deform_input(feature_3d, deformation)
        bs, c, d, h, w = out.shape
        out = out.view(bs, c * d, h, w)
        out = model.third(out)
        out = model.fourth(out)
        if model.flag_use_occlusion_map and dense_motion.get("occlusion_map") is not None:
            out = out * dense_motion["occlusion_map"]
        return out

    @torch.no_grad()
    def _forward_gpu(self, xs_t, xd_t):
        # warp -> decoder 全尺寸直通（dec_size=64 时跳过插值）
        with torch.autocast(device_type="cuda", dtype=torch.float16):
            f_3d = self._warp_features(xs_t, xd_t)
        if self.dec_size != f_3d.shape[-1]:
            f_3d = F.interpolate(
                f_3d, size=(self.dec_size, self.dec_size),
                mode="bilinear", align_corners=False,
            )
        decoder_input = f_3d.to(self.decoder_dtype).contiguous(
            memory_format=torch.channels_last
        )
        render = self.decoder.model(decoder_input)
        return (render.clamp(0, 1) * 255.0).to(torch.uint8)

    def _capture_graph(self):
        neutral = self._neutral_motion()
        xs, xd = self.stitch(self.source_info["x_s_info_lst"][0], neutral)
        self.xs_t = torch.from_numpy(xs).to(DEV, dtype=self.dtype)
        probe_xd = torch.from_numpy(xd).to(DEV, dtype=self.dtype)

        self._st_xs = torch.zeros_like(self.xs_t)
        self._st_xd = torch.zeros_like(probe_xd)

        prev_bench = torch.backends.cudnn.benchmark
        torch.backends.cudnn.benchmark = True
        s = torch.cuda.Stream()
        s.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(s):
            for _ in range(5):
                self._forward_gpu(self._st_xs, self._st_xd)
        torch.cuda.current_stream().wait_stream(s)
        torch.cuda.synchronize()

        torch.backends.cudnn.benchmark = False
        self._graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(self._graph):
            self._st_out = self._forward_gpu(self._st_xs, self._st_xd)
        torch.backends.cudnn.benchmark = prev_bench
        _log("CUDA Graph 捕获完成")

    # LMDM(cvt_fmt) 输出的运动字段；_neutral_motion 必须用同一套 key，
    # 否则 stitch 里按 d0 做相对运算时会 KeyError（曾导致说完话后空闲帧全部抛异常、画面冻结）
    MOTION_KEYS = ("scale", "pitch", "yaw", "roll", "t", "exp", "kp")

    def _neutral_motion(self):
        import copy as _copy

        src = self.cond_handler.x_s_info_0
        xd = {k: _copy.deepcopy(src[k]) for k in self.MOTION_KEYS if k in src}
        for k in ("pitch", "yaw", "roll"):
            if k in xd:
                xd[k] = np.zeros_like(xd[k])
        return xd

    # ── 单帧渲染 ──
    @torch.no_grad()
    def render_frame(self, x_d_info, motion_idx: int | None = None, **ctrl_kwargs) -> np.ndarray:
        """渲染一帧。

        motion_idx: 该帧在 25fps 运动时间轴上的全局序号，用于同步官方眨眼序列。
        """
        # 说话手势层输入由产出端挂在私有键 "_ges"=(energy, motion_time) 上，
        # 必须在进 stitch 前弹出——stitch 的 _mix_s_d_info 会按 d0 对逐键做
        # 相对运算，私有键会 KeyError（同 MOTION_KEYS 的教训）。
        ges = x_d_info.pop("_ges", None)
        if self._speech_continuation_pending:
            neutral = self._neutral_motion()
            previous = self._last_motion
            d0 = {k: np.array(v, copy=True) for k, v in x_d_info.items()}
            if previous is not None:
                for k in ("exp", "pitch", "yaw", "roll", "t"):
                    if k in d0 and k in neutral and k in previous:
                        d0[k] = x_d_info[k] + neutral[k] - previous[k]
            self.stitch.d0 = d0
            self.stitch.fade_dst = None
            self._speech_continuation_pending = False

        # 说话运动增强：能量 → 同一倍数放大 LMDM 自身的运动（官方 ctrl 通路
        # 放大头姿；相对平移 t 与前伸 scale 按句首锚点 d0 同倍数放大）。
        if ges is not None and motion_idx is not None and self.gesture_gain > 0.0:
            e, tm = ges
            mult = self._gesture_mult(e)
            ctrl_kwargs = {**self._speech_gesture_ctrl(e, tm), **ctrl_kwargs}
            d0 = self.stitch.d0
            if d0 is not None:
                for key in ("t", "scale"):
                    if key in d0 and key in x_d_info:
                        t0 = d0[key]
                        x_d_info[key] = t0 + (x_d_info[key] - t0) * mult

        # 记下「这一帧实际显示的运动」：stitch 内部算的是 src + (pred - d0)，
        # 所以这里反推出「以中性为 d0 时应传入的 v」= pred - d0 + neutral。
        # 下一句首帧用这个量反算 d0，才能延续上一句实际显示的表情和位置。
        src = self.source_info["x_s_info_lst"][0]
        neutral = self._neutral_motion()
        d0 = self.stitch.d0
        last = {}
        for k in ("exp", "pitch", "yaw", "roll", "t"):
            if k not in x_d_info or k not in src:
                continue
            if d0 is not None and k in d0:
                last[k] = x_d_info[k] - d0[k] + neutral[k]
            else:
                # 本句第一帧：d0 会被 stitch 设成这一帧，显示结果等于源图
                last[k] = np.array(neutral[k], copy=True)
        self._last_motion = last
        self._last_motion_at = time.monotonic()

        if motion_idx is not None:
            self._eye_current_idx = self._speech_eye_anchor + int(motion_idx)
        else:
            self._eye_current_idx += 1
        return self._render_motion(x_d_info, ctrl_kwargs)

    def _idle_eye_idx(self) -> int:
        return self._eye_anchor_idx + int(
            max(0.0, time.monotonic() - self._eye_anchor_at) * MOTION_FPS
        )

    def _sync_eye_clock(self):
        eye_idx_list = getattr(self.stitch, "delta_eye_idx_list", None)
        if eye_idx_list is not None:
            self.stitch.idx = int(self._eye_current_idx) % len(eye_idx_list)

    def _render_motion(self, x_d_info, ctrl_kwargs: dict) -> np.ndarray:
        """stitch + warp/decoder，无副作用（不改 _last_motion / 状态）。"""
        self._sync_eye_clock()
        xs, xd = self.stitch(
            self.source_info["x_s_info_lst"][0], x_d_info, **ctrl_kwargs
        )
        return self._render_hi(xs, xd)

    def _gesture_mult(self, e: float) -> float:
        """音量 → 运动放大倍数（对 LMDM 自身头姿/平移/前伸均匀放大）。

        gesture_gain<=0 返回 0（调用方据此跳过整层）；否则上限封顶防大角度变形。
        """
        if self.gesture_gain <= 0.0:
            return 0.0
        return min(1.0 + GESTURE_ALPHA_GAIN * e, GESTURE_ALPHA_MAX) * self.gesture_gain

    def _speech_gesture_ctrl(self, e: float, tm: float) -> dict:
        """说话运动增强（走官方 ctrl_motion 通路）：只放大 LMDM 自身的头动。

        e ∈ [0,1] 是本帧音频能量。不再注入任何手搓轨迹——此前逐轴叠加
        的游走/弹簧波形与模型自身节奏打架（观感硬编码、晃动不自然），
        已整体移除；现在音量越大，模型自己的运动放大越多。
        """
        actl = max(1e-3, self.pose_alpha * self._gesture_mult(e))
        return {
            "delta_pitch": self.base_ctrl.get("delta_pitch", 2.0) / actl,
            "delta_yaw": 0.0,
            "delta_roll": 0.0,
            "alpha_pitch": actl,
            "alpha_yaw": actl,
            "alpha_roll": actl,
        }

    # ── 空闲微动调度 ──
    def _idle_ensure(self, t: float):
        """初始化/重置空闲调度状态。

        t 是全局连续时间（秒）。跨过一次说话或长时间没有客户端时，t 会跳变，
        这时重新起调度，避免把过期的一串动作一次性补出来。
        """
        last = self._idle_last_t
        if last is None or t < last or t - last > 1.0:
            self._pose_slow_now = [0.0, 0.0, 0.0]
            self._pose_slow_from = [0.0, 0.0, 0.0]
            self._pose_slow_to = [0.0, 0.0, 0.0]
            self._pose_slow_t0 = t
            self._pose_slow_dur = 3.0
            self._pose_slow_next = t + random.uniform(1.0, 4.0)
            self._pose_fast_now = [0.0, 0.0, 0.0]
            self._pose_fast_from = [0.0, 0.0, 0.0]
            self._pose_fast_to = [0.0, 0.0, 0.0]
            self._pose_fast_t0 = t
            self._pose_fast_dur = 1.5
            self._pose_fast_next = t + random.uniform(0.5, 2.0)
            self._breath_phase = 0.0    # 从 0 振幅起步：收句接手的第一帧不会突然多出半个呼吸幅度
            self._breath_period = random.uniform(4.8, 5.8)
            self._breath_amp = random.uniform(0.30, 0.50)
            self._breath_reseed = t + random.uniform(10.0, 20.0)
            self._look_head_now = [0.0, 0.0, 0.0]
            self._look_head_from = [0.0, 0.0, 0.0]
            self._look_head_to = [0.0, 0.0, 0.0]
            self._look_head_t0 = t
            self._look_head_dur = 0.6
            self._look_next = t + random.uniform(2.0, 5.0)
            self._expr_w = {k: 0.0 for k in (self._expr_basis or {})}
            self._expr_from = dict(self._expr_w)
            self._expr_to = dict(self._expr_w)
            self._expr_t0 = t
            self._expr_dur = 1.0
            self._expr_next = t + random.uniform(2.0, 5.0)
            # 倾听调度一并重置（_nod_next=0 会让下一次渲染重新抽节拍）
            self._nod_now = 0.0
            self._nod_next = 0.0
            self._nod_half = 1
            self._tilt_now = 0.0
            self._tilt_from = 0.0
            self._tilt_next = 0.0
            # 扫视与唇姿漂移一并重置（姿态接力 _idle_carry 不在这里清：
            # 它由 end_speech 设置、按自身时间常数衰减，跨过这个 reset）
            self._sacc_now = [0.0, 0.0]
            self._sacc_from = [0.0, 0.0]
            self._sacc_to = [0.0, 0.0]
            self._sacc_t0 = -1.0
            self._sacc_next = 0.0
            self._force_blink_at = None
            self._lip_p = 0.0
            self._lip_p_from = 0.0
            self._lip_p_to = 0.0
            self._lip_p_next = 0.0
            self._lis_expr_w = {k: 0.0 for k in (self._expr_basis or {})}
            self._lis_expr_from = dict(self._lis_expr_w)
            self._lis_expr_to = dict(self._lis_expr_w)
            self._lis_expr_t0 = t
            self._lis_expr_dur = 1.0
            self._lis_expr_next = 0.0
        else:
            # 呼吸周期缓慢漂移：给周期本身加一点随机，长时间听不出节拍
            dt = t - last
            self._breath_phase += 2.0 * math.pi * dt / self._breath_period
            if t >= self._breath_reseed:
                self._breath_period = random.uniform(4.6, 6.4)
                self._breath_amp = random.uniform(0.28, 0.52)
                self._breath_reseed = t + random.uniform(10.0, 22.0)
        self._idle_last_t = t

    def _idle_pose(self, t: float) -> dict:
        """双时间尺度的头姿随机游走，不靠固定正弦。

        慢层负责整体姿势漂移（几秒到十几秒换一次目标），快层负责无意识的
        小调整；两层叠加后没有可辨认的周期。呼吸用相位累积，周期本身也在
        缓慢变化，不会像节拍器一样每 5 秒点一次头。
        """
        if t >= self._pose_slow_next:
            self._pose_slow_from = list(self._pose_slow_now)
            self._pose_slow_to = [
                random.uniform(-1.8, 1.8),      # yaw：模型对 yaw 敏感，保持小幅度但不再贴死
                random.uniform(-1.4, 1.4),      # pitch
                random.uniform(-2.2, 2.2),      # roll：歪头承担主要的姿态变化
            ]
            self._pose_slow_t0 = t
            self._pose_slow_dur = random.uniform(2.0, 4.0)
            self._pose_slow_next = t + self._pose_slow_dur + random.uniform(1.2, 5.0)
        a = min(1.0, max(0.0, (t - self._pose_slow_t0) / self._pose_slow_dur))
        a = a * a * (3 - 2 * a)
        self._pose_slow_now = [f + (n - f) * a
                               for f, n in zip(self._pose_slow_from, self._pose_slow_to)]

        if t >= self._pose_fast_next:
            self._pose_fast_from = list(self._pose_fast_now)
            self._pose_fast_to = [
                random.uniform(-0.90, 0.90),
                random.uniform(-0.45, 0.45),
                random.uniform(-0.50, 0.50),
            ]
            self._pose_fast_t0 = t
            self._pose_fast_dur = random.uniform(1.0, 2.0)
            self._pose_fast_next = t + self._pose_fast_dur + random.uniform(0.5, 2.0)
        a = min(1.0, max(0.0, (t - self._pose_fast_t0) / self._pose_fast_dur))
        a = a * a * (3 - 2 * a)
        self._pose_fast_now = [f + (n - f) * a
                               for f, n in zip(self._pose_fast_from, self._pose_fast_to)]

        breath = self._breath_amp * math.sin(self._breath_phase)

        # 说话→空闲姿态接力：从上一句实际显示姿态出发指数衰减回中性，
        # 消除句界跳变（旧实现空闲层直接归零重抽，收势帧会把头"拽回"中性）。
        carry = [0.0, 0.0, 0.0]
        if self._idle_carry is not None:
            k = math.exp(-max(0.0, time.monotonic() - self._idle_carry_t0) / IDLE_CARRY_TAU)
            if k < 0.05:
                self._idle_carry = None
            else:
                carry = [c * k for c in self._idle_carry]

        # 眼球扫视：真实注视转移是眼睛 ~100ms 先跳到位、头随后跟上。
        # 大扫视（伴随 look 转移）与微扫视（闲时眼球乱动）共用一套状态，
        # 视线目标一直保持到下一次转移。
        if t >= self._sacc_next:
            micro = random.uniform(IDLE_SACC_MIN_DEG,
                                   IDLE_SACC_MIN_DEG * 1.8) * (0.6 if self.listening else 1.0)
            if random.random() < 0.5:
                to = [random.uniform(-micro, micro),
                      random.uniform(-micro * 0.6, micro * 0.6)]
            else:
                to = [0.0, 0.0]
            self._start_saccade(to, t, random.uniform(0.05, 0.10))
            self._sacc_next = t + random.uniform(1.2, 3.5)

        # 随机注视转移只体现在头部。
        # 刚说完话的几秒更倾向看回镜头，空闲越久越容易看向别处。
        # 倾听态不发生随机转移：听的人要看着对方，look 层滑回镜头方向并保持。
        if self.listening and t >= self._look_next:
            self._look_head_from = list(self._look_head_now)
            self._look_head_to = [0.0, 0.0, 0.0]
            self._look_head_t0 = t
            self._look_head_dur = 0.6
            self._look_next = t + self._look_head_dur + random.uniform(2.0, 4.0)
        elif t >= self._look_next:
            idle_secs = max(0.0, time.monotonic() - self._last_motion_at)
            p_camera = 0.30 + 0.35 * math.exp(-idle_secs / 6.0)
            self._look_head_from = list(self._look_head_now)
            if random.random() > p_camera:
                side = self._look_side_bias if random.random() < 0.65 else -self._look_side_bias
                to_y = side * random.uniform(1.0, 2.2)
                to_p = random.uniform(-1.2, 1.2)   # 俯仰对称：避免"总在低头看"的偏置
                roll = -side * random.uniform(2.0, 3.5)
                hold = random.uniform(1.2, 3.5)
                # 大扫视：眼睛先跳到注视方向（满幅），头延迟跟随（share 部分）
                self._start_saccade(
                    [max(-IDLE_SACC_MAX_DEG, min(IDLE_SACC_MAX_DEG, to_y * 6.0)),
                     max(-IDLE_SACC_MAX_DEG * 0.7,
                         min(IDLE_SACC_MAX_DEG * 0.7, to_p * 6.0))],
                    t, random.uniform(0.06, 0.12))
                self._force_blink_at = time.monotonic() + random.uniform(0.15, 0.30)
            else:
                to_y = to_p = 0.0
                roll = 0.0
                hold = random.uniform(0.8, 2.5)
                self._start_saccade([0.0, 0.0], t, random.uniform(0.06, 0.12))
                self._force_blink_at = time.monotonic() + random.uniform(0.15, 0.30)
            amp = max(abs(to_y), abs(to_p))
            share = random.uniform(0.45, 0.70)
            self._look_head_to = [to_y * share, to_p * share, roll]
            self._look_head_t0 = t + random.uniform(0.12, 0.28)   # 眼先动，头后跟
            self._look_head_dur = 0.45 + 0.05 * amp
            self._look_next = self._look_head_t0 + self._look_head_dur + hold

        if t < self._look_head_t0:
            self._look_head_now = list(self._look_head_from)
        else:
            u = min(1.0, (t - self._look_head_t0) / self._look_head_dur)
            a = u * u * (3 - 2 * u)
            self._look_head_now = [f + (n - f) * a
                                   for f, n in zip(self._look_head_from, self._look_head_to)]

        sy, sp, sr = self._pose_slow_now
        fy, fp, fr = self._pose_fast_now
        return {
            "delta_yaw": sy + fy + self._look_head_now[0] + carry[0],
            "delta_pitch": sp + fp + breath + self._look_head_now[1] + carry[1],
            "delta_roll": sr + fr + self._look_head_now[2] + carry[2],
        }

    def _start_saccade(self, to_deg, t: float, dur: float):
        """发起一次眼球扫视（°等效视线偏移），眼睛先于头部移动。"""
        self._sacc_from = list(self._sacc_now)
        self._sacc_to = [max(-20.0, min(20.0, to_deg[0])),
                         max(-14.0, min(14.0, to_deg[1]))]
        self._sacc_t0 = t
        self._sacc_dur = max(0.05, dur)

    def _saccade_exp(self) -> np.ndarray | None:
        """当前视线偏移 → exp 眼区增量（kp11/15 的 x/y，同官方 _fix_gaze 系数）。"""
        dy, dp = self._sacc_now
        if abs(dy) < 0.05 and abs(dp) < 0.05:
            return None
        v = np.zeros((21, 3), dtype=np.float32)
        dx = dy * 0.26
        dyp = dp * 0.28
        v[11][0] += dx * 0.0007 * IDLE_SACC_GAIN
        v[15][0] += dx * 0.001 * IDLE_SACC_GAIN
        v[11][1] += dyp * -0.001 * IDLE_SACC_GAIN
        v[15][1] += dyp * -0.001 * IDLE_SACC_GAIN
        return v.reshape(1, 63)

    def _advance_saccade(self, t: float):
        u = min(1.0, max(0.0, (t - self._sacc_t0) / max(self._sacc_dur, 1e-3))) \
            if self._sacc_t0 >= 0 else 1.0
        a = u * u * (3 - 2 * u)
        self._sacc_now = [f + (n - f) * a
                          for f, n in zip(self._sacc_from, self._sacc_to)]

    def _lip_posture(self, t: float) -> np.ndarray | None:
        """中性唇姿微漂移：微张/抿嘴的慢随机游走（不产生微笑方向）。"""
        vec = self._lip_part_vec
        if vec is None:
            return None
        if t >= self._lip_p_next:
            self._lip_p_from = self._lip_p
            if random.random() < 0.5:
                self._lip_p_to = random.uniform(0.0, 1.0)      # 微张
            else:
                self._lip_p_to = random.uniform(-0.6, 0.0)     # 轻抿
            self._lip_p_t0 = t
            self._lip_p_dur = random.uniform(1.0, 2.5)
            self._lip_p_next = t + self._lip_p_dur + random.uniform(1.5, 5.0)
        u = min(1.0, max(0.0, (t - self._lip_p_t0) / max(self._lip_p_dur, 1e-3)))
        a = u * u * (3 - 2 * u)
        self._lip_p = self._lip_p_from + (self._lip_p_to - self._lip_p_from) * a
        return vec.reshape(1, 63) * (self._lip_p * IDLE_LIP_POSTURE_MAX)

    def _jump_to_next_blink(self):
        """把眨眼时钟跳到下一次眨眼起点前 ~120ms（扫视后常伴随眨眼）。"""
        lst = getattr(self.stitch, "delta_eye_idx_list", None)
        if not lst:
            return
        cur = int(self._eye_current_idx)
        for i in range(cur + 2, min(cur + 200, len(lst))):
            if lst[i] > 0 and lst[i - 1] == 0:
                self._eye_anchor_idx = max(0, i - 2)
                self._eye_anchor_at = time.monotonic()
                self._eye_current_idx = self._eye_anchor_idx
                return

    def _build_expr_basis(self):
        """用静音 + 不同情绪条件各跑一窗 LMDM，提取「表情方向」向量。

        取情绪窗口相对中性窗口的 exp 差异，只保留眉眼颊等区域（嘴部分量
        清零，嘴部动态由中性唇姿漂移承担），再夹紧幅度。空闲时按随机权重
        混合这些方向，表情是连续变化的，不是一段固定视频循环。
        """
        self._expr_basis = None
        if not getattr(self.cond_handler, "use_emo", False):
            return
        t0 = time.monotonic()
        dk = self.default_kwargs
        try:
            silence = np.zeros(int(80 / MOTION_FPS * SAMPLE_RATE), dtype=np.float32)
            feat = self.wav2feat.wav2feat(silence)
            if len(feat) < 80:
                return
            feat = feat[:80]

            means = {}
            for name, emo in list(IDLE_EXPR_EMOS) + [("neutral", IDLE_EXPR_BASE_EMO)]:
                # 每段都从源姿态重新起，避免上一段的表情/姿态残留
                self.a2m.setup(
                    self.cond_handler.x_s_info_0,
                    overlap_v2=dk.get("overlap_v2", 10),
                    fix_kp_cond=dk.get("fix_kp_cond", 0),
                    fix_kp_cond_dim=dk.get("fix_kp_cond_dim", None),
                    sampling_timesteps=min(int(self.steps), 6),
                    online_mode=False,
                    v_min_max_for_clip=dk.get("v_min_max_for_clip"),
                    smo_k_d=dk.get("smo_k_d", 3),
                )
                cond = self.cond_handler(feat, 0, emo=emo)[None]
                res = self.a2m(cond, None)
                xds = self.a2m.cvt_fmt(res)
                means[name] = np.mean(
                    [np.asarray(x["exp"], dtype=np.float32).reshape(-1) for x in xds[20:70]], 0
                )

            base = means.pop("neutral")
            # 情绪表情只管眉眼颊：嘴部分量清零——happy 基的微笑分量慢速淡入
            # 曾被感知为"眨眼时嘴角上扬"（实测眨眼波形对唇 kp 位移仅 ~0.0003，
            # 与眨眼无关）；嘴部动态由 _lip_posture 的中性漂移承担。
            mask = np.ones(63, dtype=np.float32)
            mask[[k * 3 + i for k in IDLE_LIP_KP for i in range(3)]] = IDLE_LIP_MASK_RATIO
            lip_only = np.zeros(63, dtype=np.float32)
            lip_only[[k * 3 + i for k in IDLE_LIP_KP for i in range(3)]] = 1.0
            # 唇部"张合方向"取 surprise（张嘴）的唇部分量并单位化，供中性唇姿漂移
            self._lip_part_vec = None
            if "surprise" in means:
                part = (means["surprise"] - base) * lip_only
                peak = float(np.abs(part).max())
                if peak > 1e-5:
                    self._lip_part_vec = (part / peak).astype(np.float32)
            basis = {}
            for name, exp in means.items():
                v = np.clip(exp - base, -0.02, 0.02) * mask
                if float(np.abs(v).max()) > 1e-4:
                    basis[name] = v.astype(np.float32)
            self._expr_basis = basis or None
            _log(f"空闲表情基 {list(basis)} {time.monotonic() - t0:.1f}s")
        except Exception as exc:  # noqa: BLE001
            _log(f"空闲表情基生成失败，空闲不叠加表情: {exc}")
            self._expr_basis = None
        finally:
            self._setup_a2m()

    def _idle_expr(self, t: float):
        """随机混合表情基，返回 exp 增量。

        每 2.5~8.7s 随机换一个目标（70% 带表情、30% 回中性），过渡 0.9~2.2s。
        目标、时长、权重每次都重新抽，不会形成固定序列。
        """
        basis = self._expr_basis
        if not basis:
            return None
        if self._expr_next <= 0.0:
            self._expr_w = {k: 0.0 for k in basis}
            self._expr_from = dict(self._expr_w)
            self._expr_to = dict(self._expr_w)
            self._expr_t0 = t
            self._expr_dur = 1.0
            self._expr_next = t + random.uniform(2.0, 5.0)

        if t >= self._expr_next:
            self._expr_from = dict(self._expr_w)
            to = {k: 0.0 for k in basis}
            if random.random() > 0.20:          # 80% 的时候带一点表情
                names = list(basis)
                if len(names) >= 2 and random.random() < 0.20:
                    picks = random.sample(names, 2)
                else:
                    picks = [random.choice(names)]
                for name in picks:
                    to[name] = random.uniform(0.45, 1.0)
            self._expr_to = to
            self._expr_t0 = t
            self._expr_dur = random.uniform(0.6, 1.4)
            self._expr_next = t + self._expr_dur + random.uniform(1.2, 4.2)

        a = min(1.0, max(0.0, (t - self._expr_t0) / self._expr_dur))
        a = a * a * (3 - 2 * a)
        self._expr_w = {
            k: self._expr_from.get(k, 0.0) * (1 - a) + self._expr_to.get(k, 0.0) * a
            for k in basis
        }
        delta = np.zeros(63, dtype=np.float32)
        for name, w in self._expr_w.items():
            if w > 0.0:
                delta += basis[name] * w
        peak = float(np.abs(delta).max())
        if peak > IDLE_EXPR_MAX_DELTA:
            delta *= IDLE_EXPR_MAX_DELTA / peak
        return delta[None]

    def _listening_pose(self, t: float) -> dict:
        """倾听态头姿：复用空闲的双尺度游走与呼吸（切换连续），叠随机小幅点头/侧倾。

        注视转移已在 _idle_pose 的 listening 分支里被抑制（看向镜头并保持），
        这里只补「在听」的动作信号。幅度刻意保守——单图 2D warp 大角度会变形。
        """
        pose = self._idle_pose(t)

        if self._nod_next <= 0.0 or t >= self._nod_next:
            # 节拍概率可由用户侧语音能量调制（set_listening_energy；未下发时
            # 纯随机）——"你说到重点我才点头"。20~35% 空节拍避免规律感。
            lvl = self._listen_energy
            p_nod = 0.80 if lvl is None else min(0.95, 0.35 + 0.6 * lvl)
            if random.random() < p_nod:
                self._nod_to = random.uniform(1.2, 2.4)
                self._nod_half = 2 if random.random() < 0.25 else 1   # 偶发双点头
            else:
                self._nod_to = 0.0
                self._nod_half = 1
            self._nod_t0 = t
            self._nod_dur = random.uniform(0.5, 0.8) * (1.6 if self._nod_half == 2 else 1.0)
            self._nod_next = t + self._nod_dur + random.uniform(1.8, 5.0)
        u = min(1.0, max(0.0, (t - self._nod_t0) / self._nod_dur))
        # 单点头 = sin 半波（下去再回来，首尾归零）；双点头 = 两个半波连发
        self._nod_now = self._nod_to * abs(math.sin(u * math.pi * self._nod_half))

        if self._tilt_next <= 0.0 or t >= self._tilt_next:
            side = self._look_side_bias if random.random() < 0.65 else -self._look_side_bias
            self._tilt_from = self._tilt_now
            self._tilt_to = side * random.uniform(1.0, 2.0) if random.random() < 0.45 else 0.0
            self._tilt_t0 = t
            self._tilt_dur = random.uniform(0.8, 1.6)
            self._tilt_next = t + self._tilt_dur + random.uniform(3.0, 8.0)
        u = min(1.0, max(0.0, (t - self._tilt_t0) / self._tilt_dur))
        a = u * u * (3 - 2 * u)
        self._tilt_now = self._tilt_from + (self._tilt_to - self._tilt_from) * a

        pose["delta_pitch"] = pose.get("delta_pitch", 0.0) + self._nod_now
        pose["delta_roll"] = pose.get("delta_roll", 0.0) + self._tilt_now
        return pose

    def _listening_expr(self, t: float):
        """倾听态表情：轻微挑眉（关注）为底，偶尔叠淡笑，缓慢波动。

        与空闲表情共用 _expr_basis 与 IDLE_EXPR_MAX_DELTA 上限；目标分布偏向
        attention（surprise/happy），不会像空闲那样完全回中性。
        """
        basis = self._expr_basis
        if not basis:
            return None
        if self._lis_expr_next <= 0.0 or t >= self._lis_expr_next:
            self._lis_expr_from = dict(self._lis_expr_w) if self._lis_expr_w \
                else {k: 0.0 for k in basis}
            to = {k: 0.0 for k in basis}
            if "surprise" in basis and random.random() < 0.85:
                to["surprise"] = random.uniform(0.25, 0.55)
            if "happy" in basis and random.random() < 0.6:
                to["happy"] = random.uniform(0.20, 0.45)
            self._lis_expr_to = to
            self._lis_expr_t0 = t
            self._lis_expr_dur = random.uniform(1.2, 2.4)
            self._lis_expr_next = t + self._lis_expr_dur + random.uniform(2.0, 5.0)
        a = min(1.0, max(0.0, (t - self._lis_expr_t0) / self._lis_expr_dur))
        a = a * a * (3 - 2 * a)
        self._lis_expr_w = {
            k: self._lis_expr_from.get(k, 0.0) * (1 - a) + self._lis_expr_to.get(k, 0.0) * a
            for k in basis
        }
        delta = np.zeros(63, dtype=np.float32)
        for name, w in self._lis_expr_w.items():
            if w > 0.0:
                delta += basis[name] * w
        peak = float(np.abs(delta).max())
        if peak > IDLE_EXPR_MAX_DELTA:
            delta *= IDLE_EXPR_MAX_DELTA / peak
        return delta[None]

    def set_listening(self, active: bool) -> None:
        """切换倾听态。非 GPU 操作，可随时调用。

        说话期间空闲循环停摆，倾听状态自然挂起；speak_end 后若仍是 listening
        则回到注视镜头的倾听微动。切换时重置点头/侧倾/表情节拍，
        下一次渲染按新状态重新抽目标。
        """
        active = bool(active)
        if self.listening == active:
            return
        self.listening = active
        self._nod_next = 0.0
        self._tilt_next = 0.0
        self._lis_expr_next = 0.0

    def _build_idle_bank(self):
        """用静音跑一遍官方 LMDM，把其中的微表情收进空闲运动库。

        只取非嘴部的表情增量（眉眼颊的细微信号），嘴部保留 35%。
        取样时按随机片段交叉淡化（见 _idle_bank_frame），不做固定循环。
        """
        self._idle_bank = None
        self._idle_bank_pose = None
        self._idle_bank_n = 0
        if IDLE_BANK_SEC <= 0:
            return
        t0 = time.monotonic()
        try:
            silence = np.zeros(int(IDLE_BANK_SEC * SAMPLE_RATE), dtype=np.float32)
            # 运动库只是取静音时的微表情，用低步数就够；否则冷启动要多花 20 多秒
            _saved_steps = self.a2m.sampling_timesteps
            self.a2m.sampling_timesteps = min(int(_saved_steps), 6)
            try:
                motions = [xd for _, xd in self.audio_to_motions(silence, fps=MOTION_FPS)]
            finally:
                self.a2m.sampling_timesteps = _saved_steps
            if len(motions) < 8:
                raise RuntimeError(f"静音运动帧过少: {len(motions)}")

            exp0 = np.asarray(motions[0]["exp"], dtype=np.float32).reshape(-1)
            exps = np.stack(
                [np.asarray(m["exp"], dtype=np.float32).reshape(-1) - exp0 for m in motions], 0
            )
            pose = np.stack(
                [self._pose_degrees(motions, k) for k in ("yaw", "pitch", "roll")], 1
            )
            pose = pose - pose[0]

            mask = np.ones(63, dtype=np.float32)
            mask[[k * 3 + i for k in IDLE_LIP_KP for i in range(3)]] = 0.35
            self._idle_bank = (exps * mask[None, :]).astype(np.float32)
            self._idle_bank_pose = pose.astype(np.float32)
            self._idle_bank_n = len(motions)
            self._bank_from = 0.0
            self._bank_to = 0.0
            self._bank_next = 0.0
            _log(f"空闲运动库 {len(motions)} 帧（随机片段取样）"
                 f" {time.monotonic() - t0:.1f}s")
        except Exception as exc:  # noqa: BLE001
            _log(f"空闲运动库生成失败，退回纯程序化微动: {exc}")
            self._idle_bank = None
            self._idle_bank_pose = None
            self._idle_bank_n = 0
        finally:
            # 生成过程推进了 LMDM 的 kp_cond/clip_idx，必须复位，否则影响下一句语音
            self.reset_stream(keep_pose=False)

    @staticmethod
    def _pose_degrees(motions, key: str) -> np.ndarray:
        arr = np.concatenate(
            [np.asarray(m[key], dtype=np.float32).reshape(1, -1) for m in motions], 0
        )
        return bin66_to_degree(arr).reshape(-1)

    def _bank_sample(self, pos: float):
        """在微表情库的连续位置上插值取样。"""
        n = self._idle_bank_n
        pos = pos % n
        i0 = int(pos) % n
        i1 = (i0 + 1) % n
        w = pos - int(pos)
        exp = self._idle_bank[i0] * (1 - w) + self._idle_bank[i1] * w
        pose = self._idle_bank_pose[i0] * (1 - w) + self._idle_bank_pose[i1] * w
        return pose, exp

    def _idle_bank_frame(self, t: float):
        """从微表情库里随机取片段，返回 (pose_delta, exp_delta)。

        以前是「按时间戳取模、固定 12s 循环一遍」，时间一长就能看出重复。
        现在每隔 2.5~5.5s 随机跳到另一段，跳转用 0.35~0.7s 交叉淡化，
        两段都继续按 25fps 前进，没有倒带或跳帧的痕迹。
        """
        if self._idle_bank_n < 8:
            return None, None

        if self._bank_next <= 0.0:
            self._bank_t0 = t
            self._bank_next = t + random.uniform(2.5, 5.5)
        if t >= self._bank_next:
            # 旧段在跳转时刻的相位，作为交叉淡化的起点
            self._bank_from = self._bank_to + (t - self._bank_t0) * MOTION_FPS
            self._bank_to = float(random.randrange(self._idle_bank_n))
            self._bank_t0 = t
            self._bank_dur = random.uniform(0.35, 0.7)
            self._bank_next = t + random.uniform(2.5, 5.5)

        dt = t - self._bank_t0
        pos_new = self._bank_to + dt * MOTION_FPS
        pose_new, exp_new = self._bank_sample(pos_new)
        if dt < self._bank_dur:
            pos_old = self._bank_from + dt * MOTION_FPS
            pose_old, exp_old = self._bank_sample(pos_old)
            a = dt / self._bank_dur
            a = a * a * (3 - 2 * a)
            return (pose_old * (1 - a) + pose_new * a,
                    exp_old * (1 - a) + exp_new * a)
        return pose_new, exp_new

    def render_idle(self, t: float) -> np.ndarray:
        """空闲态自然微动：双尺度头姿 + 模型原生表情，与说话共用渲染管线。

        listening 时切到倾听微动（注视镜头 + 点头/侧倾 + 关注表情），
        底层的双尺度游走与呼吸共用，切换不跳变。
        """
        self._idle_ensure(t)

        pose = self._listening_pose(t) if self.listening else self._idle_pose(t)
        # 补齐与说话相同的常量头姿。stitch 里显式 kwargs 会覆盖 overall_ctrl_info，
        # 不补的话空闲是 0°、说话是 +2°，一切换整张脸就会上下错开。
        for _k, _v in self.base_ctrl.items():
            pose[_k] = pose.get(_k, 0.0) + _v

        # delta_exp 三层叠加：情绪基（眉眼颊，不动嘴）+ 中性唇姿漂移 + 眼球扫视
        delta_exp = np.zeros((1, 63), dtype=np.float32)
        expr = self._listening_expr(t) if self.listening else self._idle_expr(t)
        if expr is not None:
            delta_exp = delta_exp + expr
        extra = self._lip_posture(t)
        if extra is not None:
            delta_exp = delta_exp + extra
        self._advance_saccade(t)
        sacc = self._saccade_exp()
        if sacc is not None:
            delta_exp = delta_exp + sacc

        # 扫视后强排眨眼：把眨眼时钟跳到下一次眨眼起点前 ~120ms
        if self._force_blink_at is not None and time.monotonic() >= self._force_blink_at:
            self._force_blink_at = None
            self._jump_to_next_blink()

        # 空闲帧的相对基准必须是「中性运动」：d0 若还留着上一句首帧，
        # 整段空闲都会带着一个常量偏移（脸一直歪着/僵着），直到下一句才被覆盖。
        if self.stitch.d0 is None:
            self.stitch.d0 = self._neutral_motion()

        neutral = self._neutral_motion()
        # 呼吸进 scale：胸廓/整体轻微起伏（与说话端"前伸后缩"同通道）
        neutral["scale"] = neutral["scale"] + IDLE_BREATH_SCALE * math.sin(self._breath_phase)

        x_s_info = self.source_info["x_s_info_lst"][0]
        self._eye_current_idx = self._idle_eye_idx()
        self._sync_eye_clock()
        xs, xd = self.stitch(x_s_info, neutral,
                             delta_exp=delta_exp, **pose)
        return self._render_hi(xs, xd)

    def _render_hi(self, xs, xd) -> np.ndarray:
        """模型输出直通（CUDA Graph），不合成任何原图像素。"""
        xs_t = torch.from_numpy(xs).to(DEV, dtype=self.dtype)
        xd_t = torch.from_numpy(xd).to(DEV, dtype=self.dtype)
        with torch.no_grad():
            if self._graph is not None:
                self._st_xs.copy_(xs_t)
                self._st_xd.copy_(xd_t)
                self._graph.replay()
                out = self._st_out
            else:
                out = self._forward_gpu(xs_t, xd_t)
        return out.permute(0, 2, 3, 1)[0].cpu().numpy()

    def encode_jpeg(self, frame_rgb: np.ndarray) -> bytes:
        ok, buf = cv2.imencode(
            ".jpg", cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR),
            [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality],
        )
        if not ok:
            raise RuntimeError("JPEG 编码失败")
        return buf.tobytes()

    def end_speech(self):
        """一句说完：解除本句的表情锚点，空闲帧从中性重新起算。"""
        self._eye_anchor_idx = self._eye_current_idx
        self._eye_anchor_at = time.monotonic()
        self.stitch.d0 = None
        self.stitch.fade_dst = None
        self._speech_continuation_pending = False
        # 姿态接力：把本句实际显示的头姿（bin66→度 + base 偏移）作为空闲层
        # 的出发点，空闲/收势帧按 IDLE_CARRY_TAU 指数衰减回中性——消除句界
        # "头被一帧拽回中性"的跳变。能量在句尾已收零，alpha≈pose_alpha，
        # 这里按 (bin66度 + base) 近似即可。
        self._idle_carry = None
        last = self._last_motion
        if last:
            try:
                self._idle_carry = [
                    float(bin66_to_degree(
                        np.asarray(last[k], dtype=np.float32).reshape(1, -1)
                    ).reshape(-1)[0]) + float(self.base_ctrl.get(f"delta_{k}", 0.0))
                    for k in ("yaw", "pitch", "roll")
                ]
                self._idle_carry_t0 = time.monotonic()
            except Exception:  # noqa: BLE001
                self._idle_carry = None

    def set_listening_energy(self, level) -> None:
        """接收用户侧语音能量（0~1），调制倾听点头节拍。

        客户端暂未下发（当前只有 listening 布尔），下发后点头概率/幅度
        会跟随"用户说到重点"——无需改引擎结构。
        """
        if level is None:
            self._listen_energy = None
        else:
            self._listen_energy = max(0.0, min(1.0, float(level)))

    def continue_speech(self):
        """下一句首帧到达时，按上一句实际显示帧反算相对锚点。"""
        self._speech_continuation_pending = True
        self.stitch.fade_dst = None

    def reset_stream(self, keep_pose: bool = True):
        """新一句开始前的复位。

        keep_pose=True：保留 LMDM 的 kp_cond（上一句末尾的姿态条件），让多轮对话的运动更连续。
        但 stitch 的 d0 / fade_dst 必须**每句重置**：它们定义的是「相对本句首帧的偏移」，
        沿用上一句会给整句的 exp / pitch / yaw / roll 加一个常量偏移，
        表现为脸一直被拉着、口型固定在某个形状（官方 online 管线同样在每段开头重设 d0）。
        换头像等需要彻底复位时传 keep_pose=False。
        """
        if not keep_pose:
            self._setup_a2m()
        self._speech_eye_anchor = self._idle_eye_idx()
        self._eye_current_idx = self._speech_eye_anchor
        self.stitch.d0 = None
        self.stitch.fade_dst = None
        self._speech_continuation_pending = False

    # ── 音频 → 运动帧（流式）──
    def audio_to_motions(self, audio_16k: np.ndarray, fps: int = 25):
        """按官方 offline 对齐方式输出 25fps 运动帧。

        特征从音频第 0 帧开始，窗口步长 = valid_clip_len；每个窗口算完即吐出
        已定稿帧，既保持口型对齐，也让首帧无需等待整句运动全部生成。
        """
        seq = self.a2m.seq_frames
        valid = self.a2m.valid_clip_len
        overlap = self.a2m.overlap_v2

        total = int(np.ceil(len(audio_16k) / SAMPLE_RATE * fps))
        if total <= 0:
            return
        # 说话手势层输入：整段音频已知，句尾收零直接烧进能量数组
        ges_energy = _frame_energy(audio_16k, total)
        t_feat = time.monotonic()
        feat = self.wav2feat.wav2feat(audio_16k.astype(np.float32))
        feat_ms = (time.monotonic() - t_feat) * 1000
        if len(feat) < total:
            feat = np.concatenate([feat, np.stack([feat[-1]] * (total - len(feat)), 0)], 0)
        else:
            feat = feat[:total]

        emo_base = self.default_kwargs.get("emo")
        if (isinstance(emo_base, np.ndarray) and emo_base.ndim == 2
                and emo_base.shape[1] == 8 and len(emo_base) > 0):
            n_emo = len(emo_base)
            pos = self._emo_cursor % n_emo
            emo_seq = emo_base[(np.arange(total) + pos) % n_emo].astype(np.float32)
            self._emo_cursor = (pos + total) % n_emo
        else:
            emo_seq = np.zeros((total, 8), dtype=np.float32)
            emo_seq[:, 4] = 1.0
        cond_all = self.cond_handler(feat, 0, emo=emo_seq)

        res = None
        idx = 0
        emitted = 0
        n_windows = 0
        t_lmdm = 0.0

        while idx < total:
            aud = cond_all[idx:idx + seq]
            if len(aud) < seq:
                aud = np.concatenate([aud, np.stack([aud[-1]] * (seq - len(aud)), 0)], 0)

            t_w = time.monotonic()
            res = self.a2m(aud[None], res)
            t_lmdm += time.monotonic() - t_w
            n_windows += 1
            idx += valid

            final_end = (seq - overlap) if n_windows == 1 else (res.shape[1] - valid)
            final_end = min(final_end, total)
            if final_end > emitted:
                for x_d_info in self.a2m.cvt_fmt(res[:, emitted:final_end]):
                    x_d_info["_ges"] = (float(ges_energy[emitted]), emitted / fps)
                    yield emitted, x_d_info
                    emitted += 1

        if emitted < total:
            for x_d_info in self.a2m.cvt_fmt(res[:, emitted:total]):
                x_d_info["_ges"] = (float(ges_energy[emitted]), emitted / fps)
                yield emitted, x_d_info
                emitted += 1

        _log(f"特征 {feat_ms:.0f}ms | LMDM {n_windows} 窗 {t_lmdm * 1000:.0f}ms "
             f"({total} 帧)")

    # ── 流式运动 ──
    def open_motion_stream(self) -> "MotionStream":
        """开一条回复的增量运动流：append 音频 → pop 已定稿运动帧。

        与 audio_to_motions 同一套官方窗口对齐（seq=80/stride=70），但音频
        可以随 TTS 流陆续到达，每凑够一个窗口就产出一批定稿帧，不用等整段。
        实现在模块级的 MotionStream（见文件末尾）。
        """
        return MotionStream(self)

    # ── 预热 ──
    def warmup(self):
        # 1) HuBERT 特征提取：首次调用要初始化 ONNX 会话并预热 GPU，不预热会多花 2-3 秒
        self.wav2feat.wav2feat(np.zeros(SAMPLE_RATE, dtype=np.float32))
        # 2) 渲染链
        self.render_frame(self._neutral_motion())
        # 3) 空闲路径
        self.render_idle(0.0)
        # 4) LMDM 扩散（走一次完整窗口）
        dummy_feat = np.zeros((self.a2m.seq_frames, 1024), dtype=np.float32)
        cond = self.cond_handler(dummy_feat, 0)[None]
        self.a2m(cond, None)
        torch.cuda.synchronize()
        self.reset_stream()
        _log("预热完成")


class MotionStream:
    """一条回复的增量运动生成会话（LMDM 状态跨窗口续算）。

    复用 audio_to_motions 的官方窗口对齐（seq=80 / stride=valid=70）：
    第 k 个窗口消费 cond[70k : 70k+80]，产出定稿帧至 min(70k+70, total)。
    与 offline 的差别只在音频可以随 TTS 流陆续到达，每凑够一个窗口的
    条件帧就产出一批定稿帧，不用等整段合成完。

    特征按「当前累计音频」整段重算：HuBERT 是双向上下文，新到的音频会微调
    早先帧的特征，但已 emit 的运动帧不会重算，只影响未定稿的尾部——与
    offline 路径的口型对齐口径一致（特征都从音频第 0 帧起算）。
    """

    def __init__(self, engine: "DittoEngine"):
        self._eng = engine
        self._audio = np.zeros(0, dtype=np.float32)
        self._res = None
        self._n_windows = 0
        self._emitted = 0
        self._finished = False
        self._closed = False
        self._emo_pos = engine._emo_cursor

    def append(self, pcm_16k: np.ndarray) -> None:
        """追加 16kHz int16 音频块。"""
        self._audio = np.concatenate(
            [self._audio, pcm_16k.astype(np.float32) / 32768.0])

    def finish(self) -> None:
        """音频流结束：允许 pad 尾窗，把剩余帧全部产出（与 offline 末窗一致）。"""
        self._finished = True

    def _total_frames(self) -> int:
        return int(np.ceil(len(self._audio) / SAMPLE_RATE * MOTION_FPS))

    def _attach_ges(self, x_d_info, energy, total: int, tail_frames: int) -> None:
        """挂说话手势层输入 (energy, motion_time)；音频结束后句尾收零。"""
        k = self._emitted
        if energy is None or k >= len(energy):
            return
        e = float(energy[k])
        if self._finished and total > tail_frames:
            rem = total - 1 - k
            if rem < tail_frames:
                e *= max(0.0, rem / max(tail_frames - 1, 1))
        x_d_info["_ges"] = (e, k / MOTION_FPS)

    def pop_frames(self):
        """产出已定稿的运动帧 [(idx, x_d_info)]；无可产出时返回 []。

        必须在 GPU 串行的线程里调用（与 offline 的 render worker 同约束）。
        """
        eng = self._eng
        seq = eng.a2m.seq_frames
        valid = eng.a2m.valid_clip_len
        overlap = eng.a2m.overlap_v2

        out = []
        # 说话手势层输入：按当前累计音频算能量（本调用内音频不变，句尾未知
        # 时不收零，finish 后由 _attach_ges 补收零）
        total0 = self._total_frames()
        energy = (_frame_energy(self._audio.astype(np.float32), total0, apply_tail=False)
                  if total0 > 0 else None)
        tail_frames = int(GESTURE_TAIL_SEC * MOTION_FPS)
        while True:
            total = self._total_frames()
            idx = self._n_windows * valid
            if self._finished:
                if self._emitted >= total or idx >= total:
                    break        # 全部交付完毕；或窗口起点已越过音频末尾 → 走循环外交付
            elif total < idx + seq:
                break        # 真实音频不足以支撑下一个完整窗口（不做提前 pad）

            # 特征整段重算 + 补齐到运动帧数
            feat = eng.wav2feat.wav2feat(self._audio.astype(np.float32))
            if len(feat) == 0:
                break
            if len(feat) < total:
                feat = np.concatenate(
                    [feat, np.stack([feat[-1]] * (total - len(feat)), 0)], 0)
            else:
                feat = feat[:total]

            emo_base = eng.default_kwargs.get("emo")
            if (isinstance(emo_base, np.ndarray) and emo_base.ndim == 2
                    and emo_base.shape[1] == 8 and len(emo_base) > 0):
                n_emo = len(emo_base)
                pos = self._emo_pos % n_emo
                emo_seq = emo_base[(np.arange(total) + pos) % n_emo].astype(np.float32)
            else:
                emo_seq = np.zeros((total, 8), dtype=np.float32)
                emo_seq[:, 4] = 1.0
            cond_all = eng.cond_handler(feat, 0, emo=emo_seq)

            aud = cond_all[idx:idx + seq]
            if len(aud) < seq:
                aud = np.concatenate(
                    [aud, np.stack([aud[-1]] * (seq - len(aud)), 0)], 0)
            self._res = eng.a2m(aud[None], self._res)
            self._n_windows += 1

            final_end = (seq - overlap) if self._n_windows == 1 \
                else (self._res.shape[1] - valid)
            final_end = min(final_end, total)
            if final_end > self._emitted:
                for x_d_info in eng.a2m.cvt_fmt(self._res[:, self._emitted:final_end]):
                    self._attach_ges(x_d_info, energy, total, tail_frames)
                    out.append((self._emitted, x_d_info))
                    self._emitted += 1

            if not self._finished and total < self._n_windows * valid + seq:
                break        # 下一个窗口的条件帧还不够，等更多音频

        # finished 后的余帧：最后一个窗口（起点 < total）的 cond 已 pad 到
        # seq，res 覆盖范围 ≥ total，直接交付 [emitted:total]，不再多开窗口
        # ——与 offline audio_to_motions 的收尾完全一致。
        if self._finished and self._res is not None:
            total = self._total_frames()
            if self._emitted < total:
                for x_d_info in eng.a2m.cvt_fmt(self._res[:, self._emitted:total]):
                    self._attach_ges(x_d_info, energy, total, tail_frames)
                    out.append((self._emitted, x_d_info))
                    self._emitted += 1
        return out

    def close(self) -> None:
        """回复结束：把本条回复消耗的情绪序列游标写回引擎（跨回复连续）。幂等。"""
        if self._closed:
            return
        self._closed = True
        eng = self._eng
        emo_base = eng.default_kwargs.get("emo")
        if isinstance(emo_base, np.ndarray) and emo_base.ndim == 2 \
                and emo_base.shape[1] == 8 and len(emo_base) > 0:
            eng._emo_cursor = (self._emo_pos + self._emitted) % len(emo_base)
