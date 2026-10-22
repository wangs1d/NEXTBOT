import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolvePrimaryExternalModelBinding } from "../external-model/resolve-provider.js";
import {
  OpenClawGatewayClient,
  isWechatClawFeatureEnabled,
  readOpenClawGatewayConfig,
} from "./openclaw-gateway-client.js";

function openclawStateDir(env: NodeJS.ProcessEnv): string {
  const custom = env.OPENCLAW_STATE_DIR?.trim();
  if (custom) return custom;
  return join(homedir(), ".openclaw");
}

function parseOpenClawConfigYaml(text: string): { apiKey?: string; model?: string; baseUrl?: string } {
  const out: { apiKey?: string; model?: string; baseUrl?: string } = {};
  let inAi = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^ai:\s*$/.test(line)) {
      inAi = true;
      continue;
    }
    if (inAi && /^[^\s#]/.test(line)) {
      inAi = false;
    }
    if (!inAi) continue;
    const m = line.match(/^\s+(apiKey|model|baseUrl):\s*(.+)\s*$/);
    if (m) {
      out[m[1] as "apiKey" | "model" | "baseUrl"] = m[2].trim();
    }
  }
  return out;
}

type OpenClawProviderKey = "moonshot" | "openai";

type ResolvedOpenClawModel = {
  openclawProvider: OpenClawProviderKey;
  openclawModel: string;
  apiKey: string;
  baseUrl: string;
};

function toOpenClawModel(binding: NonNullable<ReturnType<typeof resolvePrimaryExternalModelBinding>>): ResolvedOpenClawModel {
  // deepseek 与 openai 同走 openai 系适配器（OpenAI 兼容协议 + 自定义 baseUrl）；
  // OpenClaw 侧没有独立的 deepseek provider 键，落到 moonshot 分支会模型前缀错配。
  if (binding.providerId === "openai" || binding.providerId === "deepseek") {
    return {
      openclawProvider: "openai",
      openclawModel: `openai/${binding.model}`,
      apiKey: binding.apiKey,
      baseUrl: binding.baseUrl,
    };
  }
  return {
    openclawProvider: "moonshot",
    openclawModel: `moonshot/${binding.model}`,
    apiKey: binding.apiKey,
    baseUrl: binding.baseUrl,
  };
}

async function resolveOpenClawModel(env: NodeJS.ProcessEnv): Promise<ResolvedOpenClawModel | null> {
  const binding = resolvePrimaryExternalModelBinding(env);
  if (binding) return toOpenClawModel(binding);

  const stateDir = openclawStateDir(env);
  try {
    const yaml = await readFile(join(stateDir, "config.yaml"), "utf8");
    const ai = parseOpenClawConfigYaml(yaml);
    if (ai.apiKey) {
      return {
        openclawProvider: "moonshot",
        openclawModel: `moonshot/${ai.model?.trim() || "kimi-k2.5"}`,
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl?.trim() || "https://api.moonshot.cn/v1",
      };
    }
  } catch {
    /* no yaml */
  }
  return null;
}

function fingerprint(model: ResolvedOpenClawModel): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: model.openclawProvider,
        model: model.openclawModel,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
      }),
    )
    .digest("hex");
}

