import { createHash } from "node:crypto";

import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 前缀看门狗（2026-10-12 P0 根修配套埋点）。
 *
 * 目标：前缀缓存命中率再劣化时，**一条日志直击责任段**，不再人工排障。
 *
 * 原理：MiniMax/Kimi/DeepSeek 的前缀缓存按「工具列表 → system → 消息历史」
 * 逐字节比对。把每次请求切四段分别取指纹：
 *   tools   —— 发出的工具 schema 数组（历史分叉头号元凶：逐轮重筛/排序抖动）
 *   system  —— 请求头 system 消息（stable 层冻结破坏 / variant 翻转会变）
 *   history —— 末条 user 消息之前的消息（正常增长不算异常）
 *   tail    —— 末条 user 消息（动态层沉底处，天然逐轮变化，不参与归因）
 *
 * 与上一请求比对：tools/system 任一变化即归因告警（history 增长属正常）。
 * 基线 key = sessionId|stage（对话面/任务面各自基线，防车道交替误报）。
 *
 * 日志一行直击：
 *   [prefix-watchdog] tools-churn stage=... sess=... tools=ab12cd34(prev=9988aa11)
 *
 * 聚合计数经 getPrefixWatchdogSummary() 暴露（管理台/巡检脚本可接）。
 * PREFIX_WATCHDOG=0 关闭；内存 LRU 上限 256 会话，零外部依赖。
 */

export type RequestHeadFingerprint = {
  toolsHash: string;
  systemHash: string;
  historyHash: string;
  tailHash: string;
  msgCount: number;
  toolCount: number;
};

type WatchBaseline = RequestHeadFingerprint & { at: number; seq: number };

type WatchdogAttribution = {
  /** 冷启动（会话首请求，全价） */
  cold: number;
  /** tools/system 双稳，前缀命中（history 正常增长不算分叉） */
  ok: number;
  /** tools 段抖动（头号元凶：逐轮重筛/排序/schema 变动） */
  toolsChurn: number;
  /** system 段漂移（stable 冻结破坏 / variant 翻转 / 桥接开关翻转） */
  systemDrift: number;
};

const ATTRIBUTION: WatchdogAttribution = { cold: 0, ok: 0, toolsChurn: 0, systemDrift: 0 };

const BASELINES = new Map<string, WatchBaseline>();
const BASELINES_MAX = 256;

let _seq = 0;

function envEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

function watchdogEnabled(): boolean {
  return envEnabled("PREFIX_WATCHDOG", true);
}

function shortHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function findLastUserIndex(messages: ChatCompletionMessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

/**
 * 对即将发出的请求取分段指纹。在请求构造点调用（create 之前），返回值透传给
 * {@link reportPrefixWatchOutcome}。
 */
export function fingerprintRequestHead(args: {
  tools: ChatCompletionTool[];
  messages: ChatCompletionMessageParam[];
}): RequestHeadFingerprint {
  const { tools, messages } = args;
  const lastUserIdx = findLastUserIndex(messages);
  const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
  const history = lastUserIdx > 1 ? messages.slice(1, lastUserIdx) : [];
  const tail = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : [];
  return {
    toolsHash: shortHash(tools),
    systemHash: shortHash(systemMsg ? systemMsg.content : "(no-system)"),
    historyHash: shortHash(history),
    tailHash: shortHash(tail),
    msgCount: messages.length,
    toolCount: tools.length,
  };
}

/**
 * 请求完成后上报 outcome（usage 到达点调用），自动归因并打印一行结论。
 * history 增长视为正常；只有 tools/system 变化才告警。
 */
export function reportPrefixWatchOutcome(args: {
  sessionId?: string;
  stage?: string;
  fingerprint: RequestHeadFingerprint;
  hitTokens?: number;
  missTokens?: number;
}): void {
  if (!watchdogEnabled() || !args.sessionId) return;
  const key = `${args.sessionId}|${args.stage ?? "default"}`;
  const fp = args.fingerprint;
  _seq += 1;
  const seq = _seq;

  if (BASELINES.size >= BASELINES_MAX && !BASELINES.has(key)) {
    const oldest = BASELINES.keys().next().value as string | undefined;
    if (oldest !== undefined) BASELINES.delete(oldest);
  }
  const prev = BASELINES.get(key);
  BASELINES.delete(key);

  const hitPart =
    typeof args.hitTokens === "number" || typeof args.missTokens === "number"
      ? ` hit=${args.hitTokens ?? 0}/${(args.hitTokens ?? 0) + (args.missTokens ?? 0)}`
      : "";

  if (!prev) {
    ATTRIBUTION.cold += 1;
    BASELINES.set(key, { ...fp, at: Date.now(), seq });
    console.info(
      `[prefix-watchdog] cold stage=${args.stage ?? "-"} sess=${key} ` +
        `tools=${fp.toolsHash}(${fp.toolCount}) system=${fp.systemHash}${hitPart}`,
    );
    return;
  }

  const toolsChanged = fp.toolsHash !== prev.toolsHash;
  const systemChanged = fp.systemHash !== prev.systemHash;

  if (!toolsChanged && !systemChanged) {
    ATTRIBUTION.ok += 1;
    BASELINES.set(key, { ...fp, at: Date.now(), seq });
    // 正常路径低频输出（每 20 条打一条心跳），避免刷屏
    if (seq % 20 === 0) {
      console.info(
        `[prefix-watchdog] ok stage=${args.stage ?? "-"} sess=${key} ` +
          `tools=${fp.toolsHash} system=${fp.systemHash}${hitPart}`,
      );
    }
    return;
  }

  if (toolsChanged) {
    ATTRIBUTION.toolsChurn += 1;
    console.warn(
      `[prefix-watchdog] ⚠ tools-churn stage=${args.stage ?? "-"} sess=${key} ` +
        `tools=${fp.toolsHash}(${fp.toolCount}) prev=${prev.toolsHash}(${prev.toolCount}) ` +
        `→ 前缀从 tools 段分叉，本轮缓存仅命中公共头${hitPart}`,
    );
  }
  if (systemChanged) {
    ATTRIBUTION.systemDrift += 1;
    console.warn(
      `[prefix-watchdog] ⚠ system-drift stage=${args.stage ?? "-"} sess=${key} ` +
        `system=${fp.systemHash} prev=${prev.systemHash} ` +
        `→ stable 层冻结失效或 variant/桥接开关翻转，前缀从 system 段分叉${hitPart}`,
    );
  }
  BASELINES.set(key, { ...fp, at: Date.now(), seq });
}

/** 聚合快照：巡检脚本/管理台接入。 */
export function getPrefixWatchdogSummary(): WatchdogAttribution & { sessions: number } {
  return { ...ATTRIBUTION, sessions: BASELINES.size };
}

/** 仅供测试使用 */
export function resetPrefixWatchdogForTest(): void {
  BASELINES.clear();
  ATTRIBUTION.cold = 0;
  ATTRIBUTION.ok = 0;
  ATTRIBUTION.toolsChurn = 0;
  ATTRIBUTION.systemDrift = 0;
}
