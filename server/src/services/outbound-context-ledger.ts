// 已发送消息的短期上下文台账（2026-11-17）。
//
// 解决的问题：主动发送通道 / 提醒通道发出的消息，agent 需要「知道自己发过」，
// 但若把它写进 chat thread（模型上下文），隔天仍会被读到，导致反复提旧提醒。
//
// 契约：
//  - 只做短期自知：条目在「当天」（Asia/Shanghai 到次日零点）内注入 prompt 动态层，
//    过期自动失效，永不写入 thread / 对话历史；
//  - 有界：每个 actor 最多保留 MAX_ENTRIES 条，稳定性只靠 id（发送时生成，
//    删除/覆盖都按 id，绝不按文本或下标）；
//  - 注入块带明确指令：这些是「你本人已发出的消息」，不是用户说的话，不要重发。
export type OutboundContextKind = "proactive" | "reminder";

export type OutboundContextEntry = {
  /** 稳定标识：ctx-proactive:<signalId>:<ts> / ctx-reminder:<taskId>:<runAt> */
  id: string;
  kind: OutboundContextKind;
  text: string;
  /** 发送时刻（ms） */
  at: number;
  /** 过期时刻（ms）：发送当天结束（Asia/Shanghai 次日零点） */
  expiresAt: number;
};

const MAX_ENTRIES = 4;
const MAX_ENTRY_TEXT = 120;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 发送当天结束（次日零点，Asia/Shanghai；中国无夏令时，固定 +08:00） */
function endOfShanghaiDay(at: number): number {
  return Math.floor((at + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - SHANGHAI_OFFSET_MS;
}

function formatHm(at: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export class OutboundContextLedger {
  private byActor = new Map<string, OutboundContextEntry[]>();

  /** 记录一条「已发送」。同 id 覆盖（重投/重复回调幂等）。 */
  record(
    actorId: string,
    input: { id: string; kind: OutboundContextKind; text: string; at?: number },
  ): void {
    const text = input.text.trim();
    if (!actorId || !text) return;
    const at = input.at ?? Date.now();
    const entries = this.live(actorId, at);
    const entry: OutboundContextEntry = {
      id: input.id,
      kind: input.kind,
      text: clip(text, MAX_ENTRY_TEXT),
      at,
      expiresAt: endOfShanghaiDay(at),
    };
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    this.byActor.set(actorId, entries.slice(-MAX_ENTRIES));
  }

  /** 显式删除（如发送失败需要回滚自知记录）。按 id 幂等。 */
  remove(actorId: string, id: string): void {
    const entries = this.byActor.get(actorId);
    if (!entries) return;
    const next = entries.filter((e) => e.id !== id);
    if (next.length > 0) this.byActor.set(actorId, next);
    else this.byActor.delete(actorId);
  }

  /** 生成 prompt 动态层块；无有效条目返回 undefined（零注入）。 */
  buildPromptBlock(actorId: string, now = Date.now()): string | undefined {
    const entries = this.live(actorId, now);
    if (entries.length === 0) {
      this.byActor.delete(actorId);
      return undefined;
    }
    this.byActor.set(actorId, entries);
    const lines = entries.map((e) => {
      const label = e.kind === "reminder" ? "提醒" : "主动消息";
      return `- ${formatHm(e.at)} ${label}：${e.text}`;
    });
    return [
      "【最近已发送】",
      "下面是你本人刚刚真实发给用户的消息（不是用户说的话）。不要重复发送、也不要再提醒一次；用户若追问，可以自然承接，但别把它当成用户的新指令。",
      ...lines,
    ].join("\n");
  }

  /** 清理所有过期条目（供定时/长期运行时调用；读路径也会顺带清理）。 */
  sweep(now = Date.now()): void {
    for (const actorId of [...this.byActor.keys()]) {
      const entries = this.live(actorId, now);
      if (entries.length > 0) this.byActor.set(actorId, entries);
      else this.byActor.delete(actorId);
    }
  }

  private live(actorId: string, now: number): OutboundContextEntry[] {
    const entries = this.byActor.get(actorId) ?? [];
    return entries.filter((e) => e.expiresAt > now).slice(-MAX_ENTRIES);
  }
}

export const outboundContextLedger = new OutboundContextLedger();
