/**
 * 平台默认模型 provider 与「装机配置」的边界闸（2026-11-12 根因回归）。
 *
 * 根因：applyServiceConfigToEnv 曾把部署方 .env 里显式声明的
 * EXTERNAL_MODEL_PROVIDER=none 静默覆写成 openai，让「平台默认 provider」寄生在
 * 单用户装机配置重放上。开强制鉴权关掉重放后 none 生效 → provider=null →
 * 所有未绑定 BYOK 的用户每轮吃「模型服务还没配置好」。
 *
 * 锁两件事：
 * ① 单机形态：装机配置仍照旧写 env（加闸不能把单机装机弄坏）；
 * ② 云端形态：装机配置绝不碰模型 env，平台来源只有 server/.env。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfigFile } from "../src/config/service-config-store.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "platform-model-boundary-"));
process.env.NEXTBOT_DATA_DIR = SCRATCH;
delete process.env.ACCESS_AUTH_REQUIRED;
delete process.env.MODEL_KEY_SECRET;

const {
  applyServiceConfigToEnv,
  applyPersistedServiceConfig,
  serviceConfigFilePath,
} = await import("../src/config/service-config-store.js");

function installedConfig(): ServiceConfigFile {
  return {
    version: 1,
    updatedAt: "2026-11-09T18:11:28.145Z",
    model: {
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      apiKey: "sk-user-installed",
      updatedAt: "2026-11-09T18:11:28.145Z",
    },
    tts: {
      provider: "minimax",
      apiKey: "tts-user-installed",
      updatedAt: "2026-11-09T18:11:28.145Z",
    },
  };
}

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

test("单机形态：装机模型配置照旧写 env 并钉住 openai 槽位", () => {
  const env: NodeJS.ProcessEnv = { EXTERNAL_MODEL_PROVIDER: "none" };
  applyServiceConfigToEnv(installedConfig(), env, { sharedTenant: false });
  assert.equal(env.OPENAI_API_KEY, "sk-user-installed");
  assert.equal(env.OPENAI_BASE_URL, "https://api.deepseek.com");
  assert.equal(env.OPENAI_MODEL, "deepseek-flash");
  assert.equal(env.EXTERNAL_MODEL_PROVIDER, "openai", "单机装机仍要抢过 auto 槽位");
  assert.equal(env.MINIMAX_API_KEY, "tts-user-installed", "TTS 段不受影响");
});

test("云端形态：装机模型不写 env，部署方 EXTERNAL_MODEL_PROVIDER 原样保留", () => {
  const env: NodeJS.ProcessEnv = {
    EXTERNAL_MODEL_PROVIDER: "none",
    OPENAI_API_KEY: "sk-platform-owned",
    OPENAI_BASE_URL: "https://api.deepseek.com",
    OPENAI_MODEL: "deepseek-chat",
  };
  applyServiceConfigToEnv(installedConfig(), env, { sharedTenant: true });
  assert.equal(env.EXTERNAL_MODEL_PROVIDER, "none", "部署方显式声明绝不覆写");
  assert.equal(env.OPENAI_API_KEY, "sk-platform-owned", "平台 key 不被用户自配 key 顶掉");
  assert.equal(env.OPENAI_MODEL, "deepseek-chat");
  assert.equal(env.MINIMAX_API_KEY, "tts-user-installed", "非模型段仍按既有语义应用");
});

test("云端形态：误调 applyPersistedServiceConfig 也不会把用户 key 变成全站 provider", async () => {
  process.env.ACCESS_AUTH_REQUIRED = "1";
  try {
    writeFileSync(
      serviceConfigFilePath(SCRATCH),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-09T18:11:28.145Z",
        model: {
          providerId: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "sk-user-installed",
          updatedAt: "2026-11-09T18:11:28.145Z",
        },
      }),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = {
      EXTERNAL_MODEL_PROVIDER: "none",
      OPENAI_API_KEY: "sk-platform-owned",
    };
    const cfg = await applyPersistedServiceConfig(SCRATCH, env);
    assert.equal(cfg?.model?.apiKey, "sk-user-installed", "只读视图仍拿得到（状态口/迁移用）");
    assert.equal(env.OPENAI_API_KEY, "sk-platform-owned", "env 没被装机 key 污染");
    assert.equal(env.EXTERNAL_MODEL_PROVIDER, "none", "部署方声明没被覆写");
  } finally {
    delete process.env.ACCESS_AUTH_REQUIRED;
    rmSync(serviceConfigFilePath(SCRATCH), { force: true });
  }
});
