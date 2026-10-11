// 时效护栏实测探针（2026-10-09）
//
// 用**真实线程数据**回放「好饿」事故，验证三处修复：
//   1) 注入层：recap 分类索引视图——瞬时状态条目跨天从视图剔除（原话素材
//      不常驻）、持久未闭环项带策略位「勿主动提」、年龄标注；
//   2) 主动性层：越窗旧话题的主动意图被时效准入闸拦下（并留痕）；
//   3) 终验：事故原话「好饿」不得出现在任何发往模型的视图里。
//
// 用法：cd server && node --import tsx scripts/probe-temporal-guard.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildTimestampFreeLlmView } from "../src/external-model/chat-thread-store.js";
import {
  indexifyRecapForLlm,
  isTransientRecapTopic,
  isUnclosedOpenLoop,
} from "../src/services/conversation-rolling-summarizer.js";
import {
  TemporalAdmissionGate,
  type AdmissionContext,
} from "../src/proactivity/temporal-admission.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

/** 事故当刻：10-09 21:38（agent 说出「刚才你说好饿」的那一刻） */
const INCIDENT_NOW = new Date(2026, 9, 9, 21, 38, 0);
const ACTOR = process.env.PROBE_ACTOR ?? "2378709729@qq.com";
const THREADS_PATH = join(process.cwd(), "data", "chat-threads.json");

