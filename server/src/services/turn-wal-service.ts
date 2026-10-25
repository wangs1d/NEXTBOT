import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveDataPath } from "../config/data-dir.js";
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
  /** 同进程写串行化：append 与 replace 都落在同一天文件，交错会互相覆盖。 */
  private writeChain: Promise<unknown> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async append(entry: TurnWalEntry): Promise<void> {
    if (!this.config.walEnabled) return;

    const day = getCalendarDay(new Date(entry.ts));
    // resolveDataPath 兼容 walDir 配置为绝对路径的场景
    const dir = resolveDataPath(this.config.walDir);
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

    await this.enqueue(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(filePath, `${JSON.stringify(safe)}\n`, "utf8");
    });
  }

  /**
   * 用「出口定稿文本」覆盖本轮的 assistantText（2026-10-24）。
   *
   * 动机：WAL 在 turn-finalizer 里落的是模型原始文本，而确定性卡片
   * （行程卡/简报卡）与协议标记剥离都发生在 WS 出口更晚的一步。结果
   * 聊天记录回放（/api/chat-data/history?full=1）里既没有行程卡，又会把
   * [RENDER_HINT]/[NEXT_UP_START] 原样漏到用户屏幕。
   *
   * 只替换 assistantText，其余字段（userText/highSignal/messageId/ts）不动；
   * 找不到匹配轮次时返回 false（跨午夜等边缘场景静默降级）。
   */
  replaceAssistantText(entry: {
    actorId: string;
    messageId: string;
    assistantText: string;
    now?: Date;
  }): Promise<boolean> {
    const target = entry.messageId.trim();
    if (!this.config.walEnabled || !target) return Promise.resolve(false);
    const day = getCalendarDay(entry.now ?? new Date());
    const filePath = join(resolveDataPath(this.config.walDir), `${day}.jsonl`);

    return this.enqueue(async () => {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        return false;
      }
      const replaced = replaceAssistantTextInJsonl(raw, {
        actorId: entry.actorId,
        messageId: target,
        assistantText: redactSensitiveText(entry.assistantText),
      });
      if (replaced == null) return false;
      // 整文件重写走临时文件 + rename，避免进程中断留下半截 JSONL
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, replaced, "utf8");
      await rename(tmp, filePath);
      return true;
    });
  }
}

/**
 * 在 JSONL 原文里把匹配 (actorId, messageId) 的那一行的 assistantText 换掉。
 * 未命中返回 null（调用方据此跳过重写）；其余行逐字保留。
 */
export function replaceAssistantTextInJsonl(
  raw: string,
  entry: { actorId: string; messageId: string; assistantText: string },
): string | null {
  let hit = false;
  const lines = raw.split("\n").map((line) => {
    if (hit || !line.trim()) return line;
    let parsed: TurnWalEntry;
    try {
      parsed = JSON.parse(line) as TurnWalEntry;
    } catch {
      return line;
    }
    if (parsed.actorId !== entry.actorId || (parsed.messageId ?? "").trim() !== entry.messageId) {
      return line;
    }
    hit = true;
    return JSON.stringify({ ...parsed, assistantText: entry.assistantText });
  });
  return hit ? lines.join("\n") : null;
}

let singleton: TurnWalService | null = null;

export function getTurnWalService(): TurnWalService {
  if (!singleton) singleton = new TurnWalService();
  return singleton;
}
