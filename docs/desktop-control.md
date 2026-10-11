# 桌面操控能力(desktop-visual)工具地图与约定

Agent 操作电脑的能力分两层:

- **server 端**(Node,`server/src/tools/desktop-visual-tools.ts`):向 LLM 暴露 `desktop.*` 工具,按「电脑桥接在线 → 本机 Python 子进程」双路径择优执行。
- **执行端**(Python,`desktop-visual/desktop_visual/`):`stdio_worker` 接收 JSON 请求完成实际操作(pyautogui / pynput / pywinauto / ctypes),`bridge_ws_client` 是连接 server 的常驻桥接进程。

动作空间对齐主流 computer-use agent(Anthropic Computer Use、OpenAI CUA/Operator、UI-TARS)。

## 工具清单(13 个)

| 工具 | 用途 | 关键点 |
| --- | --- | --- |
| `desktop.visual.screenshot` | 截屏 | 支持 `display`(多屏)、`maxDim`(降采样);返回 `scale/screenWidth/screenHeight` 坐标标定 |
| `desktop.visual.run_task` | VLM 视觉循环(最后手段) | 硬性要求本轮先调过 uia_query + run_input;每步经 stderr `##STEP` 行上报为 `desktop.task.step` 事件 |
| `desktop.open` | 原生打开 file/url/app | 别名展开 + 跨盘扫描 + 开始菜单兜底;窗口验证防"假成功" |
| `desktop.run_preset` | 预打包只读 shell 命令 | list_dir/read_file/ping/processes 等,token 省 |
| `desktop.run_shell` | 受控 shell | 默认白名单,高危命令拒绝;审计落账 |
| `desktop.uia_query` | UIA 结构化查询 | mode=query/read_children/inspect_point/**snapshot**;`windowTitle` 限定窗口 |
| `desktop.run_automation` | UIA pattern 直调 | click/set_value/get_value/toggle/focus/**select/expand/collapse/scroll_into_view**;selector 支持 `path` |
| `desktop.run_input` | 键鼠模拟(主流动作空间) | click/double/triple/middle/right、type(中文剪贴板路径)、key/shortcut/hold_key、drag、scroll(纵+横+目标坐标)、wait、cursor_position |
| `desktop.window` | 窗口管理 | list/activate/close/minimize/maximize/restore/move/resize;按 hwnd/title/index 定位 |
| `desktop.clipboard` | 剪贴板读写 | get/set;`type` 的非 ASCII 粘贴路径与这里共用底层 |
| `desktop.http_get` | 桌面本机 HTTP GET | SSRF 防护、响应截断 |
| `desktop.web_search` | 桌面本机 Bing CN 搜索 | — |
| `desktop.web_fetch` | 桌面本机网页正文抓取 | — |

## 坐标系约定(重要)

全链路统一 **屏幕物理像素**。执行进程启动时声明 Per-Monitor V2 DPI aware
(`runtime/dpi.py`),此后截图、鼠标(SetCursorPos)、UIA(ElementFromPoint /
BoundingRectangle)三者坐标系一致,125%/150% 缩放屏不再错位。

- 截图默认返回原始物理像素;传 `maxDim` 时等比降采样并返回 `scale`(screen = image × scale)。
- 模型手里只有截图坐标时:`desktop.run_input` 传 `coordSpace:"image"` + `imageWidth/imageHeight`,Python 自动换算回屏幕坐标(仅对整屏截图有效;区域截图直接用屏幕坐标)。
- `desktop.uia_query` 返回的 bbox 永远是屏幕物理像素,可直接喂给 `desktop.run_input`。

## 推荐操作序列(主流 "snapshot → act" 模式)

```
desktop.open(启动应用) 
→ desktop.window(list/activate,把窗口带到前台)
→ desktop.uia_query(mode=snapshot,windowTitle=...)   # 拿控件树与 path
→ desktop.run_automation(selector.path=..., action=click/set_value)  # 按 path 精准操作
→ 失败? → desktop.run_input 坐标路径(Electron/自绘 UI)
→ desktop.visual.screenshot 验证结果
```

优先级:UIA pattern 直调 > 键鼠模拟 > VLM 视觉循环(最后手段,token 贵且慢)。

## 桥接通道(手机远控电脑)

server ↔ PC 通过 `desktop.bridge.invoke/result`(jobId 配对)请求-响应;
PC → server 可单向推送 `desktop.event`。action 字段白名单见
`desktop_visual/bridge_actions.py` 的 `ACTION_FIELD_ALLOWLIST`——未知 action
直接拒绝,**不会**静默降级成 run_task(2026-08-31 修复的历史 bug)。

### 手机远控电脑:无 UI 入口,走 Agent 工具(2026-10-09 定案)

手机端**不设**「电脑」页面入口——用户直接对 Agent 说「帮我在电脑上打开 XX /
截个屏 / 把这段字发到电脑剪贴板」,Agent 调 `desktop.*` 工具族,经
`desktop.bridge.invoke` 下发到那台已配对的 PC 执行(工具全局注册,手机端会话同样可见)。

- **身份口径**:桥接执行器按 `userId` 绑定(ws 层 `actorId = userId || sessionId`,
  且桌面桥接通道强制要求 userId),所以**手机与电脑必须登录同一账号**才能命中同一台机器。
- **提示词配套(关键)**:`prompt-context-builder.ts` 的 mobile 分支原先写
  「涉及电脑端才能做的事就直说稍后在电脑上办」——这句会直接压制远控(模型有工具也不调)。
  已改为明确告知模型:可直接调 `desktop.*` 代用户在已配对电脑上执行,只有确需本人
  站到电脑前(插拔设备等)才让用户过去,电脑离线就直说没连上。
- **电脑侧 Flutter 桥接**:`desktop_bridge_service.dart` 放行 `window` / `clipboard` /
  `run_automation` 三个此前只在 Python worker 里支持的动作,否则手机让 Agent
  切窗口 / 传剪贴板会拿到 `action_not_supported`。
- **注意**:若电脑离线**且**服务端本机开着 `DESKTOP_VISUAL_ENABLED=1`,
  `desktop.visual.screenshot` 会回退到在**服务器本机**截屏(既有行为,用于自托管场景);
  结果文案会区分「已通过电脑桥接截取屏幕」与「已截取屏幕」。手机远控场景建议不要
  在服务端开 `DESKTOP_VISUAL_ENABLED`,避免截错机器。

`run_task` 的每步动作经 stderr `##STEP {json}` 行由桥接转发为
`desktop.task.step` 事件(server 端 `DesktopBridgeCoordinator.subscribeEvents`
可订阅,ws 层无 event_type 白名单),客户端可据此实时展示操作步骤。

## 环境开关

| 变量 | 作用 |
| --- | --- |
| `DESKTOP_VISUAL_ENABLED=1` | server 本机启用 Python 子进程执行 |
| `DESKTOP_BRIDGE_ENABLED=1` 或 `DESKTOP_BRIDGE_TOKEN`(≥8 字符) | 启用电脑桥接特性(token 强制鉴权) |
| `DESKTOP_SHELL_ENABLED=1` | 解锁 `desktop.run_shell` / `desktop.run_preset` |
| `DESKTOP_SHELL_ALLOWLIST=0` | 关闭 shell 白名单(allowDestructive 才能生效,高风险) |
| `DESKTOP_VISUAL_STUB=1` | Python 侧用 StubVLM 调试管线 |
| `DESKTOP_VISUAL_PYTHON` | 指定 Python 解释器路径(默认 `python`) |
| `DESKTOP_VISUAL_ROOT` | desktop-visual 包根目录 |
| `DESKTOP_VISUAL_HTTP_GET_ALLOW_PRIVATE=1` | 允许 http_get 访问内网(默认 SSRF 拦截) |

安全护栏:shell 白名单/黑名单(`shell_policy.py`)+ env 脱敏;所有 desktop 工具调用写审计日志(`AuditService`);`desktop.open` 以"窗口确实出现"为成功标准,防止对用户谎报。

## 验证与测试

```bash
# Python 纯逻辑单测(34 项:桥接白名单/run_input 归一化/坐标换算/VLM 解析)
cd desktop-visual && py -3.12 -m pytest tests -q

# server 端冒烟(注册/schema/参数校验;加 --live + DESKTOP_VISUAL_ENABLED=1 走真实子进程)
cd server && DESKTOP_VISUAL_ENABLED=1 npx tsx scripts/verify-desktop-control.ts --live
```

## 桌面情境感知（SceneWatcher，默认关闭）

`DESKTOP_SCENE_WATCHER_ENABLED=1` 启用。检测层完全零 token：复用 desktop.event
的 `focus_change` / `window_open` / `window_close`，外加 Python 侧
`event_subscribers.start_scene_reporter()` 每 30s 推送的 `scene_tick` 前台心跳
（`DESKTOP_SCENE_TICK_SECONDS` 可调，0 关闭）。`DesktopSceneWatcherService`
（`server/src/services/desktop-scene-watcher-service.ts`）按「窗口标题 + 进程名 +
停留时长」做纯规则分类，三个场景：

| 场景 | 判定 | 触发动作 | token |
| --- | --- | --- | --- |
| 会议 | 专用会议进程（腾讯会议/Zoom）任意窗口；或标题含「会议/Meeting」 | `set_dnd` 静音系统通知，`window_close` 或前台离开宽限后恢复并回报 | 0 |
| 文档 | 标题含 pdf/docx/pptx/txt/md 等文档名，前台停留 ≥60s | `read_document` 提取文本（桌面/文档/下载目录可按文件名定位）→ 一次 LLM 摘要+3 个关键问题 | 每文档一次 |
| 商品页 | 浏览器进程 + 标题命中电商关键词，停留 ≥45s | UIA 读地址栏 URL（失败退化为标题搜索）→ `web_fetch`+`web_search` → 一次 LLM 比价 | 每商品一次 |

实现约定：

- 检测/节流/冷却（同文档与同商品页默认 6h）全在 watcher，纯代码不调模型；
  触发后由 `desktop-scene-handlers.ts` 的 handler 执行，LLM 走
  `ephemeralTurn` 单轮（不污染会话线程，`maxOutputTokens` 封顶）。
- 新增 Python action：`read_document`（path/maxChars）、`set_dnd`（dndOp），
  已登记 `bridge_actions.ACTION_FIELD_ALLOWLIST`，仅情境感知内部使用，
  **不暴露给 LLM 工具循环**。
- `set_dnd` 为 best-effort：写注册表 toast 主开关
  `NOC_GLOBAL_SETTING_TOASTS_ENABLED`（enable 前把原值记到临时状态文件，
  disable 恢复），失败时如实告知用户，不谎报。
- 处理器动作执行走「桥接优先、本机子进程兜底」（与 desktop 工具策略一致）；
  结果经 `agent.proactive_message` 推给客户端。
- 失败静默降级（仅记日志），只有会议勿扰开关失败才发消息纠正。

## LLM 工具暴露策略

`desktop.*` 仅在 Complex/delegate/full 模式或桥接在线时进入 LLM 视野
(`resolve-chat-tools.ts` 的 `DESKTOP_VISUAL_PINNED_TOOLS`),Fast/contextual
模式不注入,避免 schema token 污染轻量对话;桥接明确离线时整体剔除
(`dropOfflineDesktopTools`)。
