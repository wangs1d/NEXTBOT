/**
 * 服务接入 · 密钥落盘形态单测。锁四件事：
 * ① 密钥不再明文躺在 data/service-config.json 里——配了主密钥就挪进加密仓
 *   service-secrets/machine.enc，文件只剩 providerId/baseUrl/model；
 * ② 没配主密钥时不假装加密：明文原样留着（单机装机不因此用不了），状态如实报
 *   encryptedAtRest:false；
 * ③ 邮箱授权码不再走机器级 env 那条路：老文件里那份存量只桥接给 env 让邮箱注册表
 *   按「整机唯一账号」收编，新保存的授权码根本不再进这个文件，也不再点亮
 *   MAIL_WATCH_ENABLED（账号接入自带开盯语义）；
 * ④ 补丁之间互不连坐：只改 TTS 不动模型 key，只写文件字段不写密钥。
 *
 * 数据根钉到临时目录：加密仓按 getDataDir() 解析，绝不让单测碰真实数据。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "svc-secret-"));
process.env.NEXTBOT_DATA_DIR = SCRATCH;
delete process.env.MODEL_KEY_SECRET;
delete process.env.WELLNESS_DATA_SECRET;
delete process.env.BROWSER_SESSION_SECRET;
delete process.env.SESSION_SECRET;

const {
  applyPersistedServiceConfig,
  maskServiceKey,
  readServiceConfigFile,
  saveServiceConfigPatch,
  serviceConfigFilePath,
  serviceSecretsEncryptedAtRest,
} = await import("../src/config/service-config-store.js");

const { getDataDir } = await import("../src/config/data-dir.js");
if (getDataDir() !== SCRATCH) throw new Error(`数据根未钉住：${getDataDir()} ≠ ${SCRATCH}`);

const SECRETS_FILE = join(SCRATCH, "service-secrets", "machine.enc");

/** 每个用例从干净的数据根开始（同进程共享目录，密文与配置文件都要清） */
function resetDir(): void {
  rmSync(serviceConfigFilePath(SCRATCH), { force: true });
  rmSync(SECRETS_FILE, { force: true });
}

function writeLegacyFile(obj: unknown): void {
  writeFileSync(serviceConfigFilePath(SCRATCH), JSON.stringify(obj), "utf8");
}

function readFileText(): string {
  try {
    return readFileSync(serviceConfigFilePath(SCRATCH), "utf8");
  } catch {
    return "";
  }
}

test("老文件的明文密钥：有主密钥 → 挪进加密仓并抹掉明文；重启仍生效", async () => {
  resetDir();
  process.env.MODEL_KEY_SECRET = "unit-master-secret-for-service-config";
  try {
    writeLegacyFile({
      version: 1,
      updatedAt: new Date().toISOString(),
      model: {
        providerId: "custom",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        apiKey: "sk-legacy-plain",
        updatedAt: new Date().toISOString(),
      },
    });
    const env: NodeJS.ProcessEnv = {};
    const cfg = await applyPersistedServiceConfig(SCRATCH, env);
    assert.equal(cfg?.model?.apiKey, "sk-legacy-plain", "内存视图照样拿到 key");
    assert.equal(env.OPENAI_API_KEY, "sk-legacy-plain", "重放仍写 env 热生效");
    assert.equal(env.EXTERNAL_MODEL_PROVIDER, "openai");
    assert.ok(existsSync(SECRETS_FILE), "密钥已加密落盘");
    assert.ok(!readFileText().includes("sk-legacy-plain"), "文件里不再躺明文");
    assert.equal(serviceSecretsEncryptedAtRest(), true);

    const reread = await readServiceConfigFile(SCRATCH);
    assert.equal(reread?.model?.apiKey, "sk-legacy-plain", "第二次读从密文取，不读文件明文");
    assert.equal(reread?.model?.baseUrl, "https://api.deepseek.com");
  } finally {
    delete process.env.MODEL_KEY_SECRET;
  }
});

test("没配主密钥：不假装加密，明文留着但状态如实报 encryptedAtRest=false", async () => {
  resetDir();
  writeLegacyFile({
    version: 1,
    updatedAt: new Date().toISOString(),
    model: {
      providerId: "custom",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKey: "sk-no-vault",
      updatedAt: new Date().toISOString(),
    },
  });
  const env: NodeJS.ProcessEnv = {};
  const cfg = await applyPersistedServiceConfig(SCRATCH, env);
  assert.equal(cfg?.model?.apiKey, "sk-no-vault", "没有密文也要能用（回落到文件存量）");
  assert.equal(env.OPENAI_API_KEY, "sk-no-vault");
  assert.equal(serviceSecretsEncryptedAtRest(), false);
  assert.ok(readFileText().includes("sk-no-vault"), "没有主密钥就不动原文件：宁可明文可用，也不写解不开的密文");
  assert.ok(!existsSync(SECRETS_FILE));
});

