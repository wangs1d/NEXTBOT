import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serverRoot } from "./paths.js";

/**
 * AI 网页应用收款（alipay.trade.page.pay）配置。
 *
 * 沙箱：读取项目根 .alipay-sandbox.json（Skill 沙箱流程写入的受保护本机配置），
 * Node.js 固定使用其中的 appPrivatePkcsKey（PKCS#1 原始值，不做任何格式加工）。
 * 生产：由用户自行在环境注入 WEBPAY_ALIPAY_*（PKCS#1），Agent 不接触生产私钥。
 * 两者都不存在时返回 null，路由按未配置 503，不回退示例值或占位密钥。
 */

export const ALIPAY_SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
export const ALIPAY_PRODUCTION_GATEWAY = "https://openapi.alipay.com/gateway.do";

export interface WebpayConfig {
  env: "sandbox" | "production";
  appId: string;
  /** PKCS#1 原始私钥字符串（无 PEM 头尾） */
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  sellerId: string;
  sellerEmail: string;
  /** 本站对外 base URL，用于 return_url（协议+主机+端口，无尾斜杠） */
  baseUrl: string;
  /** 可选公网 HTTPS 异步通知地址；空串 = 下单省略 notify_url，主动查单兜底 */
  notifyUrl: string;
}

export function webpaySandboxConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WEBPAY_SANDBOX_CONFIG?.trim();
  if (override) return resolve(override);
  return resolve(serverRoot(), "..", ".alipay-sandbox.json");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultBaseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.WEBPAY_BASE_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const portRaw = Number(env.PORT);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3000;
  return `http://127.0.0.1:${port}`;
}

function readNotifyUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.WEBPAY_NOTIFY_URL?.trim() ?? "";
  // 使用通知时必须是公网 HTTPS 地址，且不得含空格/HTML 标签；不满足则整体省略，由主动查单兜底
  if (!raw || /[\s<>]/.test(raw)) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

export function loadWebpayConfig(env: NodeJS.ProcessEnv = process.env): WebpayConfig | null {
  const baseUrl = defaultBaseUrl(env);
  const notifyUrl = readNotifyUrl(env);

  const sandboxPath = webpaySandboxConfigPath(env);
  if (existsSync(sandboxPath)) {
    try {
      const raw = JSON.parse(readFileSync(sandboxPath, "utf8")) as Record<string, unknown>;
      const appId = readString(raw.appId);
      const privateKey = readString(raw.appPrivatePkcsKey);
      const alipayPublicKey = readString(raw.alipayPublicKey);
      if (!appId || !privateKey || !alipayPublicKey) return null;
      return {
        env: "sandbox",
        appId,
        privateKey,
        alipayPublicKey,
        gateway: readString(raw.gateway) || ALIPAY_SANDBOX_GATEWAY,
        sellerId: readString(raw.sellerId),
        sellerEmail: readString(raw.sellerEmail),
        baseUrl,
        notifyUrl,
      };
    } catch {
      return null;
    }
  }

  const appId = readString(env.WEBPAY_ALIPAY_APP_ID);
  const privateKey = readString(env.WEBPAY_ALIPAY_PRIVATE_KEY);
  const alipayPublicKey = readString(env.WEBPAY_ALIPAY_PUBLIC_KEY);
  if (!appId || !privateKey || !alipayPublicKey) return null;
  return {
    env: "production",
    appId,
    privateKey,
    alipayPublicKey,
    gateway: readString(env.WEBPAY_ALIPAY_GATEWAY) || ALIPAY_PRODUCTION_GATEWAY,
    sellerId: readString(env.WEBPAY_ALIPAY_SELLER_ID),
    sellerEmail: readString(env.WEBPAY_ALIPAY_SELLER_EMAIL),
    baseUrl,
    notifyUrl,
  };
}