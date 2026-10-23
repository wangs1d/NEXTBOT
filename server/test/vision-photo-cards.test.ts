import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  persistVisionFrames,
  buildVisionPhotoCards,
  buildImageResultBlock,
  attachImageResultPhotos,
  IMAGE_RESULT_START,
  IMAGE_RESULT_END,
  type VisionPhotoItem,
} from "../src/services/vision-photo-cards.js";
import { stripMarkersToPlainText } from "../src/services/reply-envelope.js";

/**
 * 识图照片卡（image_result 真实设计）测试：
 * 每张照片 + 各自的一句话描述（内容 + 可推断拍摄场景/地点），
 * 结构化绑定下发（Coze 式），不依赖 LLM 正文。
 */

// 1x1 PNG（最小合法 PNG 字节）
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("persistVisionFrames：帧落盘并返回 /agent/images 访问 URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-cards-"));
  try {
    const urls = await persistVisionFrames(
      "actor-1",
      [
        {
          sourceKind: "device_camera",
          sourceId: "phone",
          mimeType: "image/png",
          dataBase64: PNG_BASE64,
          capturedAt: new Date().toISOString(),
        },
        {
          sourceKind: "device_camera",
          sourceId: "phone",
          mimeType: "image/jpeg",
          dataBase64: PNG_BASE64,
          capturedAt: new Date().toISOString(),
        },
      ],
      dir,
    );
    assert.equal(urls.length, 2);
    assert.ok(urls[0].startsWith("/agent/images/actor-1/vision-"));
    assert.ok(urls[0].endsWith(".png"));
    assert.ok(urls[1].endsWith(".jpg"));
    // 文件确实落盘（URL → images/{actor}/{file}）
    const rel = urls[0].replace("/agent/images/", "");
    const buf = await readFile(join(dir, "images", rel));
    assert.ok(buf.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildVisionPhotoCards：落盘 + 注入 captioner → 照片与描述成对返回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-cards-"));
  try {
    const items = await buildVisionPhotoCards({
      actorId: "actor-1",
      frames: [
        {
          sourceKind: "device_camera",
          sourceId: "phone",
          mimeType: "image/png",
          dataBase64: PNG_BASE64,
          capturedAt: new Date().toISOString(),
        },
      ],
      baseDir: dir,
      locationHint: "上海市徐汇区",
      captioner: async (cards) => cards.map(() => "书桌上的橘猫，室内书房场景"),
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].caption, "书桌上的橘猫，室内书房场景");
    assert.ok(items[0].url.startsWith("/agent/images/"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildImageResultBlock / attachImageResultPhotos：结构化块格式与附着位置", () => {
  const items: VisionPhotoItem[] = [
    { url: "/agent/images/a/1.jpg", caption: "外滩夜景，人流如织" },
    { url: "/agent/images/a/2.jpg", caption: "" },
  ];
  const block = buildImageResultBlock(items);
  assert.ok(block.startsWith(IMAGE_RESULT_START));
  assert.ok(block.endsWith(IMAGE_RESULT_END));
  assert.ok(block.includes("外滩夜景，人流如织"));

  // 附着：紧跟 [RENDER_AS:image_result] 行之后
  const reply = "[RENDER_AS:image_result]\n这是识别到的两张照片。";
  const attached = attachImageResultPhotos(reply, items);
  const renderAsIdx = attached.indexOf("[RENDER_AS:image_result]");
  const blockIdx = attached.indexOf(IMAGE_RESULT_START);
  assert.ok(blockIdx > renderAsIdx);
  assert.ok(attached.indexOf("这是识别到的两张照片") > blockIdx);

  // 重复防护：已含块时不二次附着
  assert.equal(attachImageResultPhotos(attached, items), attached);

  // 无 RENDER_AS 行时附着在文本最前
  const plain = attachImageResultPhotos("你好", items);
  assert.ok(plain.startsWith(IMAGE_RESULT_START));

  // 空条目不动
  assert.equal(attachImageResultPhotos(reply, []), reply);
});

test("plain 编码：识图照片卡只保留描述行，URL 不透出", () => {
  const block =
    "[IMAGE_RESULT_START]\n" +
    JSON.stringify({
      items: [
        { url: "/agent/images/a/1.jpg", caption: "外滩夜景" },
        { url: "/agent/images/a/2.jpg", caption: "" },
      ],
    }) +
    "\n[IMAGE_RESULT_END]";
  const plain = stripMarkersToPlainText(`看这些照片：\n${block}\n完`);
  assert.ok(!plain.includes("IMAGE_RESULT"), plain);
  assert.ok(!plain.includes("/agent/images"), "URL 不应透出");
  assert.ok(plain.includes("· 外滩夜景"));
  assert.ok(plain.includes("看这些照片"));
});
