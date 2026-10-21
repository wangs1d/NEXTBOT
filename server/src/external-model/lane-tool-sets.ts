/**
 * 静态双车道 Core 工具清单（2026-09-19 架构级工具暴露改造）。
 *
 * 根源问题：旧架构里"模型每轮看到哪些工具"由三个动态层叠加决定——
 * contextual 按关键词逐工具裁剪、前台 4 工具白名单 + 能力域关键词临时注入、
 * 任务面 per-turn LLM planner——同一输入每轮算出的可见集不同，行为不可复现，
 * 且每轮重算打爆前缀缓存。主流 agent（Claude Code / OpenAI Agents SDK / Manus）
 * 的稳定来自"选一种暴露模式然后不动"。
 *
 * 本模块是新的唯一事实源：
 *   - chat 车道：CHAT_LANE_CORE_NAMES 静态常驻（感知只读 + 单步轻动作 + 控制工具）
 *   - task 车道：TASK_LANE_CORE_NAMES 静态常驻 + 路由能力束（Tier-2 确定性增量注入）
 *   - 其余工具全部进延迟目录，经 tool_discover / tool_call / tool_request 到达
 *
 * 回滚：AGENT_TOOL_ARCH=legacy 恢复旧路径（见 isStaticToolArchEnabled）。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { bm25HitsForQuery, domainVotesForQuery, priorDirectMatchesForQuery, PRIOR_DIRECT_LIMIT, topToolMatchesForQuery } from "../tools/tool-search/index.js";
import { firstSentence } from "../tools/tool-search/schema-slim.js";
import {
  domainsForTool,
  isExplicitDomain,
  toolInCapabilityDomains,
  toolsInDomain,
} from "../tools/tool-search/tool-category.js";
import {
  isPreloadDeweighted,
  recordPreloadInjection,
} from "../tools/tool-search/preload-feedback.js";

export type LaneId = "chat" | "task";

/** 架构开关：默认静态双车道；AGENT_TOOL_ARCH=legacy 回退旧暴露链路。 */
export function isStaticToolArchEnabled(): boolean {
  const raw = process.env.AGENT_TOOL_ARCH?.trim().toLowerCase();
  return raw !== "legacy";
}

/**
 * chat 车道静态 Core。准入规则：感知类（只读）+ 单步轻动作（低副作用）+
 * 控制工具。写操作（转账/下单/智能家居控制）与多步流程（浏览器/代码/桌面）
 * 一律不进——安全边界，不只是省 token。
 *
 * 按名解析自注册表，注册表缺失的工具自动跳过（生产/测试环境差异容错）。
 * brain.recall 由 setMemoryChatTools 在 bootstrap 注入，测试环境缺省属正常。
 */
export const CHAT_LANE_CORE_NAMES: readonly string[] = [
  // 时间/位置/天气（感知）
  "clock.get_current_time",
  "clock.get_user_location",
  // 2026-10-07：此前只在 task 车道，chat 车道模型看不到天气工具，
  // 实证会嘴硬「没有联网天气接口的访问权限」而非 discover——天气是对话高频
  // 动作，提为 chat 常驻（profile.update 同款教训）。
  "weather.get_local",
  // 联网信息（只读）
  // 2026-10-21 工具面收敛：媒体/热榜三件套移入延迟目录——它们是低频按需检索，
  // 且 media 域有 BM25 域预载兜底（"找张图/猫咪视频/热搜"会确定性带回来），
  // 每轮常驻约 850 字符并不划算。search_web/fetch_web 仍是对话刚需，常驻。
  "search_web",
  "fetch_web",
  // 日程/提醒（轻动作）
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.list_tasks",
  // 通讯（轻动作）
  // phone.ensure_my_number 保留常驻（2026-10-21 实测）：「我的手机号」这类口语
  // 召回不稳（BM25 top-10 缺位），而它一旦进目录，模型会直接嘴硬"查不到号码"。
  // 228 字符换掉一次"没权限"事故，划算。
  "phone.ensure_my_number",
  "messages.overview",
  "messages.reply",
  "world.link.send_message",
  // 记忆（感知）
  "brain.recall",
  // 用户画像自编辑（2026-09-29）：「越来越了解用户」是对话基本动作；
  // 进延迟目录模型会忘记搜索、直接嘴硬说记了（真机实证），须常驻可见。
  "profile.update",
  // 持续感知回溯（只读，2026-09-19 P0-1）
  "perception.overview",
  // 自我/能力（模型自救入口）
  // agent.query_capabilities 必须常驻：它是模型"以为没权限"时的自救入口。
  // self.list_custom_skills 低频，移入延迟目录（"我会什么/自定义技能"可召回）。
  "agent.query_capabilities",
  // 表达/控制
  "surface.show",
  // 重活逃生门（委派后台）+ 委派闭环（查询/取消，2026-09-19 P0-2）
  "task.dispatch",
  "task.status",
  "task.cancel",
];

