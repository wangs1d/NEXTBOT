"""桌宠单实例指令通道（Windows 上就是 \\\\.\\pipe\\ 同名管道）。

只依赖 QtCore/QtNetwork，宿主侧发指令时不必加载 QtWebEngine。
"""
from __future__ import annotations

from PySide6.QtNetwork import QLocalSocket

# 单实例锁与指令通道共用同一个名字
INSTANCE_PIPE_NAME = "com.nextbot.sphere-overlay-py"


def send_instance_command(command: bytes, timeout_ms: int = 500) -> bool:
    """向已在跑的桌宠进程发一条指令：show 唤到前台，quit 优雅退出。

    没有已在跑的实例时返回 False。
    """
    socket = QLocalSocket()
    socket.connectToServer(INSTANCE_PIPE_NAME)
    if not socket.waitForConnected(timeout_ms):
        return False
    socket.write(command)
    socket.flush()
    socket.waitForBytesWritten(timeout_ms)
    socket.close()
    return True
