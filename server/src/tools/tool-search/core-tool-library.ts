/**
 * 核心工具库：与「延迟工具目录」分离，每轮直接注入 LLM `tools` 列表。
 *
 * - **essential**：时间、联网、能力查询、子 Agent 委派（几乎每轮都可能用到）
 * - **dialogue**：主对话高频（日程/通讯/只读钱包/关怀/协议等）
 * - **embodiment / games**：按前缀整族暴露，避免中文检索与多轮桥接
 *
 * 未列入核心库的工具进入 BM25 延迟目录，经 `tool_discover` + `tool_call` 按需加载。
 *
 * **主 Agent** 内置工具与核心库对齐（见 {@link isMasterAgentBuiltinTool}）；
 * `master.*` 委派工具由 `buildMasterSubAgentDelegateChatTools` 单独注入，不在此判定内。
 */
import { isOssEdition } from "../../config/env.js";

export const CORE_TOOL_LIBRARY = {
  essential: {
    label: "会话基础设施",
    names: [
      "clock.get_current_time",
      "clock.get_user_location",
      "clock.get_date",
      "clock.format_timestamp",
      // 天气常驻核心（2026-10-08 真机实证）：天气与时间/定位同为环境基础设施。
      // 留在延迟目录时轻任务面（realtime_lookup）分类召回不稳定——LLM 拿到
      // 位置后搜不到天气工具，直接幻觉编造「晴朗17°C风速2.6m/s」（真机事故）。
      "weather.get_local",
      "agent.query_capabilities",
      "internet.research",
      "internet.live_check",
      "internet.verify",
      "search_web",
      "search_images",
      "search_images_batch",
      "search_videos",
      "fetch_web",
      "browser.session.list",
      // ObservationPack 读回工具（SoL-Pi 借鉴）：压缩/折叠损失的原文按句柄分页读回，
      // 常驻 core 档——它服务的正是「其他工具结果被压缩」的每轮场景，进延迟目录会失效。
      "obs_recall",
    ],
  },
  dialogue: {
    label: "主对话高频",
    names: [
      "calendar.create_from_text",
      "calendar.create_task",
      "calendar.list_tasks",
      "calendar.delete_task",
      "reminder.plan",
      // 用户画像自编辑（2026-09-29）：「越来越了解用户」是每轮对话的基本动作，
      // 进延迟目录模型会忘记搜、直接嘴硬说记了（真机实证），必须常驻可见。
      "profile.update",
      "phone.ensure_my_number",
      "phone.call_user",
      "world.link.send_message",
      "budget.calculate",
      "shopping.suggest",
      // 接驳下单两件套（travel-upgrade-plan P2，2026-10-18 live e2e 实证）：core 层级
      // 归属（不进 BM25 延迟目录）。注意：每轮可见性由 resolve-chat-tools 的
      // ALWAYS_INCLUDED_TOOLS 决定（已同步加入），两处须同时在场——
      // quote/book 是时点性刚需，接驳确认后 1-2 轮内必须走通（错过窗口就没意义）。
      // status/cancel 低频，留在延迟目录按需召回。
      "ride_hailing.quote",
      "ride_hailing.book",
      "self.list_custom_skills",
      "surface.show",
    ],
    prefixes: [
      "calendar.",
      "phone.",
      "voice.",
      "world.link.",
      "care.",
      "wallet.get_",
      "protocol.unified.",
      "aip.",
    ],
  },
  embodiment: {
    label: "具身身体",
    prefixes: ["embodiment."],
  },
  desktop: {
    label: "桌面截图与键鼠",
    prefixes: ["desktop.visual."],
  },
  browser: {
    label: "电商 Cookie 读价",
    prefixes: ["browser."],
  },
  mcp: {
    label: "MCP 外部工具（动态注册）",
    prefixes: ["mcp."],
  },
} as const;

/**
 * 开源版（NEXTBOT_EDITION=oss）从核心常驻名单剔除的条目：
 * 虚拟电话（phone.*）+ 好友/联络（world.link.*）。
 * 这些工具在开源版不注册执行器，留在 core 名单会变成 LLM 可见但不可调的死条目。
 */
const OSS_EXCLUDED_CORE_EXACT = new Set<string>([
  "phone.ensure_my_number",
  "phone.call_user",
  "world.link.send_message",
]);

const OSS_EXCLUDED_CORE_PREFIXES: readonly string[] = ["phone.", "world.link."];

const CORE_EXACT_NAMES = new Set<string>([
  ...CORE_TOOL_LIBRARY.essential.names,
  ...CORE_TOOL_LIBRARY.dialogue.names,
]);

const CORE_PREFIXES: readonly string[] = [
  ...CORE_TOOL_LIBRARY.dialogue.prefixes,
  ...CORE_TOOL_LIBRARY.embodiment.prefixes,
  ...CORE_TOOL_LIBRARY.desktop.prefixes,
  ...CORE_TOOL_LIBRARY.browser.prefixes,
];

export type ToolExposureTier = "core" | "deferred";

export function classifyToolExposureTier(registryName: string): ToolExposureTier {
  return isCoreToolRegistryName(registryName) ? "core" : "deferred";
}

export function isCoreToolRegistryName(name: string): boolean {
  // 内测版（默认）：全量 core，与历史行为一致
  if (!isOssEdition()) {
    if (CORE_EXACT_NAMES.has(name)) return true;
    return CORE_PREFIXES.some((p) => name.startsWith(p));
  }
  // 开源版：剔除电话/好友家族
  if (CORE_EXACT_NAMES.has(name)) return !OSS_EXCLUDED_CORE_EXACT.has(name);
  return (
    CORE_PREFIXES.some((p) => name.startsWith(p)) &&
    !OSS_EXCLUDED_CORE_PREFIXES.some((p) => name.startsWith(p))
  );
}

/** @deprecated 使用 {@link isCoreToolRegistryName}；保留别名供旧 import。 */
export const isToolSearchCoreRegistryName = isCoreToolRegistryName;

export const TOOL_SEARCH_CORE_REGISTRY_NAMES = CORE_EXACT_NAMES;

export const TOOL_SEARCH_CORE_REGISTRY_PREFIXES = CORE_PREFIXES;

export function summarizeCoreToolLibrary(): {
  exactNameCount: number;
  prefixCount: number;
  tierLabels: string[];
} {
  return {
    exactNameCount: CORE_EXACT_NAMES.size,
    prefixCount: CORE_PREFIXES.length,
    tierLabels: [
      CORE_TOOL_LIBRARY.essential.label,
      CORE_TOOL_LIBRARY.dialogue.label,
      CORE_TOOL_LIBRARY.desktop.label,
    ],
  };
}
