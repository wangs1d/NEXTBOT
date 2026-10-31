# Agent Sphere Avatar — 独立移植指南

`agent-sphere-avatar/` 是**自包含模块**，所有 3D 渲染、动画、嵌入协议均在此目录内。  
移植到其他项目时，复制整个目录即可，无需改动 PAI 服务端代码。

## 模块边界

```
agent-sphere-avatar/          ← 复制此目录
├── src/                      全部源码（组件、hooks、协议）
├── public/models/            3D 模型资源
├── *.html                    3 个入口（demo / embed / overlay）
├── scripts/                  构建与部署脚本
├── PORTABLE.md               本文档
└── dist/                     npm run build 产物（可单独托管）
```

**可选宿主壳（不属于核心模块）：**

| 目录 | 用途 |
|------|------|
| `sphere-overlay-py/` | PySide6 透明桌宠 |
| `server/web/chat/` | PAI 网页聊天 iframe 宿主 |
| `client/flutter_app/` | Flutter WebView 宿主 |

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

### 3. 宿主页面嵌入 iframe

**推荐模式**（宿主统一管理 WebSocket，避免双连接）：

```html
<iframe
  id="agent-sphere"
  src="/assets/sphere/embed.html?wsOff=1&sessionId=YOUR_SESSION"
  allow="microphone"
></iframe>
```

```javascript
import { createSphereHost } from "./agent-sphere-avatar/src/host-sdk.ts";

const host = createSphereHost({
  frame: "#agent-sphere",
  onReady: () => console.log("sphere ready"),
  onSend: (action, text) => {
    // 用户点击唤醒/对话 → 宿主转发到自己的后端
    if (action === "wake") myBackend.wake();
    if (action === "chat") myBackend.chat(text);
  },
});

// 推送状态
host.patch({ mood: "thinking", energy: 0.72 });
host.command({ action: "roam", strength: 1.1 });
```

纯 HTML 宿主也可直接使用 `postMessage`，见下方协议表。

## 入口 HTML 选择

| 文件 | 场景 | WebSocket |
|------|------|-----------|
| `embed.html` | 网页侧边栏、聊天浮层 | 推荐 `?wsOff=1`，由宿主转发 |
| `overlay.html` | PySide6 桌宠、全屏透明窗 | 直连 WS（传 `?ws=&sessionId=`） |

## postMessage 协议（单一事实来源）

协议常量定义在 `src/embed-protocol.ts`，宿主与 iframe 只需遵守下列消息类型。

### 宿主 → iframe

| type | 字段 | 说明 |
|------|------|------|
| `agent-sphere:patch` | `mood`, `energy`, `caption`, `phase`, … | 更新 Agent 状态 |
| `agent-sphere:command` | `action`, `x`, `y`, `z`, `strength` | 具身指令：roam / move / stop / window_roam / excite |

```javascript
frame.contentWindow.postMessage({
  type: "agent-sphere:patch",
  mood: "speaking",
  energy: 0.85,
  caption: "正在回复…",
}, "*");
```

### iframe → 宿主

| type | 说明 |
|------|------|
| `agent-sphere:ready` | iframe 加载完成 |
| `agent-sphere:send` | 用户交互：`action` = wake / chat / focus |
| `agent-sphere:touch` | 触摸/旋转球体 |
| `agent-sphere:boundary` | 3D 边界碰撞 |
| `agent-sphere:command` | 请求宿主执行 window_roam 等 |
| `agent-sphere:pan` | Shift/Alt 拖动浮层位移 |

## 公共 API 导出

```typescript
// 完整 API
import { ... } from "agent-sphere-avatar";

// 仅协议常量
import { SPHERE_MSG, postPatchToSphere } from "agent-sphere-avatar/protocol";

// 宿主 SDK
import { createSphereHost, buildEmbedUrl } from "agent-sphere-avatar/host-sdk";

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

1. **纯 postMessage** — 宿主自行维护 WebSocket，`wsOff=1` 模式下 iframe 零网络连接
2. **直连 WebSocket** — 传 `?ws=wss://...&sessionId=...`，iframe 内 `useAgentWebSocket` 处理
3. **参考 WS 映射** — `src/bridge/ws-agent-mapper.ts` 展示如何将聊天事件映射为 mood/energy

若你的后端事件格式不同，只需在宿主侧调用 `host.patch()`，无需修改 avatar 源码。

## 目录内文件职责

| 路径 | 职责 |
|------|------|
| `src/embed-protocol.ts` | postMessage 协议常量与解析 |
| `src/host-sdk.ts` | 宿主侧 iframe 集成 SDK |
| `src/public-api.ts` | 模块公共导出入口 |
| `src/bridge/ws-agent-mapper.ts` | WS 事件 → AgentState（可替换） |
| `src/components/` | 3D 场景与模型 |
| `src/hooks/` | 动画、WS、嵌入桥接 |
| `src/modes/` | embed / overlay 壳组件 |

## 常见问题

**Q: 能否作为 npm 包发布？**  
可以。`package.json` 已配置 `exports` 与 `files` 字段，发布前将 `private` 改为 `false`。

**Q: 模型资源可以换吗？**  
CAD 源文件放 `source/DG2.fbx`（Fusion 导出，组件名见 `scripts/build-model.mjs` 里的 `PART_NAMES`），
跑 `npm run model` 转出 `public/models/DG2.glb`；比例不对时再调 `src/constants/model-proportions.ts`。

**Q: 不需要独立桌宠？**  
只复制 `agent-sphere-avatar/`，忽略 `sphere-overlay-py/` 即可。
