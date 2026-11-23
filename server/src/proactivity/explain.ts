/**
 * 主动消息的「为什么现在告诉我」（2026-11-23 需求 §3.10 可解释）。
 *
 * 管道每一步裁决都往 `reasonChain` 里留了机器可读的 token（`wait_until:...`、
 * `kind_cooldown(...)`……），诊断接口看这些足够，但用户长按一条消息时想知道的是
 * 人话：「你昨天说今天面试，所以我在面试前一小时说」。这里把那串 token 翻译成
 * 一句 ≤ 40 字的说明，随消息一起下发（客户端 `payload.why`），并写进决策留痕。
 *
 * 只解释**时机与频控**，不复述内容——正文已经说了是什么，重复一遍只是变长。
 */

/** 解释用的最小提案形状（避免为文案把整个 ProactiveProposal 拖进来） */
export type ExplainableProposal = {
  kind: string;
  title?: string;
  tier?: "must" | "social" | "ambient";
  evidence?: string[];
};

/** token → 人话：越具体的规则排前面，第一条命中的就是这条消息真正经过的闸 */
const RULES: Array<{ match: RegExp; say: (m: RegExpMatchArray) => string }> = [
  {
    // 触点计划把消息排到某个时刻（§3.4）：用户看到的「为什么是现在」多数是这一条
    match: /^wait_until:(.+)$/,
    say: (m) => {
      const at = Date.parse(m[1] ?? "");
      const hhmm = Number.isFinite(at) ? clockTime(at) : null;
      return hhmm ? `排到 ${hhmm} 那个触点一起说，那时你更可能有空看。` : "排到你方便的时候再说。";
    },
  },
  {
    match: /^slot:.*同触点合并/,
    say: () => "和同一时段的几件事并成一条说，省得连着给你弹好几条。",
  },
  {
    match: /^phone_quiet:in_call/,
    say: () => "刚才你在通话里，就先压着没开口。",
  },
  {
    match: /^phone_quiet:dnd/,
    say: () => "你开了勿扰，等它过去我才说。",
  },
  {
    match: /^in_conversation_defer/,
    say: () => "那会儿你正在说话，等你说完我才接。",
  },
  {
    match: /^offline_wait_reconnect/,
    say: () => "发的时候你不在线，一连上就补给你了。",
  },
  {
    match: /^frequency_governor:dnd_active/,
    say: () => "勿扰刚过，这条是等着补上的。",
  },
  {
    // 分 kind 冷却：这类话本身有间隔要求（care 8h、greeting 每天一次……）
    match: /^frequency_governor:kind_cooldown\(([^,]+),(\d+)m<(\d+)m\)/,
    say: (m) => `这类消息要隔 ${m[3]} 分钟才说第二次，这会儿刚够。`,
  },
  {
    match: /^frequency_governor:daily_once/,
    say: () => "这类话每天只说一次，这是今天的那一次。",
  },
  {
    match: /^reach_gate:send_now/,
    say: () => "现在你手头上没别的事，说一句正合适。",
  },
  {
    match: /^reach_gate:forced_send/,
    say: (m) => `已经压过几轮了，再不说就来不及了${m[1] ? `（延后 ${m[1]} 次）` : ""}。`,
  },
  {
    match: /^tier=must_bypass/,
    say: () => "这是你让我到点必须说的，不能等。",
  },
  {
    match: /^action_utility:/,
    say: () => "顺手能办的事，办完了跟你说一声。",
  },
];

/** 一天只说一次的必达类（闹钟/日程提醒）：kind 命中就直接给结论，不看 token */
const KIND_LINES: Record<string, string> = {
  alarm_wake: "你定的闹钟到点了。",
  schedule_reminder: "你自己设的提醒时间到了。",
  morning_briefing: "按你要的时间，把今天的事说一下。",
  evening_digest: "按你的作息，睡前把明天的事过一遍。",
  commitment: "上次你答应过这件事，到日子了问一句。",
  followup: "之前那件事有下文，跟你说一下。",
  task_followup: "之前那件事有下文，跟你说一下。",
  weather_alert: "天气有变化，怕你出门吃亏。",
  parcel: "东西到了，顺路捎一句。",
  bill: "这笔该处理了，提醒一下。",
};

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 把一条已投递提案的裁决链翻成一句人话。
 * 顺序：先认「真正拦住/放行它的那道闸」（reasonChain 里最具体的 token），
 * 再退到 kind 的固定说法，最后兜一句通用话术——绝不返回空串，
 * 「为什么」点了没反应比给一句朴素的解释更让人怀疑。
 */
export function explainTiming(p: ExplainableProposal, chain: string[]): string {
  for (const token of chain) {
    for (const rule of RULES) {
      const m = token.match(rule.match);
      if (m) return rule.say(m);
    }
  }
  const leaf = p.kind.includes(".") ? (p.kind.split(".").pop() ?? p.kind) : p.kind;
  const byKind = KIND_LINES[p.kind] ?? KIND_LINES[leaf];
  if (byKind) return byKind;
  if (p.tier === "must") return "这事不能等，看到就说。";
  return "觉得这会儿该让你知道，就说了。";
}
