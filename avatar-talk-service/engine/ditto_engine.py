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
IDLE_EXPR_MAX_DELTA = 0.004              # 限制空闲表情在关键点空间的最大形变量，避免腮部轮廓伸缩


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


# ── 人物分割（背景透明化）──
_SEGMENTER = None
_SEGMENTER_TRIED = False
_SEGMENTER_MULTICLASS = False


def _person_segmenter():
    """懒加载 mediapipe 分割器（一次性）；包/模型不可用时返回 None。

    优先 multiclass 模型（按类别输出 hair/body_skin/face_skin/clothes，
    紧脸裁剪下发丝轮廓准）；缺文件时回退旧 coarse 模型——后者把「人物 vs
    背景」置信度在人脸占满画面时整片饱和，蒙版会连背景一起保住（残留根因），
    仅作保底。
    """
    global _SEGMENTER, _SEGMENTER_TRIED, _SEGMENTER_MULTICLASS
    if _SEGMENTER_TRIED:
        return _SEGMENTER
    _SEGMENTER_TRIED = True
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        model_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "models")
        multiclass = os.path.join(model_dir, "selfie_multiclass_256x256.tflite")
        coarse = os.path.join(model_dir, "selfie_segmenter.tflite")
        use_multiclass = os.path.exists(multiclass)
        if not use_multiclass and not os.path.exists(coarse):
            _log(f"分割模型缺失，背景透明化停用: {coarse}")
            return None
        if not use_multiclass:
            _log("multiclass 分割模型缺失，回退 coarse 模型（蒙版偏大）")
        _SEGMENTER_MULTICLASS = use_multiclass
        opts = vision.ImageSegmenterOptions(
            base_options=mp_python.BaseOptions(
                model_asset_path=multiclass if use_multiclass else coarse),
            output_category_mask=use_multiclass,
            output_confidence_masks=not use_multiclass)
        _SEGMENTER = vision.ImageSegmenter.create_from_options(opts)
    except Exception as exc:  # noqa: BLE001
        _log(f"分割器初始化失败，背景透明化停用: {exc}")
        _SEGMENTER = None
    return _SEGMENTER


def _compute_person_mask(rgb: np.ndarray) -> np.ndarray:
    """人物 alpha 蒙版（uint8 H×W，255=人物）。失败回退全 255（行为同旧版不透明）。

    multiclass 按类别取人物（类别 0=背景，1-5=人物）；coarse 走 0.5 置信度
    阈值。分割一次 ~130ms（注册期调用，不占帧预算）；形态学清理 + 向内
    收边羽化（背景像素零保留，见下方注释）。
    """
    import mediapipe as mp

    rgb_u8 = np.ascontiguousarray(
        np.clip(rgb, 0, 255).astype(np.uint8)) if rgb.dtype != np.uint8 \
        else np.ascontiguousarray(rgb)
    seg = _person_segmenter()
    if seg is None:
        return np.full(rgb_u8.shape[:2], 255, dtype=np.uint8)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_u8)
    res = seg.segment(mp_img)
    if _SEGMENTER_MULTICLASS:
        cat = np.asarray(res.category_mask.numpy_view()).squeeze()
        if cat.ndim != 2:
            raise RuntimeError(f"category mask 形状异常: {cat.shape}")
        m = (cat > 0).astype(np.uint8) * 255
    else:
        mask = np.asarray(res.confidence_masks[0].numpy_view())[:, :, 0].copy()
        m = (mask > 0.5).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    # 边缘只向内收（erode）+ 小幅羽化：羽化过渡必须压在人物像素上，
    # 上传照片的背景像素一个都不保留——之前向外 dilate 留一圈原背景
    # 给转头位移兜底，深色面板下显出背景色白描边（用户明确不要）。
    m = cv2.erode(m, np.ones((9, 9), np.uint8))
    m = cv2.GaussianBlur(m, (7, 7), 0)
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


# 上传照片的背景填充色（RGB）：与客户端面板深底同款近黑。
# 模型（decoder）会忠实重建源图背景——照片什么背景渲染帧就什么背景，
# 头一动静态蒙版必然漏它。源头治理：加载时在内存里抠出人物、背景填这个
# 中性色（不落盘），之后所有帧露出的边缘带都是同色，与面板融为一体。
AVATAR_BG_FILL_RGB = (14, 14, 16)


