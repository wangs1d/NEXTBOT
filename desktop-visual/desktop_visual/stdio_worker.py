"""
Node 端通过 stdin 收 JSON、stdout 出一行 JSON 的 worker。
也支持 `python -m desktop_visual` CLI 直接跑；DESKTOP_VISUAL_STUB=1 走 stub VLM。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timezone

from desktop_visual.shell_policy import (
    evaluate_shell_command,
    format_command_for_log,
    sanitize_env,
)


def ensure_dpi_aware() -> None:
    """启动时声明 DPI 感知（幂等）；之后全链路坐标统一为物理像素。"""
    try:
        from desktop_visual.runtime.dpi import ensure_per_monitor_dpi_aware

        ensure_per_monitor_dpi_aware()
    except Exception:
        pass


def _stub_env_on() -> bool:
    for key in ("DESKTOP_VISUAL_STUB", "DESKTOP_VISUAL_AGENT_STUB"):
        if os.environ.get(key, "").strip().lower() in ("1", "true", "yes", "on"):
            return True
    return False


def _normalize_openai_base(url: str) -> str:
    u = url.strip().rstrip("/")
    if u.endswith("/v1"):
        return u[:-3].rstrip("/")
    return u


async def _handle_screenshot(req: dict) -> dict:
    """截整屏 / 指定显示器 / 区域，返回 base64 PNG + 尺寸 + 坐标标定。

    - display: 1-based 显示器编号（省略 = 主屏）
    - maxDim: 图片最长边上限，超出时等比降采样；返回 scale 供坐标换算
      （screen = image * scale）。region 相对该显示器左上角（物理像素）。
    """
    try:
        from desktop_visual.runtime.capture import grab_display_png

        region = req.get("region")
        region_t: tuple[int, int, int, int] | None = None
        if region is not None:
            if not isinstance(region, list) or len(region) != 4:
                return {"ok": False, "error": "region must be [left, top, width, height]"}
            region_t = (int(region[0]), int(region[1]), int(region[2]), int(region[3]))

        display = req.get("display")
        display_int = int(display) if isinstance(display, (int, float)) else None
        max_dim_raw = req.get("maxDim")
        max_dim = int(max_dim_raw) if isinstance(max_dim_raw, (int, float)) and int(max_dim_raw) >= 200 else None

        grab = grab_display_png(display=display_int, region=region_t, max_dim=max_dim)
        image_base64 = base64.b64encode(grab.png).decode("ascii")

        return {
            "ok": True,
            "imageBase64": image_base64,
            "mimeType": "image/png",
            "width": grab.width,
            "height": grab.height,
            "screenWidth": grab.screen_width,
            "screenHeight": grab.screen_height,
            "scale": grab.scale,
            "display": grab.display,
            "origin": [grab.origin_x, grab.origin_y],
            "capturedAt": grab.captured_at,
        }
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        logging.exception("screenshot failed")
        return {"ok": False, "error": f"截图失败: {str(e)}"}


# ---- run_shell ----
# 默认配置：30s 超时，硬上限 5min，最大 stdout/stderr 各 256KB
DEFAULT_SHELL_TIMEOUT_S = 30
MAX_SHELL_TIMEOUT_S = 300
MAX_SHELL_OUTPUT_BYTES = 256 * 1024


# ---- open ----
import string

_SKIP_DIRS = {
    "$recycle.bin", "system volume information", "config.msi", "recovery",
    "perflogs", "cache", "deps", "lib", "nuget", "npm", "npm-global",
    "gradle", ".appdata", "rail_user_data",
}


def _all_drive_roots() -> list[str]:
    """返回所有可用盘符根目录（跨平台安全）。Windows 下从 A: 扫到 Z:。"""
    if os.name != "nt":
        return []
    roots: list[str] = []
    for letter in string.ascii_uppercase:
        root = f"{letter}:\\"
        if os.path.isdir(root):
            roots.append(root)
    return roots


def _build_search_dirs() -> list[str]:
    """构建软件搜索目录：系统盘常规位置 + 非系统盘根目录下的软件目录（排系统/缓存目录）。"""
    dirs: list[str] = []
    system_drive = os.environ.get("SystemDrive", "C:").rstrip("\\")
    # 系统盘常规位置
    for sub in [
        os.environ.get("ProgramFiles", f"{system_drive}\\Program Files"),
        os.environ.get("ProgramFiles(x86)", f"{system_drive}\\Program Files (x86)"),
        os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~\\AppData\\Local")), "Programs"),
        os.path.expanduser("~\\Desktop"),
        os.path.expanduser("~\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs"),
    ]:
        dirs.append(sub)
    # 非系统盘根目录下所有目录，排除系统/缓存目录
    for root in _all_drive_roots():
        if root.upper().startswith(system_drive.upper()):
            continue
        try:
            for entry in os.scandir(root):
                if entry.is_dir() and entry.name.lower() not in _SKIP_DIRS:
                    dirs.append(entry.path)
        except OSError:
            continue
    # 按优先级排：名字中含已知软件关键字的目录排前面，早点命中早返回
    _priority = {"weixin", "wechat", "qq", "tencent", "douyin", "dingtalk", "feishu", "lark",
                 "program files", "desktop", "trae", "doubao", "豆包"}
    def _key(p: str) -> int:
        low = os.path.basename(p).lower()
        return 0 if low in _priority else 1
    dirs.sort(key=_key)
    return dirs


_APP_SEARCH_DIRS = _build_search_dirs()


# 双向别名表：键和值都参与匹配（值是 canonical 形式，键和值互为别名）。
# 用于把"豆包" / "doubao" / "WeChat" / "Weixin" 等中英别名统一到同一组候选。
_APP_ALIASES: dict[str, list[str]] = {
    "wechat":       ["wechat", "weixin"],
    "weixin":       ["weixin", "wechat"],
    "qq":           ["qq", "tencentqq", "qqpc"],
    "dingtalk":     ["dingtalk", "dingtalkgov"],
    "feishu":       ["feishu", "lark"],
    "lark":         ["lark", "feishu"],
    "douyin":       ["douyin", "tiktok"],
    "doubao":       ["doubao", "豆包", "doubao_talk", "doubaotalk", "doubao-desktop"],
    "豆包":         ["豆包", "doubao", "doubao_talk", "doubaotalk", "doubao-desktop"],
    "wps":          ["wps", "wpp", "kingsoft"],
    "trae":         ["trae"],
}


def _expand_name_variants(name: str) -> set[str]:
    """展开用户传入名称的所有别名变体（小写、去 .exe/.lnk 扩展名）。"""
    if not isinstance(name, str) or not name.strip():
        return set()
    base = name.strip().lower()
    # 用 removesuffix,不要 rstrip —— 后者会把 "Weixin" 末尾的 n 误吃
    for suf in (".exe", ".lnk"):
        if base.endswith(suf):
            base = base[: -len(suf)]
    variants: set[str] = {base}
    # 双向展开：键==base → 加入值；值包含 base → 加入键
    for k, vs in _APP_ALIASES.items():
        k_low = k.lower()
        v_lows = [v.lower() for v in vs]
        if base == k_low or base in v_lows:
            variants.add(k_low)
            for v in v_lows:
                variants.add(v)
    return variants


def _is_start_menu_dir(d: str) -> bool:
    """判断目录是否是开始菜单目录（递归深度不受 2 层限制）。"""
    d_low = d.lower()
    return ("start menu" in d_low) and ("programs" in d_low)


def _find_exe(name: str) -> str | None:
    """在 PATH 和常见安装目录中查找可执行文件/快捷方式，返回完整路径或 None。

    匹配规则（按优先级）:
    1. 精确 basename 匹配（去扩展名小写后 == 候选集任一项）
    2. 子串匹配（候选串长度 >=3 且出现在 basename 中）
    3. 开始菜单目录递归到 8 层；其他安装目录递归到 4 层
       （典型路径：C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe 是 3 层；4 层留冗余）
    """
    if not isinstance(name, str) or not name.strip():
        return None
    resolved = shutil.which(name)
    if resolved:
        return resolved
    candidates = _expand_name_variants(name)
    if not candidates:
        return None
    # 精确匹配的优先级集合（含 canonical + 别名）
    exact_set = {c for c in candidates if len(c) >= 2}
    # 子串匹配候选：阈值 >= 2（中文 2 字名 = 2 char;长候选按 len desc 优先,
    # 短的"qq"等仍可能误匹配,但精确匹配永远排前面,见函数顶部 docstring）
    substring_set = sorted(candidates, key=len, reverse=True)

    # 收集 (优先级, depth, path)，最后统一排序
    matches: list[tuple[int, int, str]] = []
    for d in _APP_SEARCH_DIRS:
        if not os.path.isdir(d):
            continue
        try:
            max_depth = 8 if _is_start_menu_dir(d) else 4
            base_depth = d.count(os.sep)
            for root, _dirs, files in os.walk(d):
                depth = root.count(os.sep) - base_depth
                if depth > max_depth:
                    _dirs.clear()  # 不再下钻
                    continue
                for f in files:
                    f_low = f.lower()
                    if not f_low.endswith((".exe", ".lnk")):
                        continue
                    f_base = os.path.splitext(f_low)[0]
                    if f_base in exact_set:
                        matches.append((0, depth, os.path.join(root, f)))
                    else:
                        for c in substring_set:
                            if c in f_base:
                                matches.append((1, depth, os.path.join(root, f)))
                                break
        except OSError:
            continue

    if not matches:
        return None
    matches.sort(key=lambda x: (x[0], x[1], x[2]))
    return matches[0][2]


def _find_start_menu_shortcut(name: str) -> str | None:
    """在用户/系统开始菜单里按名称找 .lnk 快捷方式（最后兜底）。

    与 _find_exe 区别:
    - 仅扫 .lnk（开始菜单里只有快捷方式）
    - 两个 Start Menu 目录都扫（用户级 + 系统级），递归到 6 层封顶
    - 优先匹配子串；模糊时按 depth 优先（顶层目录的快捷方式更可能是用户想要的）
    """
    if os.name != "nt":
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    candidates = _expand_name_variants(name)
    if not candidates:
        return None
    exact_set = {c for c in candidates if len(c) >= 2}
    # 子串匹配：阈值 >= 2。Python len 对中文按字符算(len("豆包")==2),
    # 阈值 3 会把 2 字中文名直接过滤掉。短的子串可能误匹配(如 "qq" 命中 "qqmusic"),
    # 但精确匹配(priority 0)永远排在子串匹配(priority 1)前面,长候选按 len desc 优先。
    substring_set = sorted(candidates, key=len, reverse=True)

    start_menu_dirs = [
        os.path.expanduser("~\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs"),
        os.path.join(
            os.environ.get("ProgramData", "C:\\ProgramData"),
            "Microsoft\\Windows\\Start Menu\\Programs",
        ),
    ]

    matches: list[tuple[int, int, str]] = []
    for d in start_menu_dirs:
        if not os.path.isdir(d):
            continue
        try:
            base_depth = d.count(os.sep)
            for root, _dirs, files in os.walk(d):
                depth = root.count(os.sep) - base_depth
                if depth > 6:
                    _dirs.clear()
                    continue
                for f in files:
                    f_low = f.lower()
                    if not f_low.endswith(".lnk"):
                        continue
                    f_base = os.path.splitext(f_low)[0]
                    if f_base in exact_set:
                        matches.append((0, depth, os.path.join(root, f)))
                        continue
                    for c in substring_set:
                        if c in f_base:
                            matches.append((1, depth, os.path.join(root, f)))
                            break
        except OSError:
            continue

    if not matches:
        return None
    matches.sort(key=lambda x: (x[0], x[1], x[2]))
    return matches[0][2]


def _handle_open(req: dict) -> dict:
    """
    原生 API 打开文件/网页/软件（不走 shell，不经 shell_policy 判定）。
    - url  → webbrowser.open（跨平台，用默认浏览器）
    - file → os.startfile（Windows）/ xdg-open（Linux）/ open（macOS）
    - app  → .lnk 快捷方式 / 非 .exe 走 os.startfile（让 shell 解析快捷方式），
             .exe 直接 subprocess.Popen 启动

    重要语义：对 app 分支，ok=true 表示「窗口确实出现并激活到前台」，
    不是「进程已派发」。窗口未在超时内出现则 ok=false，避免 LLM 对用户撒谎。
    """
    target = req.get("target")
    path = req.get("path")
    if not isinstance(target, str) or target not in ("file", "url", "app"):
        return {"ok": False, "error": f"target 必须是 file/url/app，收到 {target!r}"}
    if not isinstance(path, str) or not path.strip():
        return {"ok": False, "error": "path 不能为空"}

    try:
        if target == "url":
            # webbrowser.open 返回 True/False，不抛异常
            success = webbrowser.open(path)
            if not success:
                return {"ok": False, "error": f"webbrowser.open 返回 False：{path}"}
            # url 无可等窗口,直接返回成功
            return {
                "ok": True,
                "target": target,
                "path": path,
                "openedAt": datetime.now(timezone.utc).isoformat(),
            }
        elif target == "file":
            if os.name == "nt":
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
            # file 派发不等待窗口（可能是文档/文件夹,语义不同）
            return {
                "ok": True,
                "target": target,
                "path": path,
                "openedAt": datetime.now(timezone.utc).isoformat(),
            }
        else:  # app
            # 如果 path 是裸文件名（无路径分隔符），先在 PATH + 常见目录找
            if not ("\\" in path or "/" in path):
                found = _find_exe(path)
                if found:
                    path = found
                else:
                    # 最后兜底：开始菜单 .lnk 快捷方式（豆包/wps 这类非系统盘安装的
                    # 软件在 Program Files 找不到,只能从开始菜单入口走）
                    lnk = _find_start_menu_shortcut(path)
                    if lnk:
                        # .lnk 走 os.startfile,Windows 自己解析快捷方式
                        if os.name == "nt":
                            os.startfile(lnk)  # type: ignore[attr-defined]
                            # .lnk 也走窗口验证（resolveFromShell 后真实进程会起窗口）
                            launched_ok = _launch_and_verify_window(lnk, fallback_hints_from_name=path)
                            if not launched_ok:
                                return {
                                    "ok": False,
                                    "error": (
                                        f"已派发快捷方式但窗口未在 5s 内出现: {lnk}。"
                                        "可能应用启动慢/被托盘隐藏/需要登录。建议改用 desktop.visual.screenshot 截图确认。"
                                    ),
                                    "target": target,
                                    "path": lnk,
                                    "resolvedVia": "start_menu_shortcut",
                                    "windowVerified": False,
                                }
                            return {
                                "ok": True,
                                "target": target,
                                "path": lnk,
                                "resolvedVia": "start_menu_shortcut",
                                "windowVerified": True,
                                "openedAt": datetime.now(timezone.utc).isoformat(),
                            }
                        path = lnk
                    else:
                        return {
                            "ok": False,
                            "error": (
                                f"找不到应用: {path!r}。已扫描全部盘符 Program Files、"
                                "非系统盘根目录、AppData\\Local\\Programs、"
                                "桌面、开始菜单（用户级+系统级）。"
                                "请确认应用已安装,或直接传完整可执行文件路径。"
                            ),
                        }
            else:
                # 传了完整路径,但文件可能不存在(如 WeChat.exe vs Weixin.exe 别名混淆)
                # 尝试用文件名重新走 _find_exe 兜底(会做 WeChat<->Weixin 别名映射)
                if not os.path.exists(path):
                    basename = os.path.basename(path)
                    found = _find_exe(basename)
                    if found:
                        path = found
            path_lower = path.lower()
            is_exe = path_lower.endswith(".exe")
            is_lnk = path_lower.endswith(".lnk")
            if os.name == "nt" and (is_lnk or not is_exe):
                os.startfile(path)  # type: ignore[attr-defined]
            elif os.name == "nt" and is_exe:
                # DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP:让子进程脱离父进程控制,
                # 避免 stdio_worker 退出时子进程被连带终止
                subprocess.Popen(
                    [path],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=0x00000008 | 0x00000200,  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
                )
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])

            # Windows: 等窗口出现 + 置顶到前台 + 把结果塞进 ok 判定
            # 没等到窗口 = 应用没真起来,必须返 ok:false,防止 LLM 撒谎
            if os.name == "nt":
                launched_ok = _launch_and_verify_window(path, fallback_hints_from_name=path)
                if not launched_ok:
                    return {
                        "ok": False,
                        "error": (
                            f"已派发进程但窗口未在 5s 内出现: {path}。"
                            "可能应用启动慢/被托盘隐藏/需要登录。"
                            "建议立即用 desktop.visual.screenshot 截图确认当前屏幕状态。"
                        ),
                        "target": target,
                        "path": path,
                        "windowVerified": False,
                    }
                return {
                    "ok": True,
                    "target": target,
                    "path": path,
                    "windowVerified": True,
                    "openedAt": datetime.now(timezone.utc).isoformat(),
                }
    except FileNotFoundError as e:
        return {"ok": False, "error": f"找不到目标: {e}"}
    except OSError as e:
        return {"ok": False, "error": f"打开失败: {e}"}

    # 非 Windows 路径(无窗口验证能力)
    return {
        "ok": True,
        "target": target,
        "path": path,
        "openedAt": datetime.now(timezone.utc).isoformat(),
    }


# 常见应用 exe 名 → 窗口标题关键字映射
# 微信进程名是 Weixin.exe,但窗口标题是"微信";类似情况都列在这里
_APP_WINDOW_TITLE_HINTS: dict[str, list[str]] = {
    "weixin.exe": ["微信", "WeChat"],
    "wechat.exe": ["微信", "WeChat"],
    "qq.exe": ["QQ"],
    "dingtalk.exe": ["钉钉"],
    "feishu.exe": ["飞书", "Lark"],
    "lark.exe": ["飞书", "Lark"],
    "qqlive.exe": ["腾讯视频"],
    "tencentvideo.exe": ["腾讯视频"],
    "qqplayer.exe": ["QQ影音"],
    "douyin.exe": ["抖音"],
    "tiktok.exe": ["抖音"],
    "doubao.exe": ["豆包"],
    "doubao_talk.exe": ["豆包"],
    "doubaotalk.exe": ["豆包"],
    "wps.exe": ["WPS"],
    "et.exe": ["WPS"],
    "wpp.exe": ["WPS"],
    "trae.exe": ["Trae"],
    "code.exe": ["Visual Studio Code"],
    "chrome.exe": ["Chrome"],
    "msedge.exe": ["Edge"],
    "firefox.exe": ["Firefox"],
    "notepad.exe": ["记事本", "Notepad"],
    "calc.exe": ["计算器", "Calculator"],
    "explorer.exe": [],  # 资源管理器标题多变,走 fallback
}


def _resolve_window_hints(exe_path: str, fallback_hints_from_name: str | None = None) -> list[str]:
    """根据 exe 名解析窗口标题 hints。无映射时返回空列表(走 fallback 逻辑)。

    fallback:若调用方传了 fallback_hints_from_name(原始 path 参数,可能是中文名如"腾讯视频"),
    直接按字符串切词加入 hints(用于 .lnk 启动场景,无法从 exe 名推断真实标题)。
    """
    exe_name = os.path.basename(exe_path).lower()
    hints = list(_APP_WINDOW_TITLE_HINTS.get(exe_name, []))
    if not hints and fallback_hints_from_name:
        # 用户传入的 path 可能本身就是窗口标题提示(如 "腾讯视频")
        # 去扩展名 + 去路径,留作 hint
        base = os.path.basename(fallback_hints_from_name)
        for suf in (".exe", ".lnk"):
            if base.lower().endswith(suf):
                base = base[: -len(suf)]
        if base:
            hints.append(base)
    return hints


def _activate_window(hwnd: int) -> None:
    """恢复最小化 + 置顶到前台（窗口激活的标准套路）。"""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    SW_SHOW = 5
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.ShowWindow(hwnd, SW_SHOW)
    foreground_thread_id = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    target_thread_id = user32.GetWindowThreadProcessId(hwnd, None)
    if foreground_thread_id != target_thread_id:
        user32.AttachThreadInput(foreground_thread_id, target_thread_id, True)
        user32.SetForegroundWindow(hwnd)
        user32.AttachThreadInput(foreground_thread_id, target_thread_id, False)
    else:
        user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)


def _launch_and_verify_window(
    exe_path: str,
    wait_seconds: float = 5.0,
    fallback_hints_from_name: str | None = None,
) -> bool:
    """启动 exe 后等待窗口出现,置顶到前台。返回 True 表示窗口确实出现并激活。

    失败(窗口未在 wait_seconds 内出现)返回 False,调用方应据此判定 ok=False。

    匹配策略(按优先级):
    1. 先检查是否已有匹配 hints 的窗口存在 → 有则直接激活(应用已在运行)
    2. 启动后等新窗口出现(快照差集),按 hints 精确匹配
    3. 无 hints 或未命中 → 任何「启动后新出现的可见顶层窗口」都算成功
    """
    if os.name != "nt":
        return True  # 非 Windows 无窗口验证能力,默认成功
    try:
        import time
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        hints = _resolve_window_hints(exe_path, fallback_hints_from_name)

        def _activate(hwnd: int) -> None:
            _activate_window(hwnd)

        def _find_existing_by_hints() -> int | None:
            """按 hints 在所有可见顶层窗口里找已存在的窗口。"""
            if not hints:
                return None
            found: list[int] = []

            def _cb(hwnd, _lparam):
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length <= 0:
                    return True
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
                if any(h in title for h in hints):
                    found.append(hwnd)
                    return False
                return True

            user32.EnumWindows(EnumWindowsProc(_cb), 0)
            return found[0] if found else None

        # Step 1: 先查已存在的窗口(应用可能已在运行)
        existing = _find_existing_by_hints()
        if existing:
            logging.info("应用已在运行,直接激活已有窗口 hwnd=%s", existing)
            _activate(existing)
            return True

        # Step 2: 启动前快照顶层可见窗口集合(用于 fallback:任何新出现的窗口都算成功)
        pre_hwnds: set[int] = set()

        def _snapshot_cb(hwnd, _lparam):
            if user32.IsWindowVisible(hwnd):
                pre_hwnds.add(hwnd)
            return True

        user32.EnumWindows(EnumWindowsProc(_snapshot_cb), 0)

        # Step 3: 等待新窗口出现
        # 策略:先按 hints 精确匹配,超时前若未命中则兜底接受任何新出现的可见窗口
        found_hwnd = None
        fallback_hwnd = None  # hints 未命中时的兜底候选

        def _find_new_cb(hwnd, _lparam):
            nonlocal found_hwnd, fallback_hwnd
            if not user32.IsWindowVisible(hwnd):
                return True
            if hwnd in pre_hwnds:
                return True  # 启动前就在,跳过
            length = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(length + 1) if length > 0 else None
            title = ""
            if buf:
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
            if hints and title:
                # 有 hints:优先精确匹配
                if any(h in title for h in hints):
                    found_hwnd = hwnd
                    return False
                # hints 未命中,但这是新窗口,记录为兜底候选(选标题最长的,通常是主窗口)
                if fallback_hwnd is None or len(title) > len(fallback_hwnd[1]):
                    fallback_hwnd = (hwnd, title)
            else:
                # 无 hints 或无标题:任何新出现的可见窗口都算
                found_hwnd = hwnd
                return False
            return True

        deadline = time.time() + wait_seconds
        while time.time() < deadline and not found_hwnd:
            user32.EnumWindows(EnumWindowsProc(_find_new_cb), 0)
            if not found_hwnd:
                time.sleep(0.3)

        # hints 未命中但有新窗口出现,接受兜底候选
        if not found_hwnd and fallback_hwnd:
            found_hwnd = fallback_hwnd[0]
            logging.info("hints 未命中,兜底接受新窗口: %s", fallback_hwnd[1])

        if not found_hwnd:
            return False

        _activate(found_hwnd)
        return True
    except Exception as e:
        logging.debug("激活窗口失败(非致命): %s", e)
        return False


async def _handle_run_shell(req: dict) -> dict:
    """
    在 PC 本机跑一条 shell 命令（cmd / powershell / bash）。
    安全流程：evaluate_shell_command → 拒则直接回 ok=false；通则 subprocess。
    """
    command = req.get("command")
    if not isinstance(command, str) or not command.strip():
        return {"ok": False, "error": "missing command"}
    shell = req.get("shell")
    if shell is not None and shell not in ("cmd", "powershell", "bash"):
        return {"ok": False, "error": f"unsupported shell={shell!r}"}
    allow_destructive = bool(req.get("allowDestructive"))
    cwd_raw = req.get("cwd")
    cwd = cwd_raw if isinstance(cwd_raw, str) and cwd_raw.strip() else None

    try:
        timeout_s = float(req.get("timeoutMs", DEFAULT_SHELL_TIMEOUT_S * 1000)) / 1000.0
    except (TypeError, ValueError):
        timeout_s = DEFAULT_SHELL_TIMEOUT_S
    timeout_s = max(0.1, min(timeout_s, MAX_SHELL_TIMEOUT_S))

    decision = evaluate_shell_command(
        command,
        shell=shell,
        allow_destructive=allow_destructive,
    )

    loggable = format_command_for_log(command)
    logging.info(
        "[run_shell] shell=%s first=%s allowed=%s reason=%s cmd=%s timeout=%.1fs cwd=%s",
        decision.detected_shell, decision.first_token, decision.allowed,
        decision.reason, loggable, timeout_s, cwd or "<inherit>",
    )

    if not decision.allowed:
        return {
            "ok": False,
            "error": f"shell 命令被策略拒绝: {decision.reason}",
            "decision": {
                "allowed": False,
                "shell": decision.detected_shell,
                "firstToken": decision.first_token,
                "reason": decision.reason,
            },
            "command": loggable,
        }

    # 拼 shell 调用
    sh = decision.detected_shell
    if sh == "cmd":
        argv = ["cmd.exe", "/d", "/c", command]
    elif sh == "powershell":
        # -NoProfile -NonInteractive 防止启动 profile 脚本绕开策略
        argv = [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-Command", command,
        ]
    else:  # bash
        argv = ["bash", "-lc", command]

    # 强制剥离敏感 env
    safe_env = decision.sanitized_env
    if isinstance(safe_env, dict) and "PATH" in os.environ and "PATH" not in safe_env:
        safe_env["PATH"] = os.environ["PATH"]
    if isinstance(safe_env, dict) and "SystemRoot" in os.environ and "SystemRoot" not in safe_env:
        safe_env["SystemRoot"] = os.environ["SystemRoot"]

    started = datetime.now(timezone.utc)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=safe_env,
        )
    except FileNotFoundError as e:
        return {
            "ok": False,
            "error": f"shell 解释器未找到: {e}",
            "command": loggable,
            "shell": sh,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"启动 shell 失败: {e}",
            "command": loggable,
            "shell": sh,
        }

    killed = False
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        killed = True
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=2.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            stdout_b, stderr_b = b"", b""
    duration = (datetime.now(timezone.utc) - started).total_seconds()

    # 截断输出
    def _clip(b: bytes) -> str:
        if not b:
            return ""
        if len(b) > MAX_SHELL_OUTPUT_BYTES:
            return b[:MAX_SHELL_OUTPUT_BYTES].decode("utf-8", errors="replace") + "\n...<truncated>"
        return b.decode("utf-8", errors="replace")

    stdout_s = _clip(stdout_b)
    stderr_s = _clip(stderr_b)
    exit_code = proc.returncode if proc.returncode is not None else -1

    return {
        "ok": exit_code == 0 and not killed,
        "command": loggable,
        "shell": sh,
        "firstToken": decision.first_token,
        "exitCode": exit_code,
        "stdout": stdout_s,
        "stderr": stderr_s,
        "durationMs": int(duration * 1000),
        "killed": killed,
        "decision": {
            "allowed": True,
            "shell": sh,
            "firstToken": decision.first_token,
            "reason": decision.reason,
        },
    }


# ---- run_input ----
# 原生键盘/鼠标模拟输入（不依赖 VLM，直接操作系统输入）。
# 动作空间与参数校验在 desktop_visual.input_actions（纯逻辑、可单测）；
# 本函数只做效果执行。坐标系 = 屏幕物理像素（进程已 DPI aware）。


def _type_text_smart(pointer, text: str, *, interval_s: float) -> tuple[str | None, str | None]:
    """输入文本：纯 ASCII 走逐字；含非 ASCII 走剪贴板粘贴（备份→粘贴→恢复）。

    pyautogui.write 只能发 ASCII 虚拟键，中文/emoji 会静默丢失，
    因此非 ASCII 文本统一走剪贴板 + Ctrl+V（主流 computer-use agent 的标准做法）。
    返回 (method, error)：method 为 write / clipboard_paste；error 非 None 表示失败。
    """
    if all(ord(ch) < 128 for ch in text):
        pointer.type_text(text, interval_s=interval_s)
        return "write", None

    from desktop_visual.runtime import clipboard

    backup = clipboard.get_text()
    if not clipboard.set_text(text):
        return None, "剪贴板不可用，无法输入非 ASCII 文本（中文/emoji 等）。可尝试仅输入 ASCII 内容。"
    time.sleep(0.08)
    import pyautogui

    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.08)
    if backup:
        clipboard.set_text(backup)  # 尽力恢复原剪贴板内容
    return "clipboard_paste", None


def _handle_run_input(req: dict) -> dict:
    from desktop_visual.input_actions import RunInputError, normalize_run_input
    from desktop_visual.runtime.displays import resolve_monitor

    def monitor_lookup(display):
        m = resolve_monitor(display)
        return (m.left, m.top, m.width, m.height)

    try:
        norm = normalize_run_input(req, monitor_lookup)
    except RunInputError as exc:
        return {"ok": False, "error": str(exc)}

    action = norm["action"]
    try:
        from desktop_visual.runtime.mouse_controller import HybridPointer

        pointer = HybridPointer(fail_safe=False)
    except Exception as e:
        return {"ok": False, "error": f"启动输入控制器失败: {e}"}

    try:
        if action in ("click", "double_click", "triple_click", "right_click", "middle_click"):
            clicks = {"click": 1, "double_click": 2, "triple_click": 3, "right_click": 1, "middle_click": 1}[action]
            x, y = norm["x"], norm["y"]
            pointer.move(x, y, duration_s=norm["moveDuration"])
            pointer.click(x, y, button=norm["button"], clicks=clicks, interval_s=max(0.02, norm["interval"]))
            return {"ok": True, "action": action, "x": x, "y": y, "button": norm["button"]}

        if action == "move":
            x, y = norm["x"], norm["y"]
            pointer.move(x, y, duration_s=norm["moveDuration"])
            return {"ok": True, "action": "move", "x": x, "y": y}

        if action == "drag":
            pointer.drag_to(
                norm["x"], norm["y"], norm["toX"], norm["toY"],
                duration_s=norm["moveDuration"] or 0.3,
                button=norm["button"],
            )
            return {"ok": True, "action": "drag", "x": norm["x"], "y": norm["y"],
                    "toX": norm["toX"], "toY": norm["toY"]}

        if action == "type":
            method, err = _type_text_smart(pointer, norm["text"], interval_s=norm["interval"])
            if err:
                return {"ok": False, "error": err}
            text = norm["text"]
            return {
                "ok": True,
                "action": "type",
                "text": text[:50] + ("…" if len(text) > 50 else ""),
                "length": len(text),
                "method": method,
            }

        if action == "key":
            key = norm["key"]
            import pyautogui

            if key not in pyautogui.KEYBOARD_KEYS and len(key) != 1:
                return {
                    "ok": False,
                    "error": (
                        f"不支持的按键: {key!r}。可用键: enter/tab/escape/backspace/space/delete/"
                        "home/end/pageup/pagedown/方向键/f1-f12/insert/capslock 等，或任意单个字符"
                    ),
                }
            pointer.key_tap(key)
            return {"ok": True, "action": "key", "key": key}

        if action == "hold_key":
            pointer.hold_key(norm["key"], norm["holdSeconds"])
            return {"ok": True, "action": "hold_key", "key": norm["key"], "holdSeconds": norm["holdSeconds"]}

        if action == "shortcut":
            import pyautogui

            parts = norm["keys"]
            pyautogui.hotkey(*parts)
            return {"ok": True, "action": "shortcut", "keys": "+".join(parts)}

        if action == "scroll":
            v = norm.get("scrollClicks", 0)
            h = norm.get("scrollX", 0)
            if "x" in norm and "y" in norm:
                pointer.scroll_at(norm["x"], norm["y"], v, hclicks=h)
            elif h:
                pointer.hscroll(h)
            elif v:
                pointer.scroll(v)
            return {"ok": True, "action": "scroll", "scrollClicks": v, "scrollX": h}

        if action == "wait":
            time.sleep(norm["waitMs"] / 1000.0)
            return {"ok": True, "action": "wait", "waitMs": norm["waitMs"]}

        if action == "cursor_position":
            import pyautogui

            pos = pyautogui.position()
            return {"ok": True, "action": "cursor_position", "x": int(pos.x), "y": int(pos.y)}

    except Exception as e:
        logging.exception("run_input failed")
        return {"ok": False, "error": f"输入操作失败: {e}"}

    return {"ok": False, "error": f"未知 action: {action}"}


# ---- window ----
# 窗口管理（主流 computer-use / OS agent 标配）：
# list 枚举可见顶层窗口；activate/close/minimize/maximize/restore/move/resize
# 按 hwnd / title 子串 / list 编号定位。仅 Windows。

_WINDOW_OPS = ("list", "activate", "close", "minimize", "maximize", "restore", "move", "resize")


def _process_name_of_hwnd(hwnd: int) -> str | None:
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return None
        handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return None
        try:
            size = wintypes.DWORD(512)
            buf = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return os.path.basename(buf.value)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return None
    return None


def _list_top_windows() -> list[dict]:
    """可见、有标题的顶层窗口列表（物理像素 bbox），index 为 1-based 稳定序号。"""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    out: list[dict] = []

    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value.strip()
        if not title:
            return True
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        info: dict = {
            "index": len(out) + 1,
            "hwnd": int(hwnd),
            "title": title[:120],
            "bbox": [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)],
            "minimized": bool(user32.IsIconic(hwnd)),
            "maximized": bool(user32.IsZoomed(hwnd)),
            "foreground": int(hwnd) == int(user32.GetForegroundWindow()),
        }
        pname = _process_name_of_hwnd(int(hwnd))
        if pname:
            info["processName"] = pname
        out.append(info)
        return len(out) < 80

    user32.EnumWindows(EnumWindowsProc(_cb), 0)
    return out


def _resolve_window_hwnd(req: dict) -> int | None:
    """按 hwnd / title 子串 / list 编号三种方式定位窗口。"""
    import ctypes

    user32 = ctypes.windll.user32
    hwnd = req.get("hwnd")
    if isinstance(hwnd, (int, float)) and int(hwnd) > 0 and user32.IsWindow(int(hwnd)):
        return int(hwnd)
    windows = _list_top_windows()
    title = req.get("title")
    if isinstance(title, str) and title.strip():
        needle = title.strip().lower()
        for w in windows:
            if needle in w["title"].lower():
                return w["hwnd"]
        return None
    index = req.get("index")
    if isinstance(index, (int, float)) and int(index) >= 1:
        for w in windows:
            if w["index"] == int(index):
                return w["hwnd"]
    return None


def _window_info(hwnd: int) -> dict:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1) if length > 0 else None
    title = ""
    if buf:
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    info: dict = {
        "hwnd": int(hwnd),
        "title": title[:120],
        "bbox": [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)],
        "minimized": bool(user32.IsIconic(hwnd)),
        "maximized": bool(user32.IsZoomed(hwnd)),
        "foreground": int(hwnd) == int(user32.GetForegroundWindow()),
    }
    pname = _process_name_of_hwnd(hwnd)
    if pname:
        info["processName"] = pname
    return info


def _handle_window(req: dict) -> dict:
    if os.name != "nt":
        return {"ok": False, "error": "窗口管理仅支持 Windows"}
    op = req.get("windowOp") or req.get("op")
    if op not in _WINDOW_OPS:
        return {"ok": False, "error": f"windowOp 必须是 {'/'.join(_WINDOW_OPS)}，收到 {op!r}"}

    try:
        if op == "list":
            windows = _list_top_windows()
            return {"ok": True, "op": "list", "count": len(windows), "windows": windows}

        hwnd = _resolve_window_hwnd(req)
        if hwnd is None:
            return {
                "ok": False,
                "error": "未找到目标窗口：请传 hwnd、title（标题子串，大小写不敏感）"
                "或 index（desktop.window list 输出的编号）。",
            }

        import ctypes

        user32 = ctypes.windll.user32
        if op == "activate":
            _activate_window(hwnd)
            return {"ok": True, "op": op, "window": _window_info(hwnd)}
        if op == "close":
            user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE，走应用正常关闭流程（可被取消）
            return {"ok": True, "op": op, "hwnd": hwnd}
        if op == "minimize":
            user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
        elif op == "maximize":
            user32.ShowWindow(hwnd, 3)  # SW_MAXIMIZE
        elif op == "restore":
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        elif op == "move":
            x, y = req.get("x"), req.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                return {"ok": False, "error": "move 需要 x, y（屏幕物理像素）"}
            user32.SetWindowPos(hwnd, 0, int(x), int(y), 0, 0, 0x0001 | 0x0004)  # SWP_NOSIZE|NOZORDER
        elif op == "resize":
            w, h = req.get("width"), req.get("height")
            if not isinstance(w, (int, float)) or not isinstance(h, (int, float)) or w <= 0 or h <= 0:
                return {"ok": False, "error": "resize 需要 width, height（正数，物理像素）"}
            user32.SetWindowPos(hwnd, 0, 0, 0, int(w), int(h), 0x0002 | 0x0004)  # SWP_NOMOVE|NOZORDER
        return {"ok": True, "op": op, "window": _window_info(hwnd)}
    except Exception as e:
        logging.exception("window op failed")
        return {"ok": False, "error": f"窗口操作失败: {e}"}


# ---- clipboard ----
# 剪贴板读写（desktop.clipboard 工具 + 中文输入的粘贴路径共用）。

def _handle_clipboard(req: dict) -> dict:
    op = req.get("clipboardOp") or req.get("op")
    if op not in ("get", "set"):
        return {"ok": False, "error": f"clipboardOp 必须是 get 或 set，收到 {op!r}"}
    from desktop_visual.runtime import clipboard

    if op == "get":
        text = clipboard.get_text()
        if text is None:
            return {"ok": False, "error": "剪贴板无文本或读取失败"}
        limit = 8000
        return {
            "ok": True,
            "op": "get",
            "text": text[:limit],
            "length": len(text),
            "truncated": len(text) > limit,
        }

    text = req.get("text")
    if not isinstance(text, str):
        return {"ok": False, "error": "set 需要 text 字符串参数"}
    if not clipboard.set_text(text):
        return {"ok": False, "error": "剪贴板写入失败（可能被其他进程占用）"}
    return {"ok": True, "op": "set", "length": len(text)}


# ---- show_message ----
# 桌面置顶悬浮提示：用 tkinter 创建无边框置顶窗口，显示文字 N 秒后淡出消失。
# 不走 shell，不经过 shell_policy；参数仅文本 + 时长 + 字号，安全可控。

def _handle_show_message(req: dict) -> dict:
    """在桌面显示一个置顶悬浮提示窗口（无边框、居中、自动淡出消失）。"""
    text = req.get("text")
    if not isinstance(text, str) or not text.strip():
        return {"ok": False, "error": "text 不能为空"}

    # 参数约束（防注入/防异常值）
    text = text.strip()[:200]  # 最长 200 字符
    try:
        duration_ms = max(1000, min(int(req.get("durationMs", 5000)), 60_000))
    except (TypeError, ValueError):
        duration_ms = 5000
    try:
        font_size = max(16, min(int(req.get("fontSize", 42)), 120))
    except (TypeError, ValueError):
        font_size = 42
    bg_color = str(req.get("bgColor", "#FF6B6B")).strip()[:20] or "#FF6B6B"
    fg_color = str(req.get("fgColor", "#FFFFFF")).strip()[:20] or "#FFFFFF"

    try:
        import tkinter as tk
    except ImportError:
        return {"ok": False, "error": "tkinter 不可用（Python 安装时未勾选 tcl/tk）"}

    try:
        root = tk.Tk()
        root.overrideredirect(True)  # 无边框
        root.attributes("-topmost", True)  # 置顶
        root.configure(bg=bg_color)

        label = tk.Label(
            root,
            text=text,
            font=("微软雅黑", font_size, "bold"),
            fg=fg_color,
            bg=bg_color,
            padx=48,
            pady=28,
        )
        label.pack()

        # 居中显示
        root.update_idletasks()
        w = root.winfo_reqwidth()
        h = root.winfo_reqheight()
        sw = root.winfo_screenwidth()
        sh = root.winfo_screenheight()
        x = (sw - w) // 2
        y = (sh - h) // 2 - 60  # 略偏上，避免遮挡任务栏
        root.geometry(f"+{x}+{y}")

        # 淡出动画：最后 800ms 内 alpha 从 1.0 逐步降到 0.05 再销毁
        fade_start = duration_ms - 800
        steps = 16
        fade_interval = 800 // steps

        def start_fade():
            alpha = [1.0]
            def fade_step():
                alpha[0] -= (0.95 / steps)
                if alpha[0] <= 0.05:
                    root.destroy()
                    return
                try:
                    root.attributes("-alpha", alpha[0])
                except Exception:
                    root.destroy()
                    return
                root.after(fade_interval, fade_step)
            fade_step()

        root.after(fade_start, start_fade)
        root.after(duration_ms, root.destroy)
        root.mainloop()
    except Exception as e:
        logging.exception("show_message failed")
        return {"ok": False, "error": f"显示提示失败: {e}"}

    return {
        "ok": True,
        "text": text,
        "durationMs": duration_ms,
        "shownAt": datetime.now(timezone.utc).isoformat(),
    }


# ---- read_document ----
# 本机文档文本提取（文本类/pdf/docx），供 server 端情境感知（文档摘要）直接调用，
# 不暴露给 LLM 工具循环。路径支持完整路径或桌面/文档/下载目录下的文件名。

def _handle_read_document(req: dict) -> dict:
    from desktop_visual.document_reader import read_document

    path = req.get("path")
    if not isinstance(path, str) or not path.strip():
        return {"ok": False, "error": "path 不能为空"}
    return read_document(path, max_chars=req.get("maxChars"))


# ---- set_dnd ----
# 系统通知勿扰开关（注册表主开关，best-effort），供会议场景自动免打扰。
# 不走 shell、不经过 shell_policy；仅 enable/disable/query 三个只读可逆操作。

def _handle_set_dnd(req: dict) -> dict:
    from desktop_visual.notifications_policy import set_dnd

    return set_dnd(str(req.get("dndOp") or "query"))


async def _run() -> dict:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    ensure_dpi_aware()
    raw = sys.stdin.buffer.read()
    if not raw:
        return {"ok": False, "error": "empty stdin"}
    try:
        line = raw.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        return {"ok": False, "error": f"stdin 编码错误: {exc} (raw_len={len(raw)})"}
    if not line:
        return {"ok": False, "error": "empty stdin"}
    try:
        req = json.loads(line)
    except json.JSONDecodeError as exc:
        logging.error("stdin JSON 无效，前 300 字符: %s", line[:300])
        return {"ok": False, "error": f"stdin JSON 无效: {exc} (raw_len={len(raw)})"}

    action = req.get("action", "run_task")

    if action == "screenshot":
        return await _handle_screenshot(req)
    if action == "open":
        return _handle_open(req)
    if action == "uia_query":
        return _handle_uia_query(req)
    if action == "run_shell":
        return await _handle_run_shell(req)
    if action == "show_message":
        return _handle_show_message(req)
    if action == "run_input":
        return _handle_run_input(req)
    if action == "run_automation":
        return _handle_run_automation(req)
    if action == "window":
        return _handle_window(req)
    if action == "clipboard":
        return _handle_clipboard(req)
    if action == "http_get":
        return _handle_http_get(req)
    if action == "web_search":
        return _handle_web_search(req)
    if action == "web_fetch":
        return _handle_web_fetch(req)
    if action == "read_document":
        return _handle_read_document(req)
    if action == "set_dnd":
        return _handle_set_dnd(req)

    task = str(req.get("task", "")).strip()
    if not task:
        return {"ok": False, "error": "missing task"}
    max_steps = int(req.get("maxSteps", 40))
    region = req.get("region")
    region_t: tuple[int, int, int, int] | None = None
    if region is not None:
        if not isinstance(region, list) or len(region) != 4:
            return {"ok": False, "error": "region must be [left, top, width, height]"}
        region_t = (int(region[0]), int(region[1]), int(region[2]), int(region[3]))

    max_shot_raw = req.get("maxScreenshotDim")
    max_shot_dim = (
        int(max_shot_raw)
        if isinstance(max_shot_raw, (int, float)) and int(max_shot_raw) >= 200
        else None
    )

    stub = bool(req.get("stub")) or _stub_env_on()

    from desktop_visual.visual_loop import LoopConfig, VisualDesktopLoop
    from desktop_visual.vlm.openai_compatible import OpenAICompatibleVLM
    from desktop_visual.vlm.stub import StubVLM

    if stub:
        vlm = StubVLM()
    else:
        from desktop_visual.vlm.env_config import resolve_vlm_from_request

        cfg = resolve_vlm_from_request(req)
        if not cfg:
            return {
                "ok": False,
                "error": "未配置视觉模型密钥：请设置 MOONSHOT_API_KEY 或 OPENAI_API_KEY，或由服务端桥接下发 vlm（use stub:true / DESKTOP_VISUAL_STUB=1 调试）",
            }
        vlm = OpenAICompatibleVLM(
            base_url=cfg["baseUrl"],
            api_key=cfg["apiKey"],
            model=cfg["model"],
        )

    def _emit_step(payload: dict) -> None:
        # 步骤事件经 stderr "##STEP {json}" 行上报，桥接转发为 desktop.task.step
        try:
            line = json.dumps(payload, ensure_ascii=False)
            sys.stderr.write("##STEP " + line[:2000] + "\n")
            sys.stderr.flush()
        except Exception:
            pass

    loop = VisualDesktopLoop(vlm, uia=_get_uia_for_loop(), on_step=_emit_step)
    out = await loop.run(
        LoopConfig(max_steps=max_steps, task=task, region=region_t, max_screenshot_dim=max_shot_dim)
    )
    return out


def _get_uia_for_loop():
    """获取共享 UiaController 实例供 visual_loop 隐式兜底用。非 Windows 或 pywinauto 未装时返回 None。"""
    try:
        from desktop_visual.runtime.uia_controller import get_uia_controller

        ctrl = get_uia_controller()
        return ctrl if ctrl.is_available() else None
    except Exception:
        return None


def _handle_uia_query(req: dict) -> dict:
    """UIA 结构化查询。mode: query | read_children | inspect_point | snapshot。"""
    from desktop_visual.runtime.uia_controller import get_uia_controller

    ctrl = get_uia_controller()
    if not ctrl.is_available():
        return {
            "ok": False,
            "error": "UIA 不可用（非 Windows 或 pywinauto 未安装）",
            "available": False,
        }

    mode = req.get("mode", "query")
    try:
        if mode == "inspect_point":
            point = req.get("point") or {}
            x = int(point.get("x", 0))
            y = int(point.get("y", 0))
            return ctrl.inspect_point(x, y)

        if mode == "snapshot":
            # 整树快照（主流"快照→按元素操作"模式）：
            # windowTitle 省略时取前台窗口；path 可在 run_automation 里复用
            window_title = req.get("windowTitle") or None
            try:
                max_depth = int(req.get("maxDepth") or 6)
            except (TypeError, ValueError):
                max_depth = 6
            try:
                limit = int(req.get("limit") or 150)
            except (TypeError, ValueError):
                limit = 150
            root_ref, win_title = ctrl.find_window_root(window_title)
            if root_ref is None:
                return {
                    "ok": False,
                    "error": f"未找到窗口: {window_title!r}" if window_title else "当前无可用窗口",
                    "mode": "snapshot",
                }
            items = ctrl.snapshot_tree(root_ref, max_depth=max_depth, limit=limit)
            return {
                "ok": True,
                "mode": "snapshot",
                "windowTitle": win_title,
                "count": len(items),
                "elements": [_strip_ref(e) for e in items],
            }

        # query / read_children 支持 windowTitle 限定查询范围到某个顶层窗口
        scope_selector: dict | None = None
        window_title = req.get("windowTitle")
        if window_title:
            root_ref, _win = ctrl.find_window_root(window_title)
            if root_ref is None:
                return {"ok": False, "error": f"未找到窗口: {window_title!r}", "mode": mode}
            scope_selector = {"parent": root_ref}

        if mode == "query":
            selector = {**(req.get("selector") or {}), **(scope_selector or {})}
            top_only = bool(req.get("topOnly", True))
            limit_raw = req.get("limit")
            limit = int(limit_raw) if isinstance(limit_raw, (int, float)) else 100
            elements = ctrl.query(selector, top_only=top_only, limit=limit)
            # 剥掉 __ref / parent（不可序列化；parent 是 COM 元素引用）
            echo_selector = {k: v for k, v in selector.items() if k != "parent"}
            return {
                "ok": True,
                "mode": "query",
                "selector": echo_selector,
                "count": len(elements),
                "elements": [_strip_ref(e) for e in elements],
            }

        if mode == "read_children":
            # 先用 selector 找父元素，再读子树
            selector = {**(req.get("selector") or {}), **(scope_selector or {})}
            limit_raw = req.get("limit")
            limit = int(limit_raw) if isinstance(limit_raw, (int, float)) else 200
            parents = ctrl.query(selector, top_only=True, limit=1)
            if not parents:
                return {"ok": False, "error": "未找到匹配父元素", "selector": {
                    k: v for k, v in selector.items() if k != "parent"
                }}
            parent_ref = parents[0].get("__ref")
            children = ctrl.read_children(parent_ref, limit=limit)
            return {
                "ok": True,
                "mode": "read_children",
                "parent": _strip_ref(parents[0]),
                "count": len(children),
                "elements": [_strip_ref(c) for c in children],
            }

        return {"ok": False, "error": f"未知 mode: {mode!r}（应为 query/read_children/inspect_point/snapshot）"}
    except Exception as exc:
        return {"ok": False, "error": f"UIA 查询失败: {exc}", "mode": mode}


def _strip_ref(elem: dict) -> dict:
    """剥掉不可序列化的 __ref 字段。"""
    if not isinstance(elem, dict):
        return elem
    return {k: v for k, v in elem.items() if k != "__ref"}


def _handle_run_automation(req: dict) -> dict:
    """UIA 原生控件原子操作。一次调用完成 query → pattern 操作,不模拟鼠标键盘。

    支持的 action:
    - click: 调 InvokePattern(等效于点击按钮/菜单项,但不抢鼠标)
    - set_value: 调 ValuePattern.SetValue(直接设置文本框内容,不模拟键盘)
    - get_value: 读 ValuePattern.CurrentValue
    - toggle: 调 TogglePattern.Toggle(复选框/单选)
    - focus: 调 SetFocus(设焦点,不激活窗口)
    - select: 调 SelectionItemPattern.Select(列表项/树节点选中)
    - expand / collapse: 调 ExpandCollapsePattern(下拉框/树节点展开折叠)
    - scroll_into_view: 调 ScrollItemPattern(滚动到可见区域)

    定位方式(二选一):
    - selector: name/name_contains/control_type/class_name/automation_id 组合查询
    - selector.path: desktop.uia_query(mode=snapshot) 输出的元素 path(如 "2.1.3")
    windowTitle 可把查询范围限定到指定顶层窗口。

    返回值包含 matched 元素信息(不含 __ref)和操作结果。
    若 selector 匹配多个元素,默认操作第一个,可在 selector 里加 index 字段选第 N 个。

    重要：本工具不抢鼠标、不抢键盘、不要求窗口在前台。
    但目标应用必须支持 UIA(Win32/WPF/WinForms)。
    Electron/自绘 UI 应用(微信新版/腾讯视频/QQ)内部控件读不到,本工具会返回 ok:false。
    """
    from desktop_visual.runtime.uia_controller import get_uia_controller

    ctrl = get_uia_controller()
    if not ctrl.is_available():
        return {
            "ok": False,
            "error": "UIA 不可用（非 Windows 或 pywinauto 未安装）",
            "available": False,
        }

    action = req.get("action_name") or req.get("op") or req.get("automation_action")
    # 兼容字段名:外部可能直接传 action(会和顶层 action 冲突),所以优先 action_name
    if not action:
        action = req.get("action")
    VALID_AUTOMATION_ACTIONS = (
        "click", "set_value", "get_value", "toggle", "focus",
        "select", "expand", "collapse", "scroll_into_view",
    )
    if action not in VALID_AUTOMATION_ACTIONS:
        return {
            "ok": False,
            "error": f"automation_action 必须是 {'/'.join(VALID_AUTOMATION_ACTIONS)},收到 {action!r}",
        }

    selector = req.get("selector") or {}
    if not isinstance(selector, dict) or not selector:
        return {"ok": False, "error": "selector 不能为空(至少给 name/control_type/automation_id/path 之一)"}

    value = req.get("value")
    if action == "set_value" and not isinstance(value, str):
        return {"ok": False, "error": "set_value 需要 value 字符串参数"}

    index = int(req.get("index", 0) or 0)
    if index < 0:
        index = 0

    try:
        elem: dict | None = None
        matched_count = 0

        # windowTitle：把查询范围限定到指定顶层窗口
        scope_parent = None
        window_title = req.get("windowTitle")
        if window_title:
            scope_parent, _win = ctrl.find_window_root(window_title)
            if scope_parent is None:
                return {"ok": False, "error": f"未找到窗口: {window_title!r}", "action": action}

        if isinstance(selector.get("path"), str) and selector["path"].strip():
            # 按 snapshot 输出的 path 复原元素（跨进程稳定，主流"快照→按元素操作"）
            if scope_parent is None:
                scope_parent, _win = ctrl.find_window_root(None)
            elem = ctrl.element_by_path(scope_parent, selector["path"]) if scope_parent is not None else None
            matched_count = 1 if elem is not None else 0
            if elem is None:
                return {
                    "ok": False,
                    "error": f"path {selector['path']!r} 未解析到元素（窗口结构可能已变化，请重新 snapshot）",
                    "matchedCount": 0,
                    "action": action,
                }
        else:
            query_selector = {**selector, **({"parent": scope_parent} if scope_parent is not None else {})}
            elements = ctrl.query(query_selector, top_only=bool(req.get("topOnly", True)), limit=max(index + 1, 10))
            matched_count = len(elements)
            if not elements:
                return {
                    "ok": False,
                    "error": (
                        f"未找到匹配元素(selector={ {k: v for k, v in selector.items() if k != 'parent'} })。"
                        "若目标应用是 Electron/自绘 UI(微信新版/腾讯视频/QQ),"
                        "UIA 只能看到顶层窗口读不到内部控件,本工具无法操作,需走 desktop.run_input 坐标路径。"
                    ),
                    "matchedCount": 0,
                    "action": action,
                }
            if index >= len(elements):
                return {
                    "ok": False,
                    "error": f"index={index} 超出匹配元素数量({len(elements)})",
                    "matchedCount": len(elements),
                    "action": action,
                }
            elem = elements[index]

        elem_info = _strip_ref(elem)

        # 执行操作
        ok = False
        result_value: str | None = None
        if action == "click":
            ok = ctrl.invoke(elem)
        elif action == "set_value":
            ok = ctrl.set_value(elem, value)
        elif action == "get_value":
            result_value = ctrl.get_value(elem)
            ok = result_value is not None
        elif action == "toggle":
            ok = ctrl.toggle(elem)
        elif action == "focus":
            ok = ctrl.focus(elem)
        elif action == "select":
            ok = ctrl.select(elem)
        elif action == "expand":
            ok = ctrl.expand(elem, expand=True)
        elif action == "collapse":
            ok = ctrl.expand(elem, expand=False)
        elif action == "scroll_into_view":
            ok = ctrl.scroll_into_view(elem)

        return {
            "ok": ok,
            "action": action,
            "matchedCount": matched_count,
            "matchedElement": elem_info,
            "value": result_value if action == "get_value" else None,
            "error": None if ok else (
                f"元素不支持 {action} 操作(pattern 不支持)。"
                f"该元素 patterns: {elem_info.get('patterns', [])}。"
                "可改用 desktop.run_input 坐标点击,或换 selector 找其他元素。"
            ),
        }
    except Exception as exc:
        return {"ok": False, "error": f"run_automation 失败: {exc}", "action": action}


def _handle_http_get(req: dict) -> dict:
    """原生 HTTP GET 请求(用 requests 库,不走 shell 避免注入)。

    仅支持 GET(只读,不修改服务端状态)。
    用于 LLM 调外部 API 获取实时信息(天气/股价/翻译/搜索/汇率等),
    替代 shell 的 curl 调用,避免命令注入风险。

    安全约束:
    - 仅允许 http/https scheme(file/gopher/ftp 等禁掉)
    - 强制超时(默认 15s,上限 60s)
    - 响应体截断到 256KB(防 OOM)
    - 拒绝 localhost/127.x/内网 IP(防 SSRF)——除非 DESKTOP_VISUAL_HTTP_GET_ALLOW_PRIVATE=1
    """
    url = req.get("url")
    if not isinstance(url, str) or not url.strip():
        return {"ok": False, "error": "url 不能为空"}
    url = url.strip()

    # SSRF + scheme 校验(复用统一函数)
    ssrf_err = _ssrf_check(url)
    if ssrf_err:
        return {"ok": False, "error": ssrf_err}

    # headers
    headers: dict[str, str] = {"User-Agent": "NextBot-Desktop/1.0"}
    extra_headers = req.get("headers")
    if isinstance(extra_headers, dict):
        for k, v in extra_headers.items():
            if isinstance(k, str) and isinstance(v, str):
                headers[k] = v

    # 超时
    timeout_s = req.get("timeoutMs")
    try:
        timeout = max(1, min(60, int(timeout_s) // 1000 if timeout_s else 15))
    except (TypeError, ValueError):
        timeout = 15

    # 最大响应体
    max_bytes = 256 * 1024

    try:
        import requests  # type: ignore
    except ImportError:
        return {"ok": False, "error": "缺少 requests 库,pip install requests"}

    try:
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True, stream=True)
    except requests.exceptions.RequestException as exc:
        return {"ok": False, "error": f"HTTP 请求失败: {exc}"}

    # 读响应体(限制大小)
    chunks = []
    total = 0
    truncated = False
    try:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                total += len(chunk)
                if total > max_bytes:
                    chunks.append(chunk[: max_bytes - (total - len(chunk))])
                    truncated = True
                    break
                chunks.append(chunk)
    except Exception as exc:
        return {"ok": False, "error": f"读取响应体失败: {exc}"}
    finally:
        resp.close()

    body_bytes = b"".join(chunks)

    # content-type 判断返回文本还是 base64
    content_type = resp.headers.get("content-type", "").lower()
    if "json" in content_type or "text" in content_type or "xml" in content_type or "html" in content_type:
        try:
            body_text = body_bytes.decode("utf-8", errors="replace")
        except Exception:
            body_text = body_bytes.decode("latin-1", errors="replace")
        body_field = body_text
    else:
        # 二进制用 base64(虽然 GET 通常不返回大二进制)
        import base64
        body_field = base64.b64encode(body_bytes).decode("ascii")

    return {
        "ok": True,
        "url": url,
        "statusCode": resp.status_code,
        "contentType": content_type,
        "body": body_field,
        "bodyEncoding": "text" if isinstance(body_field, str) and not content_type.startswith("application/octet") else "text",
        "truncated": truncated,
        "bytesReceived": len(body_bytes),
        "headers": dict(resp.headers),
    }


def _ssrf_check(url: str) -> str | None:
    """SSRF 检查:返回错误消息或 None(通过)。复用 http_get 的逻辑。"""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"scheme 必须是 http/https,收到 {parsed.scheme!r}"
    if not parsed.netloc:
        return f"url 缺少 host: {url!r}"
    host = (parsed.hostname or "").lower()
    private_disabled = os.environ.get("DESKTOP_VISUAL_HTTP_GET_ALLOW_PRIVATE", "").strip() not in ("1", "true", "yes")
    if private_disabled and host:
        import ipaddress
        import socket as _socket
        if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
            return f"目标 host {host!r} 是内网地址,被 SSRF 防护拦截"
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
                return f"目标 host {host!r} 是内网/loopback 地址,被 SSRF 防护拦截"
        except ValueError:
            try:
                infos = _socket.getaddrinfo(host, None)
                for info in infos:
                    ip_str = info[4][0]
                    try:
                        ip = ipaddress.ip_address(ip_str)
                        if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
                            return f"目标 host {host!r} 解析到内网 IP {ip_str},被 SSRF 防护拦截"
                    except ValueError:
                        pass
            except _socket.gaierror:
                pass
    return None


def _handle_web_search(req: dict) -> dict:
    """桌面端联网搜索(Bing CN)。

    用 requests 抓取 Bing 搜索结果页,解析 HTML 提取标题/URL/摘要。
    不依赖服务端,桌面本机直接联网。

    参数:
    - query: 搜索关键词(必填)
    - limit: 返回条数(1-20,默认 8)
    """
    query = req.get("query")
    if not isinstance(query, str) or not query.strip():
        return {"ok": False, "error": "query 不能为空"}
    query = query.strip()

    try:
        limit = max(1, min(20, int(req.get("limit", 8))))
    except (TypeError, ValueError):
        limit = 8

    try:
        import requests  # type: ignore
    except ImportError:
        return {"ok": False, "error": "缺少 requests 库,pip install requests"}

    from urllib.parse import quote_plus, urlparse, parse_qs

    search_url = f"https://cn.bing.com/search?q={quote_plus(query)}&count={limit}&setlang=zh-CN"
    ssrf_err = _ssrf_check(search_url)
    if ssrf_err:
        return {"ok": False, "error": ssrf_err}

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }

    try:
        resp = requests.get(search_url, headers=headers, timeout=15, allow_redirects=True)
    except requests.exceptions.RequestException as exc:
        return {"ok": False, "error": f"搜索请求失败: {exc}"}

    if resp.status_code != 200:
        return {"ok": False, "error": f"Bing 返回 HTTP {resp.status_code}", "statusCode": resp.status_code}

    html = resp.text

    # 用正则解析 Bing 搜索结果(轻量级,不依赖 BeautifulSoup)
    import re
    import html as html_module

    items: list[dict] = []

    # Bing 搜索结果的标题在 <h2> 内,<a href="..."> 标题 </a>
    # 用 finditer 代替 findall,拿到 match 位置用于定位 snippet
    for m in re.finditer(
        r'<h2[^>]*>\s*<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>',
        html,
        re.DOTALL,
    ):
        if len(items) >= limit:
            break
        url = m.group(1)
        title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
        title = html_module.unescape(title)
        if not title or not url:
            continue

        # 用 match 的结束位置定位 snippet(比 html.find(url) 更精确)
        snippet = ""
        after_h2 = html[m.end():m.end() + 3000]
        snippet_match = re.search(r'<p[^>]*>(.*?)</p>', after_h2, re.DOTALL)
        if snippet_match:
            snippet = re.sub(r'<[^>]+>', '', snippet_match.group(1)).strip()
            snippet = html_module.unescape(snippet)

        items.append({
            "title": title[:300],
            "url": url,
            "snippet": snippet[:500] if snippet else "",
        })

    return {
        "ok": True,
        "query": query,
        "count": len(items),
        "items": items,
        "engine": "bing_cn",
    }


def _handle_web_fetch(req: dict) -> dict:
    """桌面端抓取网页正文。

    用 requests 抓取 URL,提取纯文本正文(去 HTML 标签/脚本/样式)。
    不依赖服务端,桌面本机直接联网。

    参数:
    - url: 目标网页 URL(必填)
    """
    url = req.get("url")
    if not isinstance(url, str) or not url.strip():
        return {"ok": False, "error": "url 不能为空"}
    url = url.strip()

    ssrf_err = _ssrf_check(url)
    if ssrf_err:
        return {"ok": False, "error": ssrf_err}

    try:
        import requests  # type: ignore
    except ImportError:
        return {"ok": False, "error": "缺少 requests 库,pip install requests"}

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    try:
        resp = requests.get(url, headers=headers, timeout=15, allow_redirects=True, stream=True)
    except requests.exceptions.RequestException as exc:
        return {"ok": False, "error": f"抓取失败: {exc}"}

    # 限制响应体大小(256KB)
    chunks = []
    total = 0
    max_bytes = 256 * 1024
    truncated = False
    try:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                total += len(chunk)
                if total > max_bytes:
                    chunks.append(chunk[: max_bytes - (total - len(chunk))])
                    truncated = True
                    break
                chunks.append(chunk)
    except Exception as exc:
        return {"ok": False, "error": f"读取响应体失败: {exc}"}
    finally:
        resp.close()

    html_bytes = b"".join(chunks)

    import re
    import html as html_module

    # 解码:优先 Content-Type charset,其次 <meta charset>,最后默认 utf-8
    content_type = resp.headers.get("content-type", "").lower()
    charset = "utf-8"
    if "charset=" in content_type:
        charset = content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
    else:
        # 尝试从 HTML <meta> 标签检测编码(中文站常用 GBK/GB2312)
        head = html_bytes[:4096].decode("ascii", errors="replace")
        meta_match = re.search(r'<meta[^>]+charset=["\']?([\w-]+)', head, re.IGNORECASE)
        if meta_match:
            charset = meta_match.group(1).strip()
    try:
        html = html_bytes.decode(charset, errors="replace")
    except (LookupError, Exception):
        html = html_bytes.decode("utf-8", errors="replace")

    # 提取 <title>
    title = ""
    title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.DOTALL | re.IGNORECASE)
    if title_match:
        title = re.sub(r'\s+', ' ', title_match.group(1)).strip()

    # 去掉 script/style/nav/footer/header
    cleaned = re.sub(r'<(script|style|nav|footer|header|aside)[^>]*>.*?</\1>', '', html, flags=re.DOTALL | re.IGNORECASE)
    # 去掉 HTML 注释
    cleaned = re.sub(r'<!--.*?-->', '', cleaned, flags=re.DOTALL)
    # 去掉所有 HTML 标签
    text = re.sub(r'<[^>]+>', '\n', cleaned)
    # HTML 实体解码
    text = html_module.unescape(text)
    # 清理空白
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    text = '\n'.join(lines)

    # 生成摘要(前 300 字)
    summary = text[:300].replace('\n', ' ').strip()
    if len(text) > 300:
        summary += "..."

    # 截断正文(4KB)
    max_text = 4096
    text_truncated = False
    if len(text) > max_text:
        text = text[:max_text]
        text_truncated = True

    return {
        "ok": True,
        "url": url,
        "title": title[:200] if title else "",
        "summary": summary,
        "content": text,
        "contentTruncated": text_truncated,
        "statusCode": resp.status_code,
        "contentType": content_type,
        "bytesReceived": len(html_bytes),
    }


def main() -> None:
    try:
        result = asyncio.run(_run())
    except Exception as e:
        result = {"ok": False, "error": str(e)}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.stderr.flush()


if __name__ == "__main__":
    main()