function readCurrentModel(config: Record<string, unknown>): string | null {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const model = defaults?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function openclawConfigMatches(config: Record<string, unknown>, resolved: ResolvedOpenClawModel): boolean {
  if (readCurrentModel(config) !== resolved.openclawModel) return false;
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, Record<string, unknown>> | undefined;
  const provider = providers?.[resolved.openclawProvider];
  if (!provider) return false;
  return provider.baseUrl === resolved.baseUrl && provider.apiKey === resolved.apiKey;
}

/** 主服务未配置 OPENAI 时移除 ~/.openclaw 里遗留的 openai/rkapi，避免微信会话误用超时模型。 */
function pruneStaleOpenClawProviders(
  config: Record<string, unknown>,
  resolved: ResolvedOpenClawModel,
  env: NodeJS.ProcessEnv,
): boolean {
  let changed = false;
  const models = (config.models as Record<string, unknown> | undefined) ?? {};
  const providers = (models.providers as Record<string, unknown> | undefined) ?? {};
  if (resolved.openclawProvider === "moonshot" && !env.OPENAI_API_KEY?.trim() && providers.openai) {
    delete providers.openai;
    changed = true;
  }
  if (resolved.openclawProvider === "openai" && !env.MOONSHOT_API_KEY?.trim() && providers.moonshot) {
    delete providers.moonshot;
    changed = true;
  }
  if (changed) {
    models.providers = providers;
    config.models = models;
    const plugins = (config.plugins as Record<string, unknown> | undefined) ?? {};
    const entries = (plugins.entries as Record<string, Record<string, unknown>> | undefined) ?? {};
    if (resolved.openclawProvider === "moonshot" && entries.openai) {
      entries.openai = { ...entries.openai, enabled: false };
      plugins.entries = entries;
      config.plugins = plugins;
    }
    if (resolved.openclawProvider === "openai" && entries.moonshot) {
      entries.moonshot = { ...entries.moonshot, enabled: false };
      plugins.entries = entries;
      config.plugins = plugins;
    }
  }
  return changed;
}

export type OpenClawModelSyncResult =
  | { ok: true; changed: false; model: string }
  | { ok: true; changed: true; model: string; reloaded: boolean }
  | { ok: false; message: string };

/**
 * 将主服务当前外部模型同步到 ~/.openclaw/openclaw.json。
 * 配置未变化时跳过写入；变化时尝试通知 Gateway 热加载。
 */
export async function syncOpenClawAgentModel(
  env: NodeJS.ProcessEnv = process.env,
  options?: { forceReload?: boolean },
): Promise<OpenClawModelSyncResult> {
  const resolved = await resolveOpenClawModel(env);
  if (!resolved) {
    return {
      ok: false,
      message:
        "未找到可用外部模型（请配置 MOONSHOT_API_KEY / OPENAI_API_KEY，或 ~/.openclaw/config.yaml 的 ai.apiKey）",
    };
  }

  const stateDir = openclawStateDir(env);
  const configPath = join(stateDir, "openclaw.json");

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* 首次写入 */
  }

  const fp = fingerprint(resolved);
  const prunedStaleProviders = pruneStaleOpenClawProviders(config, resolved, env);
  if (openclawConfigMatches(config, resolved) && !prunedStaleProviders) {
    lastSyncedFingerprint = fp;
    return { ok: true, changed: false, model: resolved.openclawModel };
  }

  const agents = (config.agents as Record<string, unknown> | undefined) ?? {};
  const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
  defaults.model = resolved.openclawModel;
  agents.defaults = defaults;
  config.agents = agents;

  const models = (config.models as Record<string, unknown> | undefined) ?? {};
  models.mode = "merge";
  const providers = (models.providers as Record<string, unknown> | undefined) ?? {};
  providers[resolved.openclawProvider] = {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    api: "openai-completions",
  };
  models.providers = providers;
  config.models = models;

  const gateway = (config.gateway as Record<string, unknown> | undefined) ?? {};
  if (gateway.mode !== "local") {
    gateway.mode = "local";
    config.gateway = gateway;
  }

  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  lastSyncedFingerprint = fp;

  const reloaded = await tryReloadOpenClawGateway(env, options?.forceReload === true);
  if (reloaded) {
    console.log(`[wechat-claw] OpenClaw 模型已同步为 ${resolved.openclawModel}（Gateway 已热加载）`);
  } else {
    console.log(`[wechat-claw] OpenClaw 模型已同步为 ${resolved.openclawModel}`);
  }

  return { ok: true, changed: true, model: resolved.openclawModel, reloaded };
}

let lastSyncedFingerprint: string | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight: Promise<OpenClawModelSyncResult> | null = null;

async function tryReloadOpenClawGateway(env: NodeJS.ProcessEnv, force: boolean): Promise<boolean> {
  if (!isWechatClawFeatureEnabled(env)) return false;
  try {
    const client = new OpenClawGatewayClient(readOpenClawGatewayConfig(env));
    await client.configReload(force);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/unknown method|not found|unsupported/i.test(msg)) {
      console.warn(`[wechat-claw] Gateway 热加载失败（可重启 Gateway）: ${msg}`);
    }
    return false;
  }
}

/** 主服务启动后启动后台同步：跟随 EXTERNAL_MODEL_PROVIDER / MOONSHOT_MODEL / OPENAI_MODEL 变更。 */
export function startOpenClawModelSyncWatcher(
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = 30_000,
): () => void {
  if (!isWechatClawFeatureEnabled(env)) {
    return () => {};
  }
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }

  const tick = (): void => {
    if (syncInFlight) return;
    syncInFlight = syncOpenClawAgentModel(env).finally(() => {
      syncInFlight = null;
    });
  };

  void syncOpenClawAgentModel(env).then((r) => {
    if (r.ok && r.changed) {
      console.log(`[wechat-claw] 启动时 OpenClaw 模型同步: ${r.model}`);
    } else if (!r.ok) {
      console.warn(`[wechat-claw] 启动时 OpenClaw 模型同步跳过: ${r.message}`);
    }
  });

  watchTimer = setInterval(tick, intervalMs);
  watchTimer.unref?.();

  return () => {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  };
}
