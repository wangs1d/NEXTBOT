/**
 * 通用二维码推送服务 + 支付确认按钮卡 单元测试。
 *
 * 验证：
 *   1. QrAssistService 三种来源（dataURL / 本地文件 / Buffer）→ 落盘 + 推卡
 *   2. 无推送通道 / 无 imageStore 时 best-effort 返回 null（不抛错）
 *   3. shopping.pay.submit builder 产出带 actions 的确认卡结构
 *   4. tryAttachToolResultCard 把 actions 透传进 AGENT_RESULT_CARD marker
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ImageGenerationService } from "../src/services/image-generation-service.js";
import { QrAssistService } from "../src/services/qr-assist-service.js";
import {
  lookupToolCardBuilder,
  tryAttachToolResultCard,
} from "../src/services/tool-card-registry.js";

/** 1x1 PNG。 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

type PushedCard = { type: string; title: string; thumbnailUrl?: string; mediaUrl?: string; caption?: string };

function makeEnv() {
  const pushed: PushedCard[] = [];
  const ctx = {
    sessionId: "test-qr-session",
    userId: "test-qr-user",
    agentAccessMode: "full" as const,
    pushMediaCards: (cards: PushedCard[]) => {
      pushed.push(...cards);
    },
  };
  return { pushed, ctx };
}

test("QrAssistService: dataURL source → savePng + push card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qr-assist-"));
  try {
    const imageStore = new ImageGenerationService({ storageRoot: dir });
    const qrAssist = new QrAssistService({ imageStore });
    const { pushed, ctx } = makeEnv();

    const dataUrl = `data:image/png;base64,${TINY_PNG.toString("base64")}`;
    const imageUrl = await qrAssist.pushQrImage(
      ctx,
      { title: "测试二维码", caption: "扫码测试" },
      { dataUrl },
    );

    assert.ok(imageUrl, "返回落盘 URL");
    assert.match(imageUrl, /^\/agent\/images\/test-qr-user\/\d+-[a-f0-9]{8}\.png$/);
    const filePath = join(dir, "test-qr-user", imageUrl.replace("/agent/images/test-qr-user/", ""));
    const s = await stat(filePath);
    assert.ok(s.size > 0, "PNG 真实落盘");

    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].type, "image");
    assert.equal(pushed[0].title, "测试二维码");
    assert.equal(pushed[0].caption, "扫码测试");
    assert.equal(pushed[0].mediaUrl, imageUrl);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("QrAssistService: filePath (file:///) and raw Buffer sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qr-assist-file-"));
  try {
    const imageStore = new ImageGenerationService({ storageRoot: dir });
    const qrAssist = new QrAssistService({ imageStore });

    // 先落一张源图
    const sourceUrl = await imageStore.savePng("src-user", TINY_PNG);
    const sourcePath = join(dir, "src-user", sourceUrl.replace("/agent/images/src-user/", ""));

    const { pushed, ctx } = makeEnv();

    const fromFile = await qrAssist.pushQrImage(ctx, { title: "来自文件" }, { filePath: sourcePath });
    const fromFileUrl = await qrAssist.pushQrImage(ctx, { title: "来自 file:// URI" }, { filePath: `file:///${sourcePath.replace(/\\/g, "/")}` });
    const fromBuffer = await qrAssist.pushQrImage(ctx, { title: "来自 Buffer" }, { png: TINY_PNG });

    assert.ok(fromFile && fromFileUrl && fromBuffer, "三种来源均成功");
    assert.equal(pushed.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("QrAssistService: best-effort — no push channel / no imageStore returns null without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qr-assist-none-"));
  try {
    // 无 pushMediaCards（后台任务上下文）
    const imageStore = new ImageGenerationService({ storageRoot: dir });
    const qrAssist = new QrAssistService({ imageStore });
    const silentCtx = { sessionId: "s", agentAccessMode: "full" as const };
    const r1 = await qrAssist.pushQrImage(
      silentCtx as Parameters<QrAssistService["pushQrImage"]>[0],
      { title: "t" },
      { png: TINY_PNG },
    );
    assert.equal(r1, null, "无推送通道 → null");

    // 无 imageStore
    const bare = new QrAssistService({});
    const { ctx } = makeEnv();
    const r2 = await bare.pushQrImage(ctx, { title: "t" }, { png: TINY_PNG });
    assert.equal(r2, null, "无图片服务 → null");

    // 非法 dataURL
    const withStore = new QrAssistService({ imageStore });
    const r3 = await withStore.pushQrImage(ctx, { title: "t" }, { dataUrl: "not-a-data-url" });
    assert.equal(r3, null, "非法 dataURL → null");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shopping.pay.submit builder produces confirm action card", () => {
  const builder = lookupToolCardBuilder("shopping.pay.submit");
  assert.ok(builder, "builder 已注册");

  const payload = builder({
    ok: true,
    orderId: "so_test_1",
    platform: "jd",
    amountCny: 42.5,
    itemTitle: "测试商品",
  });
  assert.ok(payload);
  assert.equal(payload!.title, "💳 支付确认");
  // 2026-11 购物卡族满版化：支付确认卡随族改为 shopping_pay（自绘版面）
  assert.equal(payload!.cardType, "shopping_pay");
  assert.ok(payload!.actions && payload!.actions.length === 2, "两个按钮");
  assert.equal(payload!.actions![0].id, "shopping_pay_done");
  assert.equal(payload!.actions![0].variant, "primary");
  assert.deepEqual(payload!.actions![0].payload, { localOrderId: "so_test_1", platform: "jd" });
  assert.equal(payload!.actions![1].id, "shopping_pay_later");

  // 失败结果 / 缺单号 → 不出卡
  assert.equal(builder({ ok: false, error: "x" }), null);
  assert.equal(builder({ ok: true }), null);
});

test("tryAttachToolResultCard passes actions through into AGENT_RESULT_CARD marker", () => {
  const marker = tryAttachToolResultCard(
    "已在内置浏览器打开收银台",
    "shopping.pay.submit",
    { ok: true, orderId: "so_test_2", platform: "taobao", amountCny: 128, itemTitle: "商品A" },
  );
  assert.ok(marker, "生成 marker");
  assert.match(marker, /\[AGENT_RESULT_CARD_START\]/);
  assert.match(marker, /已在内置浏览器打开收银台/);
  assert.match(marker, /shopping_pay_done/);
  assert.match(marker, /"variant":"primary"/);
  assert.match(marker, /so_test_2/);

  const jsonLine = marker.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(jsonLine);
  const parsed = JSON.parse(jsonLine!.trim());
  assert.ok(Array.isArray(parsed.actions) && parsed.actions.length === 2, "actions 非空数组透传");
  assert.equal(parsed.cardId.startsWith("card_"), true);
});
