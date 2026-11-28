# 整管线逐段计时（脱离 ComfyUI 调度，复用节点的 musetalk 代码）
import sys
import time
import types

# stub folder_paths（节点模块在顶层 import 它）
fp = types.ModuleType("folder_paths")
fp.__file__ = r"D:\ComfyUI\folder_paths.py"
fp.get_folder_paths = lambda name: [rf"D:\ComfyUI\models\{name}"]
sys.modules["folder_paths"] = fp

# stub comfy.utils（节点用它的 ProgressBar，脱离 ComfyUI 时不需要）
comfy = types.ModuleType("comfy")
comfy_utils = types.ModuleType("comfy.utils")
comfy_utils.ProgressBar = lambda n: types.SimpleNamespace(update=lambda k=1: None)
comfy.utils = comfy_utils
sys.modules["comfy"] = comfy
sys.modules["comfy.utils"] = comfy_utils

sys.path.insert(0, r"D:\ComfyUI\custom_nodes\ComfyUI-MuseTalk")
sys.path.insert(0, r"D:\ComfyUI\custom_nodes\ComfyUI-MuseTalk\musetalk")
sys.path.insert(0, r"D:\ComfyUI")

import glob  # noqa: E402
import os  # noqa: E402

import torch  # noqa: E402

t0 = time.time()
from musetalk.utils.utils import load_all_model  # noqa: E402
from musetalk.utils.preprocessing import get_landmark_and_bbox  # noqa: E402

audio_processor, vae, unet, pe = load_all_model()
print(f"[{time.time()-t0:6.1f}s] 模型加载完成")

img_list = glob.glob(r"E:\ws-project\NextBot\avatar-talk-service\assets\avatar_frames\*.[jpJP][pnPN]*[gG]")
wav = r"E:\ws-project\NextBot\avatar-talk-service\data\tts\tts.wav"

t = time.time()
whisper_feature = audio_processor.audio2feat(wav)
whisper_chunks = audio_processor.feature2chunks(feature_array=whisper_feature, fps=25)
print(f"[{time.time()-t:6.1f}s] whisper 特征: {whisper_feature.shape}, chunks={len(whisper_chunks)}")

t = time.time()
coord_list, frame_list = get_landmark_and_bbox(img_list, 0)
print(f"[{time.time()-t:6.1f}s] 关键点+bbox: {len(coord_list)}")

import cv2  # noqa: E402

t = time.time()
input_latent_list = []
for bbox, frame in zip(coord_list, frame_list):
    if bbox == (0.0, 0.0, 0.0, 0.0):
        continue
    x1, y1, x2, y2 = bbox
    crop = frame[y1:y2, x1:x2]
    crop = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
    input_latent_list.append(vae.get_latents_for_unet(crop))
print(f"[{time.time()-t:6.1f}s] VAE 编码: {len(input_latent_list)} latents")

from musetalk.utils.utils import datagen  # noqa: E402

timesteps = torch.tensor([0], device=unet.device)
frame_list_cycle = frame_list + frame_list[::-1]
coord_list_cycle = coord_list + coord_list[::-1]
input_latent_list_cycle = input_latent_list + input_latent_list[::-1]
gen = datagen(whisper_chunks, input_latent_list_cycle, batch_size=8)
total = int(len(whisper_chunks) / 8) + 1
t = time.time()
first_batch_done = False
for i, (wb, lb) in enumerate(gen):
    tb = time.time()
    tensor_list = [torch.FloatTensor(arr) for arr in wb]
    afb = torch.stack(tensor_list).to(unet.device)
    afb = pe(afb)
    with torch.no_grad():
        pred = unet.model(lb, timesteps, encoder_hidden_states=afb).sample
    recon = vae.decode_latents(pred)
    if not first_batch_done:
        torch.cuda.synchronize()
        print(f"[{time.time()-tb:6.1f}s] 第1个 batch(8帧) unet+vae 推理")
        first_batch_done = True
torch.cuda.synchronize()
print(f"[{time.time()-t:6.1f}s] 全部 {len(whisper_chunks)} 帧 unet 推理完成")
print(f"总耗时: {time.time()-t0:.1f}s")

# ── 实时模式探测：fp16 + batch=1 逐帧延迟（实时链路的关键指标）──
unet.model = unet.model.half()
vae.vae = vae.vae.half()
pe = pe.half()
latents_fp16 = [l.half() for l in input_latent_list_cycle]
gen1 = datagen(whisper_chunks, latents_fp16, batch_size=1)
t = time.time()
per_frame = []
for wb, lb in gen1:
    tb = time.time()
    afb = pe(torch.stack([torch.FloatTensor(a) for a in wb]).to(unet.device).half())
    with torch.no_grad():
        pred = unet.model(lb, timesteps, encoder_hidden_states=afb).sample
    vae.decode_latents(pred)
    torch.cuda.synchronize()
    per_frame.append(time.time() - tb)
    if len(per_frame) == 1:
        continue  # 首帧含 cudnn 预热，不计时
    if len(per_frame) >= 51:
        break
steady = per_frame[1:]
avg = sum(steady) / len(steady) * 1000
print(f"fp16 batch=1 稳态逐帧: {avg:.1f}ms/帧 (n={len(steady)}, 实时门槛 40ms@25fps)")
print("PIPELINE OK")
