/**
 * 灵魂文件库契约测试（2026-10-13 架构方案 P2 最小锁定）：
 *   - 首次访问自动播种 identity/disposition，overlay 注入块渲染正确；
 *   - 周级门禁：changelog 最近一条不足 7 天 → 反思跳过（不调 LLM）；
 *   - disposition 键值行解析/render 往返。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSoulOverlay, maybeRunSoulReflection } from "../src/agent/soul-store.js";

function makeTempSoulRoot(): string {
  const root = join(tmpdir(), `soul-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

test("getSoulOverlay：首次访问播种并渲染身份+处事两层", () => {
  const root = makeTempSoulRoot();
  process.env.PA_DATA_DIR = root;
  try {
    const overlay = getSoulOverlay();
    assert.ok(overlay, "overlay 不应为空");
    assert.match(overlay, /【灵魂·身份】/);
    assert.match(overlay, /NEXTBOT/);
    assert.match(overlay, /【灵魂·处事】/);
    assert.match(overlay, /- 默契度: /);
    const dir = join(root, "profile", "soul");
    assert.ok(existsSync(join(dir, "identity.md")));
    assert.ok(existsSync(join(dir, "disposition.md")));
  } finally {
    delete process.env.PA_DATA_DIR;
  }
});

test("getSoulOverlay：disposition 手工编辑后 overlay 跟随更新", () => {
  const root = makeTempSoulRoot();
  process.env.PA_DATA_DIR = root;
  try {
    getSoulOverlay(); // 触发播种
    const dir = join(root, "profile", "soul");
    writeFileSync(join(dir, "disposition.md"), "# 处事层\n\n- 默契度: 3/5，接得住黑话\n", "utf8");
    // overlay 是 mtime 缓存；播种与手工编辑落在同一毫秒时缓存不会失效，
    // 显式把 mtime 推后，测的是「编辑后跟随更新」而不是文件系统精度。
    const stamp = new Date(Date.now() + 5000);
    utimesSync(join(dir, "disposition.md"), stamp, stamp);
    const overlay = getSoulOverlay();
    assert.ok(overlay?.includes("- 默契度: 3/5，接得住黑话"));
  } finally {
    delete process.env.PA_DATA_DIR;
  }
});

test("maybeRunSoulReflection：changelog 最近一条不足 7 天 → 冷却跳过", async () => {
  const root = makeTempSoulRoot();
  process.env.PA_DATA_DIR = root;
  try {
    getSoulOverlay(); // 播种
    const dir = join(root, "profile", "soul");
    writeFileSync(join(dir, "changelog.md"), "# 演化日志\n- 2026-10-13 更新:默契度 | 证据:「测试」\n", "utf8");
    // now 显式传入：冷却判定必须相对日志日期，否则日历一走测试就烂（2026-10-24 踩过）
    const outcome = await maybeRunSoulReflection({
      transcript: "用户: 测试\nAgent: 好的",
      now: new Date("2026-10-16T00:00:00Z"),
    });
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "cooldown");
    // 冷却路径绝不改写 disposition
    assert.match(readFileSync(join(dir, "disposition.md"), "utf8"), /刚认识/);
  } finally {
    delete process.env.PA_DATA_DIR;
  }
});
