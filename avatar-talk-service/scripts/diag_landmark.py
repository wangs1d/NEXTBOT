# 拆分计时：dwpose inference_topdown vs sfd get_detections_for_batch
import sys
import time
import types

fp = types.ModuleType("folder_paths")
fp.__file__ = r"D:\ComfyUI\folder_paths.py"
fp.get_folder_paths = lambda name: [rf"D:\ComfyUI\models\{name}"]
sys.modules["folder_paths"] = fp

comfy = types.ModuleType("comfy")
comfy_utils = types.ModuleType("comfy.utils")
comfy_utils.ProgressBar = lambda n: types.SimpleNamespace(update=lambda k=1: None)
comfy.utils = comfy_utils
sys.modules["comfy"] = comfy
sys.modules["comfy.utils"] = comfy_utils

sys.path.insert(0, r"D:\ComfyUI\custom_nodes\ComfyUI-MuseTalk")
sys.path.insert(0, r"D:\ComfyUI\custom_nodes\ComfyUI-MuseTalk\musetalk")
sys.path.insert(0, r"D:\ComfyUI")

import numpy as np  # noqa: E402
import cv2  # noqa: E402

print("[ 0.0s] 导入 preprocessing（含 dwpose+sfd 初始化）...")
t0 = time.time()
from musetalk.utils.preprocessing import inference_topdown, model, fa  # noqa: E402
print(f"[{time.time()-t0:6.1f}s] 初始化完成")

img = cv2.imread(r"E:\ws-project\NextBot\avatar-talk-service\assets\avatar_frames\00000000.jpg")
h, w = img.shape[:2]

t = time.time()
res = inference_topdown(model, img)
print(f"[{time.time()-t:6.1f}s] inference_topdown (dwpose)")

t = time.time()
bbox = fa.get_detections_for_batch(np.asarray([img]))
print(f"[{time.time()-t:6.1f}s] get_detections_for_batch (sfd) -> {bbox}")

# 再各跑一次（排除首次初始化效应）
t = time.time()
inference_topdown(model, img)
print(f"[{time.time()-t:6.1f}s] inference_topdown 第二次")

t = time.time()
fa.get_detections_for_batch(np.asarray([img]))
print(f"[{time.time()-t:6.1f}s] sfd 第二次")
print("DONE")
