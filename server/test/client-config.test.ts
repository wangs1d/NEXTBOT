import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

/**
 * 客户端远程配置（远程配置下发·地基，2026-11-10）：
 * - `GET /api/client/config` 三层合并：内置兜底(全空) ← config/client-config.json
 *   ← 环境变量 CLIENT_CONFIG_*（后者逐字段覆盖前者，trim 后空串=未配置）。
 * - 全空 = 客户端保持烤入值（地基阶段零行为变化）。
 * - 文件缺失/损坏/字段类型不对 → 按「未配置」处理，接口永不抛错。
 *
 * 运行：npx tsx --test test/client-config.test.ts
 */

const { mergeClientConfig, readClientConfig, registerClientConfigRoutes } = await import(
  "../src/routes/http/client-config.js"
);
const { default: Fastify } = await import("fastify");

test("mergeClientConfig：内置兜底为全空（不覆盖任何烤入值）", () => {
  const merged = mergeClientConfig({});
  assert.equal(merged.httpBase, "");
  assert.equal(merged.controlPlaneUrl, "");
  assert.equal(merged.updateManifestUrl, "");
});

test("mergeClientConfig：文件值逐字段生效", () => {
  const merged = mergeClientConfig({
    httpBase: "https://api.example.com",
    controlPlaneUrl: "https://cp.example.com",
  });
  assert.equal(merged.httpBase, "https://api.example.com");
  assert.equal(merged.controlPlaneUrl, "https://cp.example.com");
  assert.equal(merged.updateManifestUrl, ""); // 未配置的字段保持空
});

test("mergeClientConfig：环境变量覆盖文件值（部署期临时调整）", () => {
  const merged = mergeClientConfig(
    { httpBase: "https://from-file.example.com" },
    { CLIENT_CONFIG_HTTP_BASE: "https://from-env.example.com" },
  );
  assert.equal(merged.httpBase, "https://from-env.example.com");
});

test("mergeClientConfig：trim 后空串视为未配置，一律归一成空串", () => {
  const merged = mergeClientConfig({
    httpBase: "   ",
    controlPlaneUrl: "",
    updateManifestUrl: 123 as unknown as string, // 类型不对的字段按未配置处理
  });
  assert.equal(merged.httpBase, "");
  assert.equal(merged.controlPlaneUrl, "");
  assert.equal(merged.updateManifestUrl, "");
});

test("readClientConfig：目录无配置文件 → 全空兜底，不抛错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-config-empty-"));
  const config = await readClientConfig(dir);
  assert.deepEqual(config, { httpBase: "", controlPlaneUrl: "", updateManifestUrl: "" });
});

test("readClientConfig：损坏的 JSON 文件 → 全空兜底，不抛错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-config-broken-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "config", "client-config.json"), "{ not valid json !!");
  const config = await readClientConfig(dir);
  assert.deepEqual(config, { httpBase: "", controlPlaneUrl: "", updateManifestUrl: "" });
});

test("readClientConfig：合法文件逐字段读出", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-config-valid-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(
    path.join(dir, "config", "client-config.json"),
    JSON.stringify({ httpBase: "https://api.migrated.example.com" }),
  );
  const config = await readClientConfig(dir);
  assert.equal(config.httpBase, "https://api.migrated.example.com");
  assert.equal(config.controlPlaneUrl, "");
});

test("GET /api/client/config：返回 ok:true + 合并结果", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-config-route-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(
    path.join(dir, "config", "client-config.json"),
    JSON.stringify({ controlPlaneUrl: "https://cp.migrated.example.com" }),
  );
  // readClientConfig 默认读 process.cwd()——测试进程临时切目录注入
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const app = Fastify();
    registerClientConfigRoutes(app);
    const resp = await app.inject({ method: "GET", url: "/api/client/config" });
    assert.equal(resp.statusCode, 200);
    const body = resp.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.httpBase, "");
    assert.equal(body.controlPlaneUrl, "https://cp.migrated.example.com");
    await app.close();
  } finally {
    process.chdir(prevCwd);
  }
});
