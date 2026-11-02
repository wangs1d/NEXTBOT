import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 图片图库 HTTP 路由域（routes/http/picture.ts）测试。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）+ 真实 PictureKitRegistry（临时分区根）：
 * - GET /picture/assets 列表
 * - DELETE /picture/assets/:id 删除后列表为空、源文件/缩略图落盘清理
 * - 重复删除 / 未知 id → 404
 * - 照片只属于上传者：别的 actor 看不到、下不了、删不掉
 *
 * 运行：npx tsx --test test/picture-routes.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picture-routes-test-"));

const { PictureKitRegistry } = await import("../src/services/picture-kit-registry.js");
const { registerPictureRoutes } = await import("../src/routes/http/picture.js");
const { default: Fastify } = await import("fastify");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const ACTOR = "route-test@local";
const OTHER = "other-test@local";

async function buildApp() {
  const rootDir = path.join(tmpDir, `kits-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const kits = new PictureKitRegistry({ rootDir, batchOutputDir: path.join(rootDir, "batch") });
  const app = Fastify();
  registerPictureRoutes(app, { pictureKits: kits });
  const partition = await kits.forActor(ACTOR);
  return { app, kits, kit: partition.kit, rootDir: partition.kit.store.rootDir, userId: ACTOR };
}

test("picture 路由：DELETE 删除照片并清理文件,重复删除 404", async () => {
  const { app, kit, rootDir, userId } = await buildApp();
  try {
    const { asset } = await kit.store.ingest(PNG_1PX, { fileName: "t.png", tags: ["portrait"] });

    const before = await app.inject({ method: "GET", url: "/picture/assets", query: { userId } });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().total, 1);

    const del = await app.inject({
      method: "DELETE",
      url: `/picture/assets/${asset.id}`,
      query: { userId },
    });
    assert.equal(del.statusCode, 200);
    const delBody = del.json();
    assert.equal(delBody.ok, true);
    assert.equal(delBody.id, asset.id);
    assert.ok(typeof delBody.trashId === "string" && delBody.trashId.length > 0, "删除应入回收站");

    // 列表为空 + 源文件移入回收站（不再在 assets/ 目录）
    const after = await app.inject({ method: "GET", url: "/picture/assets", query: { userId } });
    assert.equal(after.json().total, 0);
    assert.equal(fs.existsSync(asset.filePath), false);
    const trashDir = path.join(rootDir, "trash");
    assert.ok(fs.existsSync(trashDir), "trash 目录应存在");
    assert.ok(fs.readdirSync(trashDir).some((f) => f.includes(delBody.trashId)), "回收站内应有原图");

    // 恢复 → 回到图库
    const restore = await app.inject({
      method: "POST",
      url: "/picture/trash/restore",
      query: { userId },
      payload: { ids: [delBody.trashId] },
    });
    assert.equal(restore.json().restored, 1);
    const revived = await app.inject({ method: "GET", url: "/picture/assets", query: { userId } });
    assert.equal(revived.json().total, 1);

    // 再次删除（回回收站），重复删除 / 未知 id → 404
    await app.inject({ method: "DELETE", url: `/picture/assets/${asset.id}`, query: { userId } });
    const repeat = await app.inject({
      method: "DELETE",
      url: `/picture/assets/${asset.id}`,
      query: { userId },
    });
    assert.equal(repeat.statusCode, 404);

    const missing = await app.inject({
      method: "DELETE",
      url: "/picture/assets/not-exist",
      query: { userId },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("picture 路由：照片只属于上传者，别的 actor 看不到也删不掉", async () => {
  const { app, kit, userId, kits } = await buildApp();
  try {
    const { asset } = await kit.store.ingest(PNG_1PX, { fileName: "mine.png" });

    const mine = await app.inject({ method: "GET", url: "/picture/assets", query: { userId } });
    assert.equal(mine.json().total, 1);

    const intruder = await app.inject({
      method: "GET",
      url: "/picture/assets",
      query: { userId: OTHER },
    });
    assert.equal(intruder.json().total, 0, "另一 actor 的列表必须是空的");

    const intruderFile = await app.inject({
      method: "GET",
      url: `/picture/assets/${asset.id}/file`,
      query: { userId: OTHER },
    });
    assert.equal(intruderFile.statusCode, 404, "别人的照片 id 在本人分区里不存在");

    const intruderDelete = await app.inject({
      method: "DELETE",
      url: `/picture/assets/${asset.id}`,
      query: { userId: OTHER },
    });
    assert.equal(intruderDelete.statusCode, 404);
    const otherPartition = await kits.forActor(OTHER);
    assert.equal(otherPartition.kit.store.get(asset.id), null);
    assert.ok(fs.existsSync(asset.filePath), "本图文件不得被越权删除");
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

after(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