/**
 * task 车道静态 Core：在 chat Core 基础上替换进执行主力（深网/桌面/代码）。
 * 长尾（购物订单、智能家居、财务域、vision.periodic_* 等）留在延迟目录。
 */
export const TASK_LANE_CORE_NAMES: readonly string[] = [
  // 搜索全档
  "search_web",
  "fetch_web",
  "deep_search",
  "search_images",
  "search_videos",
  "hot_rankings",
  "internet.research",
  // 深读/站点导航
  "info.inspect_webpage",
  "info.navigate_site",
  "browser.session.list",
  // 感知
  "clock.get_current_time",
  "clock.get_user_location",
  "weather.get_local",
  // 日程/提醒
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.list_tasks",
  // 通讯
  "messages.overview",
  "messages.reply",
  "world.link.send_message",
  // 桌面（桥/本机视觉离线时由调用方过滤）
  "desktop.visual.screenshot",
  // 代码沙箱（self-programming 注册，缺失自动跳过）
  "code.run",
  "code.write_file",
  "code.read_file",
  // 记忆/能力
  "brain.recall",
  "agent.query_capabilities",
  "self.list_custom_skills",
  // 持续感知回溯（只读，2026-09-19 P0-1）
  "perception.overview",
  // 钱（只读）
  "wallet.get_balance",
  "wallet.get_transactions",
  // ObservationPack 读回（压缩补偿，常驻才有意义）
  "obs_recall",
  // 元工具桥 + 逃生门 + 委派闭环（2026-09-19 P0-2）
  "tool_discover",
  "task.dispatch",
  "task.status",
  "task.cancel",
];

/**
 * chat 车道保留完整 schema 的高频工具；其余 Core 工具做 schema 瘦身。
 * 瘦身 = description 压到首句（≤120 字符）+ 丢弃字段级描述；schema 仍在
 * tools 数组中（零往返直调），只是写得短——与"菜单式隐藏 schema"（需一次
 * discover 往返）有本质区别，后者已论证在 Core 规模下不划算。
 */
const CHAT_FULL_SCHEMA_NAMES: ReadonlySet<string> = new Set([
  "task.dispatch",
  "task.status",
  "task.cancel",
  "search_web",
  "reminder.plan",
  "calendar.create_from_text",
  "clock.get_current_time",
  "weather.get_local",
  "messages.reply",
]);

/** task 车道 schema 全保留（仅 core 模式回滚时使用；router-first 下不进 prompt）。 */
const TASK_FULL_SCHEMA_NAMES: ReadonlySet<string> | null = null;

/**
 * task 车道暴露模式（2026-09-23 token 优化）：router-first（默认）。
 *
 * 背景：task Core 36 个全量 schema ≈ 5.1k token/轮，占 light 档单次输入
 * （API 实测均值 8.2k）的一半以上，而 light 档 2-3 波的编排深度根本用不满
 * 36 个工具。router-first 下可见集只留桥工具（tool_discover/tool_call 由
 * prepareToolsWithToolSearch 自动注入），全量语料进 BM25 延迟目录按需召回；
 * 质量护栏：意图预召回（top-1 高置信工具免 discover 直转正）+ <tool_request>
 * 请求卡 + 高频调用自动晋升（PROMOTE_THRESHOLD=3）。chat 车道不受影响。
 *
 * 回滚：AGENT_TASK_LANE=core 恢复静态 Core 全量注入。
 */
export function isTaskLaneRouterFirst(): boolean {
  const raw = process.env.AGENT_TASK_LANE?.trim().toLowerCase();
  return raw !== "core";
}