test("邮箱授权码：老存量只桥接给 env 供收编，且不再点亮机器级 MAIL_WATCH_ENABLED", async () => {
  resetDir();
  writeLegacyFile({
    version: 1,
    updatedAt: new Date().toISOString(),
    mail: { pass: "legacy-auth-code", updatedAt: new Date().toISOString() },
  });
  const env: NodeJS.ProcessEnv = {};
  const cfg = await applyPersistedServiceConfig(SCRATCH, env);
  assert.equal(cfg?.legacyMailPass, "legacy-auth-code", "存量以只读字段暴露");
  assert.equal(env.MAIL_WATCH_PASS, "legacy-auth-code", "交给邮箱注册表按整机唯一账号收编");
  assert.equal(env.MAIL_WATCH_ENABLED, undefined, "授权码不再顺手把整机盯梢开关打开");
});

test("env 已有授权码时不被老文件顶掉（部署方 config.env 优先）", async () => {
  resetDir();
  writeLegacyFile({ version: 1, updatedAt: new Date().toISOString(), mail: { pass: "from-file" } });
  const env: NodeJS.ProcessEnv = { MAIL_WATCH_PASS: "from-deploy-env" };
  await applyPersistedServiceConfig(SCRATCH, env);
  assert.equal(env.MAIL_WATCH_PASS, "from-deploy-env");
});

test("保存：文件只留非密钥字段，密钥进密文；后续补丁不连坐别的块", async () => {
  resetDir();
  process.env.MODEL_KEY_SECRET = "unit-master-secret-for-service-config";
  try {
    const env: NodeJS.ProcessEnv = {};
    const saved = await saveServiceConfigPatch(
      { model: { providerId: "custom", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "sk-aaa1" } },
      SCRATCH,
      env,
    );
    assert.equal(saved.model?.apiKey, "sk-aaa1", "返回值仍是完整视图（路由要取尾号）");
    assert.equal(maskServiceKey(saved.model?.apiKey), "****aaa1");
    assert.ok(!readFileText().includes("sk-aaa1"), "明文不落文件");

    await saveServiceConfigPatch({ tts: { provider: "minimax", apiKey: "mk-bbb2" } }, SCRATCH, env);
    assert.equal(env.MINIMAX_API_KEY, "mk-bbb2", "TTS 单独写 env");
    const after = await readServiceConfigFile(SCRATCH);
    assert.equal(after?.model?.apiKey, "sk-aaa1", "只改 TTS 不动模型 key");
    assert.equal(after?.tts?.apiKey, "mk-bbb2");
    assert.equal(after?.model?.model, "deepseek-chat");
    assert.ok(!readFileText().includes("sk-aaa1"));
    assert.ok(!readFileText().includes("mk-bbb2"));

    // 换模型不重填 key：路由按"留空=沿用已存"取的那份来自密文
    const reuse = await saveServiceConfigPatch(
      { model: { providerId: "custom", baseUrl: "https://api.deepseek.com", model: "deepseek-v3", apiKey: (await readServiceConfigFile(SCRATCH))?.model?.apiKey ?? "" } },
      SCRATCH,
      env,
    );
    assert.equal(reuse.model?.apiKey, "sk-aaa1", "沿用已存 key");
    assert.equal(reuse.model?.model, "deepseek-v3");
  } finally {
    delete process.env.MODEL_KEY_SECRET;
  }
});

test("保存的补丁里没有邮箱块：授权码不再写进这个文件", async () => {
  resetDir();
  const env: NodeJS.ProcessEnv = {};
  const saved = await saveServiceConfigPatch(
    { model: { providerId: "custom", baseUrl: "https://a.example.com", model: "m1", apiKey: "sk-ccc3" } },
    SCRATCH,
    env,
  );
  assert.equal("mail" in saved, false, "ServiceConfigFile 不再有 mail 视图");
  assert.ok(!readFileText().includes("mail"), "文件里没有邮箱块");
  assert.equal(env.MAIL_WATCH_PASS, undefined, "保存模型 key 不该顺手动邮箱 env");
});

test("主密钥轮换后解不开：读口返回存量而非崩溃，密文原样留着", async () => {
  resetDir();
  process.env.MODEL_KEY_SECRET = "unit-master-secret-for-service-config";
  try {
    await saveServiceConfigPatch(
      { model: { providerId: "custom", baseUrl: "https://a.example.com", model: "m1", apiKey: "sk-rotate" } },
      SCRATCH,
      {},
    );
  } finally {
    delete process.env.MODEL_KEY_SECRET;
  }
  const cfg = await readServiceConfigFile(SCRATCH);
  assert.equal(cfg?.model?.apiKey, "", "解不开就是解不开：不回落到任何平台凭据");
  assert.ok(existsSync(SECRETS_FILE), "密文留着，换回主密钥仍可读");
});
