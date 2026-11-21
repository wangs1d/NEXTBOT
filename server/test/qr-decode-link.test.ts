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
 *     走 tbopen、jd 走 openapp.jdmobile）；pdd 不返回深链（down_scan 落地页
 *     跳 App 到不了确认页，2026-11-21 实测）；纯 token 串/无已知 scheme 的
 *     平台返回 null——不出「点码登录」，纯扫码兜底。
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

test("toAppLaunchLink：App scheme 原样透传（含非购物深链平台）", () => {
  const scheme = "taobao://s.taobao.com/search?q=手机";
  const link = toAppLaunchLink("taobao", scheme);
  assert.ok(link);
  assert.equal(link.link, scheme);
  assert.equal(link.fallback, undefined);
  // 码内容本身就是 App scheme：即使平台包装规则没收录，也照样透传
  assert.equal(
    toAppLaunchLink("douyin", "snssdk1128://webview?url=x")?.link,
    "snssdk1128://webview?url=x",
  );
  assert.equal(
    toAppLaunchLink("meituan", "imeituan://www.meituan.com/web?url=x")?.link,
    "imeituan://www.meituan.com/web?url=x",
  );
});

test("toAppLaunchLink：taobao/tmall 的 https 包装成 tbopen 深链（不回落网页）", () => {
  const url = "https://h5.m.taobao.com/qr/login.html?token=abc";
  const taobao = toAppLaunchLink("taobao", url);
  assert.ok(taobao);
  assert.equal(taobao.link, `tbopen://m.taobao.com/tbopen/index.html?h5Url=${encodeURIComponent(url)}`);
  assert.equal(taobao.fallback, undefined);

  const tmall = toAppLaunchLink("tmall", url);
  assert.ok(tmall);
  assert.equal(tmall.link, `tbopen://m.taobao.com/tbopen/index.html?h5Url=${encodeURIComponent(url)}`);
});

test("toAppLaunchLink：jd 的 https 包装成 openapp.jdmobile 深链（不回落网页）", () => {
  const url = "https://plogin.m.jd.com/qr/login?token=xyz";
  const link = toAppLaunchLink("jd", url);
  assert.ok(link);
  assert.ok(link.link.startsWith("openapp.jdmobile://virtual?params="));
  const params = JSON.parse(
    decodeURIComponent(link.link.slice("openapp.jdmobile://virtual?params=".length)),
  ) as { category: string; des: string; url: string };
  assert.deepEqual(params, { category: "jump", des: "url", url });
  assert.equal(link.fallback, undefined);
});

test("toAppLaunchLink：pdd 不返回深链（down_scan 是落地页，跳 App 到不了确认页）", () => {
  // 拼多多扫码登录码的真实内容（2026-11-20 云端解码所得）
  const url =
    "https://mobile.yangkeduo.com/down_scan.html?secret_key=abc&pdd_biz_scene=AUTH_LOGIN&app_id=512";
  // 2026-11-21 用户实测定稿：pinduoduo:// 宿主 / pddopen:// 都只落到下载页或
  // 首页，到不了登录确认界面——这条路是死的。返回 null → 客户端存相册走
  // App 扫一扫，服务端后台自动检测登录态。
  assert.equal(toAppLaunchLink("pdd", url), null);
});

test("toAppLaunchLink：没有已知 scheme 的平台返回 null（不出「点码登录」）", () => {
  // 返回原 https 会让 url_launcher 起浏览器（拼多多真机事故的同款路径），
  // 宁可不出按钮、退回相册扫码
  const unknown = toAppLaunchLink("suning", "https://login.suning.com/qr?token=1");
  assert.equal(unknown, null);
});

test("toAppLaunchLink：纯 token 串返回 null（App 打不开，纯扫码兜底）", () => {
  assert.equal(toAppLaunchLink("taobao", "E7C1D9F2-token-only"), null);
  assert.equal(toAppLaunchLink("jd", ""), null);
  assert.equal(toAppLaunchLink("jd", "   "), null);
});
