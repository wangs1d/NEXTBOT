/**
 * chat 车道「工具自决」探针（2026-09-23 工具自决权改造配套）。
 *
 * 测的是主模型在 chat 车道上的工具决策行为（真实 LLM + 真实工具执行）：
 *   - 工具需求组：涉及当前事实的问题（模拟路由误判进对话面的轮——没有
 *     【实时检索结果】证据块），看模型是否**自己调用 search_web** 等联网工具。
 *     改造目标：调用率 ↑（决策权还给主模型后，模型应有搜就搜）。
 *   - 纯闲聊对照组：寒暄/情绪/观点，看模型是否**保持零工具直答**。
 *     改造红线：调用率不应明显上升（不能矫枉过正见啥都搜）。
 *
 * 与生产的对齐：工具集 = buildLaneCoreTools("chat") 同源；系统提示 =
 * RuntimeKernel.buildSessionSystem() + FOREGROUND_ROLE_GUIDANCE 同源
 * （脚本默认引用 src 源字符串；--guidance=old 时用下方冻结的旧版文本
 * 做基线对照，旧版=2026-09-23 改造前的逐字快照）。
 *
 * 用法：
 *   npx tsx scripts/eval-chat-lane-tool-decision.ts --guidance=old --label=baseline --out=results/lane-baseline.json
 *   npx tsx scripts/eval-chat-lane-tool-decision.ts --guidance=new --label=after --out=results/lane-after.json
 *   REPEATS=3（默认）控制每组重复次数。
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const guidanceMode = process.argv.find((a) => a.startsWith("--guidance="))?.slice(11) ?? "new";

/* ── 冻结的旧版 FOREGROUND_ROLE_GUIDANCE（2026-09-23 改造前逐字快照，仅供基线） ── */
const OLD_FOREGROUND_ROLE_GUIDANCE = `你现在是对话里那个"人"本人。你手里有一组常用动作，以本轮工具列表为准（2026-09-19 静态双车道后为固定清单，不随话题变化）：创建提醒/日程（reminder.plan、calendar.create_from_text：直接调用当场办成，成功返回 nextRunAtLocal 后才算办妥）；search_web（涉及实时事实的问题系统已先检索并把结果放在【实时检索结果】块里，你需要更多细节时可对条目继续搜索核实）；查时间/位置/钱包余额/消息、搜图搜视频、看热搜等只读动作直接调用；task.dispatch（把耗时的事派给后台：找照片视频、看位置/周边、发消息、下单支付、操作软件/设备、多步任务等，立即返回不阻塞对话，办完后结果会自动回到对话里）。如果工具列表不足以完成用户要的事，在回复中输出 <tool_request>一句话描述你需要的能力</tool_request>（如 <tool_request>把客厅空调调到26度</tool_request>），系统会检索并加载对应工具供你下一步直接调用；拿到工具后继续完成任务，不要只输出请求标记就停。
- 先接住话头：回应对方真正说的那件事，再给你自己真实的反应——有印象讲印象，有偏好讲偏好，有立场就亮立场。
- 用户想设提醒/日程（含「明天8点叫我起床」这类带时间点的请求）就当场调 reminder.plan 真实创建（含糊时间用 calendar.create_from_text），工具返回 nextRunAtLocal 后才算办妥、才能向用户确认；未说明是否重复时先自然问一句再创建。绝不在没创建成功时说"到点叫你/已设置/晚安"这类收场话。要重写的其他事（下单/支付/发消息/操作设备）用 task.dispatch 派出去：派发前先自然应一声（像"好嘞，在办了"这种分量），goal 用一句完整、自包含的话说清要办成什么。
- 涉及现实世界当前事实（谁在哪、近况、活动、新闻、价格、天气）的回答，一律以【实时检索结果】块为准：那是系统刚真实搜索到的数据，与此前的对话内容、记忆、你的印象冲突时以它为准，并主动纠正之前说过的话；块内条目不够细节时可自己再调 search_web 深挖，条目没覆盖的部分就照实说「没查到」，不用旧对话或想象补事实。
- 凭常识或对方刚说的话就能答的（寒暄、情绪交流、观点）直接答，不要调工具。
- 诚实底线：没真查过就不说"已查到/我搜了下"，查不到就明说查不到。
- 永远不暴露机制词汇：不提工具、接口、返回、路由、后台、任务系统。用户对面是一个人，不是一套系统。
- 语感、调子菜单（沉稳/坦诚/幽默/调侃/抬杠/阴阳/暗示）与破功禁句统一由【说话方式·伙伴面】承担，本块不重复。`;

