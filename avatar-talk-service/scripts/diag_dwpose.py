# GPU 诊断：matmul 基准 + DWPose 单帧推理计时
import sys
import time

import torch

print("torch:", torch.__version__)
x = torch.randn(2048, 2048, device="cuda")
torch.cuda.synchronize()
t0 = time.time()
for _ in range(20):
    y = x @ x
torch.cuda.synchronize()
print(f"matmul 2048x20: {time.time() - t0:.2f}s")

sys.path.insert(0, r"D:\ComfyUI\custom_nodes\ComfyUI-MuseTalk")
import cv2  # noqa: E402
import numpy as np  # noqa: E402

from mmpose.apis import inference_topdown, init_model  # noqa: E402

device = torch.device("cuda")
config_file = r"D:\ComfyUI\custom_nodes\ComfyUI-MuseTalk\musetalk\utils\dwpose\rtmpose-l_8xb32-270e_coco-ubody-wholebody-384x288.py"
ckpt = r"D:\ComfyUI\models\diffusers\TMElyralab\MuseTalk\dwpose\dw-ll_ucoco_384.pth"
print("init dwpose...")
t0 = time.time()
model = init_model(config_file, ckpt, device=device)
print(f"init: {time.time() - t0:.1f}s")

img = cv2.imread(r"E:\ws-project\NextBot\avatar-talk-service\assets\avatar_frames\00000000.jpg")
h, w = img.shape[:2]
print("img:", img.shape)
t0 = time.time()
pred = inference_topdown(model, img, np.array([[0, 0, w, h]]))
torch.cuda.synchronize()
print(f"dwpose inference: {time.time() - t0:.2f}s, instances: {len(pred)}")
print("OK")
