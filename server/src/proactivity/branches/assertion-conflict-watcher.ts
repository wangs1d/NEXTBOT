// 断言冲突监察（AssertionConflictWatcher）—— 「模型修正驱动的主动开口」第一块（2026-10-22）。
//
// 架构语义：真正的主动不是关键词命中就弹窗，而是 **agent 脑中的世界模型被新信息
// 推翻时才开口**。上传树枝（课表/行程表）主张"周三 14:00 有高数"，消息树枝进来
// "老师说周三停课"——两个树枝的事实矛盾由本监察（零 LLM 确定性比对）发现，
// 产出一个"模型修正"提案交主动性板块：默认模板直投（directText），批准后才花 LLM。
//
// 匹配口径从严（宁漏不误）：必须同时满足——
//   ① 文本命中日程变动信号（复用 detectScheduleChange 的确定性规则）
//   ② 存在时间窗内（缺省未来 14 天）的现行日程主张
//   ③ 主张的 subject/title 作为子串出现在消息文本里
// 防重：dedupKey（assertionId×内容指纹）+ 每主张 30 分钟冷却。
import { createHash } from "node:crypto";

import { detectScheduleChange } from "../triggers/message-watch-trigger.js";
import { resolveBaseActorId } from "../../agent/master-chat-session.js";
import type { ProactiveProposal } from "../pipeline-types.js";
import type { ScheduleAssertion, ScheduleAssertionStore } from "./schedule-assertion-store.js";

export type ConflictWatchDeps = {
  store: ScheduleAssertionStore;
  submitProposal: (p: ProactiveProposal) => void;
  now?: () => number;
  /** 时间窗（天，从现在起；缺省 14 天） */
  windowDays?: number;
  /** 每主张冷却（缺省 30 分钟） */
  cooldownMs?: number;
};

const MAX_TEXT_LENGTH = 300;

export class AssertionConflictWatcher {
  private readonly lastFiredAt = new Map<string, number>();
  private readonly nowFn: () => number;
  private readonly windowDays: number;
  private readonly cooldownMs: number;

  constructor(private readonly deps: ConflictWatchDeps) {
    this.nowFn = deps.now ?? Date.now;
    this.windowDays = deps.windowDays ?? 14;
    this.cooldownMs = deps.cooldownMs ?? 30 * 60_000;
  }

  /**
   * MessageHub 入站消息回调：同步、零 LLM、异常静默（不阻断落库主链路）。
   * 与 MessageWatchTrigger 并联——它管"发现日程变动"，本监察管"变动撞上了已导入的事实"。
   */
  handleInbound(input: { actorId: string; text: string; channelId?: string; platform?: string }): void {
    try {
      const text = String(input.text ?? "").trim();
      if (text.length === 0 || text.length > MAX_TEXT_LENGTH) return;
      if (detectScheduleChange(text) == null) return;

      const now = this.nowFn();
      const actorId = resolveBaseActorId(input.actorId);
      const conflicts = this.deps.store.findConflicts(actorId, {
        windowStart: now,
        windowEnd: now + this.windowDays * 24 * 3600_000,
        text,
        limit: 3,
      });
      const hit = conflicts[0];
      if (!hit) return;

      const cooldownKey = `${actorId}:${hit.assertionId}`;
      const last = this.lastFiredAt.get(cooldownKey);
      if (last != null && now - last < this.cooldownMs) return;
      this.lastFiredAt.set(cooldownKey, now);

      const excerpt = text.replace(/\s+/g, " ").slice(0, 120);
      const fingerprint = createHash("sha1")
        .update(`${actorId}|${hit.assertionId}|${excerpt}`)
        .digest("hex")
        .slice(0, 16);
      const when = formatLocal(hit.runAt);

      this.deps.submitProposal({
        proposalId: `ac_${fingerprint}`,
        actorId,
        kind: "action.schedule_conflict",
        tier: "must",
        importance: "high",
        dedupKey: `schedule_conflict:${hit.assertionId}:${fingerprint}`,
        title: "导入的日程有变动信号",
        summary: `${hit.sourceName}：${hit.title}（${when}）`,
        evidence: [
          "assertion_conflict",
          `document:${hit.documentId}`,
          `assertion:${hit.assertionId}`,
          `keyword:${text.match(/(推迟|延迟|延误|延后|改期|改到|换到|提前|取消|时间有变|有变动)/)?.[0] ?? "变动"}`,
        ],
        directText:
          `你之前导入的「${hit.sourceName}」里，${when} 有「${hit.title}」；` +
          `刚收到「${excerpt}」，看起来就是说这件事。要我帮你改日程或撤掉提醒吗？`,
        createdAt: now,
        source: "schedule_upload",
        // 共同键：课程/日程主体词——发现层据此把消息源与上传源的文字自然汇聚
        subject: hit.subject,
        detail: {
          来源: `${hit.sourceName}（v${hit.version}）`,
          主张: `${hit.title} · ${when}`,
          消息: excerpt,
        },
        utility: {
          risk: {
            reversible: true,
            financialImpact: "none",
            dataSensitivity: "personal",
            thirdPartyImpact: false,
          },
          authorization: "none",
        },
        confirmAction: { label: "让助手处理" },
      });
    } catch {
      /* 冲突检测失败不影响消息主链路 */
    }
  }
}

function formatLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type { ScheduleAssertion };
