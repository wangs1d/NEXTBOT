/**
 * 旅游规划根修效果演示服务（2026-11-13）。
 *
 * 静态托管 index.html（手机壳 UI）+ 把 /api/* 反代到本机 3000 的
 * /travel/plan-session* 真实 API——演示页里每一次点选都是真后端、真 LLM
 * 编排驱动的，不是 mock。
 *
 * 运行：PATH=/d/nodejs:$PATH node scratch/travel-planner-demo/server.mjs
 * 打开：http://127.0.0.1:3001/
 * 后端：需 127.0.0.1:3000 有 NextBot server（npm run dev:all 或单独起 server）。
 */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT ?? 3001);
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    const backendPath = url.pathname.replace(/^\/api/, "");
    const proxyReq = httpRequest(
      {
        host: BACKEND_HOST,
        port: BACKEND_PORT,
        path: backendPath + url.search,
        method: req.method,
        headers: { "content-type": "application/json" },
        timeout: 240_000,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { "content-type": "application/json" });
        up.pipe(res);
      },
    );
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "后端超时（真实生成最长可到 120s，请稍后重试）" }));
    });
    proxyReq.on("error", () => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: "后端（127.0.0.1:3000）未连接——请先启动 NextBot dev server，然后刷新本页重试",
      }));
    });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => proxyReq.end(body || undefined));
    return;
  }

  if (url.pathname === "/healthz") {
    const probe = httpRequest(
      { host: BACKEND_HOST, port: BACKEND_PORT, path: "/travel/plan-session/_meta", method: "GET", timeout: 4000 },
      (up) => {
        res.writeHead(200, { "content-type": "application/json" });
        up.pipe(res);
      },
    );
    probe.on("timeout", () => { probe.destroy(); res.writeHead(200, {"content-type":"application/json"}); res.end('{"backend":"timeout"}'); });
    probe.on("error", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ backend: "down" }));
    });
    probe.end();
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const data = readFileSync(join(ROOT, file));
    res.writeHead(200, { "content-type": MIME[join(ROOT, file).split(".").pop()] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`[travel-demo] http://127.0.0.1:${PORT}/  → backend 127.0.0.1:${BACKEND_PORT}`);
});
