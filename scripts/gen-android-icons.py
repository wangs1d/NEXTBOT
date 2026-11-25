"""重新生成 Android 图标（2026-11-24 v3）。

历史教训：
  v1 把白色 N「抠」出来后按 bbox 重排到 72dp —— N 被拉大贴边、重心偏、细灰斜线断掉 → 又怪又大。
  v2 把整张圆角盘缩进 72dp 安全区 —— 圈里套了个小一号的盘子，边缘有台阶 → 像贴图。
  v3（本版）：抠图但不重排 —— 白色 N 保持它在原图里的**精确位置与比例**，
      底板交给 adaptive 的 background 纯色承担（同 #070707），系统遮罩自己出圆角。
      → 无裁剪、无贴片台阶、N 居中且大小与原图一致。

源图：windows/runner/resources/app_icon.ico 的 256 尺寸（与桌面端图标同源）。
"""

from PIL import Image, ImageFilter

ICO = "client/flutter_app/windows/runner/resources/app_icon.ico"
RES = "client/flutter_app/android/app/src/main/res"
COLORS_XML = f"{RES}/values/ic_launcher_background.xml"
DENS = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}

CANVAS_DP = 108          # adaptive icon 画布
ART_SCALE = 0.80         # 字标在画布上的占比（用户 2026-11-24 二次要求「N 再小一点」：0.94→0.80）
PLATE_HEX = "#070707"    # 盘标底色（采样值），background 用它 → 边缘彻底无缝

_ico = Image.open(ICO)
_ico.size = (256, 256)
_ico.load()
src = _ico.convert("RGBA")


def mark_alpha(img: Image.Image) -> Image.Image:
    """亮度当 alpha：盘底(亮度<30)全透明，白字/灰斜线保留，边缘线性过渡。"""
    lum = img.convert("RGB").convert("L")
    lut = [0 if v < 30 else (255 if v > 200 else int((v - 30) * 255 / 170)) for v in range(256)]
    a = lum.point(lut)
    # 缩放后盘边容易留一两个 alpha≈20 的游离像素，直接抹掉（不可见但会让 bbox 失真）
    return a.point(lambda v: 0 if v < 32 else v)


def optical_offset() -> tuple[float, float]:
    """量出 N 主干（去掉细斜线）的中心相对原图中心的偏移，用于把字标摆到正中间。"""
    a = mark_alpha(src)
    body = a.filter(ImageFilter.MinFilter(11)).filter(ImageFilter.MaxFilter(11))  # 开运算吃掉细线
    bb = body.getbbox()
    if not bb:
        return 0.0, 0.0
    cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
    return (src.width / 2 - cx), (src.height / 2 - cy)


SHIFT_X, SHIFT_Y = optical_offset()
print(f"optical shift: {SHIFT_X:+.1f}px, {SHIFT_Y:+.1f}px (原图 256 空间)")


for name, k in DENS.items():
    # 1) legacy 图标：48dp，整张圆角盘等比缩放（用户认可的效果，保持）
    px = round(48 * k)
    src.resize((px, px), Image.LANCZOS).save(f"{RES}/mipmap-{name}/ic_launcher.png")

    # 2) adaptive 前景：只留字标，位置/比例与原图一致，画布 108dp
    canvas = round(CANVAS_DP * k)
    art_px = round(canvas * ART_SCALE)
    art = src.resize((art_px, art_px), Image.LANCZOS)
    alpha = mark_alpha(art)

    fg = Image.new("RGBA", (canvas, canvas), (255, 255, 255, 0))
    off_x = round((canvas - art_px) / 2 + SHIFT_X * art_px / src.width)
    off_y = round((canvas - art_px) / 2 + SHIFT_Y * art_px / src.height)
    fg.paste(Image.new("RGBA", (art_px, art_px), (255, 255, 255, 255)), (off_x, off_y), alpha)
    fg.save(f"{RES}/mipmap-{name}/ic_launcher_foreground.png")

    # 自检：合成后的可见字标占画布比例
    bb = alpha.getbbox()
    if bb:
        w = (bb[2] - bb[0]) / canvas
        h = (bb[3] - bb[1]) / canvas
        print(f"{name}: legacy {px}px | fg {canvas}px | mark {w:.0%}w x {h:.0%}h | "
              f"center offset ({(bb[0]+bb[2])/2/canvas-0.5:+.1%}, {(bb[1]+bb[3])/2/canvas-0.5:+.1%})")
    else:
        print(f"{name}: legacy {px}px | fg {canvas}px | 字标提取失败")

# 背景色与盘底对齐，避免任何可见台阶
xml = f'''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">{PLATE_HEX}</color>
</resources>
'''
with open(COLORS_XML, "w", encoding="utf-8") as f:
    f.write(xml)
print("done")