/** 冻结的旧版 search_web 描述（2026-09-23 改造前逐字快照）：--guidance=old 时同步替换，
 * 保证「旧世界」= 旧指导语 + 旧工具描述的完整基线，与「新世界」只差本次改造。 */
const OLD_SEARCH_WEB_DESCRIPTION = "联网搜索公开网页信息（按发布时间从新到旧）。query 由你按用户意图组织成完整、具体、语义清晰的搜索词（可含主体+特征+限定词），不要机械截成 2-6 字短词；时效话题请加当前年月或「最新」。\n如果有多个独立的查询维度（例如对比多个商品 / 多个主题），请在同一轮内并行发起多个 search_web 调用，每个 tool_call 用不同的 query，避免串行等待。\n【强制调用规则】涉及时事、新闻、股价、排片、票价、天气、价格、公告等时效信息，或任何人物的近况、行程、所在城市/地区、公开活动时，必须先调用本工具，禁止仅凭训练数据作答；本地消费（电影票、外卖等）同样须先搜索再试。整合结果时优先引用发布时间最新的条目并注明日期。动态/新闻/盘点/对比类问题要把多来源信息按主题整理充分（保留日期、数字、人名、作品名等细节），用 Markdown 小标题/加粗/表格组织成结构清晰的充分回答；只有真正的单一事实判断（是/否、单个数据点）才用「结论 + 1句依据」收尾。若摘要不足以覆盖用户要的细节（事件经过、正文内容），继续用 fetch_web / deep_search 深读相关链接后再回答。搜索结果与问题无关或为空时，如实说没查到，禁止编造。";

