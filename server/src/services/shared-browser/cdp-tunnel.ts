import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

/**
 * 客户端内置浏览器的 CDP 隧道（2026-11-22）。
 *
 * 要解决的问题：桌面端的「内置浏览器」是客户端本机的 WebView2，调试端口
 * 只绑 **127.0.0.1**（安全设计，不能对外监听）。服务端一旦部署在云端，
 * Playwright 去连 `http://127.0.0.1:9333` 连的是服务器自己——永远连不上，
 * 于是每次比价都回落到云端无头浏览器，用户在桌面面板里什么也看不到。
 *
 * 做法：服务端在**自己**的回环上开一个 TCP 监听，把每条连接原样转发给
 * 客户端（经已认证的聊天 WS），客户端再连它本机的调试端口。这样 Playwright
 * 看到的就是「127.0.0.1 上的一个 CDP 端点」，而实际流量穿过 WS 到达用户电脑。
 *
 * 为什么是**裸 TCP 透传**而不是自己解析 HTTP/WS：
 *   Playwright 的 connectOverCDP 会先 GET `/json/version`，拿到它返回的
 *   `webSocketDebuggerUrl` 再建 WebSocket。Chromium 是用**请求的 Host 头**
 *   拼这个 URL 的，我们原样透传 Host，回来就正好指向这个代理端口——不需要
 *   改写任何响应体，升级后的 WS 帧也是字节透传。少一层解析就少一类诡异 bug。
 *
 * 边界与安全：
 *   - 监听只绑 127.0.0.1，端口随机；每个 actor 独立一个监听，互不串台；
 *   - 隧道只能到客户端自己**已开**的调试端口，服务端指定不了目标主机；
 *   - 客户端 socket 断开即回收监听与全部隧道，不留僵尸连接。
 */

export type CdpTunnelSend = (actorId: string, payload: Record<string, unknown>) => boolean;

type Tunnel = {
  actorId: string;
  socket: Socket;
  /** 客户端连上本机调试端口之前，服务端侧先到的字节先排这里。 */
  queue: Buffer[];
  opened: boolean;
};

/** 单 actor 同时开的隧道上限（Playwright 一般 1 条 HTTP + 1 条 WS）。 */
const MAX_TUNNELS_PER_ACTOR = 12;
/** 单隧道待发队列上限（防客户端迟迟不 opened 时内存堆积）。 */
const MAX_QUEUED_CHUNKS = 64;

export class CdpTunnelHub {
  private readonly listeners = new Map<string, { server: Server; port: number }>();
  private readonly starting = new Map<string, Promise<string | null>>();
  private readonly tunnels = new Map<string, Tunnel>();

  constructor(private readonly deps: { send: CdpTunnelSend }) {}

  /** 该 actor 的代理端点（`http://127.0.0.1:<port>`）；不可用时 null。 */
  async endpointFor(actorId: string): Promise<string | null> {
    const existing = this.listeners.get(actorId);
    if (existing) return `http://127.0.0.1:${existing.port}`;
    const inflight = this.starting.get(actorId);
    if (inflight) return inflight;
    const p = this.listen(actorId).finally(() => this.starting.delete(actorId));
    this.starting.set(actorId, p);
    return p;
  }

