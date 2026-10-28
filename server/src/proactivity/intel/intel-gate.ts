// 统一入口闸：所有信源进面板前的同一道门。
//
// 只挡「注定不需要」的东西——一次性口令、营销推送、账号类系统通知（注册/激活/
// 登录成功这类流水通知）。安全告警、交易、人际消息一律放行，值不值得说交给模型。
// 闸口是纯确定性、失败即放行（fail-open）：宁可让模型多看一眼，也不能因为正则
// 抛错把真消息吞掉。被挡样本进状态面板，便于复核误杀。

import type {
  IntelGateCategory,
  IntelGateSample,
  IntelGateStats,
  IntelGateVerdict,
} from "./intel-types.js";

/** 一次性口令语境（必须同时有 4–8 位数字才算，避免「验证码登录已开启」这类通知被误挡） */
const OTP_CONTEXT =
  /(验证码|校验码|动态密码|动态码|验证代码|安全代码|verification\s+code|security\s+code|login\s+code|sign[-\s]?in\s+code|one[-\s]?time\s+(?:password|code|passcode)|\botp\b)/i;
const OTP_CODE = /(?:^|\D)\d{4,8}(?!\d)/;

/** 主题级营销词：主题命中即判营销（事务性邮件正文里的营销尾巴不会误伤） */
const PROMO_SUBJECT =
  /(促销|优惠|折扣|特惠|秒杀|满减|满赠|立减|返现|返券|红包|优惠券|代金券|大促|清仓|闪购|拼团|免单|0元购|0元领|免费领|扫码领|立省|抽奖|专享|会员日|双十一|双11|黑五|年货节|购物节|退订|取消订阅|\b(?:sale|promos?|promotions?|discount|discounts|coupons?|deals?|cashback|clearance|newsletter|unsubscribe|exclusive\s+offer|limited[-\s]?time\s+offer)\b)/i;

const UNSUBSCRIBE = /(退订|取消订阅|不再接收|停止接收|拒收此类邮件|unsubscribe|opt[-\s]?out)/i;
const PROMO_TEXT_KEYWORD =
  /(促销|优惠|折扣|特惠|秒杀|满减|立减|返现|红包|优惠券|大促|清仓|闪购|拼团|抽奖|\b(?:sale|promos?|promotions?|discount|coupons?|deals?|cashback|clearance)\b)/i;
const PROMO_FROM = /(?:^|[._-])(?:promo|promotion|marketing|newsletter|edm|deals|offers|sales|advertising)(?:[._-]|@|$)/i;

/** 账号/订阅类流水通知 */
const ACCOUNT_NOISE =
  /(注册成功|注册完成|欢迎加入|账号已激活|账户已激活|激活成功|绑定成功|邮箱验证成功|订阅成功|已成功订阅|退订成功|登录成功|欢迎注册|完成注册)/i;
/** 安全语境：即便是「登录成功」也可能是被盗提醒，有这些词就放行给模型 */
const SECURITY_CONTEXT =
  /(异常|异地|境外|新设备|陌生设备|风险|失败|未授权|被盗|安全提醒|安全警报|suspicious|unusual|new\s+device|unauthorized|failed)/i;

export type IntelGateOptions = {
  /** 白名单发件人（邮箱地址或 @domain）：用户钦点的来源永远放行 */
  vipSenders?: readonly string[];
  nowFn?: () => number;
  /** 保留的被挡样本条数（状态面板复核用） */
  sampleLimit?: number;
};

export type IntelGateCheckInput = {
  source: string;
  title: string;
  text: string;
  from?: string;
};

const DEFAULT_SAMPLE_LIMIT = 20;

function extractAddress(from: string | undefined): string {
  if (!from) return "";
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export class IntelGate {
  private readonly vipSenders: string[];
  private readonly nowFn: () => number;
  private readonly sampleLimit: number;
  private readonly samples: IntelGateSample[] = [];
  private readonly byCategory: Record<IntelGateCategory, number> = { otp: 0, marketing: 0, noise: 0 };
  private checked = 0;
  private allowed = 0;
  private blocked = 0;

  constructor(opts: IntelGateOptions = {}) {
    this.vipSenders = (opts.vipSenders ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    this.nowFn = opts.nowFn ?? Date.now;
    this.sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  }

  /** 纯函数式判定；任何异常按放行处理（fail-open） */
  check(input: IntelGateCheckInput): IntelGateVerdict {
    this.checked += 1;
    let verdict: IntelGateVerdict;
    try {
      verdict = this.decide(input);
    } catch {
      verdict = { allow: true };
    }
    if (verdict.allow) {
      this.allowed += 1;
      return verdict;
    }
    this.blocked += 1;
    this.byCategory[verdict.category] += 1;
    if (this.samples.length >= this.sampleLimit) this.samples.shift();
    this.samples.push({
      at: this.nowFn(),
      source: input.source,
      ...(input.from ? { from: input.from } : {}),
      title: input.title.slice(0, 120),
      category: verdict.category,
      rule: verdict.rule,
    });
    return verdict;
  }

  stats(): IntelGateStats {
    return {
      checked: this.checked,
      allowed: this.allowed,
      blocked: this.blocked,
      byCategory: { ...this.byCategory },
      samples: [...this.samples],
    };
  }

  private decide(input: IntelGateCheckInput): IntelGateVerdict {
    if (this.isVip(input.from)) return { allow: true };
    const title = input.title ?? "";
    const text = input.text ?? "";
    const both = `${title}\n${text}`;

    if (OTP_CONTEXT.test(both) && OTP_CODE.test(both)) {
      return { allow: false, category: "otp", rule: "gate:otp:code" };
    }

    const addr = extractAddress(input.from);
    const local = addr.split("@")[0] ?? "";
    const unsub = UNSUBSCRIBE.test(text);
    if (
      PROMO_SUBJECT.test(title) ||
      (unsub && PROMO_TEXT_KEYWORD.test(text)) ||
      (unsub && PROMO_FROM.test(local))
    ) {
      return { allow: false, category: "marketing", rule: "gate:marketing:offer" };
    }

    if (ACCOUNT_NOISE.test(both) && !SECURITY_CONTEXT.test(both)) {
      return { allow: false, category: "noise", rule: "gate:noise:account_lifecycle" };
    }

    return { allow: true };
  }

  private isVip(from: string | undefined): boolean {
    if (this.vipSenders.length === 0) return false;
    const addr = extractAddress(from);
    if (!addr) return false;
    for (const entry of this.vipSenders) {
      if (entry.startsWith("@") ? addr.endsWith(entry) : addr === entry) return true;
    }
    return false;
  }
}

export function createIntelGate(opts: IntelGateOptions = {}): IntelGate {
  return new IntelGate(opts);
}
