import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getCalendarDay, getShortTermMemoryConfig } from "./short-term-memory-config.js";
import { redactSensitiveText } from "../utils/redact.js";
import { isProfileExtractHint } from "../agentic-memory/unified-extractor.js";

export type TurnWalEntry = {
  ts: string;
  actorId: string;
  userText: string;
  assistantText: string;
  highSignal?: boolean;
  messageId?: string;
  planExecuteUsed?: boolean;
  /** 记忆上下文：主会话 vs 笔记会话 */
  context?: "main" | "notes";
  /**
   * 画像抽取候选标记（2026-10-22 三层写入调度 T0）：
   * 对【完整 userText】跑 hint 正则（不是下游压缩残片），命中则夜间批抽取
   * 会读这条全文。缺省由 append 自动判定；测试/调用方可显式覆盖。
   */
  profileCandidate?: boolean;
};

/**
 * 回合预写日志（WAL）：每轮先 append JSONL，再更新内存 digest，防崩溃丢当天对话。
 */
export class TurnWalService {
  private readonly config = getShortTermMemoryConfig();

  async append(entry: TurnWalEntry): Promise<void> {
    if (!this.config.walEnabled) return;

    const day = getCalendarDay(new Date(entry.ts));
    // resolve 兼容 walDir 配置为绝对路径的场景（join 会把绝对路径拼坏）
    const dir = resolve(process.cwd(), this.config.walDir);
    const filePath = join(dir, `${day}.jsonl`);

    const safe: TurnWalEntry = {
      ...entry,
      userText: redactSensitiveText(entry.userText),
      assistantText: redactSensitiveText(entry.assistantText),
      // T0 候选标记：正则跑在【落盘前的完整原文】上——这是画像批抽取的召回
      // 根基（此前下游统一抽取只拿到 120 字压缩残片，正则预筛形同虚设）。
      profileCandidate:
        entry.profileCandidate ?? (isProfileExtractHint(entry.userText) || entry.highSignal === true),
    };

    await mkdir(dir, { recursive: true });
    await appendFile(filePath, `${JSON.stringify(safe)}\n`, "utf8");
  }
}

let singleton: TurnWalService | null = null;

export function getTurnWalService(): TurnWalService {
  if (!singleton) singleton = new TurnWalService();
  return singleton;
}
