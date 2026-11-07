import type { ShoppingPlatformAdapter } from "./types.js";
import { applySpecGroups, extractSpecGroups } from "./spec-extract.js";
import { TaobaoAdapter, TmallAdapter } from "./taobao-adapter.js";
import { JdAdapter } from "./jd-adapter.js";
import { MeituanAdapter } from "./meituan-adapter.js";
import { PddAdapter } from "./pdd-adapter.js";
import { DouyinAdapter } from "./douyin-adapter.js";
import { DamaiAdapter } from "./damai-adapter.js";
import { MaoyanAdapter } from "./maoyan-adapter.js";
import { SuningAdapter } from "./suning-adapter.js";
import { SmzdmAdapter } from "./smzdm-adapter.js";

export * from "./types.js";

/**
 * 已实现的平台 adapter 注册表。
 *
 * 综合电商：taobao / tmall / jd / pdd / douyin（均需登录态）；
 * 免登录取价：suning（苏宁易购，实时价）/ smzdm（什么值得买，爆料价情报）；
 * 本地生活：meituan（外卖闪购）；
 * 演出票务：damai（大麦）/ maoyan（猫眼）——实名制演出不代填证件信息，
 * 下单前由 agent 向用户确认观演人已在其账号内。
 */
const adapters: Record<string, ShoppingPlatformAdapter> = {
  taobao: new TaobaoAdapter(),
  tmall: new TmallAdapter(),
  jd: new JdAdapter(),
  meituan: new MeituanAdapter(),
  pdd: new PddAdapter(),
  douyin: new DouyinAdapter(),
  suning: new SuningAdapter(),
  smzdm: new SmzdmAdapter(),
  damai: new DamaiAdapter(),
  maoyan: new MaoyanAdapter(),
};

/**
 * 规格能力的统一挂载（2026-11-06 用户要求「把商家提供的所有组合呈现给用户」）。
 *
 * 各 adapter 不再各自实现「读规格 / 点规格」——由 `spec-extract.ts` 的选择器表
 * 驱动，平台 id 就是表的键。没有表项的平台调用返回空数组，调用方据此直接去
 * 结算，绝不给用户一个空的规格页。这样新增平台只要补一行选择器，不用改服务。
 */
for (const [platform, adapter] of Object.entries(adapters)) {
  adapter.extractSpecs ??= (page) => extractSpecGroups(page, platform);
  adapter.applySpecs ??= async (page, picked) => {
    const r = await applySpecGroups(page, platform, picked);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };
}

/** 获取平台 adapter；未实现时返回 null。 */export function getShoppingPlatformAdapter(platform: string): ShoppingPlatformAdapter | null {
  return adapters[platform] ?? null;
}

/** 列出所有已实现 adapter 的 platform 名。 */
export function listSupportedPlatforms(): string[] {
  return Object.keys(adapters);
}

/**
 * 商品比价的缺省平台：按各 adapter 自报的 category 派生（general=综合电商），
 * 保持注册顺序。本地生活（meituan 外卖闪购 / dianping 到店）与演出票务
 * （damai / maoyan）不卖标准商品，不参与商品比价缺省——用户明确指定平台时
 * 仍可传入任意已实现平台。
 *
 * 2026-11-06 起再收一层 `authMode`：缺省集合只要 anonymous（匿名能读到真实价）；
 * login 类平台要么被登录墙拦住空手而归、要么把一轮比价变成登录交接
 * （手机端无可视浏览器，实测淘宝/京东/拼多多全部如此）。用户已有授权 Cookie
 * 的 login 平台由调用方补进请求平台列表（见 ShoppingCompareService.comparePrices）。
 *
 * 设计约定（单一事实源）：这里**不维护**手写平台数组——缺省列表由注册表 +
 * adapter 自报字段推导；新增/删除 adapter 时只要类目/登录态标对，缺省列表
 * 自动跟随，漏标直接编译失败（两个字段都是必填）。
 */
export function listDefaultComparePlatforms(): string[] {
  return Object.keys(adapters).filter(
    (p) => adapters[p]!.category === "general" && adapters[p]!.authMode === "anonymous",
  );
}

/** 需要登录态才能取价的综合电商平台（有授权 Cookie 时可补进缺省集合）。 */
export function listLoginRequiredL1Platforms(): string[] {
  return Object.keys(adapters).filter(
    (p) => adapters[p]!.category === "general" && adapters[p]!.authMode === "login",
  );
}

/**
 * 该平台能不能真的下单（2026-11-06）：看 adapter 自报的 supportsCheckout
 * （默认 true）。情报站（什么值得买）false——候选卡据此禁用「下单」按钮。
 * 需要登录的平台依然是 true：登录在卡内扫码解决，不再是一票否决。
 */
export function platformSupportsCheckout(platform: string): boolean {
  return adapters[platform]?.supportsCheckout !== false;
}
