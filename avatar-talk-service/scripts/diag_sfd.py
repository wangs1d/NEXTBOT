# sfd 人脸检测诊断（疑似卡点）
import sys
import time

import numpy as np
import torch

sys.path.insert(0, r"D:\ComfyUI\custom_nodes\ComfyUI-MuseTalk")

import cv2  # noqa: E402

from musetalk.utils.face_detection import FaceAlignment, LandmarksType  # noqa: E402

print("init sfd...")
t0 = time.time()
fa = FaceAlignment(LandmarksType._2D, flip_input=False, device="cuda")
print(f"init: {time.time() - t0:.1f}s")

img = cv2.imread(r"E:\ws-project\NextBot\avatar-talk-service\assets\avatar_frames\00000000.jpg")
print("img:", img.shape)
t0 = time.time()
res = fa.get_detections_for_batch(np.asarray([img]))
torch.cuda.synchronize()
print(f"sfd detect: {time.time() - t0:.2f}s, result: {res}")
print("OK")
