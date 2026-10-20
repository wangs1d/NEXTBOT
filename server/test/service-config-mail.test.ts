/**
 * 服务接入 · 邮箱授权码块单测（2026-10-20）：「服务接入」页邮箱胶囊把 IMAP 授权码
 * 经 PUT /api/service-config 落盘 data/service-config.json 并写 env 热生效。
 * 语义锁：① 落盘可重放（applyPersistedServiceConfig 把 pass/enabled 写回 env）；
 *        ② 授权码只回尾号（maskServiceKey），绝不下发明文；③ mail 补丁不动别的块。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPersistedServiceConfig,
  maskServiceKey,
  readServiceConfigFile,
  saveServiceConfigPatch,
} from "../src/config/service-config-store.js";

test("mail 块：落盘 + env 即时生效 + 启动重放", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-mail-"));
  try {
    const env: NodeJS.ProcessEnv = {};
    const saved = await saveServiceConfigPatch({ mail: { pass: "authcode-1234" } }, dir, env);
    assert.equal(saved.mail?.pass, "authcode-1234");
    assert.equal(env.MAIL_WATCH_PASS, "authcode-1234", "保存即写 env 热生效");
    assert.equal(env.MAIL_WATCH_ENABLED, "1", "接入即点亮邮箱盯梢开关");

    const onDisk = await readServiceConfigFile(dir);
    assert.equal(onDisk?.mail?.pass, "authcode-1234", "落盘供重启重放");

    const replayEnv: NodeJS.ProcessEnv = {};
    await applyPersistedServiceConfig(dir, replayEnv);
    assert.equal(replayEnv.MAIL_WATCH_PASS, "authcode-1234", "重启后由文件重放回 env");
    assert.equal(maskServiceKey("authcode-1234"), "****1234", "只回尾号，绝不下发明文");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mail 补丁不覆盖既有 model/tts 块", async () => {
  const dir = mkdtempSync(join(tmpdir(), "svc-mail-"));
  try {
    const env: NodeJS.ProcessEnv = {};
    await saveServiceConfigPatch(
      {
        model: {
          providerId: "custom",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: "sk-abc",
        },
      },
      dir,
      env,
    );
    await saveServiceConfigPatch({ mail: { pass: "code" } }, dir, env);
    const cfg = await readServiceConfigFile(dir);
    assert.equal(cfg?.model?.apiKey, "sk-abc", "模型块保持原样");
    assert.equal(cfg?.mail?.pass, "code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
