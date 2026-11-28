# 将头像照片缩放到标准尺寸（控制 sfd 特征图规模）
import cv2

SRC = r"E:\ws-project\NextBot\avatar-talk-service\assets\avatar_frames\00000000.jpg"
img = cv2.imread(SRC)
h, w = img.shape[:2]
print("原图:", img.shape)

# 目标：短边 768（保持比例）
scale = 768 / min(h, w)
new_w, new_h = int(w * scale), int(h * scale)
resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
cv2.imwrite(SRC, resized, [cv2.IMWRITE_JPEG_QUALITY, 95])
print("缩放后:", resized.shape)
