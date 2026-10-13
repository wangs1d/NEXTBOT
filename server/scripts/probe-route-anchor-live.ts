/**
 * 路由标签审计活体探针（2026-10-12 架构重构配套真机验证）。
 *
 * 与 eval-route-classifier.ts 同骨架：真实 provider + 真实 routeTurnByLlm，
 * 无 mock。验证三件事：
 *   1. P0-1 状态注入后，真实 L1 对事故句（自我介绍/提醒/承接）的标签是否正确；
 *   2. 真实模型是否会按新 schema 输出 evidence 字段（兼容性）；
 *   3. L2 审计（锚定/一致性）在真实输出上的表现（不放行坏标签、不误杀好标签）。
 *
 * 用法：npx tsx scripts/probe-route-anchor-live.ts
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";

loadServerEnv();

type Case = {
  name: string;
  text: string;
  dialogStateLines?: string[];
  expect: (d: { intent?: string; searchQuery?: string; reasons: string[] }) => string | null;
};

// 模拟「上一轮搜过刘亦菲照片且已交付」的对话状态（事故现场还原，
// 格式与 dialog-state.promptLines 真实输出一致）。
const MEDIA_DELIVERED_STATE = [
  "- 用户：「搜几张刘亦菲的照片」→ 意图 media_retrieval｜已执行工具：search_images（媒体结果已交付给用户）",
];

const CASES: Case[] = [
  {
    name: "事故回放① 自我介绍（上一轮刚交付照片）",
    text: "真名叫王铭川 以后喊我川哥王哥都行",
    dialogStateLines: MEDIA_DELIVERED_STATE,
    expect: (d) =>
      d.intent === "chat" && !d.searchQuery
        ? null
        : `期望 chat 且无查询词，实际 intent=${d.intent} q="${d.searchQuery ?? ""}" reasons=[${d.reasons.join(",")}]`,
  },
  {
    name: "事故回放② 提醒创建（须判 action_write）",
    text: "明早7点提醒我加外套",
    expect: (d) =>
      d.intent === "action_write"
        ? null
        : `期望 action_write，实际 ${d.intent} reasons=[${d.reasons.join(",")}]`,
  },
  {
    name: "承接语：上一轮照片已交付，再来点（结构契约：不烧网页预执行，模型可自选图搜）",
    text: "再来点",
    dialogStateLines: MEDIA_DELIVERED_STATE,
    expect: (d) => {
      // 2026-10-12 架构收敛后的契约：标签本身降级为资源选择——
      //   media（prompt 修复后 L1 首选）→ 预执行或模型自决皆可；
      //   realtime（误标）→ 必须 searchQuery=undefined（锚定缺失收权，不烧网页搜索）；
      //   chat → chat 车道常驻 search_images，模型仍可搜图。
      // 只有「realtime + 带查询词预执行」才算失败（= 拿媒体诉求烧网页搜索）。
      if (d.intent === "realtime_lookup" && d.searchQuery) {
        return `误标 realtime 且未收权，将烧网页搜索 q="${d.searchQuery}"`;
      }
      if (d.intent === "chat") return null;
      if (d.intent === "media_retrieval" || d.intent === "realtime_lookup") return null;
      return `意外标签 ${d.intent}`;
    },
  },
  {
    name: "真媒体轮：明确找图（锚定应通过并产查询词）",
    text: "给我几张景甜的美照",
    expect: (d) =>
      d.intent === "media_retrieval" && !!d.searchQuery
        ? null
        : `期望 media+查询词，实际 ${d.intent} q="${d.searchQuery ?? ""}" reasons=[${d.reasons.join(",")}]`,
  },
  {
    name: "确认轮：你会提醒我吗（应 chat，不触发写动作）",
    text: "你会提醒我吗",
    expect: (d) => (d.intent !== "action_write" ? null : `不应判 action_write，实际 ${d.intent}`),
  },
  {
    name: "两句话轮：自我介绍+提醒（action_write 与 personal_fact 共存）",
    text: "我叫王铭川，明天9点提醒我开会",
    expect: (d) => (d.intent === "action_write" ? null : `期望 action_write，实际 ${d.intent}`),
  },
  {
    name: "否定提醒：别提醒我开会的事（应 chat）",
    text: "以后别提醒我开会的事",
    expect: (d) => (d.intent !== "action_write" ? null : `不应判 action_write，实际 ${d.intent}`),
  },
];

async function main(): Promise<void> {
  const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
  const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[anchor-probe] 外部模型 provider 未启用，无法真机验证");
    process.exit(1);
  }
  console.log(`[anchor-probe] provider=${provider.id} cases=${CASES.length}\n`);

  let pass = 0;
  let fail = 0;
  for (const c of CASES) {
    const t0 = Date.now();
    let verdict: string | null = null;
    let detail = "";
    try {
      const d = await routeTurnByLlm(
        provider,
        `anchor-probe-${Math.random().toString(36).slice(2, 8)}`,
        c.text,
        [],
        undefined,
        [],
        c.dialogStateLines ?? [],
      );
      detail = `intent=${d.intent}@${(d.confidence ?? 0).toFixed(2)} q="${d.searchQuery ?? ""}" anchor/conflict=[${d.reasons
        .filter((r) => r.startsWith("evidence_anchor") || r.startsWith("understanding_conflict") || r.startsWith("route_downgrade"))
        .join(",")}]`;
      verdict = c.expect({
        intent: d.intent,
        searchQuery: d.searchQuery,
        reasons: d.reasons,
      });
    } catch (err) {
      verdict = `调用异常: ${err instanceof Error ? err.message : String(err)}`;
    }
    const ms = Date.now() - t0;
    if (verdict === null) {
      pass += 1;
      console.log(` ✔ ${c.name}（${ms}ms）\n    ${detail}`);
    } else {
      fail += 1;
      console.log(` ✖ ${c.name}（${ms}ms）\n    ${detail}\n    → ${verdict}`);
    }
  }

  console.log(`\n=== 汇总: ${pass}/${pass + fail} 通过 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
