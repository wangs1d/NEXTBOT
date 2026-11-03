import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";

/**
 * 发布事件流订阅：口令走 x-manifest-event-token 请求头，不再拼进 URL —— 整条 URL
 * （含 query）会原样落进对端 nginx access.log 与本进程请求日志，等于把控制面凭证
 * 常驻写盘（query 形式一律不授权）。另覆盖订阅侧三条真实故障形态：清单变化是否
 * 真的广播给在线连接、停机能否掐断自己那条长连接、口令被拒后是否还空转重连。
 *
 * 运行：npx tsx --test test/manifest-event-token-transport.test.ts
 */

const { MANIFEST_EVENT_TOKEN_HEADER, manifestEventAuthorized } = await import(
  "../src/routes/http/internal-manifest-events.js"
);
const { subscribeTarget, startClientUpdatePusher, stopClientUpdatePusher } = await import(
  "../src/services/client-update-pusher.js"
);
type PushManifest = {
  latest: string;
  minVersion: string;
  url: string;
  notes: string;
  channel: string;
};

const TOKEN = "nbtok_manifest_ev_test-value_0001";
const env = { MANIFEST_EVENT_TOKEN: TOKEN } as NodeJS.ProcessEnv;

test("请求头口令放行", () => {
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: TOKEN }, env), true);
});

test("query 口令不再参与授权：只认 x-manifest-event-token 头", () => {
  // 旧 ?token= 形式的等价形态（口令出现在参数里而不是头里）一律拒
  assert.equal(manifestEventAuthorized({ token: TOKEN }, env), false);
  assert.equal(manifestEventAuthorized({}, env), false);
});

test("口令不符 / 缺失 / 头是数组都拒", () => {
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: "wrong" }, env), false);
  assert.equal(manifestEventAuthorized({}, env), false);
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: [TOKEN] }, env), false);
});

test("未配置 MANIFEST_EVENT_TOKEN 时端点整体禁用（即使带上看起来对的口令）", () => {
  assert.equal(manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: TOKEN }, {}), false);
  assert.equal(
    manifestEventAuthorized({ [MANIFEST_EVENT_TOKEN_HEADER]: TOKEN }, { MANIFEST_EVENT_TOKEN: "  " }),
    false,
  );
});

test("订阅端构造的目标 URL 不含口令，口令单独成字段", () => {
  process.env.UPDATE_MANIFEST_SOURCE_URL = "https://control-plane.example";
  process.env.UPDATE_MANIFEST_EVENT_TOKEN = TOKEN;
  const built = subscribeTarget();
  assert.ok(built);
  assert.equal(built.url, "https://control-plane.example/api/internal/manifest-events");
  assert.equal(built.token, TOKEN);
  assert.ok(!built.url.includes(TOKEN), "URL 里不得出现口令");
  delete process.env.UPDATE_MANIFEST_SOURCE_URL;
  delete process.env.UPDATE_MANIFEST_EVENT_TOKEN;
});

test("源地址或口令任一缺失则不订阅", () => {
  delete process.env.UPDATE_MANIFEST_SOURCE_URL;
  delete process.env.UPDATE_MANIFEST_EVENT_TOKEN;
  assert.equal(subscribeTarget(), null);
  process.env.UPDATE_MANIFEST_SOURCE_URL = "https://control-plane.example";
  assert.equal(subscribeTarget(), null);
});

// ─── 订阅侧三条真实故障形态（本地假控制面，零外部依赖）───

const M_0_2_0: PushManifest = {
  latest: "0.2.0",
  minVersion: "0.1.0",
  url: "https://login.nextbot.top/downloads/Nextbot-Setup.exe",
  notes: "第一条",
  channel: "byok",
};
const M_0_2_1: PushManifest = { ...M_0_2_0, latest: "0.2.1", notes: "第二条" };

