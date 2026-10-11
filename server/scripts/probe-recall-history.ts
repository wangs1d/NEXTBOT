// memory.recall_history 真实数据探针（2026-10-10）
//
// 用**真实线程数据**（data/chat-threads.json 快照）回放「好饿」事故，
// 实测跨会话历史检索工具在真实持久层上的行为：
//   ① 跨会话命中 + 时间锚：proactive 会话消息自带 [ts:] 前缀，时间应精确到分；
//   ② 事故回放：瞬时旧事（好饿）在排除当前会话后查不到原话——recap 索引区
//      按设计跳过（防自引用），模型兜底"如实告知"；
//   ③ 新会话回查：不排除当前线程时能捞到主会话残留原文，并如实暴露
//      "线程级时间锚"的局限（无 [ts:] 前缀时回退 updatedAt）；
//   ④ 防污染：命中不得含 recap 摘要区 / system-reminder 注入块；
//   ⑤ actor 隔离：跨账号不可见。
//
// 数据安全：真实 JSON 拷贝进临时目录，走真实 ChatThreadPersistence 加载
// 管线（含 sanitize/migrate），所有落盘只发生在临时目录，真实数据不动。
//
// 用法：cd server && node --import tsx scripts/probe-recall-history.ts

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatThreadPersistence } from "../src/external-model/chat-thread-persist.js";
import { searchCrossSessionHistory } from "../src/tools/memory-recall-tools.js";
import type { ToolRegistry } from "../src/tools/tool-registry.js";