def matte_avatar_photo(rgb: np.ndarray) -> np.ndarray:
    """上传照片预处理：分割人物，背景整体替换为 AVATAR_BG_FILL_RGB 纯色。

    分割不可用/失败时原样返回（同旧行为，绝不因预处理挡上传）。
    边缘用 5×5 高光羽化过渡，发丝与填充色平滑衔接、无硬边光晕。
    """
    try:
        import mediapipe as mp

        rgb_u8 = np.ascontiguousarray(
            np.clip(rgb, 0, 255).astype(np.uint8)) if rgb.dtype != np.uint8 \
            else np.ascontiguousarray(rgb)
        seg = _person_segmenter()
        if seg is None:
            return rgb_u8
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_u8)
        res = seg.segment(mp_img)
        if _SEGMENTER_MULTICLASS:
            cat = np.asarray(res.category_mask.numpy_view()).squeeze()
            if cat.ndim != 2:
                return rgb_u8
            m = (cat > 0).astype(np.uint8) * 255   # 0=背景，1-5=人物
        else:
            conf = np.asarray(
                res.confidence_masks[0].numpy_view())[:, :, 0].copy()
            m = (conf > 0.5).astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        alpha = cv2.GaussianBlur(m, (5, 5), 0).astype(np.float32) / 255.0
        fill = np.zeros_like(rgb_u8)
        fill[..., 0] = AVATAR_BG_FILL_RGB[0]
        fill[..., 1] = AVATAR_BG_FILL_RGB[1]
        fill[..., 2] = AVATAR_BG_FILL_RGB[2]
        out = (rgb_u8.astype(np.float32) * alpha[..., None]
               + fill.astype(np.float32) * (1.0 - alpha[..., None]))
        return np.clip(out, 0, 255).astype(np.uint8)
    except Exception as exc:  # noqa: BLE001
        _log(f"上传照片抠像失败，保留原图: {exc}")
        return rgb if rgb.dtype == np.uint8 else np.clip(rgb, 0, 255
                                                         ).astype(np.uint8)


