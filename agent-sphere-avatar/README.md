# Agent Sphere Avatar

可**独立移植**的球形 3D Agent 形象 — 基于 **Three.js + React Three Fiber (R3F) + Cannon.js**。

> 移植到其他项目请参阅 **[PORTABLE.md](./PORTABLE.md)**

## 设计要点

| 模块 | 说明 |
|------|------|
| **DG2RobotModel** | OBJ 一比一还原深灰金属球形机器人 |
| **ScreenFace** | 曲屏表情与交互 |
| **SphereAgent** | 用户拖拽 / 具身指令响应 |
| **useAgentWebSocket** | 可选直连 `/ws` |
| **embed-protocol** | 宿主指令协议（postMessage / CustomEvent 单一事实来源） |

## 快速开始

```bash
cd agent-sphere-avatar
npm install
npm run dev              # 桌宠开发 http://localhost:5180/overlay.html
npm run build:standalone # 独立静态包 dist/（相对路径，可任意部署）
npm run build:chat       # PAI 内部：部署到 server/web/chat/assets/avatar/
```

### 桌面悬浮

```powershell
cd sphere-overlay-py
.\start-sphere-overlay.ps1
```

## 入口 HTML

| 文件 | 用途 |
|------|------|
| `overlay.html` | PySide6 桌面桌宠 |
| `schedule-floating.html` | 日程悬浮小部件 |
| `face-debug.html` | 面部调试工具 |

## 目录结构

```
agent-sphere-avatar/          ← 独立模块，可直接复制
├── src/
│   ├── embed-protocol.ts     # 宿主指令协议（移植时必读）
│   ├── bridge/ws-agent-mapper.ts
│   ├── hooks/
│   ├── modes/                # OverlayApp 桌宠壳
│   └── components/
├── public/models/
├── scripts/
├── PORTABLE.md               # 移植指南
└── dist/                     # 构建产物
```

## WebSocket 状态映射（可选）

对接自有后端时参考 `ws-agent-mapper.ts`：

| 服务端事件 | Agent 状态 |
|-----------|-----------|
| 用户发消息 | `listening` |
| `chat.agent_status` / `tool.call` | `thinking` |
| `chat.assistant_chunk` | `speaking` |
| `chat.assistant_done` | `happy` → `idle` |
| `error.event` | `alert` |

## PAI 项目集成点

| 宿主 | 加载路径 |
|------|----------|
| PySide6 桌宠 | `dist/overlay.html`（sphere-overlay-py 进程加载） |
