import type { ShoppingPlatformAdapter } from "./types.js";
import { TaobaoAdapter, TmallAdapter } from "./taobao-adapter.js";
import { JdAdapter } from "./jd-adapter.js";
import { MeituanAdapter } from "./meituan-adapter.js";
import { PddAdapter } from "./pdd-adapter.js";
import { DouyinAdapter } from "./douyin-adapter.js";
import { DamaiAdapter } from "./damai-adapter.js";
import { MaoyanAdapter } from "./maoyan-adapter.js";

export * from "./types.js";

/**
 * 已实现的平台 adapter 注册表。
 *
 * 综合电商：taobao / tmall / jd / meituan（外卖闪购）/ pdd / douyin；
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
  damai: new DamaiAdapter(),
  maoyan: new MaoyanAdapter(),
};

/** 获取平台 adapter；未实现时返回 null。 */
export function getShoppingPlatformAdapter(platform: string): ShoppingPlatformAdapter | null {
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
 * 设计约定（单一事实源）：这里**不维护**手写平台数组——缺省列表由注册表 +
 * adapter.category 推导；新增/删除 adapter 时只要类目标对，缺省列表自动跟随，
 * 漏标类目直接编译失败（category 为必填字段）。
 */
export function listDefaultComparePlatforms(): string[] {
  return Object.keys(adapters).filter((p) => adapters[p]!.category === "general");
}
