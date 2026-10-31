"""Sphere Overlay — PySide6 替代 Tauri 外壳。

职责：
  1. 无边框透明置顶主窗口，QWebEngineView 加载 agent-sphere-avatar/dist/overlay.html
  2. 通过 QWebChannel 注入 window.sphereOverlay API（兼容 Tauri preload）
  3. 与 PAI server WebSocket 连接，接收 agent.embodiment.patch 情绪事件
  4. 日程悬浮窗（独立窗口，加载 schedule-floating.html）
  5. 悬浮组件窗（独立全屏透明层，加载 widgets-floating.html：灵动岛 / 专注番茄钟 / 下班打卡）
  6. 系统托盘 + 单实例锁（main.py --quit 关停已在跑的实例）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import websockets
from PySide6.QtCore import (
    QBuffer,
    QByteArray,
    QEasingCurve,
    QPoint,
    QPropertyAnimation,
    QRect,
    Qt,
    QThread,
    QTimer,
    QUrl,
    Signal,
)
from PySide6.QtGui import QAction, QIcon, QMouseEvent, QPainter, QRegion
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QMenu,
    QSystemTrayIcon,
    QWidget,
)

from .bridge import SphereOverlayBridge
from .click_through import ClickThroughController
from .instance_channel import INSTANCE_PIPE_NAME, send_instance_command
from .qwebchannel_support import load_qwebchannel_js as _load_qwebchannel_js
from .win32_utils import (
    apply_desk_pet_shell,
    get_work_area,
    hwnd_from_window,
    set_click_through,
    set_window_pos,
)

# 桌宠是置顶透明小窗：Chromium 一旦把"被遮挡"当隐藏就会节流渲染，首帧和动画都会卡；
# 其余几项是这套 248×309 界面用不到的启动期后台服务。
_CHROMIUM_FLAGS = (
    "--disable-features=CalculateNativeWinOcclusion,BackForwardCache,"
    "MediaRouter,OptimizationHints,Translate,AcceptCHFrame,"
    "InterestFeedContentSuggestions,PrivacySandboxSettings4"
)
_user_flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "").strip()
if "CalculateNativeWinOcclusion" not in _user_flags:
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = f"{_user_flags} {_CHROMIUM_FLAGS}".strip()

# ===== 常量 =====
PET_WIDTH = 248
PET_HEIGHT = 309

SCHEDULE_WIDTH = 280
SCHEDULE_HEIGHT_COLLAPSED = 48
SCHEDULE_HEIGHT_EXPANDED = 340
SCHEDULE_WIDTH_COLLAPSED = 200


@dataclass
class SphereConfig:
    ws_url: str = "ws://127.0.0.1:3000/ws"
    http_base: str = "http://127.0.0.1:3000"
    session_id: str = ""
    actor_id: str = "default"
    user_id: str = ""
    dev_url: Optional[str] = None  # 开发模式前端 dev server URL
    avatar_dist: str = "../agent-sphere-avatar/dist"
    offwork_at: str = "18:30"  # 下班打卡时刻（HH:MM）
    idle_exit_ms: int = 1_800_000  # 隐藏后多久自动退出，释放 Chromium 内存


# 注入前端 WebChannel 初始化脚本 + window.sphereOverlay 包装。
# 注意：QWebChannel 构造器由 build() 注入的 qwebchannel.js 脚本（QWebEngineScript，
# DocumentCreation 时机）提供——注入是异步的，页面可能先于此就绪，故 retry 条件
# 必须同时等待两者。
WEBCHANNEL_INIT = r"""
(function () {
    function setup() {
        if (typeof qt === 'undefined' || !qt.webChannelTransport || typeof QWebChannel === 'undefined') {
            setTimeout(setup, 30);
            return;
        }
        new QWebChannel(qt.webChannelTransport, function(channel) {
            var bridge = channel.objects.sphereOverlay;
            if (!bridge) {
                console.warn('[sphereOverlay] bridge not found');
                return;
            }
            window.sphereOverlay = {
                getWorkArea: function () {
                    return Promise.resolve(bridge.getWorkArea());
                },
                moveTo: function (x, y, animateMs) {
                    bridge.moveTo(x, y, animateMs || 0);
                },
                moveBy: function (dx, dy) {
                    bridge.moveBy(dx, dy);
                },
                setPosition: function (x, y) {
                    bridge.setPosition(x, y);
                },
                getPosition: function () {
                    return Promise.resolve(bridge.getPosition());
                },
                setIgnoreMouseEvents: function (ignore, forward) {
                    bridge.setIgnoreMouseEvents(!!ignore, forward !== false);
                },
                setAttachPanel: function (width) {
                    if (typeof bridge.setAttachPanel === 'function') {
                        bridge.setAttachPanel(Math.max(0, Math.round(width) || 0));
                    }
                },
                setScheduleCollapsed: function (collapsed) {
                    bridge.setScheduleCollapsed(!!collapsed);
                },
                setHitAreas: function (areasJson) {
                    bridge.setHitAreas(areasJson);
                },
                setForceInteractive: function (force) {
                    bridge.setForceInteractive(!!force);
                },
                notifyReady: function () {
                    bridge.notifyReady();
                },
                onPatch: function (cb) {
                    bridge.patch_event.connect(cb);
                    return function () {
                        try { bridge.patch_event.disconnect(cb); } catch (e) {}
                    };
                },
                onRoam: function (cb) {
                    bridge.roam_event.connect(cb);
                    return function () {
                        try { bridge.roam_event.disconnect(cb); } catch (e) {}
                    };
                },
                onTheme: function (cb) {
                    bridge.theme_event.connect(cb);
                    return function () {
                        try { bridge.theme_event.disconnect(cb); } catch (e) {}
                    };
                }
            };
            window.sphereOverlayBridge = bridge;
            console.log('[sphereOverlay] ready (PySide6)');
            // 触发就绪事件，兼容前端检测逻辑
            // 宿主侧的"桌宠出现了"由页面在机体画完后调 notifyReady 上报
            window.dispatchEvent(new CustomEvent('sphere-overlay:ready'));
        });
    }
    setup();
})();
"""


class WsClient(QThread):
    """与 PAI server 保持 WebSocket 连接，接收 embodiment patch。"""

    connected = Signal()
    disconnected = Signal(str)
    patch = Signal(dict)
    error = Signal(str)

    def __init__(
        self,
        cfg: SphereConfig,
        parent: Optional[QObject] = None,
    ) -> None:
        super().__init__(parent)
        self.cfg = cfg
        self._send_queue: list[dict] = []
        self._queue_lock = threading.Lock()
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._stop_event = threading.Event()

    def send(self, envelope: dict) -> None:
        with self._queue_lock:
            self._send_queue.append(envelope)

    def stop(self) -> None:
        self._stop_event.set()
        if self._ws:
            try:
                import asyncio
                asyncio.run_coroutine_threadsafe(self._ws.close(), self._loop)
            except Exception:  # noqa: BLE001
                pass

    def run(self) -> None:
        import asyncio
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._loop_body())

    async def _loop_body(self) -> None:
        import asyncio
        try:
            async with websockets.connect(self.cfg.ws_url) as ws:
                self._ws = ws
                self.connected.emit()
                await ws.send(json.dumps({
                    "type": "session.init",
                    "payload": {
                        "actorId": self.cfg.actor_id,
                        "sessionId": self.cfg.session_id or None,
                        "userId": self.cfg.user_id or None,
                        "client": "sphere-overlay-py",
                    },
                }))
                consumer = asyncio.create_task(self._consume(ws))
                sender = asyncio.create_task(self._sender(ws))
                done, pending = await asyncio.wait(
                    [consumer, sender], return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
        except websockets.exceptions.ConnectionClosed as exc:
            self.disconnected.emit(f"WS 关闭：{exc}")
        except Exception as exc:  # noqa: BLE001
            self.disconnected.emit(f"WS 异常：{exc}")

    async def _consume(self, ws: websockets.WebSocketClientProtocol) -> None:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    typ = msg.get("type")
                    payload = msg.get("payload", {})
                    if typ == "agent.embodiment.patch":
                        self.patch.emit(payload)
                except Exception as exc:  # noqa: BLE001
                    self.error.emit(f"解析失败：{exc}")

    async def _sender(self, ws: websockets.WebSocketClientProtocol) -> None:
        import asyncio
        while not self._stop_event.is_set():
            to_send = []
            with self._queue_lock:
                to_send, self._send_queue = self._send_queue, []
            for envelope in to_send:
                await ws.send(json.dumps(envelope))
            await asyncio.sleep(0.05)


class SphereMainWindow(QMainWindow):
    """3D 桌宠主窗口。"""

    schedule_toggle_requested = Signal(bool)  # collapsed

    def __init__(self, cfg: SphereConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self._attach_w = 0
        self._ready_reported = False
        self._move_anim: Optional[QPropertyAnimation] = None
        self._bridge = SphereOverlayBridge(self)
        self._bridge.ready_event.connect(self._on_page_ready)
        self._setup_window()
        self._setup_webview()
        self._setup_position()
        # 穿透由控制器按命中区域动态切换（替代固定 set_click_through）
        self._click_controller = ClickThroughController(self, self)

    def _on_page_ready(self) -> None:
        """首帧已画出 —— 向 stdout 报一次就绪，宿主（Flutter）据此结束等待。"""
        if self._ready_reported:
            return
        self._ready_reported = True
        print("SPHERE_OVERLAY_READY", flush=True)

    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.resize(PET_WIDTH, PET_HEIGHT)

    def _setup_webview(self) -> None:
        self._view = QWebEngineView(self)
        self._view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setCentralWidget(self._view)

        # 透明背景
        page = self._view.page()
        page.setBackgroundColor(Qt.GlobalColor.transparent)

        # WebChannel
        self._channel = QWebChannel(self)
        self._channel.registerObject("sphereOverlay", self._bridge)
        page.setWebChannel(self._channel)

        # 桥初始化：loadFinished 后按序注入 qwebchannel.js + 初始化脚本
        # （加载前 runJavaScript 可能落在 about:blank 上被导航丢弃）
        self._view.loadFinished.connect(self._inject_bridge_init)

        # 加载页面
        url = self._build_overlay_url()
        self._view.load(QUrl(url))

    def _inject_bridge_init(self, ok: bool) -> None:
        if not ok:
            return
        page = self._view.page()
        qwc = _load_qwebchannel_js()
        if qwc:
            page.runJavaScript(qwc)
        # 脚本内有 // 注释，压成单行会把后半段全部吞掉，必须按原样注入
        page.runJavaScript(WEBCHANNEL_INIT)

    def _build_overlay_url(self) -> str:
        base = self.cfg.dev_url
        if base:
            url = QUrl(base)
            if not url.path().endswith("/overlay.html"):
                url.setPath("/overlay.html")
        else:
            dist = Path(self.cfg.avatar_dist).resolve()
            url = QUrl.fromLocalFile(str(dist / "overlay.html"))
        query = urllib.parse.urlencode({
            "ws": self.cfg.ws_url,
            "sessionId": self.cfg.session_id,
            "petW": str(PET_WIDTH),
            "petH": str(PET_HEIGHT),
            "offwork": self.cfg.offwork_at,
        })
        url.setQuery(query)
        return url.toString()

    def _setup_position(self) -> None:
        area = self.work_area()
        x = area["x"] + area["width"] - PET_WIDTH - 24
        y = area["y"] + area["height"] - PET_HEIGHT - 24
        self.move(x, y)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        apply_desk_pet_shell(self)
        # 初始穿透；随后由 ClickThroughController 按命中区域动态切换
        set_click_through(self, True)

    # ---- bridge API ----
    def work_area(self) -> dict:
        return get_work_area(self)

    def set_click_through(self, enable: bool) -> None:
        set_click_through(self, enable)

    def set_hit_areas(self, areas_json: str) -> None:
        self._click_controller.set_shapes_json(areas_json)

    def set_force_interactive(self, force: bool) -> None:
        self._click_controller.set_force_interactive(force)

    def move_window_to(self, x: int, y: int, animate_ms: int = 0) -> None:
        if animate_ms <= 0:
            self.move(x, y)
            return
        if self._move_anim is not None:
            self._move_anim.stop()
        self._move_anim = QPropertyAnimation(self, b"pos")
        self._move_anim.setDuration(animate_ms)
        self._move_anim.setStartValue(self.pos())
        self._move_anim.setEndValue(QPoint(x, y))
        self._move_anim.setEasingCurve(QEasingCurve.Type.InOutCubic)
        self._move_anim.start()

    def move_window_by(self, dx: int, dy: int) -> None:
        self.move(self.x() + dx, self.y() + dy)

    def set_window_position(self, x: int, y: int) -> None:
        self.move(x, y)

    def set_attach_panel(self, width: int) -> None:
        """桌宠附加面板：向左扩窗，保证桌宠在屏幕上的绝对位置不变。

        面板（专注计时板 / 下班打卡卡）是桌宠窗口内的 flex 兄弟节点，
        排在球体 pane 左侧。窗口加宽多少，就把窗口左边界左移多少；
        桌宠被拖到屏幕左缘时钳制在可用区内，宁可面板变窄也不出屏。
        """
        w = max(0, int(width))
        if w == self._attach_w:
            return
        delta = w - self._attach_w
        self._attach_w = w
        if delta:
            area = self.work_area()
            nx = self.x() - delta
            if area and area.get("width"):
                nx = max(area["x"], nx)
            self.move(nx, self.y())
        self._apply_width()

    def _apply_width(self) -> None:
        """窗口总宽 = 球体 + 附加面板。"""
        self.resize(PET_WIDTH + self._attach_w, PET_HEIGHT)

    def set_schedule_collapsed(self, collapsed: bool) -> None:
        self.schedule_toggle_requested.emit(collapsed)

    def emit_patch(self, payload: dict) -> None:
        self._bridge.emit_patch(payload)

    def emit_roam(self) -> None:
        self._bridge.emit_roam()


class ScheduleWindow(QMainWindow):
    """日程悬浮窗。"""

    def __init__(self, cfg: SphereConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self._collapsed = True
        self._setup_window()
        self._setup_webview()
        self._setup_position()

    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.resize(SCHEDULE_WIDTH, SCHEDULE_HEIGHT_EXPANDED)

    def _setup_webview(self) -> None:
        self._view = QWebEngineView(self)
        self._view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self._view.page().setBackgroundColor(Qt.GlobalColor.transparent)
        self.setCentralWidget(self._view)
        url = self._build_schedule_url()
        self._view.load(QUrl(url))

    def _build_schedule_url(self) -> str:
        base = self.cfg.dev_url
        if base:
            url = QUrl(base)
            url.setPath("/schedule-floating.html")
        else:
            dist = Path(self.cfg.avatar_dist).resolve()
            url = QUrl.fromLocalFile(str(dist / "schedule-floating.html"))
        query = urllib.parse.urlencode({
            "ws": self.cfg.ws_url,
            "httpBase": self.cfg.http_base,
            "sessionId": self.cfg.session_id,
        })
        url.setQuery(query)
        return url.toString()

    def _setup_position(self) -> None:
        area = get_work_area(self) or {"x": 0, "y": 0, "width": 1920, "height": 1080}
        x = area["x"] + area["width"] - SCHEDULE_WIDTH - 24
        y = area["y"] + 24
        self.move(x, y)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        apply_desk_pet_shell(self)

    def set_collapsed(self, collapsed: bool) -> None:
        self._collapsed = collapsed
        if collapsed:
            self.resize(SCHEDULE_WIDTH_COLLAPSED, SCHEDULE_HEIGHT_COLLAPSED)
        else:
            self.resize(SCHEDULE_WIDTH, SCHEDULE_HEIGHT_EXPANDED)




class SphereOverlayApp(QApplication):
    def __init__(self, argv: list[str]) -> None:
        super().__init__(argv)
        self.setQuitOnLastWindowClosed(False)
        self.cfg = self._parse_args(argv)
        self._main_win: Optional[SphereMainWindow] = None
        self._schedule_win: Optional[ScheduleWindow] = None
        self._ws = WsClient(self.cfg)
        self._tray: Optional[QSystemTrayIcon] = None
        self._single_server: Optional[QLocalServer] = None
        self._instance_conn: Optional[QLocalSocket] = None
        self._idle_timer: Optional[QTimer] = None

    def _parse_args(self, argv: list[str]) -> SphereConfig:
        parser = argparse.ArgumentParser(description="Sphere Overlay (PySide6)")
        parser.add_argument("--ws", default=os.environ.get("PAI_WS_URL", "ws://127.0.0.1:3000/ws"))
        parser.add_argument("--http-base", default=os.environ.get("PAI_HTTP_BASE", "http://127.0.0.1:3000"))
        parser.add_argument("--session-id", default=os.environ.get("PAI_SESSION_ID", ""))
        parser.add_argument("--actor-id", default=os.environ.get("PAI_ACTOR_ID", "default"))
        parser.add_argument("--user-id", default=os.environ.get("PAI_USER_ID", ""))
        parser.add_argument("--dev-url", default=os.environ.get("PAI_OVERLAY_DEV_URL"))
        parser.add_argument("--avatar-dist", default=os.environ.get("PAI_AVATAR_DIST", "../agent-sphere-avatar/dist"))
        parser.add_argument("--offwork-at", default=os.environ.get("PAI_OFFWORK_AT", "18:30"))
        parser.add_argument(
            "--idle-exit-ms",
            type=int,
            default=int(os.environ.get("PAI_PET_IDLE_EXIT_MS", "1800000")),
        )
        parser.add_argument("--single-instance", action="store_true", default=True)
        args = parser.parse_args(argv[1:])
        return SphereConfig(
            ws_url=args.ws,
            http_base=args.http_base,
            session_id=args.session_id,
            actor_id=args.actor_id,
            user_id=args.user_id,
            dev_url=args.dev_url,
            avatar_dist=args.avatar_dist,
            offwork_at=args.offwork_at,
            idle_exit_ms=args.idle_exit_ms,
        )

    def ensure_single_instance(self) -> bool:
        """尝试建立本地 server 实现单实例；若已存在则发送激活信号。"""
        if send_instance_command(b"show"):
            return False
        self._single_server = QLocalServer()
        self._single_server.listen(INSTANCE_PIPE_NAME)
        self._single_server.newConnection.connect(self._on_single_instance_command)
        return True

    def _on_single_instance_command(self) -> None:
        """连上来的字节未必已到达，交给 readyRead/disconnected 再分发。"""
        conn = self._single_server.nextPendingConnection()
        if conn is None:
            return
        self._instance_conn = conn
        conn.readyRead.connect(self._read_instance_command)
        conn.disconnected.connect(self._read_instance_command)
        self._read_instance_command()

    def _read_instance_command(self) -> None:
        conn = self._instance_conn
        if conn is None:
            return
        command = bytes(conn.readAll().data()).strip()
        if not command:
            return
        self._instance_conn = None
        conn.close()
        if command == b"quit":
            self.shutdown_gracefully()
            return
        if command == b"hide":
            self.hide_main()
            return
        self.show_main()

    def show_main(self) -> None:
        if self._main_win is None:
            return
        self._main_win.setWindowOpacity(1.0)
        self._main_win.show()
        self._main_win.raise_()
        if self._idle_timer is not None:
            self._idle_timer.stop()
        if self._tray is None:
            self._setup_tray()
        else:
            self._tray.show()

    def hide_main(self) -> None:
        if self._main_win is not None:
            self._main_win.hide()
        if self._tray is not None:
            self._tray.hide()
        if self._idle_timer is not None:
            self._idle_timer.start(self.cfg.idle_exit_ms)

    def shutdown_gracefully(self) -> None:
        """宿主请求退出时走这里，而不是被 TerminateProcess：Qt 自己收尾，
        Chromium 渲染子进程与 GPU 进程随之正常退出，不留孤儿。"""
        if self._idle_timer is not None:
            self._idle_timer.stop()
        if self._single_server is not None:
            self._single_server.close()
            self._single_server = None
        self._ws.stop()
        self._ws.wait(1500)
        for win in (self._schedule_win, self._main_win):
            if win is not None:
                win.close()
        if self._tray is not None:
            self._tray.hide()
        self.quit()

    def build(self) -> bool:
        if not self.ensure_single_instance():
            # 唤起已有实例后本进程退场；宿主据此区分"已有桌宠在运行"与启动失败
            print("SPHERE_OVERLAY_ALREADY_RUNNING", flush=True)
            return False

        self._idle_timer = QTimer(self)
        self._idle_timer.setSingleShot(True)
        self._idle_timer.timeout.connect(self.shutdown_gracefully)

        self._main_win = SphereMainWindow(self.cfg)
        # 日程窗按需创建：召唤关键路径上不再多起一个 Chromium 渲染进程

        self._main_win.schedule_toggle_requested.connect(self._on_schedule_toggle)

        self._connect_ws()
        self._ws.start()

        self._setup_tray()
        self._main_win.show()
        return True

    def _ensure_schedule_window(self) -> ScheduleWindow:
        if self._schedule_win is None:
            self._schedule_win = ScheduleWindow(self.cfg)
        return self._schedule_win

    def _on_schedule_toggle(self, collapsed: bool) -> None:
        win = self._ensure_schedule_window()
        win.set_collapsed(collapsed)
        win.show()

    def _setup_tray(self) -> None:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        menu = QMenu()
        show_action = QAction("显示", self)
        show_action.triggered.connect(self.show_main)
        hide_action = QAction("隐藏", self)
        hide_action.triggered.connect(self.hide_main)
        menu.addAction(show_action)
        menu.addAction(hide_action)

        # 换肤子菜单
        skin_menu = menu.addMenu("换肤")
        for label, theme in (
            ("默认蓝", "default"),
            ("暗夜紫", "night"),
            ("清新绿", "fresh"),
        ):
            act = QAction(label, self)
            act.triggered.connect(
                lambda checked=False, t=theme: self._main_win.emit_theme(t)
            )
            skin_menu.addAction(act)

        menu.addSeparator()

        # 关于
        about_action = QAction("关于", self)
        about_action.triggered.connect(self._show_about)
        menu.addAction(about_action)

        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self.shutdown_gracefully)
        menu.addAction(quit_action)

        self._tray = QSystemTrayIcon(self)
        self._tray.setContextMenu(menu)
        self._tray.setToolTip("NextBot 桌宠")
        self._tray.activated.connect(self._on_tray_activated)
        self._tray.show()

    def _show_about(self) -> None:
        if self._tray is not None:
            self._tray.showMessage(
                "NextBot 桌宠",
                "无边框透明置顶悬浮体 · 点击穿透\n版本 0.1.0",
                QSystemTrayIcon.MessageIcon.Information,
                3000,
            )

    def _on_tray_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self.show_main()

    def _connect_ws(self) -> None:
        self._ws.patch.connect(self._main_win.emit_patch)
        self._ws.connected.connect(lambda: None)
        self._ws.disconnected.connect(lambda msg: print(f"WS disconnected: {msg}"))

    def exec(self) -> int:
        return super().exec()


def main() -> int:
    app = SphereOverlayApp(sys.argv)
    if not app.build():
        return 0
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
