import { loadWebpayConfig } from "../config/webpay-config.js";

/**
 * 站内对外基址：授权页、收银台页、二维码内容都基于它生成。
 *
 * 解析顺序：PAYMENT_PUBLIC_BASE_URL（部署时显式指定）→ webpay baseUrl
 * （沙箱/生产已按 PORT 推导）→ 127.0.0.1:PORT 兜底。
 * 手机扫码要求这个地址在局域网/公网可达，否则二维码只能在同一台机器打开。
 */
export function resolvePublicBaseUrl(): string {
  const explicit = process.env.PAYMENT_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const webpay = loadWebpayConfig();
  if (webpay?.baseUrl) return webpay.baseUrl.replace(/\/+$/, "");
  const portRaw = Number(process.env.PORT);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3000;
  return `http://127.0.0.1:${port}`;
}

/** 授权页地址（用户在浏览器/客户端打开，设置额度并点击同意）。 */
export function authorizationPageUrl(params: {
  actorId: string;
  channel: string;
  amountCny?: number;
  subject?: string;
  bizDomain?: string;
  /** 授权完成后回跳的页面（通常是付款页），省掉用户再找一遍 */
  returnTo?: string;
}): string {
  const url = new URL(`${resolvePublicBaseUrl()}/payment/authorize`);
  url.searchParams.set("actorId", params.actorId);
  url.searchParams.set("channel", params.channel);
  if (params.amountCny != null) url.searchParams.set("amount", String(params.amountCny));
  if (params.subject) url.searchParams.set("subject", params.subject);
  if (params.bizDomain) url.searchParams.set("bizDomain", params.bizDomain);
  if (params.returnTo) url.searchParams.set("returnTo", params.returnTo);
  return url.toString();
}

/**
 * 付款页地址：金额/事由/付款方式选择 + 「确认付款」按钮都在这一页。
 * token 是确认令牌（10 分钟一次性），让「点按钮」这一下可被服务端验证；
 * 不带 token 也能打开页面（查看/重新取令牌），但真正扣款必须带。
 */
export function payPageUrl(params: { intentId: string; actorId: string; token?: string | null }): string {
  const url = new URL(`${resolvePublicBaseUrl()}/payment/pay`);
  url.searchParams.set("intentId", params.intentId);
  url.searchParams.set("actorId", params.actorId);
  if (params.token) url.searchParams.set("t", params.token);
  return url.toString();
}
