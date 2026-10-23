import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 图片图库 HTTP 路由域（routes/http/picture.ts）测试。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）+ 真实 PictureKit（临时存储根）：
 * - GET /picture/assets 列表
 * - DELETE /picture/assets/:id 删除后列表为空、源文件/缩略图落盘清理
 * - 重复删除 / 未知 id → 404
 *
 * 运行：npx tsx --test test/picture-routes.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picture-routes-test-"));

const { createPictureKit } = await import("@nextbot/picture");
const { registerPictureRoutes } = await import("../src/routes/http/picture.js");
const { default: Fastify } = await import("fastify");

type PictureKit = import("@nextbot/picture").PictureKit;

// ────────────────────────────────────────────────────────────
// 夹具：临时 PictureKit + fastify，预置一张 1x1 PNG
// ────────────────────────────────────────────────────────────

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function buildApp(): Promise<{ app: Awaited<ReturnType<typeof Fastify>>; kit: PictureKit; rootDir: string }> {
  const rootDir = path.join(tmpDir, `kit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const kit = await createPictureKit({ rootDir });
  const app = Fastify();
  registerPictureRoutes(app, { pictureKit: kit });
  return { app, kit, rootDir };
}

test("picture 路由：DELETE 删除照片并清理文件,重复删除 404", async () => {
  const { app, kit, rootDir } = await buildApp();
  try {
    const { asset } = await kit.store.ingest(PNG_1PX, { fileName: "t.png", tags: ["portrait"] });

    const before = await app.inject({ method: "GET", url: "/picture/assets" });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().total, 1);

    const del = await app.inject({ method: "DELETE", url: `/picture/assets/${asset.id}` });
    assert.equal(del.statusCode, 200);
    const delBody = del.json();
    assert.equal(delBody.ok, true);
    assert.equal(delBody.id, asset.id);
    assert.ok(typeof delBody.trashId === "string" && delBody.trashId.length > 0, "删除应入回收站");

    // 列表为空 + 源文件移入回收站（不再在 assets/ 目录）
    const after = await app.inject({ method: "GET", url: "/picture/assets" });
    assert.equal(after.json().total, 0);
    assert.equal(fs.existsSync(asset.filePath), false);
    const trashDir = path.join(rootDir, "trash");
    assert.ok(fs.existsSync(trashDir), "trash 目录应存在");
    assert.ok(fs.readdirSync(trashDir).some((f) => f.includes(delBody.trashId)), "回收站内应有原图");

    // 恢复 → 回到图库
    const restore = await app.inject({
      method: "POST",
      url: "/picture/trash/restore",
      payload: { ids: [delBody.trashId] },
    });
    assert.equal(restore.json().restored, 1);
    const revived = await app.inject({ method: "GET", url: "/picture/assets" });
    assert.equal(revived.json().total, 1);

    // 再次删除（回回收站），重复删除 / 未知 id → 404
    await app.inject({ method: "DELETE", url: `/picture/assets/${asset.id}` });
    const repeat = await app.inject({ method: "DELETE", url: `/picture/assets/${asset.id}` });
    assert.equal(repeat.statusCode, 404);

    const missing = await app.inject({ method: "DELETE", url: "/picture/assets/not-exist" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("picture 路由：/picture 端点目录不含 beautify/styles", async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/picture" });
    assert.equal(res.statusCode, 200);
    const endpoints = res.json().endpoints as string[];
    assert.ok(endpoints.some((e) => e.startsWith("DELETE /picture/assets/")));
    assert.ok(endpoints.every((e) => !e.includes("beautify") && !e.includes("styles")));
  } finally {
    await app.close();
  }
});
