import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 照片风格化测试（photo-style-service + picture.stylize handler + 媒体卡）。
 *
 * 覆盖：
 * - 四风格全部出图（尺寸/格式/确定性：同输入同输出）
 * - 未知风格报错并列出可选
 * - handler apply：真实入库（tags 带风格名与源照片）、styles 列表
 * - 媒体卡：picture.stylize 确定性建图卡
 *
 * 运行：npx tsx --test test/photo-style.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-style-test-"));

const { applyPhotoStyle, PHOTO_STYLES } = await import("../src/services/photo-style-service.js");
const { createPictureStylizeHandler } = await import("../src/tools/capability-modules/photo/handlers.js");
const { extractMediaCards } = await import("../src/services/tool-result-processor.js");
const { createPictureKit } = await import("@nextbot/picture");

type PictureKit = import("@nextbot/picture").PictureKit;

/** 64x48 内容确定的测试图（渐变，避免 sha256 撞车） */
async function samplePhoto(seed: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: { width: 256, height: 192, channels: 3, background: { r: seed * 30 % 255, g: 90, b: 160 } },
  }).png().toBuffer();
}

test("四风格全部出图且确定性（同输入同输出）", async () => {
  const src = await samplePhoto(1);
  for (const style of PHOTO_STYLES) {
    const a = await applyPhotoStyle(src, style.id, { title: "测试", seed: "s1" });
    const b = await applyPhotoStyle(src, style.id, { title: "测试", seed: "s1" });
    assert.ok(a.buffer.length > 1000, `${style.id} 出图过小`);
    assert.equal(a.buffer.toString("base64"), b.buffer.toString("base64"), `${style.id} 应确定性`);
    assert.ok(a.width > 0 && a.height > 0);
  }
  // 未知风格
  await assert.rejects(() => applyPhotoStyle(src, "nope" as never), /未知风格/);
});

test("stylize handler：apply 真实入库（tags 带风格与源）+ styles 列表 + 未知 id", async () => {
  const kit: PictureKit = await createPictureKit({ rootDir: path.join(tmpDir, `kit-${Date.now()}`) });
  try {
    const { asset: src } = await kit.store.ingest(await samplePhoto(2), { fileName: "src.png" });
    const handler = createPictureStylizeHandler(kit);

    const unknown = await handler({ action: "apply", photoId: "missing", style: "noir" }, {} as never);
    assert.equal((unknown as Record<string, unknown>).ok, false);

    const badStyle = await handler({ action: "apply", photoId: src.id, style: "nope" }, {} as never);
    assert.match((badStyle as Record<string, unknown>).error as string, /未知风格/);

    const applied = (await handler(
      { action: "apply", photoId: src.id, style: "poster_torn", title: "样张" },
      {} as never,
    )) as { ok: boolean; photo: Record<string, unknown>; styleLabel: string };
    assert.equal(applied.ok, true);
    assert.equal(applied.styleLabel, "撕纸海报");
    assert.notEqual(applied.photo.id, src.id);

    const created = kit.store.get(String(applied.photo.id));
    assert.ok(created);
    assert.ok(created!.tags.includes("风格化"));
    assert.ok(created!.tags.includes("撕纸海报"));
    assert.ok(created!.tags.includes(`源:${src.id}`));

    const styles = (await handler({ action: "styles" }, {} as never)) as { ok: boolean; styles: unknown[] };
    assert.equal(styles.ok, true);
    assert.equal(styles.styles.length, 4);
  } finally {
    fs.rmSync(kit.store.rootDir, { recursive: true, force: true });
  }
});

test("媒体卡：picture.stylize 确定性建图卡", () => {
  const cards = extractMediaCards("picture.stylize", {
    styleLabel: "撕纸海报",
    photo: { thumbnailUrl: "/picture/assets/x/thumbnail/small", imageUrl: "/picture/assets/x/file" },
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.type, "image");
  assert.equal(cards[0]!.caption, "已变成「撕纸海报」风格");
});