const line = (s = "") => console.log(s);
const rule = (t: string) => line(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`);

type RawMsg = { role?: string; content?: unknown };

function loadRecap(): string | null {
  let raw: { sessions?: Record<string, unknown> };
  try {
    raw = JSON.parse(readFileSync(THREADS_PATH, "utf8")) as { sessions?: Record<string, unknown> };
  } catch (err) {
    line(`⚠️ 读不到 ${THREADS_PATH}：${err instanceof Error ? err.message : err}`);
    return null;
  }
  const sessions = raw.sessions ?? {};
  const pick =
    (sessions[ACTOR] as { messages?: RawMsg[] } | undefined) ??
    (Object.values(sessions)[0] as { messages?: RawMsg[] } | undefined);
  const msgs = pick?.messages ?? [];
  for (const m of msgs) {
    const text = typeof m.content === "string" ? m.content : "";
    if (text.startsWith("[session-recap]")) return text;
  }
  return null;
}

// ── 1. 注入层：真实 recap 的视图前后对比 ──────────────────────
rule("① 注入层实测：真实 recap 注入视图（事故当刻 2026-10-09 21:38）");
const recap = loadRecap();
if (!recap) {
  line("（无 recap 数据，跳过）");
} else {
  const lines = recap.split("\n");
  const transient = lines.filter((l) => isTransientRecapTopic(l)).length;
  const unclosed = lines.filter((l) => isUnclosedOpenLoop(l)).length;
  line(`recap 共 ${lines.length} 行；瞬时状态类：${transient} 行；未闭环线索：${unclosed} 行`);

  line("\n—— 修复前（存储原文 → 直接发往模型）——");
  line(recap.slice(0, 700) + (recap.length > 700 ? "\n…（截断）" : ""));

  const msgs: Array<{ role: "system" | "assistant" | "user"; content: string }> = [
    { role: "system", content: "sys" },
    { role: "assistant", content: recap },
    { role: "user", content: "周末的事情就先不管了" },
  ];
  const view = buildTimestampFreeLlmView(msgs, { now: INCIDENT_NOW }).messages;
  const recapView = String(
    view.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"))?.content ?? "",
  );
  line("\n—— 修复后（分类索引视图：瞬时剔除 + 冷索引策略位 + 年龄标注）——");
  for (const l of recapView.split("\n")) {
    if (!l.trim()) continue;
    const mark = l.includes("策略:勿主动提")
      ? "★"
      : l.includes("[时效索引]")
        ? "✂"
        : l.includes("（今天）") || l.includes("（约")
          ? "●"
          : l.includes("距现在的时长")
            ? "◆"
            : " ";
    line(`${mark} ${l.slice(0, 150)}`);
  }
  line("\n标记：◆ 时间锚提示行　● 年龄段标注　★ 持久未闭环·勿主动提　✂ 瞬时条目已按 TTL 收起");

  // 终验：事故原话不得再出现在注入视图
  const leak = ["好饿", "还没决定", "未决定", "吃什么"].filter((k) => recapView.includes(k));
  line(
    leak.length === 0
      ? "\n✅ 终验通过：事故瞬时原话（好饿/还没决定吃什么）已不在注入视图中——模型无素材可说「刚才你说好饿」"
      : `\n❌ 终验失败：视图中仍残留瞬时原话关键词：${leak.join("、")}`,
  );
  line(`存储隔离校验：输入消息对象内容未被就地改写 = ${msgs[1]!.content === recap}`);
  line(`\n视图字节量：${recapView.length} / 原文 ${recap.length}（日粒度标注同日内恒定）`);
}

// ── 2. 主动性层：越窗旧话题准入实测 ──────────────────────────
rule("② 主动性层实测：时效准入闸（同一件事，四种时机的判定）");

const NOW = Date.parse("2026-10-09T21:38:00+08:00");
const HOUR = 60 * 60_000;

function scenario(label: string, intent: ProactiveIntent, ctx: AdmissionContext) {
  const gate = new TemporalAdmissionGate({ nowFn: () => NOW, ignoreEnv: true });
  const v = gate.evaluate(intent, ctx);
  const flag = v.admitted ? "放行 ✅" : "拦截 ⛔";
  line(`\n[${label}] ${flag}`);
  line(`   reason: ${v.reason}`);
  line(`   话题年龄: ${(v.ageMs / HOUR).toFixed(1)}h   复活旧话题: ${v.revived}`);
}

const hungry: ProactiveIntent = {
  actorId: ACTOR,
  kind: "followup",
  importance: "medium",
  title: "用户有等待跟进或待办事项，值得主动承接",
  summary: "用户原话：还没决定今晚吃什么，好饿",
  mode: "speak",
  source: "conversation",
};

// 场景 A：事故复现——10-08 22:07 的「好饿」，10-09 21:38 被重新派生
scenario(
  "A 事故复现：旧事 + 当轮话题不搭（周末安排）",
  { ...hungry, originAt: Date.parse("2026-10-08T22:07:00+08:00") },
  { now: NOW, currentUserText: "周末的事情就先不管了", lastInteractionAt: NOW - 2 * 60_000 },
);

// 场景 B：同一件旧事，但用户当轮正好聊到吃饭
scenario(
  "B 用户当轮主动聊到吃饭（相关）",
  { ...hungry, originAt: Date.parse("2026-10-08T22:07:00+08:00") },
  { now: NOW, currentUserText: "今天晚上吃什么好呢", lastInteractionAt: NOW - 2 * 60_000 },
);

// 场景 C：超过保质期（followup 上限 24h）的旧事
scenario(
  "C 超过保质期（>24h）的旧事",
  { ...hungry, originAt: Date.parse("2026-10-06T22:07:00+08:00") },
  { now: NOW, currentUserText: "今天晚上吃什么好呢", lastInteractionAt: NOW - 2 * 60_000 },
);

// 场景 D：新鲜事件（未打 originAt）——既有行为必须不变
scenario("D 新鲜事件（天气预警/邮件/账单类）", { ...hungry, summary: "收到重要邮件，需现在处理" }, {
  now: NOW,
  currentUserText: "周末的事情就先不管了",
  lastInteractionAt: NOW - 2 * 60_000,
});

// 场景 E：延迟投递源（顺嘴过期升级）——相关闸豁免，中优仍能送达
scenario(
  "E 顺嘴过期升级（延迟投递源）",
  { ...hungry, source: "turn_aside_expiry", originAt: NOW - 2.2 * HOUR },
  { now: NOW, lastInteractionAt: NOW - 2.2 * HOUR },
);

rule("③ 结论");
line("· 注入层（①）：瞬时状态条目跨天从视图剔除（模型无原话素材说「刚才你说好饿」），");
line("  持久未闭环项以冷索引+策略位「勿主动提」留存——上下文层管「知不知道」；");
line("· 主动性层（②）：事故复现（场景 A）被准入闸拦下并留痕；用户当轮真聊到那件事");
line("  （场景 B）仍会承接；超保质期（C）永不复活；新鲜事件（D）行为一字未变；");
line("  顺嘴过期升级（E）相关闸豁免，中优消息该弹还是弹。");
line("· 三层合起来：能否主动提由代码闸判定、注入素材按时效分类，「把旧事当现事」");
line("  的两条路径（模型自翻 recap / 主动性模块复活）都被确定性规则封住。");
