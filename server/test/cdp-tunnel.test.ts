/**
 * CDP over WS 隧道回归（2026-11-22）。
 *
 * 为什么要有这个测试：云端部署下「桌面端用自己的内置浏览器」全靠这条隧道——
 * Playwright 连服务端本机的代理端口，字节经聊天 WS 转到用户电脑的 WebView2
 * 调试端口。它一旦不通，症状是「面板打开了但什么都不动」，极难从日志看出来。
 *
 * 这里用一个回环 echo 服务冒充客户端调试端口，验证：端点在本机、open→opened
 * 的排队放行、双向字节透传、关闭回收。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Socket, createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";

import { CdpTunnelHub } from "../src/services/shared-browser/cdp-tunnel.js";

type Sent = { type: string; payload: Record<string, unknown> };

/** 冒充客户端：收到 open 就连 echo 端口，双向搬运字节。 */
function makeFakeClient(echoPort: number, sent: Sent[]) {
  const sockets = new Map<string, Socket>();
  return (actorId: string, payload: Record<string, unknown>): boolean => {
    assert.equal(actorId, "u-tunnel");
    const type = String(payload.type);
    const tunnelId = String((payload.payload as Record<string, unknown>)?.tunnelId ?? "");
    sent.push({ type, payload: payload.payload as Record<string, unknown> });
    if (type === "browser.cdp.open") {
      const socket = new Socket();
      sockets.set(tunnelId, socket);
      socket.connect(echoPort, "127.0.0.1", () => {
        hubRef!.handleOpened(actorId, tunnelId);
      });
      socket.on("data", (chunk) => {
        hubRef!.handleData(actorId, tunnelId, chunk.toString("base64"));
      });
      socket.on("error", () => {});
    } else if (type === "browser.cdp.data") {
      sockets.get(tunnelId)?.write(
        Buffer.from(String((payload.payload as Record<string, unknown>).data ?? ""), "base64"),
      );
    } else if (type === "browser.cdp.close") {
      sockets.get(tunnelId)?.destroy();
      sockets.delete(tunnelId);
    }
    return true;
  };
}

let hubRef: CdpTunnelHub | null = null;

/** 关掉 echo 服务：close 会等既有连接结束，加超时防测试挂死。 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startEcho(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}

test("隧道：代理端点在本机，字节双向透传（open → opened → data）", async () => {
  const echo = await startEcho();
  const sent: Sent[] = [];
  hubRef = null;
  const hub = new CdpTunnelHub({ send: makeFakeClient(echo.port, sent) });
  hubRef = hub;
  try {
    const endpoint = await hub.endpointFor("u-tunnel");
    assert.ok(endpoint, "应拿得到代理端点");
    assert.match(endpoint!, /^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(new URL(endpoint!).port);

    const client = new Socket();
    await new Promise<void>((resolve, reject) => {
      client.connect(port, "127.0.0.1", () => resolve());
      client.on("error", reject);
    });
    const received = new Promise<string>((resolve) => {
      client.once("data", (chunk) => resolve(chunk.toString("utf8")));
    });
    client.write("GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    const echoed = await received;
    assert.match(echoed, /GET \/json\/version/);
    assert.ok(
      sent.some((m) => m.type === "browser.cdp.open"),
      "服务端应下发 open",
    );
    assert.ok(
      sent.some((m) => m.type === "browser.cdp.data"),
      "服务端应把字节转成 data",
    );
    client.destroy();
  } finally {
    hub.dispose();
    await closeServer(echo.server);
  }
});

test("隧道：执行端不在线时 endpointFor 仍可建立代理，但连接会被立刻断开", async () => {
  const sent: Sent[] = [];
  const hub = new CdpTunnelHub({ send: () => false });
  try {
    const endpoint = await hub.endpointFor("u-tunnel");
    assert.ok(endpoint);
    const port = Number(new URL(endpoint!).port);
    const client = new Socket();
    client.on("error", () => {});
    await new Promise<void>((resolve) => {
      client.connect(port, "127.0.0.1", () => resolve());
    });
    const closed = await new Promise<boolean>((resolve) => {
      client.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    assert.equal(closed, true, "无执行端时连接必须被关掉，不能挂住");
    assert.equal(sent.length, 0);
  } finally {
    hub.dispose();
  }
});

test("隧道：disposeActor 收回监听（重连后按需重建）", async () => {
  const echo = await startEcho();
  const sent: Sent[] = [];
  const hub = new CdpTunnelHub({ send: makeFakeClient(echo.port, sent) });
  hubRef = hub;
  try {
    const first = await hub.endpointFor("u-tunnel");
    assert.ok(first);
    hub.disposeActor("u-tunnel");
    assert.equal(hub.listenerPortFor("u-tunnel"), 0, "监听应已回收");
    const second = await hub.endpointFor("u-tunnel");
    assert.ok(second);
  } finally {
    hub.dispose();
    await closeServer(echo.server);
  }
});
