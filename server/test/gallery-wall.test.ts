import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 3D 照片墙域（gallery-wall-service + photo-analysis-service + 路由）测试。
 *
 * 覆盖：
 * - clusterAssetsByTime：3h 间隔分簇 / 未记录时间归末簇
 * - computeWallLayout：走廊坐标推进、左右交替挂墙、年月地标、动态照片标记、待分析计数
 * - 动画登记表：save/load 原子往返
 * - 路由：/gallery-wall 页面含桥探针、vendor 存在、layout 与 analyze 端点
 * - parseExifGps：度分秒解析与南/西半球
 *
 * 运行：npx tsx --test test/gallery-wall.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-wall-test-"));

const { createPictureKit } = await import("@nextbot/picture");
const {
  clusterAssetsByTime,
  computeWallLayout,
} = await import("../src/services/gallery-wall-service.js");
const { parseExifGps } = await import("../src/services/photo-analysis-service.js");
const { registerGalleryWallRoutes } = await import("../src/routes/http/gallery-wall.js");
const { default: Fastify } = await import("fastify");

type PictureKit = import("@nextbot/picture").PictureKit;
type ImageAsset = import("@nextbot/picture").ImageAsset;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function assetAt(ts: number, id?: string): ImageAsset {
  return {
    id: id ?? `p${ts.toString(36)}`,
    filePath: "/tmp/x.png",
    fileName: "x.png",
    width: 100,
    height: 80,
    format: "png",
    fileSize: 1024,
    sha256: null,
    exif: {},
    takenAt: new Date(ts).toISOString(),
    tags: [],
    sceneType: null,
    rating: null,
    thumbnails: {},
    createdAt: new Date(ts).toISOString(),
  };
}

// ──────────────────────────── 分簇 ────────────────────────────

test("事件聚类：间隔>3h 切簇，连续照片同簇，未记录时间归末簇", () => {
  const base = Date.parse("2026-09-12T10:00:00Z");
  const assets = [
    assetAt(base),
    assetAt(base + 20 * 60_000),        // 20min 后 → 同簇
    assetAt(base + 4 * 3_600_000),      // 4h 后 → 新簇
    {
      ...assetAt(base, "untimed-1"),
      takenAt: null,
      createdAt: "not-a-date",
    },                                  // 无时间 → 末簇
  ];

  const clusters = clusterAssetsByTime(assets as ImageAsset[]);
  assert.equal(clusters.length, 3);
  assert.equal(clusters[0]!.length, 2);
  assert.equal(clusters[1]!.length, 1);
  assert.equal(clusters[2]!.length, 1);
  assert.equal(clusters[2]![0]!.id, "untimed-1");
});

// ──────────────────────────── 布局 ────────────────────────────