class DittoEngine:
    def __init__(
        self,
        avatar_path: str,
        max_dim: int = 1920,
        steps: int = 50,
        pose_alpha: float = 1.0,
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
        # 蒙版是中性帧的静态图，人物一动轮廓就离开蒙版覆盖区（歪头必露背景），
        # 所以每帧还要算「中性→当前」的相似变换（_update_mask_pose），
        # 随帧下发给客户端让蒙版跟着头走。
        self.person_mask = None
        self.mask_png = None
        self.mask_rev = 0
        self._mask_kp = None    # 蒙版对应帧的驱动关键点 (63,2)，load_avatar 时锚定
        self.mask_pose = None   # (a,b,tx,ty)：512 帧像素空间的相似变换；None=不跟
        self._last_xd = None    # 最近一帧 stitch 输出的驱动关键点

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
        # 蒙版锚定帧的驱动关键点一并记录（_mask_kp），逐帧相似变换以此为基准。
        # 失败时置 None → /api/avatar/mask 404 → 客户端保持不透明（同旧行为）。
        try:
            probe = self.render_frame(self._neutral_motion())
            last_xd = self._last_xd
            self._mask_kp = (
                np.asarray(last_xd, dtype=np.float64).reshape(-1, 3)[:, :2].copy()
                if last_xd is not None else None)
            self.person_mask = _compute_person_mask(probe)
            self.mask_png = _mask_png_bytes(self.person_mask)
            self.mask_rev += 1
            _log(f"人物蒙版已更新 rev={self.mask_rev} "
                 f"person%={100 * float((self.person_mask > 127).mean()):.1f}")
        except Exception as exc:  # noqa: BLE001
            self.person_mask = None
            self.mask_png = None
            self._mask_kp = None
            _log(f"人物蒙版计算失败，背景保持不透明: {exc}")

        self._last_motion = None
        self.reset_stream(keep_pose=False)
        elapsed = time.time() - t0
        _log(f"头像已加载 {avatar_path} ({w0}x{h0}) {elapsed:.1f}s")
        return {"elapsed_s": round(elapsed, 2), "size": [w0, h0]}

    # ── 图捕获 ──
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
        self._last_xd = xd
        self._update_mask_pose(xd)
        return self._render_hi(xs, xd)

    def _update_mask_pose(self, xd):
        """由当前驱动关键点更新「蒙版随头」相似变换（每帧一次，微秒级）。

        蒙版是中性帧算的静态图，人物一动轮廓就离开蒙版（歪头必露原背景）。
        这里对 63 个驱动关键点做 Umeyama 闭式相似拟合（中性→当前，复数域
        最小二乘），得到旋转+缩放+平移，随帧下发给客户端对蒙版做同样变换——
        蒙版始终贴住人物轮廓，照片背景像素零暴露。残差只剩表情导致的
        非刚性形变（发际边缘 1-3px），由蒙版向内羽化带吸收。

        kp 在 256 裁剪空间，渲染输出是 512 帧（2×），平移×2 即到像素空间。
        """
        ref = self._mask_kp
        if ref is None:
            self.mask_pose = None
            return
        kp = np.asarray(xd, dtype=np.float64).reshape(-1, 3)[:, :2]
        if kp.shape != ref.shape:
            self.mask_pose = None
            return
        mu1, mu2 = ref.mean(axis=0), kp.mean(axis=0)
        z1 = ref - mu1
        z2 = kp - mu2
        c1 = z1[:, 0] + 1j * z1[:, 1]
        c2 = z2[:, 0] + 1j * z2[:, 1]
        denom = float(np.sum(np.abs(c1) ** 2))
        if denom <= 1e-6:
            self.mask_pose = None
            return
        alpha = np.sum(np.conj(c1) * c2) / denom   # 复数相似系数 a+bi
        t = complex(float(mu2[0]), float(mu2[1])) \
            - alpha * complex(float(mu1[0]), float(mu1[1]))
        s = float(abs(alpha))
        # LMDM 异常值 / 极端帧保护：超界不跟（客户端沿用上一帧变换）
        if not (0.7 <= s <= 1.3) or abs(t) > 60:
            self.mask_pose = None
            return
        self.mask_pose = (
            round(float(alpha.real), 5), round(float(alpha.imag), 5),
            round(float(t.real) * 2.0, 2), round(float(t.imag) * 2.0, 2),
        )

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
            self._breath_amp = random.uniform(0.25, 0.38)
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
            self._tilt_now = 0.0
            self._tilt_from = 0.0
            self._tilt_next = 0.0
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
                self._breath_amp = random.uniform(0.22, 0.40)
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
                random.uniform(-1.0, 1.0),      # yaw：模型对 yaw 很敏感，保持很小
                random.uniform(-1.0, 1.0),      # pitch
                random.uniform(-1.5, 1.5),      # roll：歪头承担主要的姿态变化
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
                random.uniform(-0.60, 0.60),
                random.uniform(-0.30, 0.30),
                random.uniform(-0.32, 0.32),
            ]
            self._pose_fast_t0 = t
            self._pose_fast_dur = random.uniform(1.0, 2.0)
            self._pose_fast_next = t + self._pose_fast_dur + random.uniform(0.5, 2.0)
        a = min(1.0, max(0.0, (t - self._pose_fast_t0) / self._pose_fast_dur))
        a = a * a * (3 - 2 * a)
        self._pose_fast_now = [f + (n - f) * a
                               for f, n in zip(self._pose_fast_from, self._pose_fast_to)]

        breath = self._breath_amp * math.sin(self._breath_phase)

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
                to_y = side * random.uniform(0.8, 1.4)
                to_p = random.uniform(-0.6, 1.0)
                roll = -side * random.uniform(1.5, 3.0)
                hold = random.uniform(1.2, 3.5)
            else:
                to_y = to_p = 0.0
                roll = 0.0
                hold = random.uniform(0.8, 2.5)
            amp = max(abs(to_y), abs(to_p))
            share = random.uniform(0.35, 0.60)
            self._look_head_to = [to_y * share, to_p * share, roll]
            self._look_head_t0 = t + random.uniform(0.08, 0.20)
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
            "delta_yaw": sy + fy + self._look_head_now[0],
            "delta_pitch": sp + fp + breath + self._look_head_now[1],
            "delta_roll": sr + fr + self._look_head_now[2],
        }

    def _build_expr_basis(self):
        """用静音 + 不同情绪条件各跑一窗 LMDM，提取「表情方向」向量。

        取情绪窗口相对中性窗口的 exp 差异，只保留眉眼颊等区域，
        嘴部只留 15%，再夹紧幅度。空闲时按随机权重混合这些方向，
        表情是连续变化的，不是一段固定视频循环。
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
            mask = np.ones(63, dtype=np.float32)
            mask[[k * 3 + i for k in IDLE_LIP_KP for i in range(3)]] = 0.15
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
            # 20% 的空节拍：只有节拍没有动作，避免可辨认的点头规律
            self._nod_to = random.uniform(1.2, 2.4) if random.random() < 0.8 else 0.0
            self._nod_t0 = t
            self._nod_dur = random.uniform(0.5, 0.8)
            self._nod_next = t + self._nod_dur + random.uniform(1.8, 5.0)
        u = min(1.0, max(0.0, (t - self._nod_t0) / self._nod_dur))
        # sin 半波：下去再回来，首尾都归零，节拍之间无缝衔接
        self._nod_now = self._nod_to * math.sin(u * math.pi)

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
        delta_exp = np.zeros((1, 63), dtype=np.float32)
        expr = self._listening_expr(t) if self.listening else self._idle_expr(t)
        if expr is not None:
            delta_exp = delta_exp + expr

        # 空闲帧的相对基准必须是「中性运动」：d0 若还留着上一句首帧，
        # 整段空闲都会带着一个常量偏移（脸一直歪着/僵着），直到下一句才被覆盖。
        if self.stitch.d0 is None:
            self.stitch.d0 = self._neutral_motion()

        x_s_info = self.source_info["x_s_info_lst"][0]
        self._eye_current_idx = self._idle_eye_idx()
        self._sync_eye_clock()
        xs, xd = self.stitch(x_s_info, self._neutral_motion(),
                             delta_exp=delta_exp, **pose)
        self._last_xd = xd
        self._update_mask_pose(xd)
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
                    yield emitted, x_d_info
                    emitted += 1

        if emitted < total:
            for x_d_info in self.a2m.cvt_fmt(res[:, emitted:total]):
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

    def pop_frames(self):
        """产出已定稿的运动帧 [(idx, x_d_info)]；无可产出时返回 []。

        必须在 GPU 串行的线程里调用（与 offline 的 render worker 同约束）。
        """
        eng = self._eng
        seq = eng.a2m.seq_frames
        valid = eng.a2m.valid_clip_len
        overlap = eng.a2m.overlap_v2

        out = []
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