const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
const { getRuntimeKernel } = await import("../src/agent/runtime-kernel.js");
const { claimsWebSearch } = await import("../src/agent/realtime-search-query.js");
const { buildLaneCoreTools } = await import("../src/external-model/lane-tool-sets.js");
const { getBuiltinAgentChatTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");
const { TASK_CANCEL_TOOL_DEFINITION, TASK_STATUS_TOOL_DEFINITION } = await import("../src/tools/task-plane-tools.js");
const { PERCEPTION_OVERVIEW_TOOL_DEFINITION } = await import("../src/tools/perception-tools.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { InfoHubService } = await import("../src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");

type Case = { text: string; needsTool: boolean };

// 工具需求组 = 真实症状场景：需要现查的当前事实（在本探针里没有证据块，等价于
// 「路由误判进对话面」的轮）。对照组 = 纯寒暄/情绪/观点（应零工具直答）。
const CASES: Case[] = [
  { text: "刘浩存最近有什么新动态？", needsTool: true },
  { text: "今天上海天气怎么样？", needsTool: true },
  { text: "比特币现在多少钱一个？", needsTool: true },
  { text: "最近有什么值得看的新电影上映？", needsTool: true },
  { text: "人民币兑美元现在汇率多少？", needsTool: true },
  { text: "帮我看看今天热搜上有什么大事", needsTool: true },
  { text: "今天有点累，不想干活", needsTool: false },
  { text: "哈哈你说得对", needsTool: false },
  { text: "你觉得周末是宅家好还是出去走走好？", needsTool: false },
];

/* ── 生产噪声组（CASESET=noise）：复现真实症状形态 ──
 * 真实事故里的零工具直答轮几乎都不是裸问句，而是「代词/口语指代 + 记忆块里有
 * 相关印象」的轮（如「她最近在那呢」「我老婆最近怎么样」）：记忆块给了模型
 * 「我认识这个人/我知道这事」的底气，旧指导语又告诉它「实时事实以证据块为准、
 * 没块说明不用查」→ 从记忆与印象里直接答，不道歉不宣称，任何闸都拦不住。
 * 本组在 user 消息头部注入生产同构的记忆块 fixture，只测这 3 类高诱惑轮。 */
const NOISE_CONTEXT = [
  "【记忆图联想检索】",
  "- 用户长期关注演员刘浩存（对话中称「她」），记忆中她主演作品《恋爱 Float》；用户最近提到想看新片《悬崖之上 2》（记忆：待映）。",
  "【用户档案】偏好影视八卦与实时消息；称用户「王哥」。",
  "【待办与承诺】你答应过帮用户留意《悬崖之上 2》的上映时间。",
  "【短期上下文】上一轮：用户分享了周末看片计划，你说「回头帮你盯着上映信息」。",
  "",
].join("\n");
const NOISE_CASES: Case[] = [
  { text: "她最近在忙什么啊？", needsTool: true },
  { text: "上次说的那部电影上映了吗？", needsTool: true },
  { text: "她微博最近更新了吗", needsTool: true },
];

/** 算作"真动手"的工具：联网检索族 + 本地感知（weather.get_local 是天气轮的正确主力工具）。 */
const NETWORK_TOOL_RE = /^(search_web|search_images|search_videos|deep_search|fetch_web|hot_rankings|internet\.|info\.|weather\.)/;

function buildToolContext() {
  const infoHub = new InfoHubService();
  const upstream = new UpstreamSearchService(infoHub);
  const registry = new ToolRegistry() as any;
  registry.register("clock.get_current_time", async () => {
    const now = new Date();
    return { iso: now.toISOString(), timezone: "Asia/Shanghai", local: now.toLocaleString("zh-CN") };
  });
  registry.register("clock.get_user_location", async () => ({
    city: "上海市", latitude: 31.2304, longitude: 121.4737, source: "eval-fixture",
  }));
  registry.register("search_web", async (input: any) => upstream.searchWeb(String(input?.query ?? ""), Math.min(8, Number(input?.limit) || 8)));
  registry.register("search_images", async (input: any) => upstream.searchImages(String(input?.query ?? ""), Math.min(4, Number(input?.limit) || 4), "lane-eval"));
  registry.register("hot_rankings", async () => upstream.searchWeb("今日热搜榜", 8));
  registry.register("weather.get_local", async () => ({
    ok: true,
    result: { city: "上海市", temperature: "24℃", condition: "多云", humidity: "62%", source: "eval-fixture", observedAt: new Date().toISOString() },
  }));
  // 其余 Core 工具（钱包/消息/日程/派发等）本台架不接执行器：明确报错而非静默假成功
  const stub = async (name: string) => ({ ok: false, result: { error: `eval-harness: ${name} 未接执行器` } });
  for (const name of ["wallet.get_balance", "wallet.get_transactions", "messages.overview", "calendar.list_tasks", "brain.recall", "agent.query_capabilities", "self.list_custom_skills", "task.dispatch", "task.status", "task.cancel", "reminder.plan", "calendar.create_from_text", "phone.ensure_my_number", "phone.virtual_call", "messages.reply", "world.link.send_message", "fetch_web", "deep_search", "search_videos"]) {
    registry.register(name, stub.bind(null, name));
  }
  const calls: Array<{ name: string; ok: boolean }> = [];
  const toolCtx = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      let r: { ok: boolean; result: Record<string, unknown> };
      try {
        const out = await registry.execute(name, args, { actorId: "lane-eval" });
        r = { ok: Boolean(out?.ok), result: (out?.result ?? {}) as Record<string, unknown> };
      } catch (err) {
        r = { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
      }
      calls.push({ name, ok: r.ok });
      return r;
    },
  };
  return { toolCtx, calls };
}

type Row = Case & { repeat: number; tools: string[]; networkCalls: number; anyOk: boolean; fabricatedClaim: boolean; textChars: number; ms: number };

async function main(): Promise<void> {
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[lane-eval] 外部模型 provider 未启用，无法评测");
    process.exit(1);
  }
  const repeats = Number.parseInt(process.env.REPEATS ?? "3", 10) || 3;
  const guidance = guidanceMode === "old"
    ? OLD_FOREGROUND_ROLE_GUIDANCE
    : (await import("../src/agent/lane-role-guidance.js")).FOREGROUND_ROLE_GUIDANCE;
  const kernel = getRuntimeKernel();
  const identity = kernel.buildSessionSystem() ?? "";
  const systemPrompt = [identity, guidance].filter(Boolean).join("\n\n");

  const tools = buildLaneCoreTools("chat", getBuiltinAgentChatTools() as any, [
    TASK_DISPATCH_TOOL_DEFINITION,
    TASK_STATUS_TOOL_DEFINITION,
    TASK_CANCEL_TOOL_DEFINITION,
    PERCEPTION_OVERVIEW_TOOL_DEFINITION,
  ] as any);
  // 旧世界基线：工具描述同步回退（新世界 = 新指导语 + 新描述，单一变量是本次改造）
  const worldTools = guidanceMode === "old"
    ? tools.map((t: any) =>
        t.function?.name === "search_web"
          ? { ...t, function: { ...t.function, description: OLD_SEARCH_WEB_DESCRIPTION } }
          : t,
      )
    : tools;
  console.log(`[lane-eval] provider=${provider.id} guidance=${guidanceMode}(${guidance.length}字) tools=${tools.length} repeats=${repeats}`);

  const rows: Row[] = [];
  const caseSet = (process.env.CASESET ?? "main") === "noise" ? NOISE_CASES : CASES;
  for (const c of caseSet) {
    for (let i = 0; i < repeats; i += 1) {
      const { toolCtx, calls } = buildToolContext();
      const sessionId = `lane-eval-${Date.now()}-${rows.length}`;
      const turnText = (process.env.CASESET ?? "main") === "noise"
        ? `${NOISE_CONTEXT}${c.text}`
        : c.text;
      const t0 = Date.now();
      let final = "";
      try {
        final = await provider.streamCompletion(
          sessionId,
          { text: turnText },
          () => {},
          toolCtx as never,
          {
            toolExposureProfile: "explicit",
            chatToolsBuiltin: worldTools,
            chatToolsExtra: getBuiltinAgentChatTools() as any,
            toolLoop: { maxRounds: 3 },
            suppressRuntimeSuffixes: true,
            functionalSuffixes: true,
            turnIntent: "chat",
            ephemeralTurn: true,
          } as never,
        );
      } catch (err) {
        console.error(`[lane-eval] 轮失败：${c.text}#${i} → ${err instanceof Error ? err.message : err}`);
      }
      provider.clearSession?.(sessionId);
      const ms = Date.now() - t0;
      const networkCalls = calls.filter((x) => NETWORK_TOOL_RE.test(x.name)).length;
      const anyOk = calls.some((x) => x.ok && NETWORK_TOOL_RE.test(x.name));
      const fabricatedClaim = networkCalls === 0 && claimsWebSearch(final);
      rows.push({ ...c, repeat: i, tools: calls.map((x) => x.name), networkCalls, anyOk, fabricatedClaim, textChars: final.length, ms });
      const mark = c.needsTool ? (networkCalls > 0 ? "✔调了" : "✖没调") : (networkCalls === 0 ? "✔纯聊" : "⚠多余");
      console.log(
        ` ${mark} ${(c.text).slice(0, 20).padEnd(22)} #${i} tools=[${calls.map((x) => x.name).join(",") || "无"}] ${fabricatedClaim ? "⚠宣称搜过" : ""}（${ms}ms）`,
      );
    }
  }

  const need = rows.filter((r) => r.needsTool);
  const pure = rows.filter((r) => !r.needsTool);
  const decisionRate = need.filter((r) => r.networkCalls > 0).length / Math.max(1, need.length);
  const groundedRate = need.filter((r) => r.anyOk).length / Math.max(1, need.length);
  const purityRate = pure.filter((r) => r.networkCalls === 0).length / Math.max(1, pure.length);
  const fabrications = rows.filter((r) => r.fabricatedClaim).length;
  const avgMs = Math.round(rows.reduce((n, r) => n + r.ms, 0) / Math.max(1, rows.length));
  const summary = {
    label: process.argv.find((a) => a.startsWith("--label="))?.slice(8) ?? process.env.EVAL_LABEL ?? guidanceMode,
    guidanceMode,
    repeats,
    toolNeededTurns: need.length,
    toolDecisionRate: Number(decisionRate.toFixed(3)),
    toolGroundedRate: Number(groundedRate.toFixed(3)),
    pureChatTurns: pure.length,
    pureChatPurityRate: Number(purityRate.toFixed(3)),
    fabricatedClaims: fabrications,
    avgLatencyMs: avgMs,
    at: new Date().toISOString(),
  };
  console.log("\n=== 汇总 ===");
  console.log(JSON.stringify(summary, null, 2));

  const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  if (out) {
    const path = out.includes("/") || out.includes("\\") ? out : join(scriptDir, out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ summary, rows }, null, 2), "utf8");
    console.log(`[lane-eval] 已保存 ${path}`);
  }
}

void main();