  private async listen(actorId: string): Promise<string | null> {
    try {
      const server = createServer((socket) => this.onConnection(actorId, socket));
      // 优先绑客户端同号端口（9333）：Chromium 拼 webSocketDebuggerUrl 时
      // 若用的是自己的端口而不是请求 Host，同号也能落回这个代理；占用了
      // 就退到系统分配端口（此时靠 Host 头回指，正常实现同样成立）。
      const preferred = Number(process.env.CDP_TUNNEL_PORT ?? 9333);
      const port = await new Promise<number | null>((resolve) => {
        const tryListen = (p: number, fallback: boolean) => {
          const onError = () => {
            if (fallback) resolve(0);
            else tryListen(0, true);
          };
          server.once("error", onError);
          server.listen(p, "127.0.0.1", () => {
            server.removeListener("error", onError);
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : 0);
          });
        };
        tryListen(Number.isFinite(preferred) && preferred > 0 ? preferred : 0, false);
      });
      if (!port) {
        server.close();
        return null;
      }
      server.on("error", (err) => {
        console.log(`[cdp-tunnel] 代理监听出错（${actorId}）：${err.message}`);
      });
      this.listeners.set(actorId, { server, port });
      console.log(`[cdp-tunnel] ${actorId} 代理就绪 http://127.0.0.1:${port}`);
      return `http://127.0.0.1:${port}`;
    } catch (err) {
      console.log(
        `[cdp-tunnel] 开代理失败（${actorId}）：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private onConnection(actorId: string, socket: Socket): void {
    const active = [...this.tunnels.values()].filter((t) => t.actorId === actorId).length;
    if (active >= MAX_TUNNELS_PER_ACTOR) {
      console.log(`[cdp-tunnel] ${actorId} 隧道过多（${active}），拒绝新连接`);
      socket.destroy();
      return;
    }
    const tunnelId = randomUUID();
    const tunnel: Tunnel = { actorId, socket, queue: [], opened: false };
    this.tunnels.set(tunnelId, tunnel);

    const sent = this.deps.send(actorId, {
      type: "browser.cdp.open",
      payload: { tunnelId },
    });
    if (!sent) {
      this.tunnels.delete(tunnelId);
      socket.destroy();
      return;
    }

    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      if (!tunnel.opened) {
        if (tunnel.queue.length < MAX_QUEUED_CHUNKS) tunnel.queue.push(chunk);
        return;
      }
      this.deps.send(actorId, {
        type: "browser.cdp.data",
        payload: { tunnelId, data: chunk.toString("base64") },
      });
    });
    const cleanup = () => {
      if (!this.tunnels.delete(tunnelId)) return;
      this.deps.send(actorId, { type: "browser.cdp.close", payload: { tunnelId } });
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  /** 客户端已连上本机调试端口：把排队字节放行。 */
  handleOpened(actorId: string, tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.actorId !== actorId) return;
    tunnel.opened = true;
    for (const chunk of tunnel.queue.splice(0)) {
      this.deps.send(actorId, {
        type: "browser.cdp.data",
        payload: { tunnelId, data: chunk.toString("base64") },
      });
    }
  }

  /** 客户端回传的字节（base64）→ 写回 Playwright 侧连接。 */
  handleData(actorId: string, tunnelId: string, base64: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.actorId !== actorId) return;
    try {
      tunnel.socket.write(Buffer.from(base64, "base64"));
    } catch {
      /* 对端已关：等 close 事件统一清理 */
    }
  }

  /** 客户端侧隧道关闭。 */
  handleClosed(actorId: string, tunnelId: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel || tunnel.actorId !== actorId) return;
    this.tunnels.delete(tunnelId);
    tunnel.socket.destroy();
  }

  /** 测试/运维用：该 actor 当前的代理端口（0 = 没开）。 */
  listenerPortFor(actorId: string): number {
    return this.listeners.get(actorId)?.port ?? 0;
  }

  /** 客户端连接断开：监听与隧道一并回收（重连后按需重建）。 */
  disposeActor(actorId: string): void {
    const listener = this.listeners.get(actorId);
    if (listener) {
      this.listeners.delete(actorId);
      try {
        listener.server.close();
      } catch {
        /* ignore */
      }
    }
    for (const [id, tunnel] of this.tunnels) {
      if (tunnel.actorId !== actorId) continue;
      this.tunnels.delete(id);
      // 先告诉客户端关掉本机那条连接，再毁服务端侧（避免对方 socket 悬挂）
      this.deps.send(actorId, { type: "browser.cdp.close", payload: { tunnelId: id } });
      tunnel.socket.destroy();
    }
  }

  /** 进程退出 / 测试收尾。 */
  dispose(): void {
    for (const actorId of [...this.listeners.keys()]) this.disposeActor(actorId);
  }
}
