/**
 * 画像口径实盘探针（dev，可反复运行）：真实 LLM 统一抽取 → 结构化事实库 → prompt 渲染。
 *
 * 验证四件事（2026-10-11 主流对齐方案）：
 *   ① 抽取产出无主语短值（语义改写，不照抄原句——「我在兴义」→ 居住地:兴义）
 *   ② 注入块渲染：字段式条目 + 低置信条目带「不要把话说满」标注
 *   ③ forget 字段遗忘链路（「别记我家在哪了」→ forget → clearFact）
 *   ④ 遗忘后注入块：目标字段消失，其余保留，历史可追溯
 *
 * 运行：cd server && "D:/nodejs/node.exe" --import tsx scripts/live-profile-demo.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../src/config/load-server-env.js";
import { extractUnified } from "../src/agentic-memory/unified-extractor.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "profile-demo-"));
  const store = new StructuredFactStore(openAgenticSqlite(join(dir, "facts.db")));
  try {
    // ── ① 真实抽取：自我介绍（观察 facts 是否无主语、是否误收玩笑） ──
    console.log("=== ① 真实抽取：自我介绍 ===");
    const intro = await extractUnified(
      "我在兴义，是做后端的，平时写 TS 和 Python。最近挺想养只猫的，你说我像不像那种会养蓝猫的人？",
    );
    if (!intro) {
      console.log("（抽取失败——检查 server/.env.local 的 LLM 配置）");
      return;
    }
    console.log(`decision=${intro.decision}`);
    for (const f of intro.facts) {
      console.log(`  fact: ${f.field}=${f.value}${f.confidence != null ? ` (confidence=${f.confidence})` : ""}`);
      store.applyFact({
        actorId: "demo-user",
        field: f.field,
        value: f.value,
        confidence: f.confidence ?? null,
        sourceRef: "live-demo:intro",
      });
    }

    // 混入一条随口提及的低置信事实，演示标注
    store.applyFact({
      actorId: "demo-user",
      field: "生日",
      value: "3 月 15 日",
      confidence: 0.4,
      sourceRef: "live-demo:casual",
    });

    // ── ② 注入块渲染（观察：无主语值 + 低置信标注） ──
    console.log("\n=== ② 注入块渲染 ===");
    console.log(store.renderForPrompt("demo-user"));

    // ── ③ 真实抽取：明确要求遗忘（observe forget 可能伴随 reject 决策） ──
    console.log("\n=== ③ 真实抽取：明确要求忘掉位置 ===");
    const forgetTurn = await extractUnified(
      "对了，以后别记我家在哪儿了，我不想被记录位置信息",
    );
    if (!forgetTurn) {
      console.log("（抽取失败）");
      return;
    }
    console.log(`decision=${forgetTurn.decision}  forget=${JSON.stringify(forgetTurn.forget)}`);
    for (const field of forgetTurn.forget) {
      const cleared = store.clearFact("demo-user", field);
      console.log(`  clearFact(${field}) → 下线 ${cleared} 条`);
    }

    // ── ④ 遗忘后注入块（居住地应消失，其余保留） ──
    console.log("\n=== ④ 遗忘后注入块 ===");
    console.log(store.renderForPrompt("demo-user"));

    const stats = store.stats("demo-user");
    console.log(`\n（库内统计：active=${stats.active} superseded=${stats.superseded}——历史行保留可追溯）`);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
