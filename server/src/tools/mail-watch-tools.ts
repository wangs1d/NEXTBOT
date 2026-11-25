import type { MailWatchRegistry } from "../services/mail-watch-registry.js";
import type { SourceStore } from "../proactivity/source-store.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

export type MailWatchToolsDeps = {
  mailWatch: MailWatchRegistry;
  /** 跨源采集库（mail 流持久化）：重启后靠它把历史邮件查回来 */
  sourceStore?: SourceStore | null;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const SNIPPET_MAX = 300;
const SOURCE_POOL = 200;

type MailItem = {
  from: string;
  subject: string;
  date: string;
  snippet: string;
  importance: string;
  /** 合并去重键（同 uid 优先，无 uid 退 from|subject|date） */
  key: string;
  /** 排序用时间戳 */
  at: number;
};

/**
 * 邮箱读取工具（只读）。
 *
 * 数据源合并两处，解决"重启后查不到历史邮件"：
 * 1. [MailWatchRegistry.fetchNewSince] 内存缓冲 —— 最新一轮轮询结果，毫秒级可见；
 * 2. [SourceStore.byStream] 的 `mail` 流 —— 按天分区落盘，重启后由
 *    `loadRecent()` 重建最近 N 天（默认 7 天，`SENSOR_SOURCE_LOAD_DAYS` 可调）。
 *
 * 两处按 uid/内容指纹去重后按时间倒序。未接通时返回可直接转述给用户的原因
 * （去「能力连接」填授权码），而不是让模型把「没数据」误说成「没有邮件」。
 */
export function registerMailWatchTools(
  registry: ToolRegistry,
  deps: MailWatchToolsDeps,
) {
  registry.register("mail.recent", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    if (!actorId) return { ok: false, error: "actorId is missing" };

    const status = deps.mailWatch.statusFor(actorId);
    if (status.running !== true) {
      return {
        ok: false,
        error:
          "邮箱还没接通：" +
          (status.reason ||
            "请在手机端「我的 → 能力连接 → 邮箱」里填一次 IMAP 授权码") +
          "。接通前无法读取邮件。",
      };
    }

    const rawLimit = Number(params.limit ?? DEFAULT_LIMIT);
    const limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const query = String(params.query ?? "").trim().toLowerCase();

    const merged = new Map<string, MailItem>();

    // 1) 实时缓冲：engine 最近处理过的邮件
    for (const item of deps.mailWatch.fetchNewSince(0)) {
      if (item.mail.actorId !== actorId) continue;
      const entry = fromBuffer(item);
      merged.set(entry.key, entry);
    }

    // 2) 持久化 stream：重启后内存缓冲清空时靠它补历史
    const persisted = deps.sourceStore?.byStream("mail", {
      actorId,
      limit: SOURCE_POOL,
    });
    if (persisted) {
      for (const signal of persisted) {
        const entry = fromSignal(signal);
        if (!merged.has(entry.key)) merged.set(entry.key, entry);
      }
    }

    let items = [...merged.values()];
    if (query) {
      items = items.filter(
        (item) =>
          `${item.from}\n${item.subject}\n${item.snippet}`
            .toLowerCase()
            .includes(query),
      );
    }

    const mails = items
      .sort((a, b) => a.at - b.at)
      .slice(-limit)
      .reverse()
      .map(({ key: _key, at: _at, ...rest }) => rest);

    return {
      ok: true,
      account: status.user ?? "",
      count: mails.length,
      mails,
      summary:
        mails.length > 0
          ? `最近 ${mails.length} 封邮件已取出。`
          : query
            ? `邮箱里没找到包含「${query}」的邮件。`
            : "已接通，但最近还没有抓取到邮件。",
    };
  });
}

function fromBuffer(item: {
  uid?: number;
  at: number;
  mail: {
    uid?: number;
    from: string;
    subject: string;
    date?: string;
    textSnippet?: string;
  };
  importance: string;
}): MailItem {
  const uid = item.mail.uid ?? item.uid;
  const date = item.mail.date ?? new Date(item.at).toISOString();
  return {
    from: item.mail.from ?? "",
    subject: item.mail.subject ?? "",
    date,
    snippet: (item.mail.textSnippet ?? "").slice(0, SNIPPET_MAX),
    importance: item.importance,
    key:
      uid !== undefined
        ? `uid:${uid}`
        : `h:${item.mail.from}|${item.mail.subject}|${date}`,
    at: item.at,
  };
}

function fromSignal(signal: {
  at: number;
  payload?: unknown;
}): MailItem {
  const p = (signal.payload ?? {}) as Record<string, unknown>;
  const uid = typeof p.uid === "number" ? p.uid : undefined;
  const from = String(p.from ?? "");
  const subject = String(p.subject ?? "");
  const date = new Date(signal.at).toISOString();
  return {
    from,
    subject,
    date,
    snippet: String(p.text ?? "").slice(0, SNIPPET_MAX),
    importance: String(p.importance ?? ""),
    key: uid !== undefined ? `uid:${uid}` : `h:${from}|${subject}|${date}`,
    at: signal.at,
  };
}
