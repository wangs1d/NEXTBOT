import { loadWebpayConfig } from "../config/webpay-config.js";

/**
 * 支付宝账户凭证（统一入口）。
 *
 * 现状：凭证在项目里有三套命名——webpay（WEBPAY_ALIPAY_*）、老支付网关
 * （ALIPAY_*）、沙箱文件（项目根 .alipay-sandbox.json）。三者指向同一个
 * 支付宝应用，但只有 webpay 的解析同时覆盖「沙箱文件 + 生产环境变量」，
 * 且把 PKCS#1 私钥原样保留（Agent 不接触生产私钥由用户注入）。
 *
 * 统一支付模块不再各自解析，统一走这里：
 *   1. 项目根 .alipay-sandbox.json（沙箱，Skill 沙箱流程写入）
 *   2. 环境变量 WEBPAY_ALIPAY_*（生产）
 * 同一份凭证同时支撑「网页收款（page.pay）」与「扫码支付（precreate）」，
 * 避免两个渠道出现「一个有配置、一个没有」的割裂。
 */

export interface AlipayAccount {
  appId: string;
  /** PKCS#1 原始私钥字符串（无 PEM 头尾） */
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  sellerId: string;
  sellerEmail: string;
  env: "sandbox" | "production";
}

/** 解析支付宝账户；未配置返回 null（调用方必须显式处理，不许兜底假凭证）。 */
export function loadAlipayAccount(env: NodeJS.ProcessEnv = process.env): AlipayAccount | null {
  const config = loadWebpayConfig(env);
  if (!config) return null;
  return {
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    sellerId: config.sellerId,
    sellerEmail: config.sellerEmail,
    env: config.env,
  };
}

/** 该账户是否具备指定能力所需的字段（当前两类能力字段要求一致，留作扩展点）。 */
export function alipayAccountReady(account: AlipayAccount | null): account is AlipayAccount {
  return Boolean(account?.appId && account?.privateKey && account?.alipayPublicKey);
}
