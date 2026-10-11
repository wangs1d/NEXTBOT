// MailSensor —— MailWatchService → ProactiveSensor 适配器（2026-10-10 外部信源收编）。
//
// 设计约束（docs/proactivity-scan-architecture.md 阶段一）：
//   **只做「拉取结果 → Signal 形状」的转换，不碰业务逻辑**（IMAP 连接、营销过滤、
//   分级仍留在 MailWatchService）。这样风险最小、可增量迁移、可单源回退。
//
// 内核统一提供：调度 / 退避熔断 / 水位续采 / 健康上报 / 分发 —— 适配器本身
// 只负责"这段时间有什么新邮件"。
import type { ProactiveSensor, Signal } from "./types.js";

/** MailWatchService 的只读取数口（结构最小面，便于测试注入桩） */
export interface MailWatchReadPort {
  fetchNewSince(since: number): Array<{
    uid: number;
    mail: { actorId: string; from: string; subject: string; date?: string; textSnippet?: string };
    importance: string;
  }>;
}

export class MailSensor implements ProactiveSensor {
  readonly id = "mail_watch";
  readonly stream = "mail" as const;
  /** 邮件到达的主要通道是服务自身轮询 + 账单邮件实时桥；内核侧 2min 兜底兜"漏网" */
  readonly pollIntervalMs = 120_000;

  constructor(private readonly port: MailWatchReadPort) {}

  collect(since: number): Signal[] {
    const fresh = this.port.fetchNewSince(since);
    return fresh.map(({ uid, mail, importance }) => {
      const at = mail.date ? Date.parse(mail.date) : NaN;
      return {
        stream: "mail" as const,
        actorId: mail.actorId,
        at: Number.isFinite(at) ? at : Date.now(),
        // 有 uid 用 uid（稳定）；否则退 from+subject+date 指纹
        fingerprint: `mail:${uid >= 0 ? uid : `${mail.from}|${mail.subject}|${mail.date ?? ""}`}`,
        salience: importance === "critical" || importance === "high" ? "high" : importance === "promotional" ? "low" : "medium",
        delta: `新邮件：${mail.subject || "(无主题)"}`,
        payload: {
          uid,
          from: mail.from,
          subject: mail.subject,
          importance,
          // 跨源实体候选：发件人（"张总"）+ 主题（"三亚"）
          entities: entityHints(mail.from, mail.subject),
        },
      };
    });
  }
}

/** 从发件人与主题抽初始实体候选（内核 SourceStore 会再 tokenize，这里是高置信提示） */
function entityHints(from: string, subject: string): string[] {
  const hints: string[] = [];
  const addr = from.match(/<([^>]+)>/)?.[1] ?? from;
  const name = from.replace(/<[^>]*>/, "").trim().replace(/^"|"$/g, "");
  if (name) hints.push(name);
  const domain = addr.split("@")[1]?.split(".")[0];
  if (domain && domain.length >= 3) hints.push(domain);
  // 主题里的实体交给 SourceStore tokenize（这里只放整串主题提高召回）
  if (subject && subject.length <= 40) hints.push(subject);
  return hints.filter(Boolean);
}
