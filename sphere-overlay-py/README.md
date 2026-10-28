# Sphere Overlay — PySide6 桌宠外壳

替代原有的 `sphere-overlay-tauri`，使用 PySide6 + QWebEngineView 加载 `agent-sphere-avatar` 的构建产物，保留 3D 球机业务逻辑，只替换 UI 容器技术栈。

## 特性

- 无边框、透明背景、始终置顶
- 默认右下角位置，支持前端通过 `window.sphereOverlay` 移动窗口
- 鼠标穿透控制
- 日程悬浮窗
- 系统托盘菜单
- 单实例锁
- WebSocket 连接 PAI server，透传 `agent.embodiment.patch` 情绪事件

## 运行

```powershell
# 安装依赖（首次）
python -m pip install -r requirements.txt

# 确保 agent-sphere-avatar 已构建
# cd ../agent-sphere-avatar && npm run build

# 启动
.\start-sphere-overlay.ps1
```

环境变量：

- `PAI_WS_URL`：默认 `ws://127.0.0.1:3000/ws`
- `PAI_HTTP_BASE`：默认 `http://127.0.0.1:3000`
- `PAI_SESSION_ID` / `PAI_ACTOR_ID` / `PAI_USER_ID`
- `PAI_OVERLAY_DEV_URL`：开发模式前端 dev server URL
- `PAI_AVATAR_DIST`：dist 目录路径，默认 `../agent-sphere-avatar/dist`

## 前端 API

通过 QWebChannel 注入的 `window.sphereOverlay` 与 Tauri preload 完全兼容：

```js
window.sphereOverlay.getWorkArea().then(area => ...);
window.sphereOverlay.moveTo(x, y, animateMs);
window.sphereOverlay.moveBy(dx, dy);
window.sphereOverlay.setPosition(x, y);
window.sphereOverlay.getPosition().then(pos => ...);
window.sphereOverlay.setIgnoreMouseEvents(true);
window.sphereOverlay.setMenuExpanded(true);
window.sphereOverlay.setScheduleCollapsed(false);
const unlistenPatch = window.sphereOverlay.onPatch((patch) => ...);
const unlistenRoam = window.sphereOverlay.onRoam(() => ...);
```