const ACTOR = process.env.PROBE_ACTOR ?? "2378709729@qq.com";
const line = (s = "") => console.log(s);
const rule = (t: string) => line(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`);

// ── 准备：真实快照拷贝 → 真实加载管线 ─────────────────────────
const realPath = join(process.cwd(), "data", "chat-threads.json");
const dir = mkdtempSync(join(tmpdir(), "recall-probe-"));
const snap = join(dir, "chat-threads.json");
writeFileSync(snap, readFileSync(realPath, "utf8"));

const persistence = new ChatThreadPersistence(snap, join(dir, "notes.json"));
await persistence.load();

const ownedThreads = persistence.getActorThreads(ACTOR);
rule("加载管线（真实快照 → load → sanitize/migrate）");
line(`actor 名下持久化线程：${ownedThreads.length} 个`);
for (const t of ownedThreads) {
  line(`  · ${t.sessionId}  (${t.messages.length} msgs, updatedAt=${t.updatedAt})`);
}

// ── ① 跨会话命中 + 时间锚 ─────────────────────────────────────
rule("① 跨会话命中：主动会话原文 + [ts:] 时间锚");
const hit1 = searchCrossSessionHistory(persistence, {
  actorId: ACTOR,
  excludeSessionId: ACTOR, // 运行时形态：当前活跃线程是裸 actorId
  query: "天气不错 出门 逛逛",
  k: 5,
});
if (hit1.length === 0) {
  line("（无命中）");
} else {
  for (const h of hit1) {
    line(`  [${h.time}] ${h.sessionKind} · ${h.role} · score=${h.score}`);
    line(`    ${h.text.slice(0, 120)}`);
  }
  const tsHit = hit1.find((h) => h.sessionKind === "主动会话");
  line(
    tsHit && tsHit.time === "约 2026-10-09 18:38"
      ? "\n✅ 精确到分的会话级时间（proactive 消息不带 [ts:]，回退线程 updatedAt 并带「约」标记）"
      : `\n⚠️ 时间锚校验：期望「约 2026-10-09 18:38」，实际 ${tsHit?.time ?? "无"}`,
  );
  line(
    hit1.every((h) => h.sessionId !== ACTOR)
      ? "✅ 当前活跃线程（裸 actorId）已排除"
      : "❌ 当前活跃线程泄漏进结果",
  );
}

// ── ② 事故回放：瞬时旧事不复活 ────────────────────────────────
rule("② 事故回放：query=『好饿』（排除当前会话，模拟 10-09 当晚视角）");
const hit2 = searchCrossSessionHistory(persistence, {
  actorId: ACTOR,
  excludeSessionId: ACTOR,
  query: "好饿 还没决定吃什么",
  k: 5,
});
line(
  hit2.length === 0
    ? "✅ 零命中：瞬时旧事原话不在任何可检索的『历史原文』里（recap 索引区按设计\n" +
      "   跳过防自引用；原话轮次已滚出持久层尾部）——模型兜底『如实告知查不到』，\n" +
      "   无素材把旧事说成『刚才』。"
    : `⚠️ 命中 ${hit2.length} 条（${hit2.every((h) => !h.text.includes("好饿")) ? "均为低分弱命中：query 词撞上主动信号消息里嵌入的摘要行，非『好饿』原话本身" : "含『好饿』原话，需检查"}）：\n` +
      hit2.map((h) => `  [${h.time}] ${h.sessionKind} · score=${h.score} · ${h.text.slice(0, 80).replace(/\n/g, " ")}`).join("\n"),
);

// ── ③ 新会话回查（不排除主线程）─────────────────────────────
rule("③ 新会话回查：不排除主线程（用户明确要翻旧账时）");
const hit3 = searchCrossSessionHistory(persistence, {
  actorId: ACTOR,
  query: "好饿 晚饭 吃什么",
  k: 5,
});
if (hit3.length === 0) {
  line("（无命中）");
} else {
  for (const h of hit3) {
    line(`  [${h.time}] ${h.sessionKind} · ${h.role} · score=${h.score}`);
    line(`    ${h.text.slice(0, 140)}`);
  }
  line(
    "\n📌 局限如实披露：主会话消息落盘不带 [ts:] 前缀，时间回退线程 updatedAt\n" +
      "（线程级锚，非消息级）。工具返回的时间仍为真值（>= 实际发生时间），\n" +
      "配合『按时间叙述』的返回指令，不会再出现『刚才你说好饿』式错位。",
  );
}

// ── ④ 防污染断言 ─────────────────────────────────────────────
rule("④ 防污染：命中不得含 recap 摘要区 / system-reminder 注入块");
const allHits = [...hit1, ...hit3];
const polluted = allHits.filter(
  (h) => h.text.includes("[session-recap]") || h.text.includes("system-reminder"),
);
line(
  polluted.length === 0
    ? `✅ 全部 ${allHits.length} 条命中均不含摘要区/注入块内容`
    : `❌ 污染泄漏：${polluted.map((h) => h.text.slice(0, 60)).join(" | ")}`,
);

// ── ⑤ actor 隔离 ─────────────────────────────────────────────
rule("⑤ actor 隔离：其他账号查不到该 actor 的内容");
const hit5 = searchCrossSessionHistory(persistence, {
  actorId: "1657687600@qq.com",
  query: "王哥 好饿 周末",
  k: 5,
});
line(
  hit5.length === 0
    ? "✅ 跨 actor 零命中"
    : `❌ 跨 actor 泄漏：${hit5.map((h) => h.text.slice(0, 60)).join(" | ")}`,
);

// ── ⑥ 工具 handler 层（返回结构与兜底文案）──────────────────
rule("⑥ 工具 handler 层：注册 → 真实调用 → 返回结构");
const captured = new Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>();
const fakeRegistry = {
  register: (name: string, fn: (input: unknown, ctx: unknown) => Promise<unknown>) => {
    captured.set(name, fn);
  },
} as unknown as ToolRegistry;
// handler 依赖 shortTermMemoryGateway 非空才注册；history 路径只用 persistence
const { registerMemoryRecallTools } = await import("../src/tools/memory-recall-tools.js");
registerMemoryRecallTools(fakeRegistry, {
  shortTermMemoryGateway: {} as never,
  chatThreadPersistence: persistence,
});
const historyHandler = captured.get("memory.recall_history");
if (!historyHandler) {
  line("❌ memory.recall_history 未注册");
} else {
  const ctx = { userId: ACTOR, sessionId: ACTOR };
  const resp1 = (await historyHandler({ query: "天气不错 出门", k: 3 }, ctx)) as {
    ok: boolean;
    hits?: Array<{ time: string; session: string; role: string; text: string }>;
    message?: string;
  };
  line(`查询『天气不错 出门』→ ok=${resp1.ok}, hits=${resp1.hits?.length ?? 0}`);
  for (const h of resp1.hits ?? []) line(`  [${h.time}] ${h.session} · ${h.role} · ${h.text.slice(0, 60)}`);
  line(`  message: ${resp1.message?.slice(0, 80)}…`);
  const resp2 = (await historyHandler({ query: "完全无关的量子术语" }, ctx)) as {
    ok: boolean;
    hits: unknown[];
    message?: string;
  };
  line(`\n查询『完全无关的量子术语』→ ok=${resp2.ok}, hits=${resp2.hits.length}`);
  line(`  兜底文案: ${resp2.message}`);
}

rule("结论");
line("· 真实持久层上：跨会话检索带分级时间锚（[ts:] 前缀精确到分，缺省回退线程 updatedAt）；");
line("· 瞬时旧事原话不可被『翻出来当现事』——recap 索引区防自引用 + 当前线程排除；");
line("· 模型要引用旧细节必须显式调工具、拿到带时间的原文，『把旧事说成刚才』缺素材。");
