import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 图库批量操作 + 盲盒抽样 + 回收站测试。
 *
 * 覆盖：
 * - random：排除收藏 tag / 新入库（recentDays）/ 指定 id；池子计数
 * - batch-delete：入回收站（索引移除 + 文件在 trash）、freedBytes、missing
 * - batch-tag：批量打/去「收藏」
 * - trash：列表带预览 URL、预览图可取、恢复后 tag/文件齐备、30 天 TTL 清理
 *
 * 运行：npx tsx --test test/picture-batch-trash.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picture-batch-test-"));

const { createPictureKit } = await import("@nextbot/picture");
const { registerPictureRoutes } = await import("../src/routes/http/picture.js");
const { default: Fastify } = await import("fastify");

type PictureKit = import("@nextbot/picture").PictureKit;

/** 内容互异的测试图（同内容会被 sha256 去重） */
async function uniquePng(seed: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: (seed * 37) % 255, g: (seed * 61) % 255, b: (seed * 83) % 255 },
    },
  })
    .png()
    .toBuffer();
}

async function buildApp() {
  const rootDir = path.join(tmpDir, `kit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const kit = await createPictureKit({ rootDir });
  const app = Fastify();
  registerPictureRoutes(app, { pictureKit: kit });
  return { app, kit, rootDir };
}

test("random 抽样：排除收藏/新入库/指定 id", async () => {
  const { app, kit } = await buildApp();
  try {
    // 5 张：1 张收藏、其余正常（createdAt 即现在，用 recentDays=0 全纳入）
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { asset } = await kit.store.ingest(await uniquePng(i + 1), { fileName: `r${i}.png` });
      ids.push(asset.id);
    }
    await kit.store.addTag(ids[0]!, "收藏");

    const all = await app.inject({ method: "GET", url: "/picture/assets/random?count=10&recentDays=0" });
    const allBody = all.json();
    assert.equal(allBody.pool, 4, "收藏应被排除");
    assert.equal(allBody.photos.length, 4);

    const exclude = await app.inject({
      method: "GET",
      url: `/picture/assets/random?count=10&recentDays=0&excludeIds=${ids[1]},${ids[2]}`,
    });
    assert.equal(exclude.json().pool, 2);

    // recentDays=7：全部都是刚入库 → 池子为空
    const recent = await app.inject({ method: "GET", url: "/picture/assets/random?count=10" });
    assert.equal(recent.json().pool, 0);
    assert.equal(recent.json().photos.length, 0);
  } finally {
    await app.close();
    fs.rmSync(path.dirname(kit.store.rootDir) === tmpDir ? kit.store.rootDir : kit.store.rootDir, { recursive: true, force: true });
  }
});

test("batch-delete + trash：入回收站、恢复、TTL 清理", async () => {
  const { app, kit } = await buildApp();
  try {
    const ids: string[] = [];
    let bytes = 0;
    for (let i = 0; i < 4; i++) {
      const buf = await uniquePng(i + 10);
      const { asset } = await kit.store.ingest(buf, { fileName: `b${i}.png` });
      ids.push(asset.id);
      bytes += buf.length;
    }

    const del = await app.inject({
      method: "POST",
      url: "/picture/assets/batch-delete",
      payload: { ids: [ids[0], ids[1], "not-exist"] },
    });
    const delBody = del.json();
    assert.equal(delBody.removed, 2);
    assert.deepEqual(delBody.missing, ["not-exist"]);
    assert.equal(delBody.freedBytes > 0, true);
    assert.equal(delBody.trashIds.filter((t: string) => t).length, 2);

    // 图库剩 2；回收站列表 2 项带预览
    assert.equal(kit.store.listAll().length, 2);
    const list = await app.inject({ method: "GET", url: "/picture/trash" });
    const items = list.json().items;
    assert.equal(items.length, 2);
    assert.ok(items[0].previewUrl.startsWith("/picture/trash/"));

    const preview = await app.inject({ method: "GET", url: items[0].previewUrl });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.headers["content-type"], "image/webp");

    // 恢复一张：回到图库、文件在原位
    const restore = await app.inject({
      method: "POST",
      url: "/picture/trash/restore",
      payload: { ids: [items[0].trashId] },
    });
    assert.equal(restore.json().restored, 1);
    assert.equal(kit.store.listAll().length, 3);
    const restoredAsset = kit.store.get(ids[0]) ?? kit.store.get(ids[1]);
    assert.ok(restoredAsset);
    assert.equal(fs.existsSync(restoredAsset!.filePath), true);

    // TTL 清理：把台账里 deletedAt 改老 → 新服务实例（等价重启）惰性清理真删
    const trashIndexPath = path.join(kit.store.rootDir, "trash", "trash.json");
    const trashIndex = JSON.parse(fs.readFileSync(trashIndexPath, "utf8"));
    const remainId = Object.keys(trashIndex.entries)[0]!;
    trashIndex.entries[remainId].deletedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    fs.writeFileSync(trashIndexPath, JSON.stringify(trashIndex));
    const app2 = Fastify();
    registerPictureRoutes(app2, { pictureKit: kit });
    try {
      const afterList = await app2.inject({ method: "GET", url: "/picture/trash" });
      assert.equal(afterList.json().items.length, 0, "过期条目应被惰性清理");
    } finally {
      await app2.close();
    }
  } finally {
    await app.close();
    fs.rmSync(kit.store.rootDir, { recursive: true, force: true });
  }
});

test("batch-tag：批量打/去收藏", async () => {
  const { app, kit } = await buildApp();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { asset } = await kit.store.ingest(await uniquePng(i + 20), { fileName: `t${i}.png` });
      ids.push(asset.id);
    }
    const add = await app.inject({
      method: "POST",
      url: "/picture/assets/batch-tag",
      payload: { ids: ids.slice(0, 2), tag: "收藏" },
    });
    assert.equal(add.json().updated, 2);
    assert.ok(kit.store.get(ids[0]!)!.tags.includes("收藏"));

    // 打了收藏的不再进随机池
    const random = await app.inject({ method: "GET", url: "/picture/assets/random?count=10&recentDays=0" });
    assert.equal(random.json().pool, 1);

    const remove = await app.inject({
      method: "POST",
      url: "/picture/assets/batch-tag",
      payload: { ids: ids.slice(0, 2), tag: "收藏", remove: true },
    });
    assert.equal(remove.json().updated, 2);
    assert.equal(kit.store.get(ids[0]!)!.tags.includes("收藏"), false);

    const bad = await app.inject({
      method: "POST",
      url: "/picture/assets/batch-tag",
      payload: { ids: [], tag: "x" },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
    fs.rmSync(kit.store.rootDir, { recursive: true, force: true });
  }
});

test("trash 彻底删除：跳过 TTL 提前真删", async () => {
  const { app, kit } = await buildApp();
  try {
    const { asset } = await kit.store.ingest(await uniquePng(30), { fileName: "hd.png" });
    const del = await app.inject({ method: "DELETE", url: `/picture/assets/${asset.id}` });
    const trashId = del.json().trashId as string;
    assert.ok(trashId);

    const gone = await app.inject({ method: "DELETE", url: `/picture/trash/${trashId}` });
    assert.equal(gone.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/picture/trash" })).json().items.length, 0);
    assert.equal(fs.existsSync(asset.filePath), false);

    const repeat = await app.inject({ method: "DELETE", url: `/picture/trash/${trashId}` });
    assert.equal(repeat.statusCode, 404);
  } finally {
    await app.close();
    fs.rmSync(kit.store.rootDir, { recursive: true, force: true });
  }
});