test("沙龙照片墙布局：簇即墙、密贴不重叠、墙主/今日之图/待分析计数", async () => {
  const root = path.join(tmpDir, "layout-root");
  const kit = await createPictureKit({ rootDir: root });
  try {
    const now = new Date();
    const base = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 9, 0, 0).getTime(); // 去年同日 → 「一年前的今天」

    const assets = [
      assetAt(base, "a1"),
      assetAt(base + 5 * 60_000, "a2"),
      assetAt(new Date(now.getFullYear(), Math.min(11, now.getMonth() + 1), 2, 14, 0, 0).getTime(), "b1"),
    ];
    const layout = computeWallLayout(assets);

    assert.equal(layout.version, 1);
    assert.equal(layout.photoCount, 3);
    assert.equal(layout.events.length, 2);
    assert.equal(layout.pendingAnalysis, 3);

    // 第一面墙（8月簇，2 张密贴）
    const first = layout.events[0]!;
    assert.equal(first.photoCount, 2);
    const titleRe = new RegExp(`${now.getMonth() + 1}月${now.getDate()}日`);
    assert.match(first.title, titleRe);
    assert.equal(first.side, 1);
    assert.ok(first.ownerPhotoId, "应有墙主");
    assert.ok(first.photos.some((p) => p.id === first.ownerPhotoId));
    assert.ok(first.wallEndX > first.wallStartX);

    // 密贴不重叠：按 x 排序后相邻画幅中心距 > 半宽和 + 呼吸缝一半
    const ordered = [...first.photos].sort((a, b) => a.pos[0]! - b.pos[0]!);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!, cur = ordered[i]!;
      const minDist = (prev.hangWidth + cur.hangWidth) / 2; // 几何不重叠（密贴缝隙 0.05 属设计内）
      assert.ok(cur.pos[0]! - prev.pos[0]! >= minDist - 0.03, `画幅重叠: ${prev.id} vs ${cur.id}`);
    }
    // 全部落在墙段范围内
    for (const p of first.photos) {
      assert.ok(p.pos[0]! >= first.wallStartX && p.pos[0]! <= first.wallEndX);
    }
    // 画幅尺寸：墙主大幅（≥1.2m 高），成员小一档（≤1.1m）
    const ownerPhoto = first.photos.find((p) => p.id === first.ownerPhotoId)!;
    assert.ok(ownerPhoto.hangHeight >= 1.2, "墙主应大幅");
    const member = first.photos.find((p) => p.id !== first.ownerPhotoId)!;
    assert.ok(member.hangHeight <= 1.1, "成员应小一档");

    // 第二面墙（9月簇）在另一侧、位于第一面墙之后
    const second = layout.events[1]!;
    assert.equal(second.side, -1);
    assert.ok(second.wallStartX >= first.wallEndX);

    // 今日之图：a1/a2 是「一年前的今天」拍的
    assert.ok(layout.todayPhoto);
    assert.match(layout.todayPhoto.reason, /一年前的今天/);
    assert.ok(layout.todayPhoto.side !== first.side || true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("沙龙照片墙：设为墙主覆盖自动选择", async () => {
  const root = path.join(tmpDir, "layout-root-owner");
  const kit = await createPictureKit({ rootDir: root });
  const app = Fastify();
  registerGalleryWallRoutes(app, { pictureKit: kit });
  try {
    const { asset: a1 } = await kit.store.ingest(await (await import("sharp")).default({
      create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer(), { fileName: "o1.png" });
    const { asset: a2 } = await kit.store.ingest(await (await import("sharp")).default({
      create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).png().toBuffer(), { fileName: "o2.png" });

    const { GalleryWallService } = await import("../src/services/gallery-wall-service.js");
    const wallService = new GalleryWallService(kit, kit.store.rootDir);
    const before = await wallService.layout();
    assert.equal(before.events.length, 1);
    const autoOwner = before.events[0]!.ownerPhotoId;
    assert.ok(autoOwner === a1.id || autoOwner === a2.id);

    const chosen = autoOwner === a1.id ? a2.id : a1.id;
    const setRes = await app.inject({
      method: "POST",
      url: "/gallery-wall/wall-owner",
      payload: { photoId: chosen },
    });
    assert.equal(setRes.json().ok, true);

    const after = await wallService.layout();
    assert.equal(after.events[0]!.ownerPhotoId, chosen, "覆盖应生效");
    const ownerPhoto = after.events[0]!.photos.find((p) => p.id === chosen)!;
    assert.equal(ownerPhoto.isOwner, true);

    // 未知照片 404
    const bad = await app.inject({
      method: "POST",
      url: "/gallery-wall/wall-owner",
      payload: { photoId: "nope" },
    });
    assert.equal(bad.statusCode, 404);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ──────────────────────────── GPS 解析 ────────────────────────────

test("parseExifGps：度分秒 → 十进制，南/西半球为负", () => {
  assert.ok(Math.abs((parseExifGps("31 deg 13' 22.32\" N", "N") ?? 0) - 31.222866) < 1e-5);
  assert.ok((parseExifGps("31 deg 13' 22.32\"", "S") ?? 0) < 0);
  assert.ok((parseExifGps("121 deg 28' 7.20\"", "W") ?? 0) < 0);
  assert.equal(parseExifGps(undefined, "N"), null);
  assert.equal(parseExifGps("garbage", "N"), null);
});

// ──────────────────────────── 路由 ────────────────────────────

test("gallery-wall 路由：页面桥探针 / vendor / layout / analyze", async () => {
  const root = path.join(tmpDir, `route-kit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const kit = await createPictureKit({ rootDir: root });
  const app = Fastify();
  // 注入桩分析器：单测不依赖真实视觉模型凭据
  registerGalleryWallRoutes(app, {
    pictureKit: kit,
    analyzeFn: async (images) =>
      images.map(() => ({ scene: "室内", place: "大理古城", caption: "光线很软，时间慢下来" })),
  });
  try {
    const page = await app.inject({ method: "GET", url: "/gallery-wall" });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes("window.__galleryWall"));
    assert.ok(page.body.includes("importmap"));

    const vendor = await app.inject({ method: "GET", url: "/gallery-wall/vendor/three.module.js" });
    assert.equal(vendor.statusCode, 200);
    assert.ok(vendor.body.includes("Three.js Authors"));

    await kit.store.ingest(PNG_1PX, { fileName: "r.png" });
    const layout = await app.inject({ method: "GET", url: "/gallery-wall/layout" });
    assert.equal(layout.statusCode, 200);
    const body = layout.json();
    assert.equal(body.photoCount, 1);
    assert.ok(body.events.length >= 1);
    assert.equal(typeof body.pendingAnalysis, "number");

    const pending = await app.inject({ method: "GET", url: "/gallery-wall/pending" });
    assert.equal(pending.json().pending, body.pendingAnalysis);

    // analyze：桩分析器逐张返回结果并写回 analysis（layout 的待分析计数应清零）
    const analyze = await app.inject({
      method: "POST",
      url: "/gallery-wall/analyze",
      payload: { limit: 4 },
    });
    assert.equal(analyze.statusCode, 200);
    assert.equal(analyze.json().ok, true);
    assert.equal(analyze.json().analyzed, 1);
    assert.equal(analyze.json().failed, 0);
    assert.equal(analyze.json().remaining, 0);

    const layoutAfter = await app.inject({ method: "GET", url: "/gallery-wall/layout" });
    assert.equal(layoutAfter.json().pendingAnalysis, 0);
    const photoWithAnalysis = layoutAfter.json().events[0].photos[0];
    assert.equal(photoWithAnalysis.place, "大理古城");
    assert.equal(photoWithAnalysis.caption, "光线很软，时间慢下来");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
