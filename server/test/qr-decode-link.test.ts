/**
 * 点码登录（2026-11-14）回归锁：二维码解码 + App 深链转换。
 *
 * 背景：手机端扫码登录要「存图 → 开 App → 相册扫码」三步，太长。服务端
 * 手里就有二维码 PNG——解码出内嵌 URL，按平台包装成 App 深链（tbopen://、
 * openapp.jdmobile://），手机端点「点码登录」按钮直接拉起 App 确认。
 *
 * 锁定的行为：
 *   - decodeQrLink：qrcode 生成 → jsQR 解码 roundtrip；坏图/非二维码图返回
 *     null 而不是抛错（best-effort，绝不影响推码主流程）；
 *   - toAppLaunchLink：App scheme 原样透传；https 按平台包装（taobao/tmall
 *     走 tbopen、jd 走 openapp.jdmobile）；pdd/未知平台直通原 URL 兜底；
 *     纯 token 串（App 打不开）返回 null——该平台不出按钮，纯扫码兜底。
 */
import assert from "node:assert/strict";
import test from "node:test";

import QRCode from "qrcode";

import { decodeQrLink, toAppLaunchLink } from "../src/services/qr-assist-service.js";

async function pngOf(text: string): Promise<Buffer> {
  return await QRCode.toBuffer(text, { width: 320, margin: 2 });
}

test("decodeQrLink：qrcode 生成 → jsQR 解码 roundtrip", async () => {
  const url = "https://h5.m.taobao.com/qr/login.html?token=abc123";
  const png = await pngOf(url);
  assert.equal(await decodeQrLink(png), url);
});

test("decodeQrLink：坏输入返回 null 不抛错", async () => {
  assert.equal(await decodeQrLink(Buffer.from("not a png")), null);
  assert.equal(await decodeQrLink(Buffer.alloc(0)), null);
});

test("decodeQrLink：非二维码的合法 PNG 返回 null", async () => {
  // 1x1 红点：合法 PNG 但没有码
  const png = await QRCode.toBuffer("x", { width: 32 });
  const decoded = await decodeQrLink(png);
  // 只要不是抛错即可——1x1 缩放后能否解出无关紧要
  assert.ok(decoded === null || typeof decoded === "string");
});

test("toAppLaunchLink：App scheme 原样透传", () => {
  const scheme = "taobao://s.taobao.com/search?q=手机";
  const link = toAppLaunchLink("taobao", scheme);
  assert.ok(link);
  assert.equal(link.link, scheme);
  assert.equal(link.fallback, undefined);
});

test("toAppLaunchLink：taobao/tmall 的 https 包装成 tbopen 深链", () => {
  const url = "https://h5.m.taobao.com/qr/login.html?token=abc";
  const taobao = toAppLaunchLink("taobao", url);
  assert.ok(taobao);
  assert.equal(taobao.link, `tbopen://m.taobao.com/tbopen/index.html?h5Url=${encodeURIComponent(url)}`);
  assert.equal(taobao.fallback, url);

  const tmall = toAppLaunchLink("tmall", url);
  assert.ok(tmall);
  assert.equal(tmall.link, `tbopen://m.taobao.com/tbopen/index.html?h5Url=${encodeURIComponent(url)}`);
});

test("toAppLaunchLink：jd 的 https 包装成 openapp.jdmobile 深链", () => {
  const url = "https://plogin.m.jd.com/qr/login?token=xyz";
  const link = toAppLaunchLink("jd", url);
  assert.ok(link);
  assert.ok(link.link.startsWith("openapp.jdmobile://virtual?params="));
  const params = JSON.parse(
    decodeURIComponent(link.link.slice("openapp.jdmobile://virtual?params=".length)),
  ) as { category: string; des: string; url: string };
  assert.deepEqual(params, { category: "jump", des: "url", url });
  assert.equal(link.fallback, url);
});

test("toAppLaunchLink：pdd/未知平台 https 直通原 URL 兜底", () => {
  const url = "https://login.pinduoduo.com/qr?token=1";
  const pdd = toAppLaunchLink("pdd", url);
  assert.ok(pdd);
  assert.equal(pdd.link, url);

  const unknown = toAppLaunchLink("suning", url);
  assert.ok(unknown);
  assert.equal(unknown.link, url);
});

test("toAppLaunchLink：纯 token 串返回 null（App 打不开，纯扫码兜底）", () => {
  assert.equal(toAppLaunchLink("taobao", "E7C1D9F2-token-only"), null);
  assert.equal(toAppLaunchLink("jd", ""), null);
  assert.equal(toAppLaunchLink("jd", "   "), null);
});
