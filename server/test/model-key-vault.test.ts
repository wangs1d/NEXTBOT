/**
 * 用户模型 key 落盘契约（内测口径：云端要能在客户端离线时跑主动轮次，
 * 但绝不用运营方的额度替用户付费）。
 *
 * 锁定五件事：
 *   A. 没配主密钥 → 不写盘（不产出"源码常量就能解开"的密文），绑定退回纯内存；
 *   B. 配了主密钥 → 落盘的是密文，明文 key 不出现在文件里；
 *   C. 重启（新实例）能把落盘绑定读回来，离线期间的主动轮次照跑；
 *   D. 用户在 UI 清空 → 内存与磁盘一起删；
 *   E. 主密钥轮换后解不开 → get() 为空但 hasStoredKey() 为真，
 *      agent-core 据此**不回落平台 key**（这条就是"不要用我的钱"的落点）。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const SCRATCH = join(
  process.env.TMPDIR || process.env.TEMP || "/tmp",
  `nextbot-modelkey-test-${process.pid}`,
);
rmSync(SCRATCH, { recursive: true, force: true });
// 必须在导入任何会解析数据根的模块之前设置，否则测试会写进真实数据目录
process.env.NEXTBOT_DATA_DIR = SCRATCH;
delete process.env.WELLNESS_DATA_SECRET;
delete process.env.BROWSER_SESSION_SECRET;
delete process.env.SESSION_SECRET;

const { ActorModelBindingStore } = await import("../src/external-model/actor-model-bindings.js");
const { modelKeyCount, modelKeyVaultEnabled } = await import("../src/services/model-key-vault.js");
const { getDataDir } = await import("../src/config/data-dir.js");

// 数据根必须真的是临时目录：loadServerEnv 会用 .env.local 覆盖 NEXTBOT_DATA_DIR，
// 一旦被抢先解析到真实数据根，测试就会把密文写进用户的 model-keys 目录
if (resolve(getDataDir()) !== resolve(SCRATCH)) {
  throw new Error(`测试数据根不是临时目录（实际 ${getDataDir()}），拒绝落盘`);
}

const BASE = { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-SECRET-1234567890", model: "deepseek-chat" };

function vaultDir(): string {
  return join(SCRATCH, "model-keys");
}

test("A 未配置主密钥：不写盘，绑定仍可在内存里用", () => {
  delete process.env.MODEL_KEY_SECRET;
  assert.equal(modelKeyVaultEnabled(), false);
  const store = new ActorModelBindingStore();
  assert.equal(store.set("novault@local", BASE), true);
  assert.ok(store.get("novault@local")?.isEnabled());
  assert.equal(modelKeyCount(), 0);
  assert.equal(existsSync(vaultDir()), false);
  assert.equal(store.hasStoredKey("novault@local"), false);
});

test("B 配置主密钥：落盘是密文，明文 key 不在文件里", () => {
  process.env.MODEL_KEY_SECRET = "unit-test-master-secret";
  const store = new ActorModelBindingStore();
  assert.equal(store.set("vault-a@local", BASE), true);
  assert.equal(modelKeyCount(), 1);
  const file = join(vaultDir(), "vault-a@local.enc");
  assert.ok(existsSync(file), `应有密文文件，实际目录 ${readdirSync(vaultDir()).join(",")}`);
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("sk-SECRET"), "密文里不得出现明文 key");
  assert.ok(!raw.includes("deepseek-chat"), "密文里不得出现明文模型名");
  assert.equal(store.hasStoredKey("vault-a@local"), true);
});

test("C 重启（新实例）读回绑定：客户端离线期间的主动轮次照样用用户自己的 key", () => {
  process.env.MODEL_KEY_SECRET = "unit-test-master-secret";
  const revived = new ActorModelBindingStore();
  assert.equal(revived.size, 1, "启动时不该预热，首次取用即读回");
  const provider = revived.get("vault-a@local");
  assert.ok(provider?.isEnabled(), "新实例应能拿回落盘 provider");
  assert.equal(revived.size, 1);
  assert.deepEqual(revived.status("vault-a@local"), {
    configured: true,
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    }, "状态口只回网关与模型，不含密钥");
  assert.equal(JSON.stringify(revived.status("vault-a@local")).includes("sk-SECRET"), false);
});

test("D 清空配置：内存与磁盘一起删", () => {
  process.env.MODEL_KEY_SECRET = "unit-test-master-secret";
  const store = new ActorModelBindingStore();
  store.set("drop@local", { ...BASE, apiKey: "sk-DROP-1" });
  assert.equal(modelKeyCount(), 2);
  store.clear("drop@local");
  assert.equal(modelKeyCount(), 1);
  assert.equal(store.hasStoredKey("drop@local"), false);
  assert.equal(new ActorModelBindingStore().get("drop@local"), null);
});

test("E 主密钥轮换后解不开：取不到 provider，但仍算「配过」，不得回落平台 key", () => {
  process.env.MODEL_KEY_SECRET = "unit-test-master-secret";
  const first = new ActorModelBindingStore();
  first.set("rotate@local", { ...BASE, apiKey: "sk-ROTATE-1" });

  process.env.MODEL_KEY_SECRET = "a-different-master-secret";
  const second = new ActorModelBindingStore();
  assert.equal(second.get("rotate@local"), null, "换密钥后不该还能用");
  assert.equal(second.hasStoredKey("rotate@local"), true, "但必须知道这人配过 key");
  const p = second.persistence();
  assert.equal(p.vaultEnabled, true);
  assert.equal(p.stored, 2);
  assert.ok(p.undecryptable >= 1, `解不开的份数要报出来，实际 ${p.undecryptable}`);

  process.env.MODEL_KEY_SECRET = "unit-test-master-secret";
  new ActorModelBindingStore().clear("rotate@local");
});

test("F SSRF 门拒绝的 baseUrl 不改动现有绑定、也不落盘", () => {
  process.env.MODEL_KEY_SECRET = "unit-test-master-secret";
  const store = new ActorModelBindingStore();
  store.set("ssrf@local", BASE);
  assert.equal(store.set("ssrf@local", { ...BASE, baseUrl: "https://169.254.169.254/latest/meta-data" }), false);
  assert.equal(store.status("ssrf@local")?.baseUrl, "https://api.deepseek.com/v1", "非法上送不得覆盖既有绑定");
  new ActorModelBindingStore().clear("ssrf@local");
});
