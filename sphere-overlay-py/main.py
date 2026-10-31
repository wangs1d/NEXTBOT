#!/usr/bin/env python3
"""Sphere Overlay — PySide6 入口。

`--show` / `--hide` / `--quit` 只对已在跑的实例发一条单实例指令，不加载 QtWebEngine。
"""
import sys


def _run_instance_command(argv: list[str]) -> int | None:
    commands = {"--show": b"show", "--hide": b"hide", "--quit": b"quit"}
    flag = next((arg for arg in argv if arg in commands), None)
    if flag is None:
        return None
    from PySide6.QtCore import QCoreApplication

    from sphere_overlay.instance_channel import send_instance_command

    _ = QCoreApplication([argv[0]] if argv else ["sphere-overlay-py"])
    return 0 if send_instance_command(commands[flag], timeout_ms=1500) else 1


if __name__ == "__main__":
    early = _run_instance_command(sys.argv[1:])
    if early is not None:
        sys.exit(early)

    from sphere_overlay.app import main

    sys.exit(main())
