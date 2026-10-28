"""按命中区域动态切换鼠标穿透的控制器。

背景：Win32 的 WS_EX_TRANSPARENT 是"全穿透"——窗口一旦穿透，QWebEngine
页面连鼠标移动（hover）都收不到，无法像 Electron 那样靠
setIgnoreMouseEvents(true, {forward:true}) 让页面在 mousemove 中自行
hit-test。因此命中检测必须放在原生侧：

  1. 前端把"可交互形状"（球体投影椭圆 / 面板矩形，client CSS 像素）上报；
  2. 本控制器用 QTimer 高频轮询 QCursor 位置（Qt 已处理 DPI，逻辑坐标），
     判断光标是否落在任一形状内；
  3. 命中 → 移除 WS_EX_TRANSPARENT（可点击 / 拖动）；
     未命中 → 加上 WS_EX_TRANSPARENT（点击穿透到下层窗口）；
  4. 左键按下期间锁定：在角色上按下后，即使光标移出形状也保持捕获，
     保证拖动不会中途穿透而中断。
"""
from __future__ import annotations

import ctypes
import json
from typing import List

from PySide6.QtCore import QObject, QPoint, QTimer
from PySide6.QtGui import QCursor

from .win32_utils import set_click_through

VK_LBUTTON = 0x01

POLL_INTERVAL_MS = 16  # ~60fps


def _hit(shape: dict, p: QPoint) -> bool:
    typ = shape.get("type")
    if typ == "ellipse":
        rx = max(0.001, float(shape.get("rx", 0)))
        ry = max(0.001, float(shape.get("ry", 0)))
        dx = (p.x() - float(shape.get("cx", 0))) / rx
        dy = (p.y() - float(shape.get("cy", 0))) / ry
        return dx * dx + dy * dy <= 1.0
    if typ == "rect":
        x = float(shape.get("x", 0))
        y = float(shape.get("y", 0))
        w = float(shape.get("w", 0))
        h = float(shape.get("h", 0))
        return x <= p.x() <= x + w and y <= p.y() <= y + h
    return False


class ClickThroughController(QObject):
    """根据光标位置与命中形状，动态切换窗口穿透。"""

    def __init__(self, window, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._window = window
        self._shapes: List[dict] = []
        self._force_interactive = False
        self._pressed = False
        self._capture_at_press = False
        self._current_through: bool | None = None

        self._user32 = ctypes.windll.user32
        self._timer = QTimer(self)
        self._timer.setInterval(POLL_INTERVAL_MS)
        self._timer.timeout.connect(self._poll)
        self._timer.start()

    # ---- 前端 / 宿主调用 ----
    def set_shapes(self, shapes: List[dict]) -> None:
        self._shapes = shapes or []

    def set_shapes_json(self, raw: str) -> None:
        try:
            data = json.loads(raw or "{}")
            shapes = data.get("shapes", [])
            if isinstance(shapes, list):
                self._shapes = [s for s in shapes if isinstance(s, dict)]
        except (ValueError, TypeError):
            pass

    def set_force_interactive(self, force: bool) -> None:
        self._force_interactive = bool(force)
        if force:
            # 立即解除穿透，无需等待下一帧
            self._current_through = False
            set_click_through(self._window, False)
        else:
            # 复位，下一帧按命中区域重算
            self._current_through = None

    def shutdown(self) -> None:
        self._timer.stop()

    # ---- 内部 ----
    def _left_button_down(self) -> bool:
        return bool(self._user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)

    def _client_pos(self) -> QPoint:
        # QCursor.pos() 为逻辑全局坐标；frameGeometry().topLeft() 同为逻辑坐标，
        # 与前端上报的 client CSS 像素坐标系一致。
        return QCursor.pos() - self._window.frameGeometry().topLeft()

    def _poll(self) -> None:
        win = self._window
        if win is None or not win.isVisible():
            return

        client = self._client_pos()
        inside = self._force_interactive or any(_hit(s, client) for s in self._shapes)
        btn_down = self._left_button_down()

        if not btn_down:
            # 松开态：以当前 hover 结果为准，并复位按下锁定
            self._pressed = False
            capture = inside
        else:
            if not self._pressed:
                # 刚按下的瞬间：记录按下时是否在可交互区域
                self._pressed = True
                self._capture_at_press = inside
            # 整个按下期间保持按下瞬间的判定，避免拖动中穿透
            capture = self._capture_at_press

        through = not capture
        if through != self._current_through:
            self._current_through = through
            set_click_through(win, through)
