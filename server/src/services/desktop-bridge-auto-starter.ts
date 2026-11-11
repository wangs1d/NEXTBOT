import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { getDesktopVisualPaths } from "./desktop-visual-subprocess.js";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isBridgeFeatureEnabled(env: NodeJS.ProcessEnv): boolean {
  if (parseBooleanEnv(env.DESKTOP_BRIDGE_ENABLED)) return true;
  return (env.DESKTOP_BRIDGE_TOKEN?.trim().length ?? 0) >= 8;
}

/** 默认随 server 启动本机桥接；设 DESKTOP_BRIDGE_AUTO_START=0 可关闭。 */
export function shouldAutoStartDesktopBridge(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isBridgeFeatureEnabled(env)) return false;
  const raw = env.DESKTOP_BRIDGE_AUTO_START?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

export type DesktopBridgeAutoStarterOptions = {
  port: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

/**
 * 在本机 spawn Python `bridge_ws_client`，连接同一进程的 WebSocket（手机↔PC 桌面能力）。
 * 适用于 server 与用户 PC 在同一台机器上的开发/单机部署。
 */
export function startDesktopBridgeAutoClient(opts: DesktopBridgeAutoStarterOptions): () => void {
  const env = opts.env ?? process.env;
  if (!shouldAutoStartDesktopBridge(env)) {
    return () => {};
  }

  const log = opts.log ?? ((line: string) => console.log(line));
  const { pythonExe, packageRoot } = getDesktopVisualPaths(env);
  const modulePath = join(packageRoot, "desktop_visual");
  if (!existsSync(modulePath)) {
    log(`[desktop-bridge] 跳过自启动：未找到 ${packageRoot}`);
    return () => {};
  }

  const wsHost = env.DESKTOP_BRIDGE_WS_HOST?.trim() || "127.0.0.1";
  const wsUrl =
    env.DESKTOP_BRIDGE_WS_URL?.trim() || `ws://${wsHost}:${opts.port}/ws`;
  // 强鉴权后占位身份不再代表任何账号：绑到 session-mvp-001 只会让执行器
  // 挂在共享桶上，主通道（邮箱 / inst_…）永远查不到它。没有显式用户时
  // 宁可不启动，也不要制造「看起来在跑」的假象（2026-11-11 身份收尾）。
  const userId =
    env.DESKTOP_BRIDGE_USER_ID?.trim() ||
    env.DESKTOP_BRIDGE_AUTO_USER_ID?.trim();
  if (!userId) {
    log(
      "[desktop-bridge] 跳过自启动：未配置 DESKTOP_BRIDGE_USER_ID。" +
        "强鉴权下不能用 session-mvp-001 这类占位身份绑定桌面执行器。",
    );
    return () => {};
  }

  let stopped = false;
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    DESKTOP_BRIDGE_WS_URL: wsUrl,
    DESKTOP_BRIDGE_USER_ID: userId,
    DESKTOP_BRIDGE_SESSION_ID: env.DESKTOP_BRIDGE_SESSION_ID?.trim() || "pc-bridge",
    PYTHONUNBUFFERED: "1",
  };

  const spawnOnce = (): void => {
    if (stopped) return;
    child = spawn(pythonExe, ["-u", "-m", "desktop_visual.bridge_ws_client"], {
      cwd: packageRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[desktop-bridge] ${line}`);
      }
    });
    child.stderr.on("data", (buf) => {
      for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        log(`[desktop-bridge] ${line}`);
      }
    });

    child.on("error", (err) => {
      log(`[desktop-bridge] 进程错误: ${err instanceof Error ? err.message : String(err)}`);
      scheduleRestart(5_000);
    });

    child.on("close", (code) => {
      child = null;
      if (stopped) return;
      log(`[desktop-bridge] 进程退出 code=${code ?? "?"}，2s 后重连…`);
      scheduleRestart(2_000);
    });
  };

  const scheduleRestart = (delayMs: number): void => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnOnce();
    }, delayMs);
  };

  log(
    `[desktop-bridge] 随 server 自启动 → ${wsUrl} userId=${userId}（DESKTOP_BRIDGE_AUTO_START=0 可关闭）`,
  );
  spawnOnce();

  return () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      child = null;
    }
  };
}
