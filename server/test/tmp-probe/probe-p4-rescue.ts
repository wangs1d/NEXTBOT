/**
 * P4 闲聊误吸出口兜底 · 真机前后对比探针（2026-10-07）。
 *
 * 三组对照（全部走真实代码路径 + 真实 API）：
 *   改前·事故链路：LLM_ROUTE_TIMEOUT_MS=1 强制路由超时 → routeTurnByLlm 真实
 *     产出 conservative_task_plane 降级决策（闲聊被吸进任务面的根源）→
 *     buildTaskFailureNotice 产出「这件事没办成」机械回执（旧出口文案）。
 *   改后·出口救援：同一降级决策作为 input.route，复刻 agent-core
 *     rescueMisroutedChat 的调用参数（主模型=minimax 直答：零工具 + 纯闲聊隔离
 *     + ephemeral），词表寒暄裸 goal、非词表带处境说明（防编造）。
 *   生产常态：正常超时，路由跟随主模型——同一批句子直接判 chat 面，
 *     事故源头已堵，根本不进任务面。
 *
 * 用法（server 目录下）：
 *   node --import tsx test/tmp-probe/probe-p4-rescue.ts
 */
import "../../src/config/load-server-env.js";
import { createExternalChatProviderFromEnv } from "../../src/external-model/resolve-provider.js";
import { routeTurnByLlm } from "../../src/agent/llm-task-router.js";
import { buildTaskFailureNotice } from "../../src/external-model/fallback-texts.js";
import { isHighPrecisionChatText } from "../../src/agent/task-router.js";
import type { ExternalChatProvider } from "../../src/external-model/types.js";

const CHAT_CASES = [
  "你知道我的老婆是谁吧",
  "今天真的好累啊不想动",
  "在吗",
];
const TASK_CASE = "比特币现在什么价"; // 真任务对照：救援须走处境说明版，不许编数据
const ALL_CASES = [...CHAT_CASES, TASK_CASE];
const CACHE_BUST = ["", "\u200B", "\u200B\u200B"];

/** 与 agent-core rescueMisroutedChat 同构的对话面重答（探针复刻生产参数）。 */
async function rescueReply(
  provider: ExternalChatProvider,
  sessionId: string,
  goal: string,
  bust: string,
): Promise<string> {
  const smalltalk = isHighPrecisionChatText(goal);
  const turnText = smalltalk
    ? goal + bust
    : [
        "（系统内部说明，非用户可见：你上一轮收到的消息被误当作后台任务执行且没有产出结果。）",
        "若它本来只是聊天/问候/情绪表达，请像平时聊天一样自然回应；",
        "若它确实需要动手办事或查实时信息，请简短说明刚才没办成、不要编造任何结果或数据。",
        "只输出回复给用户的正文本身。",
        "",
        `用户原话：${goal + bust}`,
      ].join("\n");
  const reply = await provider.streamCompletion(
    sessionId,
    { text: turnText },
    () => {},
    undefined,
    {
      ephemeralTurn: true,
      toolExposureProfile: "none",
      chatLanePureChat: true,
      chatLaneSampling: true,
      maxOutputTokens: 800,
      auditStage: "task_plane_chat_rescue",
    },
  );
  return (reply ?? "").trim();
}

async function main(): Promise<void> {
  const mainProvider = createExternalChatProviderFromEnv();
  console.log(`主模型 provider: ${mainProvider?.id ?? "null"}`);
  if (!mainProvider?.isEnabled()) throw new Error("主模型未配置");

  console.log("\n═══ 组 1｜改前·事故链路复现（强制路由超时 → 降级任务面 → 机械回执）═══");
  process.env.LLM_ROUTE_TIMEOUT_MS = "1"; // 1ms 必超时：真机复现路由降级进任务面
  for (let i = 0; i < ALL_CASES.length; i++) {
    const text = ALL_CASES[i] + CACHE_BUST[0];
    const t0 = Date.now();
    const d = await routeTurnByLlm(mainProvider, "probe-p4", text);
    const notice = buildTaskFailureNotice(ALL_CASES[i]);
    console.log(
      `[改前] "${ALL_CASES[i]}" → plane=${d.plane}（${Date.now() - t0}ms）${d.reasons.join(";")}\n       出口文案：${notice.slice(0, 60)}${notice.length > 60 ? "…" : ""}`,
    );
  }

  console.log("\n═══ 组 2｜改后·出口救援（同降级决策 → minimax 对话面直答）═══");
  for (const c of ALL_CASES) {
    const t0 = Date.now();
    const reply = await rescueReply(mainProvider, "probe-p4-rescue", c, CACHE_BUST[1]);
    console.log(
      `[改后] "${c}"（词表寒暄=${isHighPrecisionChatText(c)}，${Date.now() - t0}ms）\n       → ${reply.slice(0, 120)}${reply.length > 120 ? "…" : ""}`,
    );
  }

  console.log("\n═══ 组 3｜生产常态（路由跟随主模型，正常超时）═══");
  delete process.env.LLM_ROUTE_TIMEOUT_MS;
  for (const c of ALL_CASES) {
    const text = c + CACHE_BUST[2];
    const t0 = Date.now();
    const d = await routeTurnByLlm(mainProvider, "probe-p4", text);
    console.log(
      `[常态] "${c}" → plane=${d.plane} intent=${d.intent ?? "-"} conf=${d.confidence?.toFixed(2) ?? "-"}（${Date.now() - t0}ms）`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
