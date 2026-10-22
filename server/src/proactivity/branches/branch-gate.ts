// 树枝闸（BranchGate）—— 每根树枝一个「专门管上传信息的闸」（2026-10-22 用户定调）。
//
// 三段式（本类承担 L1+L2；L3 精简在 Summarizer）：
//   L1 确定性规则：强噪声/商业密度/豁免谓词/现役闸委托——零 LLM、宁误放不误杀；
//      message 树枝通过 delegate 直接复用现役 message-gate 语义（零行为漂移）；
//   L2 游标增量：BranchCursor 指纹去重——同内容换壳/重传/重扫不再上报。
//   L3 按需精简：过闸内容做压缩视图上报管道（Phase 2 接 LLM，模板直出兜底）。
//
// 设计红线：闸是入站信号处理器，绝不参与出口（对话正文/已流式输出不经过这里）。
import type { BranchGatePolicy, BranchGateVerdict, BranchManifest } from "./branch-types.js";
import { BranchCursor } from "./branch-cursor.js";

export type BranchGateDeps = {
  manifest: BranchManifest;
  cursor: BranchCursor;
  nowFn?: () => number;
};

export class BranchGate {
  private readonly policy: BranchGatePolicy;
  private readonly strongNoise: RegExp | null;
  private readonly commercial: RegExp | null;

  constructor(private readonly deps: BranchGateDeps) {
    this.policy = deps.manifest.gate;
    this.strongNoise = this.policy.strongNoise ? new RegExp(this.policy.strongNoise) : null;
    this.commercial = this.policy.commercialDensity
      ? new RegExp(/(优惠券|秒杀|限时|折扣|满减|包邮|领券|抽奖|积分兑换|会员日|新品上市|新品上架|活动价|立减|砍价|拼团|特惠|直降|促销|大促|上新|扫码进店|点击购买)/.source, "g")
      : null;
  }

  get manifest(): BranchManifest {
    return this.deps.manifest;
  }

  /**
   * 上报闸：返回 allowed 才把内容上报管道。
   * fingerprint 由调用方按内容语义给（消息=actor|channel|摘要；上传=actor|源名|条目集）。
   */
  admit(input: { text: string; fingerprint: string; meta?: Record<string, unknown> }): BranchGateVerdict {
    const text = String(input.text ?? "");

    // L1-a 全放行（upload 树枝）：用户主动给的内容不做价值裁决，只去重
    if (this.policy.passthrough) {
      return this.l2(input.fingerprint);
    }
    // L1-b 豁免谓词（人际触达/日程变动等强证据先行放行）
    if (this.policy.exempt?.(text, input.meta)) {
      return this.l2(input.fingerprint);
    }
    // L1-c 现役闸委托（message 树枝：与 message-gate 完全同语义）
    if (this.policy.delegate) {
      const verdict = this.policy.delegate(text, input.meta);
      if (verdict.gated) return { allowed: false, stage: "L1", reason: verdict.reason ?? "delegate_gated" };
      return this.l2(input.fingerprint);
    }
    // L1-d 强噪声：命中即挡（验证码/校验码/取件码/退订/中奖/贷款…）
    if (this.strongNoise?.test(text)) {
      return { allowed: false, stage: "L1", reason: "strong_noise" };
    }
    // L1-e 商业密度：≥n 个不同商业词才挡（单词误杀率高）
    if (this.commercial) {
      const hits = new Set(text.match(this.commercial) ?? []);
      if (hits.size >= (this.policy.commercialDensity ?? 2)) {
        return { allowed: false, stage: "L1", reason: "commercial_density" };
      }
    }
    return this.l2(input.fingerprint);
  }

  /** L2：游标去重（上报层判重，与入库层 external_message_id 判重分工） */
  private l2(fingerprint: string): BranchGateVerdict {
    if (this.deps.cursor.checkAndMark(this.deps.manifest.id, fingerprint)) {
      return { allowed: false, stage: "L2", reason: "already_reported" };
    }
    return { allowed: true, stage: "L2" };
  }
}
