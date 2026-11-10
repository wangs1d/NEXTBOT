// HTTP 路由：云端无头浏览器自检（2026-11-10）。
//
// GET /api/browser/health —— 真实 launch 一次 Chromium（headless → newPage → close），
// 验证 playwright 模块 + 浏览器二进制 + 系统依赖三者齐备。这是手机端比价/下单/
// 预订的唯一执行通道（手机没有内置浏览器，全部走服务端无头）；部署脚本把它当
// 终验条件——npm ci 只装 playwright 模块、永不装浏览器二进制，缺了它
// agent_browser.*/shopping.* 全部 "Executable doesn't exist"。
//
// 公开路径（无用户数据、无副作用，deploy 脚本本地 curl 不带设备 token）。
import type { FastifyInstance } from "fastify";

import { loadPlaywright } from "../../services/browser-runtime/browser-runtime.js";

const HEALTH_TIMEOUT_MS = 10_000;

export function registerBrowserHealthRoutes(app: FastifyInstance): void {
  app.get("/api/browser/health", async () => {
    const startedAt = Date.now();
    const pw = await loadPlaywright();
    if (!pw) {
      return {
        ok: false,
        reason: "playwright_module_missing",
        hint: "server 依赖缺 playwright（生产依赖，npm ci 不应缺失）；执行 npm ci 后重试",
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const browser = await Promise.race([
        pw.chromium.launch({ headless: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("chromium launch timeout")), HEALTH_TIMEOUT_MS),
        ),
      ]);
      const version = browser.version();
      const page = await browser.newPage();
      await page.setContent("<title>ok</title>");
      const title = await page.title();
      await browser.close();
      return {
        ok: true,
        engine: version,
        probe: title,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        reason: message.includes("Executable doesn't exist")
          ? "chromium_binary_missing"
          : "chromium_launch_failed",
        detail: message.slice(0, 400),
        hint: message.includes("Executable doesn't exist")
          ? "执行: npx playwright install chromium（deploy-ecs.ps1 已内置幂等安装步）"
          : "多为系统依赖缺失：npx playwright install-deps chromium",
        durationMs: Date.now() - startedAt,
      };
    }
  });
}