/** 确定性 schema 瘦身：同输入恒同输出，不引入任何每轮变化。 */
export function slimToolSchema(tool: ChatCompletionTool): ChatCompletionTool {
  if (tool.type !== "function") return tool;
  const fn = tool.function;
  const slimParams = (() => {
    const params = fn.parameters as
      | { type?: string; properties?: Record<string, unknown>; required?: unknown }
      | undefined;
    if (!params || typeof params !== "object" || !params.properties) return fn.parameters;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params.properties)) {
      if (value && typeof value === "object" && "description" in (value as Record<string, unknown>)) {
        const { description: _drop, ...rest } = value as Record<string, unknown>;
        properties[key] = rest;
      } else {
        properties[key] = value;
      }
    }
    return { ...params, properties };
  })();
  return {
    type: "function",
    function: {
      ...fn,
      description: firstSentence(fn.description ?? "", 120),
      parameters: slimParams,
    },
  };
}

export function dedupeToolsByName(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of tools) {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

/**
 * 按静态清单解析车道 Core 工具。extraDefinitions 用于注册表外单独注入的
 * 定义（如 task.dispatch 在 agent-core 晚绑定）。清单外工具一律不进。
 */
export function buildLaneCoreTools(
  lane: LaneId,
  source: ChatCompletionTool[],
  extraDefinitions: ChatCompletionTool[] = [],
): ChatCompletionTool[] {
  const names = lane === "chat" ? CHAT_LANE_CORE_NAMES : TASK_LANE_CORE_NAMES;
  const wanted = new Set<string>(names);
  const pool = [...source, ...extraDefinitions];
  const resolved: ChatCompletionTool[] = [];
  for (const tool of pool) {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (!name || !wanted.has(name)) continue;
    const fullSchema =
      lane === "chat"
        ? CHAT_FULL_SCHEMA_NAMES.has(name)
        : TASK_FULL_SCHEMA_NAMES === null || TASK_FULL_SCHEMA_NAMES.has(name);
    resolved.push(fullSchema ? tool : slimToolSchema(tool));
  }
  return dedupeToolsByName(resolved);
}

/** 域信号预载的族规模上限（与任务面域拉取 DOMAIN_PULL_LIMIT 对齐）。 */
export const DOMAIN_PRELOAD_CAP = 12;

/** 弱信号兜底的 top-K 工具数（无强域时 BM25 直取，宁少勿滥）。 */
export const DOMAIN_PRELOAD_TOPK = 4;

/** 派生域族信号的扫描深度（BM25 top-N）。 */
const DERIVED_DOMAIN_SIGNAL_TOPN = 8;
/** 派生域族信号的最小工具数（top-N 内同族 ≥2 个不同工具才算信号）。 */
const DERIVED_DOMAIN_SIGNAL_MIN = 2;

/**
 * 派生域族信号（2026-10-10 根修，L1 对技能族的覆盖）：BM25 top-N 内同一**派生域**
 * （技能族 habit/booking/picture/finance/virtual-phone/agentworld 等，前缀自动成域）
 * 出现 ≥2 个不同工具 → 该域按强域处理，族全族瘦身 schema 进本轮可见集。
 *
 * 为什么需要独立通道：显式域用「top-5 域多数票 ≥3/5」判强信号，但技能族工具的
 * 词面分天生低（英文点号名 + 简短描述，中文口语 query 重叠少）——实测「记一下我
 * 每天早上要喝水的习惯」里 habit.list-rules 已排 BM25 **第 1**，top-5 仍只投出
 * habit:1 票，凑不到 3 票；top-K 兜底又被 0.075 绝对闸拦下。结果整族漏召，模型
 * 手上没有工具 → 要么多走一趟 discover，要么直接凭常识答。
 * 阈值取 2 而非 3：派生域语义边界由前缀唯一确定，同族 ≥2 个不同工具命中已是
 * 足够强的族信号；实测 10 个闲聊/无关 query（嗯嗯好的/今天天气怎么样/在吗…）
 * 零误命中。确定性：同语料同 query 恒同输出（复用跨轮 catalog 缓存）。
 */
function derivedDomainSignals(seg: string, corpus: ChatCompletionTool[]): string[] {
  const hits = bm25HitsForQuery(seg, corpus, DERIVED_DOMAIN_SIGNAL_TOPN);
  const byDomain = new Map<string, Set<string>>();
  for (const hit of hits) {
    for (const domain of domainsForTool(hit.name)) {
      if (isExplicitDomain(domain)) continue; // 显式域走既有票选通道，避免双重放大
      const set = byDomain.get(domain) ?? new Set<string>();
      set.add(hit.name);
      byDomain.set(domain, set);
    }
  }
  return [...byDomain.entries()]
    .filter(([, tools]) => tools.size >= DERIVED_DOMAIN_SIGNAL_MIN)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .map(([domain]) => domain);
}

/**
 * 工具召回链总开关（2026-10-09 五层根修）：AGENT_TOOL_RECALL=off 一键关闭
 * L1（域预载/top-K 兜底）与 L4（晋升常驻）——A/B 基线与故障回退共用。
 * L3（调用即发现）在 tool-loop 侧独立读本开关；L2 域卡是 2026-10-01 存量设施，
 * 不在本开关语义内（它只影响 discover 路径的指引，不影响可见集组装）。
 */
export function isToolRecallEnabled(): boolean {
  const raw = process.env.AGENT_TOOL_RECALL?.trim().toLowerCase();
  return raw !== "off";
}

/**
 * 域信号预召回（2026-10-09 工具链根修，chat / task 车道共用原语；L1 增强）。
 *
 * 根因：车道 Core 是静态白名单，长尾工具（travel.* / media.* / smart_home 等）
 * 全在延迟目录，须 tool_discover 两波召回才能到手——而模型不知道自己看不见，
 * 「自认能办事」就手写答案静默失败（三次真机实证：profile.update 9/29「嘴硬说
 * 记了」、weather.get_local 10/7「嘴硬没接口」、travel.plan-itinerary 10/8 手写
 * 行程导致旅游卡缺席）。逐领域提 Core 是打地鼠（已否定路线）；正解是组装可见集
 * 时对用户文本做确定性 BM25 域多数票，命中域全族瘦身 schema 直接进本轮可见集——
 * 把「要不要找工具」从模型自觉拿回代码裁决。
 *
 * L1 增强（2026-10-09）四通道递进：
 *   1. 强域命中（票 ≥3/5）→ 域全族注入；次强域（票 ≥2）同注入（多域意图，
 *      如「去北京旅游顺便查天气」→ travel + weather 两族）。
 *   2. 先验直取（点信号）：意图别名/例句命中（token 重叠加分 ≥0.4）的工具
 *      直取 ≤2 个，排在域族之前——确切意图证据优先于族广度（否则 12 工具的
 *      desktop 族会把 cap 挤满、点信号被 slice 丢弃，实测教训）。
 *   3. 无强域 → BM25 top-K 工具直取兜底（双闸过滤噪声，见 topToolMatchesForQuery）。
 *   4. AGENT_TOOL_RECALL=off → 空集（基线/回退）。
 *
 * excludeNames：车道 Core 已含的工具不重复注入（先排除后截断，填满 cap 的都是
 * 增量工具）；任务面 router-first 可见集 = 纯预载，传空集即退化为原语义。
 * 确定性：同语料同文本恒同输出（BM25 跨轮缓存），前缀缓存友好。
 */
export function buildDomainPreloadTools(
  text: string,
  corpus: ChatCompletionTool[],
  excludeNames: ReadonlySet<string> = new Set(),
  cap: number = DOMAIN_PRELOAD_CAP,
): ChatCompletionTool[] {
  if (!isToolRecallEnabled()) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const picked: ChatCompletionTool[] = [];
  const seen = new Set<string>();
  const push = (tool: ChatCompletionTool): void => {
    const name = tool.type === "function" ? tool.function?.name ?? "" : "";
    // 预载负反馈（2026-10-10 L5 数据回流）：冷却降权中的工具不进候选——
    // 「预载了但没被调」的噪声槽让位给真有转化率的工具（见 preload-feedback.ts）。
    if (!name || seen.has(name) || excludeNames.has(name) || isPreloadDeweighted(name)) return;
    seen.add(name);
    picked.push(slimToolSchema(tool));
  };
  const byName = new Map<string, ChatCompletionTool>();
  for (const t of corpus) {
    const name = t.type === "function" ? t.function?.name ?? "" : "";
    if (name) byName.set(name, t);
  }

  // 2. 先验直取（点信号，最先生成）：别名/例句意图命中（≥0.4）直取 ≤2 个。
  //    与 BM25 词面通道互补——描述与 query 零词面重叠的意图（买耳机/盯话题/
  //    到家提醒）靠别名召回；raw/先验双 top-1 不再被假强域整族顶掉。
  for (const m of priorDirectMatchesForQuery(trimmed, corpus, PRIOR_DIRECT_LIMIT, excludeNames)) {
    const tool = byName.get(m.name);
    if (tool) push(tool);
  }

  // 1. 域多数票：top-1 强信号（≥3/5）才注入；强域 + 次强域（≥2 票）全族
  //    （多域意图如「去北京旅游顺便查天气」→ travel + weather）。top-1 只有 2 票
  //    = 无强信号（噪声校准：噪声票恰在 2/5），整组不注入、走 top-K 兜底。
  // 子句切分（2026-10-09 L1）：连词/标点切开后按子句投票再取强域并集——
  // 长多意图 query 整句投 BM25 top-5 会被两族工具摊薄成每域 1 票（实测），
  // 按子句投才能恢复「每子句一个强域」。确定性：切分规则静态，输出恒同。
  const segments = trimmed
    .split(/顺便|然后|另外|还有|同时|接着|[，,；;。！!？?]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  const strongDomains: string[] = [];
  for (const seg of segments) {
    const votes = domainVotesForQuery(seg, corpus);
    if (votes.length > 0 && votes[0].votes >= 3) {
      // 显式域票选（top-5 多数票 ≥3）：语义浓度足够，取强域 + 次强域。
      for (const v of votes) {
        if (v.votes < 2) break;
        if (!strongDomains.includes(v.domain)) strongDomains.push(v.domain);
        if (strongDomains.length >= 2) break;
      }
    }
    // 派生域通道（2026-10-10 根修，补充式）：显式域不足 2 个时，用技能族/长尾
    // 派生域的族信号补足名额。放在显式票选**之后**且只在未满员时生效——既不
    // 挤占既有强域（travel/media 等显式强域轮零行为变化），又能救回被通用词
    // 噪声（voice 3 票等）抢走名额的技能族轮（实测「帮我把健身房打卡设为每天
    // 的习惯」显式只得 voice 1 个，补入 habit 后整族可见）。
    if (strongDomains.length < 2) {
      for (const domain of derivedDomainSignals(seg, corpus)) {
        if (!strongDomains.includes(domain)) strongDomains.push(domain);
        if (strongDomains.length >= 2) break;
      }
    }
    if (strongDomains.length >= 2) break;
  }
  // 族内按 BM25 相关性降序注入（2026-10-10 族序修正）：域命中只说明「意图在
  // 域里」，全族按注册表序截断会让大族里的无关工具占满 cap——实证「音乐暂停
  // 一下」命中 media 域后 11 个 vision.*（同域前缀混域）把 media.pause（族内
  // #14）挤掉，task 车道直达率的 2 条 miss 全栽在这。排序依据用域投票同索引的
  // 命中全表（bm25HitsForQuery，投票的证据本身排序族内工具——searchDeferredTools
  // 通道对该类 CJK query 失真，top1 是 vision 噪声、media.* 反而落榜，不可用）；
  // 同语料同 query 恒同输出，确定性成立，未上榜工具保持注册表序垫底。
  const familyScore = new Map<string, number>();
  if (strongDomains.length > 0) {
    for (const hit of bm25HitsForQuery(trimmed, corpus, corpus.length)) {
      familyScore.set(hit.name, hit.score);
    }
  }
  const byFamilyRelevance = (a: ChatCompletionTool, b: ChatCompletionTool): number => {
    const sa = familyScore.get(toolNameOfPreload(a)) ?? -1;
    const sb = familyScore.get(toolNameOfPreload(b)) ?? -1;
    return sb - sa; // 同分（含双 -1）返回 0，V8 稳定排序保持注册表序
  };
  for (const domain of strongDomains) {
    const family = toolsInDomain(corpus, domain);
    if (familyScore.size > 0) family.sort(byFamilyRelevance);
    for (const tool of family) push(tool);
  }

  // 3. 弱信号兜底：无强域时 BM25 top-K 工具直取（先验直取不算强信号，不影响此闸）
  if (strongDomains.length === 0) {
    for (const match of topToolMatchesForQuery(trimmed, corpus, DOMAIN_PRELOAD_TOPK, excludeNames)) {
      const tool = byName.get(match.name);
      if (tool) push(tool);
    }
  }

  const finalPicked = picked.slice(0, cap);
  // L5 回流：记录本轮实际预载名（负反馈判定的注入侧数据源；执行侧在
  // ToolContextFactory.execute）。AGENT_TOOL_RECALL=off / 空集不记录。
  recordPreloadInjection(finalPicked.map(toolNameOfPreload));
  return finalPicked;
}

function toolNameOfPreload(tool: ChatCompletionTool): string {
  return tool.type === "function" ? tool.function?.name ?? "" : "";
}

/**
 * task 车道 router-first 轻量常驻子集（2026-10-10 ②）。
 *
 * 根因：router-first 可见集 = 纯预载，chat 车道 Core 常驻的轻动作/感知工具
 * 在任务面完全不可见，而短口语动作 query 的 BM25 词面召回天然弱——「提醒」
 * 「回复」「记」是跨域通词被 IDF 闸杀掉，强票位被描述更长更具体的族占走
 * （实测：「明早八点提醒我交周报」calendar:5 vs reminder:1；「回复妈妈微信」
 * geofence:3「到家」撞车；「帮我记一下女儿叫小雨」无强域 top-4 全噪声）。
 * 这类轻动作单步工具确定性常驻（瘦身 schema），任务面「记一下/提醒我/回复」
 * 不再赌词面召回；长尾重活仍走预载/discover/晋升通道。
 */
export const TASK_LANE_ROUTER_FIRST_LIGHT_NAMES: readonly string[] = [
  "clock.get_current_time",
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.list_tasks",
  "messages.overview",
  "messages.reply",
  "profile.update",
];

/**
 * 按轻量子集清单解析常驻工具（语料缺失自动跳过；瘦身 schema 控 token）。
 * 输出顺序跟随清单（可读性），同输入恒同输出。
 */
export function buildTaskLaneRouterFirstLightTools(
  corpus: ChatCompletionTool[],
): ChatCompletionTool[] {
  const byName = new Map<string, ChatCompletionTool>();
  for (const t of corpus) {
    const name = t.type === "function" ? t.function?.name ?? "" : "";
    if (name) byName.set(name, t);
  }
  const out: ChatCompletionTool[] = [];
  for (const name of TASK_LANE_ROUTER_FIRST_LIGHT_NAMES) {
    const tool = byName.get(name);
    if (tool) out.push(slimToolSchema(tool));
  }
  return out;
}

/**
 * router-first 车道判定口径（2026-10-01 统一；2026-10-10 收口为共享函数）。
 *
 * 判定：延迟目录激活 且 「非常驻轻量子集、非桥工具」的可见工具数 ≤ 上限 =
 * "业务工具主力在延迟目录、本轮依赖检索召回"的轮。轻量子集（上方 ②）与
 * 桥工具不计入——它们是常驻基础设施，不稀释"主力在目录"的语义，否则轻量
 * 常驻会把 router-first 判定整体顶破、两步走引导失活。两个消费方共享本函数
 * 防口径漂移（gateway 意图预召回已退役，现存唯一消费方是 tool-loop 规划引导）。
 *
 * 数值 = travel 规划族保底规模 + 桥工具（历史口径兼容：桥/轻量扣除后，原
 * 纯预载轮的判定结果不变）。
 */
export const ROUTER_FIRST_LANE_MAX_VISIBLE = 6;

export function isRouterFirstLaneTurn(prepared: {
  toolSearchActive: boolean;
  visibleTools: ChatCompletionTool[];
  deferredToolCount: number;
}): boolean {
  if (!prepared.toolSearchActive || prepared.deferredToolCount <= 0) return false;
  const exempt = new Set<string>([
    ...TASK_LANE_ROUTER_FIRST_LIGHT_NAMES,
    ...CAPABILITY_BRIDGE_TOOLS,
  ]);
  const businessVisible = prepared.visibleTools.filter((t) => {
    const name = t.type === "function" ? t.function?.name ?? "" : "";
    return Boolean(name) && !exempt.has(name);
  }).length;
  return businessVisible <= ROUTER_FIRST_LANE_MAX_VISIBLE;
}

/** 元工具/能力查询桥：任何集合都保留，保证延迟目录可达。 */
export const CAPABILITY_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  "tool_search",
  "tool_discover",
  "tool_describe",
  "agent.query_capabilities",
]);

/**
 * Tier-2：从语料中取出路由能力束覆盖的工具（增量注入用，不做减法）。
 * capabilities 含 "full" 或为空时返回空数组（Core 已够，不扩）。
 */
export function toolsMatchingCapabilityBeam(
  corpus: ChatCompletionTool[],
  capabilities: string[] | undefined,
): ChatCompletionTool[] {
  const caps = (capabilities ?? []).map((c) => c?.trim()).filter(Boolean);
  if (caps.length === 0 || caps.includes("full")) return [];
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of corpus) {
    const name = tool.type === "function" ? tool.function?.name ?? "" : "";
    if (!name || seen.has(name)) continue;
    if (CAPABILITY_BRIDGE_TOOLS.has(name)) continue;
    if (toolInCapabilityDomains(name, caps)) {
      seen.add(name);
      out.push(tool);
    }
  }
  return out;
}
