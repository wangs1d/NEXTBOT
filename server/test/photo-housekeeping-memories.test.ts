import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 图库治理与记忆回顾测试（picture.housekeeping / picture.memories）。
 *
 * 覆盖：
 * - housekeeping suggest：连拍簇识别 / 迷你小图识别
 * - housekeeping remove：未确认 → needsConfirmation；确认后真删（连文件）
 * - memories：窗口期事件聚合、代表照片与文案
 *
 * 运行：npx tsx --test test/photo-housekeeping-memories.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-hk-test-"));

const { createPictureKit } = await import("@nextbot/picture");
const {
  createPictureHousekeepingHandler,
  createPictureMemoriesHandler,
} = await import("../src/tools/capability-modules/photo/handlers.js");
const { extractMediaCards } = await import("../src/services/tool-result-processor.js");

type PictureKit = import("@nextbot/picture").PictureKit;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function makeKit(prefix: string): Promise<PictureKit> {
  return createPictureKit({ rootDir: path.join(tmpDir, `${prefix}-${Math.random().toString(36).slice(2)}`) });
}

/** 生成内容互异的 1px PNG（同一 PNG 会被 sha256 去重合并成一张） */
async function uniquePng(seed: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: seed & 0xff, g: (seed * 7) & 0xff, b: (seed * 13) & 0xff },
    },
  })
    .png()
    .toBuffer();
}

test("housekeeping：连拍簇与迷你图进建议；remove 需确认后才真删", async () => {
  const kit = await makeKit("hk");
  try {
    // 4 张同秒连拍（ingest 间隔远小于 2s；内容互异避免哈希去重）
    const ingested: Array<{ id: string; filePath: string }> = [];
    for (let i = 0; i < 4; i++) {
      const { asset } = await kit.store.ingest(await uniquePng(i + 1), { fileName: `burst-${i}.png` });
      ingested.push({ id: asset.id, filePath: asset.filePath });
    }

    const handler = createPictureHousekeepingHandler(kit);

    const suggest = (await handler({ action: "suggest" }, {} as never)) as {
      ok: boolean;
      totalCandidates: number;
      bursts: Array<{ candidates: Array<{ id: string }> }>;
      tiny: Array<{ id: string }>;
    };
    assert.equal(suggest.ok, true);
    assert.ok(suggest.totalCandidates > 0);
    assert.equal(suggest.bursts.length, 1);
    assert.equal(suggest.bursts[0]!.candidates.length, 3); // 保留第一张，3 张进候选
    assert.ok(suggest.tiny.length >= 1); // 1px PNG < 30KB

    // 未确认：needsConfirmation，不删除
    const candidateIds = suggest.bursts[0]!.candidates.map((c) => c.id);
    const refused = (await handler(
      { action: "remove", photoIds: candidateIds },
      {} as never,
    )) as { needsConfirmation?: boolean; error?: string };
    assert.equal(refused.needsConfirmation, true);
    assert.ok(kit.store.get(candidateIds[0]!));

    // 确认后：真删（文件一并清理）
    const removed = (await handler(
      { action: "remove", photoIds: candidateIds, confirmed: true },
      {} as never,
    )) as { ok: boolean; removed: number };
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, 3);
    for (const id of candidateIds) {
      assert.equal(kit.store.get(id), null);
    }
    assert.equal(fs.existsSync(ingested[1]!.filePath), false);
  } finally {
    fs.rmSync(kit.store.rootDir, { recursive: true, force: true });
  }
});

test("memories：近 30 天事件聚合并给出代表照片与汇总文案", async () => {
  const kit = await makeKit("mem");
  try {
    await kit.store.ingest(await uniquePng(11), { fileName: "m1.png" });
    await kit.store.ingest(await uniquePng(12), { fileName: "m2.png" });

    const handler = createPictureMemoriesHandler(kit);
    const result = (await handler({ days: 30, count: 3 }, {} as never)) as {
      ok: boolean;
      memories: Array<{ title: string; photoCount: number; photos: Array<{ thumbnailUrl: string; caption: string | null }> }>;
      text: string;
    };
    assert.equal(result.ok, true);
    assert.equal(result.memories.length, 1); // 同秒入库 → 一簇
    assert.equal(result.memories[0]!.photoCount, 2);
    assert.equal(result.memories[0]!.photos.length, 2);
    assert.ok(result.memories[0]!.photos[0]!.thumbnailUrl.startsWith("/picture/assets/"));
    assert.match(result.text, /2 张照片/);

    // 空图库
    const emptyKit = await makeKit("mem-empty");
    try {
      const empty = (await createPictureMemoriesHandler(emptyKit)({ days: 30 }, {} as never)) as { ok: boolean; memories: unknown[] };
      assert.equal(empty.ok, true);
      assert.equal(empty.memories.length, 0);
    } finally {
      fs.rmSync(emptyKit.store.rootDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(kit.store.rootDir, { recursive: true, force: true });
  }
});

test("媒体卡：picture.memories 确定性建图卡（caption 走视觉分析短句）", () => {
  const cards = extractMediaCards("picture.memories", {
    memories: [
      {
        title: "9月12日 下午 · 大理",
        photos: [
          { id: "p1", thumbnailUrl: "/picture/assets/p1/thumbnail/medium", imageUrl: "/picture/assets/p1/file", caption: "风很轻" },
          { id: "p2", thumbnailUrl: "", imageUrl: "" },
        ],
      },
    ],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.type, "image");
  assert.equal(cards[0]!.caption, "风很轻");
  assert.equal(cards[0]!.mediaUrl, "/picture/assets/p1/file");
});
