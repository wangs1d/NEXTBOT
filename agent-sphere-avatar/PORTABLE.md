# Agent Sphere Avatar — 独立移植指南

`agent-sphere-avatar/` 是**自包含模块**，所有 3D 渲染、动画、宿主协议均在此目录内。  
移植到其他项目时，复制整个目录即可，无需改动 PAI 服务端代码。

## 模块边界

```
agent-sphere-avatar/          ← 复制此目录
├── src/                      全部源码（组件、hooks、协议）
├── public/models/            3D 模型资源
├── *.html                    3 个入口（overlay / schedule-floating / face-debug）
├── scripts/                  构建与部署脚本
├── PORTABLE.md               本文档
└── dist/                     npm run build 产物（可单独托管）
```

**可选宿主壳（不属于核心模块）：**

| 目录 | 用途 |
|------|------|
| `sphere-overlay-py/` | PySide6 透明桌宠 |

## 快速移植（3 步）

### 1. 复制并构建

```bash
cp -r agent-sphere-avatar /path/to/your-project/
cd /path/to/your-project/agent-sphere-avatar
npm install
npm run build:standalone    # 产出 dist/，使用相对路径 ./
```

### 2. 静态托管 dist/

将 `dist/` 部署到任意 Web 服务器，例如：

- `https://your-app.com/assets/sphere/`
- 本地 `file://` 或 Vite/Nginx 静态目录

如需自定义 URL 前缀：

```bash
node scripts/build-with-env.mjs /assets/sphere/
```

或设置环境变量 `AVATAR_PUBLIC_PATH=/assets/sphere/` 后 `npm run build`。

### 3. 以桌宠形式运行（sphere-overlay-py）

桌宠是独立 PySide6 进程，加载 `dist/overlay.html` 并直连 WebSocket：

```powershell
cd sphere-overlay-py
.\start-sphere-overlay.ps1
```

环境变量见 `sphere-overlay-py/README.md`（`PAI_WS_URL` / `PAI_SESSION_ID` / `PAI_AVATAR_DIST` 等）。

## 入口 HTML

| 文件 | 场景 | WebSocket |
|------|------|-----------|
| `overlay.html` | PySide6 桌宠、全屏透明窗 | 直连 WS（传 `?ws=&sessionId=`） |
| `schedule-floating.html` | 日程悬浮小部件 | 直连 WS |
| `face-debug.html` | 面部调试工具 | 无 |

## 宿主协议（单一事实来源）

协议常量定义在 `src/embed-protocol.ts`。

### CustomEvent（同页集成，`src/bridge/agent-bridge.ts`）

| 事件 | 字段 | 说明 |
|------|------|------|
| `agent-sphere:set-mood` | `mood` | 更新情绪 |
| `agent-sphere:set-energy` | `energy` | 更新能量 |
| `agent-sphere:set-caption` | `caption` | 台词气泡 |
| `agent-sphere:command` | `action`, `x`, `y`, `z`, `strength` | 具身指令：roam / move / stop / window_roam / excite |

```javascript
window.dispatchEvent(new CustomEvent("agent-sphere:command", {
  detail: { action: "roam", strength: 1.1 },
}));
```

### postMessage（宿主父级转发，`useEmbodimentCommandRelay` 接收）

| type | 字段 | 说明 |
|------|------|------|
| `agent-sphere:command` 或 `agent.embodiment.command` | `action`, `x`, `y`, `z`, `strength` | 具身指令 |

## 模块导出

```typescript
// 协议常量与解析
import { SPHERE_HOST_MSG, SPHERE_DOM_EVENT, parseHostCommand } from "agent-sphere-avatar/protocol";

// WS 事件映射（对接自有后端时参考）
import { mapWsToAgentUpdate } from "agent-sphere-avatar/ws-mapper";
```

## PAI 项目内部署

在本仓库中，构建并复制到 chat 静态资源：

```bash
cd agent-sphere-avatar
npm run build:chat    # base=/chat/assets/avatar/ + 复制到 server/web/chat/assets/avatar/
```

环境变量（见 `.env.example`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `AVATAR_PUBLIC_PATH` | `./` | Vite base 路径 |
| `AVATAR_DEPLOY_DIR` | `../server/web/chat/assets/avatar` | build:chat 复制目标 |

## 与后端对接

模块**不强制** PAI 服务端。对接方式：

1. **直连 WebSocket** — 传 `?ws=wss://...&sessionId=...`，页面内 `useAgentWebSocket` 处理
2. **参考 WS 映射** — `src/bridge/ws-agent-mapper.ts` 展示如何将聊天事件映射为 mood/energy

若你的后端事件格式不同，可在宿主侧派发 CustomEvent 或 postMessage 具身指令，无需修改 avatar 源码。

## 目录内文件职责

| 路径 | 职责 |
|------|------|
| `src/embed-protocol.ts` | 具身指令协议常量与解析 |
| `src/bridge/agent-bridge.ts` | CustomEvent 同页集成桥 |
| `src/bridge/ws-agent-mapper.ts` | WS 事件 → AgentState（可替换） |
| `src/components/` | 3D 场景与模型 |
| `src/hooks/` | 动画、WS、宿主指令中继 |
| `src/modes/` | OverlayApp 桌宠壳 |

## 常见问题

**Q: 能否作为 npm 包发布？**  
可以。`package.json` 已配置 `exports`（`./protocol`、`./ws-mapper`）与 `files` 字段，发布前将 `private` 改为 `false`。

**Q: 模型资源可以换吗？**  
CAD 源文件放 `source/DG2.fbx`（Fusion 导出，组件名见 `scripts/build-model.mjs` 里的 `PART_NAMES`），
跑 `npm run model` 转出 `public/models/DG2.glb`；比例不对时再调 `src/constants/model-proportions.ts`。

**Q: 不需要独立桌宠？**  
只复制 `agent-sphere-avatar/`，忽略 `sphere-overlay-py/` 即可。