const RECONNECT_WAIT_MS = 3_400; // 订阅侧重连退避 3s，跨过它才能证明"不再重连"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`等待超时：${label}`);
    await sleep(25);
  }
}

/** 本地假"更新控制面"：SSE 长连接，push() 向当前所有连接追加一帧清单 */
async function createManifestSource(
  opts: { rejectStatus?: number } = {},
): Promise<{
  url: string;
  attempts: () => number;
  openConnections: () => number;
  push: (m: PushManifest) => void;
  close: () => Promise<void>;
}> {
  let attempts = 0;
  const live = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    attempts++;
    if (opts.rejectStatus) {
      res.writeHead(opts.rejectStatus, { "content-type": "application/json" });
      res.end('{"ok":false,"error":"forbidden"}');
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    live.add(res);
    res.on("close", () => live.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    attempts: () => attempts,
    openConnections: () => live.size,
    push: (m) => {
      for (const res of live) res.write(`data: ${JSON.stringify({ edition: null, manifest: m })}\n\n`);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function stubRegistry(received: string[]): WsConnectionRegistry {
  return { broadcastAll: (data: string) => received.push(data) } as unknown as WsConnectionRegistry;
}

test("清单变化沿订阅链广播给在线连接：首帧只入缓存、变化即广播、同内容静默", async () => {
  const src = await createManifestSource();
  const received: string[] = [];
  process.env.UPDATE_MANIFEST_SOURCE_URL = src.url;
  process.env.UPDATE_MANIFEST_EVENT_TOKEN = TOKEN;
  startClientUpdatePusher(stubRegistry(received));

  await waitFor(() => src.openConnections() === 1, "订阅连接建立");
  src.push(M_0_2_0); // 首帧：只入缓存
  await sleep(150);
  assert.deepEqual(received, [], "服务启动的首帧不该广播（重启不该打扰在线用户）");

  src.push(M_0_2_1); // 变化：广播
  await waitFor(() => received.length === 1, "变化清单广播");
  const msg = JSON.parse(received[0]) as {
    type: string;
    payload: { manifest: PushManifest };
  };
  assert.equal(msg.type, "update.available");
  assert.equal(msg.payload.manifest.latest, "0.2.1");

  src.push(M_0_2_1); // 同内容重复帧（重连校准会再来一遍）
  await sleep(150);
  assert.equal(received.length, 1, "内容未变不得重复广播");

  stopClientUpdatePusher();
  await src.close();
});

test("停机终止订阅并掐断自己在握的长连接（否则 app.close() 拖到 SIGKILL）", async () => {
  const src = await createManifestSource();
  process.env.UPDATE_MANIFEST_SOURCE_URL = src.url;
  process.env.UPDATE_MANIFEST_EVENT_TOKEN = TOKEN;
  startClientUpdatePusher(stubRegistry([]));
  await waitFor(() => src.openConnections() === 1, "订阅连接建立");

  stopClientUpdatePusher();
  await waitFor(() => src.openConnections() === 0, "停机后长连接被关闭");
  const attemptsAtStop = src.attempts();
  await sleep(RECONNECT_WAIT_MS);
  assert.equal(src.attempts(), attemptsAtStop, "停机后不得再重连");

  await src.close();
});

test("口令被控制面拒绝（403）时终止订阅，不再每 3 秒空转重连", async () => {
  const src = await createManifestSource({ rejectStatus: 403 });
  const received: string[] = [];
  process.env.UPDATE_MANIFEST_SOURCE_URL = src.url;
  process.env.UPDATE_MANIFEST_EVENT_TOKEN = "wrong-token";
  startClientUpdatePusher(stubRegistry(received));
  await waitFor(() => src.attempts() >= 1, "首次订阅请求到达");
  await sleep(RECONNECT_WAIT_MS);
  assert.equal(src.attempts(), 1, "被拒即终止：只敲一次门");

  stopClientUpdatePusher();
  await src.close();
});
