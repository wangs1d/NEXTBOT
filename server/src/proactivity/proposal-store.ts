// 提案持久化队列 + 决策日志（诊断接口数据源）：data/proactivity/proposals.json
import { readJson, writeJson } from "./persist-file.js";
import type { ArbitrationDecision, ProactiveProposal } from "./pipeline-types.js";

type PersistedShape = {
  pending: ProactiveProposal[];
  decisions: ArbitrationDecision[];
  recent: Array<[string, number]>;
};

/** 已投递指纹的保留窗口（防 watcher 重启重扫/同源重复提交导致重复投递） */
const RECENT_DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;
/** 挂起提案最长滞留：超过即视为僵尸（信息已过时），启动清理时丢弃 */
const PROPOSAL_PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export class ProposalStore {
  /** dedupKey → 提案（待发区：延迟/离线挂起的提案在此等待重仲裁） */
  private readonly pending = new Map<string, ProactiveProposal>();
  /** dedupKey → 最近一次已投递时刻（已投递提案出队后仍防短期内重复提交） */
  private readonly recentDelivered = new Map<string, number>();
  private decisions: ArbitrationDecision[] = [];
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly maxDecisions = 200,
  ) {
    const raw = readJson<PersistedShape>(path, { pending: [], decisions: [], recent: [] });
    // 启动清理（2026-10-01 P0）：挂起区僵尸提案（幽灵 actor/48h+ 陈旧挂起）
    // 不再恢复——某天这些测试 actor「重连」会把旧消息当新推给用户；幽灵键
    // （历史接线 bug 把函数源码当 actorId）一并清除。
    const nowMs = Date.now();
    let dropped = 0;
    for (const p of raw.pending ?? []) {
      const aid = String(p.actorId ?? "");
      const stale = nowMs - p.createdAt > PROPOSAL_PENDING_MAX_AGE_MS;
      // 2026-11-12 修订：携带 firedAt 的离线补推提案豁免 48h 僵尸清理——
      // 补推语义（用户拍板）不设保质期，客户端按原定触发时刻落屏；不带
      // firedAt 的陈旧挂起（旧版本产生的、无法如实标注"几点该响的"）
      // 维持 48h 清理，避免三周前的"该睡觉啦"冒充新消息误投。
      if (aid.includes("exportActors") || aid.startsWith("()=>") || (stale && p.firedAt === undefined)) {
        dropped++;
        continue;
      }
      this.pending.set(p.dedupKey, p);
    }
    if (dropped > 0) {
      this.dirty = true;
      console.log(`[ProposalStore] 挂起区启动清理：丢弃 ${dropped} 条僵尸/幽灵提案`);
    }
    for (const [k, at] of raw.recent ?? []) this.recentDelivered.set(k, at);
    this.decisions = raw.decisions ?? [];
  }

  flush(): void {
    if (!this.dirty) return;
    writeJson(this.path, {
      pending: [...this.pending.values()],
      decisions: this.decisions,
      recent: [...this.recentDelivered],
    });
    this.dirty = false;
  }

  /** 入队；同 dedupKey 已在待发区时以新提案覆盖（保留更晚的 deliverAfter），返回 false=发生了合并 */
  enqueue(p: ProactiveProposal): boolean {
    const existing = this.pending.get(p.dedupKey);
    if (existing) {
      this.pending.set(p.dedupKey, {
        ...p,
        deliverAfter: p.deliverAfter !== undefined || existing.deliverAfter !== undefined
          ? Math.max(p.deliverAfter ?? 0, existing.deliverAfter ?? 0)
          : undefined,
      });
      this.dirty = true;
      return false;
    }
    this.pending.set(p.dedupKey, p);
    this.dirty = true;
    return true;
  }

  take(dedupKey: string): ProactiveProposal | undefined {
    const p = this.pending.get(dedupKey);
    if (p) {
      this.pending.delete(dedupKey);
      this.dirty = true;
    }
    return p;
  }

  /**
   * 运行期僵尸清理（2026-11-12）：启动清理只在构造函数跑一次，长驻进程里
   * defer-forever 的挂起提案（设备长期离线、arbiter 不停顺延 deliverAfter）
   * 此前会无限滞留——生产实证：proposals.json 里挂了 22 天的「该睡觉啦」。
   * 规则与启动清理一致（48h 超龄 + 无 firedAt 豁免补推），返回丢弃条数。
   */
  pruneStale(nowMs: number): number {
    let dropped = 0;
    for (const [key, p] of this.pending) {
      if (nowMs - p.createdAt > PROPOSAL_PENDING_MAX_AGE_MS && p.firedAt === undefined) {
        this.pending.delete(key);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.dirty = true;
      console.log(`[ProposalStore] 运行期清理：丢弃 ${dropped} 条超龄挂起提案`);
    }
    return dropped;
  }

  /** 投递后记入已投递指纹（prune 超窗旧键） */
  markDelivered(dedupKey: string, at: number): void {
    this.recentDelivered.set(dedupKey, at);
    for (const [k, t] of this.recentDelivered) {
      if (at - t > RECENT_DELIVERED_TTL_MS) this.recentDelivered.delete(k);
    }
    this.dirty = true;
  }

  /** 同 dedupKey 在保留窗口内已投递过 → true（重提交应合并丢弃） */
  wasDeliveredRecently(dedupKey: string, now: number): boolean {
    const at = this.recentDelivered.get(dedupKey);
    return at !== undefined && now - at <= RECENT_DELIVERED_TTL_MS;
  }

  /** 延迟提案更新可发时刻（仍在待发区等待重仲裁） */
  reschedule(dedupKey: string, deliverAfter: number): void {
    const p = this.pending.get(dedupKey);
    if (p) {
      this.pending.set(dedupKey, { ...p, deliverAfter });
      this.dirty = true;
    }
  }

  logDecision(d: ArbitrationDecision): void {
    this.decisions.push(d);
    if (this.decisions.length > this.maxDecisions) {
      this.decisions.splice(0, this.decisions.length - this.maxDecisions);
    }
    this.dirty = true;
  }

  listPending(): ProactiveProposal[] {
    return [...this.pending.values()];
  }

  recentDecisions(limit = 30): ArbitrationDecision[] {
    return this.decisions.slice(-limit);
  }
}
