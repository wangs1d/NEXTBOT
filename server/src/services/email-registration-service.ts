import { getDataDir } from "../config/data-dir.js";
import { randomInt, randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { getAgentMailDomain } from "../config/mail.js";

export type EmailPendingRecord = {
  /** 登录主体，与 `boundActorId` 一致；旧落盘字段名曾为 `sessionId` */
  userId: string;
  displayName: string;
  email: string;
  /** 本服务生成的验证码 */
  code: string;
  expiresAt: string;
  /** Inbound Webhook 从邮件正文解析出的 6 位码（第三方平台发来） */
  inboundCodes: string[];
};

function makeLocalPart(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  return slug ? `${slug}-${suffix}` : `agent-${suffix}`;
}

function makeCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

const TTL_MS = 10 * 60 * 1000;
const MAX_INBOUND_CODES = 20;

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

/** 从 `Name <a@b>` 或裸邮箱解析出小写地址 */
export function parseRecipientToEmail(to: string): string {
  const t = to.trim();
  const angle = t.match(/<([^>]+@[^>]+)>/);
  if (angle?.[1]) return angle[1].trim().toLowerCase();
  const bare = t.match(/([^\s<>]+@[^\s<>]+\.[^\s<>]+)/);
  if (bare?.[1]) return bare[1].trim().toLowerCase();
  return t.toLowerCase();
}

export function extractSixDigitCodesFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{6})\b/g)) {
    const c = m[1];
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

type PersistShape = { pendings?: (EmailPendingRecord & { sessionId?: string })[] };

/**
 * 邮箱验证码注册：支持内存 + JSON 落盘；Inbound Webhook 写入第三方验证码。
 */
export class EmailRegistrationService {
  private readonly byUserId = new Map<string, EmailPendingRecord>();
  private readonly byEmail = new Map<string, string>();

  constructor(private readonly mailDomain: string = getAgentMailDomain()) {}

  private get persistPath(): string {
    return process.env.AGENT_EMAIL_PENDING_FILE ?? join(getDataDir(), "email-pending.json");
  }

  getDomain(): string {
    return this.mailDomain;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistShape;
      const list = data.pendings ?? [];
      this.byUserId.clear();
      this.byEmail.clear();
      const now = Date.now();
      const survivors: EmailPendingRecord[] = [];
      for (const p of list) {
        const userId = String(p?.userId ?? p?.sessionId ?? "").trim();
        if (!userId || !p?.email || !p?.code || !p?.expiresAt) continue;
        if (now > new Date(p.expiresAt).getTime()) continue;
        const inboundCodes = Array.isArray(p.inboundCodes) ? p.inboundCodes.slice(0, MAX_INBOUND_CODES) : [];
        const rec: EmailPendingRecord = {
          userId,
          displayName: String(p.displayName ?? "").trim() || "Agent",
          email: p.email,
          code: p.code,
          expiresAt: p.expiresAt,
          inboundCodes,
        };
        survivors.push(rec);
        this.byUserId.set(rec.userId, rec);
        this.byEmail.set(rec.email.toLowerCase(), rec.userId);
      }
      if (survivors.length !== list.length) {
        await this.persistSnapshot(survivors);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  private async persistSnapshot(list: EmailPendingRecord[]): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.persistPath, JSON.stringify({ pendings: list }, null, 2), "utf8");
  }

  private async persist(): Promise<void> {
    await this.persistSnapshot(Array.from(this.byUserId.values()));
  }

  private indexRecord(rec: EmailPendingRecord): void {
    this.byUserId.set(rec.userId, rec);
    this.byEmail.set(rec.email.toLowerCase(), rec.userId);
  }

  private removeIndexes(userId: string, email: string): void {
    this.byUserId.delete(userId);
    this.byEmail.delete(email.toLowerCase());
  }

  /**
   * 发起注册：分配 `local@mailDomain`，生成验证码并进入待验证状态。
   */
  async start(userId: string, displayName: string): Promise<EmailPendingRecord> {
    const uid = userId.trim();
    if (!uid) throw new Error("登录主体 id 不能为空");
    const name = displayName.trim();
    if (!name) throw new Error("显示名称不能为空");
    if (name.length > 120) throw new Error("显示名称过长");

    const prev = this.byUserId.get(uid);
    if (prev) {
      this.removeIndexes(prev.userId, prev.email);
    }

    const local = makeLocalPart(name);
    const email = `${local}@${this.mailDomain}`;
    const code = makeCode();
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

    const rec: EmailPendingRecord = {
      userId: uid,
      displayName: name,
      email,
      code,
      expiresAt,
      inboundCodes: [],
    };
    this.indexRecord(rec);
    await this.persist();
    return rec;
  }

  getPending(userId: string): EmailPendingRecord | undefined {
    const uid = userId.trim();
    const p = this.byUserId.get(uid);
    if (!p) return undefined;
    if (Date.now() > new Date(p.expiresAt).getTime()) {
      this.removeIndexes(p.userId, p.email);
      void this.persist();
      return undefined;
    }
    return p;
  }

  /**
   * 校验验证码：接受本服务生成的码，或 Inbound 解析到的码。
   */
  async consume(userId: string, code: string): Promise<{ displayName: string; email: string }> {
    const uid = userId.trim();
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      throw new Error("验证码须为 6 位数字");
    }
    const p = this.getPending(uid);
    if (!p) {
      throw new Error("没有待验证的注册，请先调用注册发起接口");
    }
    const inboundOk = p.inboundCodes.includes(trimmed);
    if (p.code !== trimmed && !inboundOk) {
      throw new Error("验证码不正确");
    }
    this.removeIndexes(uid, p.email);
    await this.persist();
    return { displayName: p.displayName, email: p.email };
  }

  clearPending(userId: string): void {
    const uid = userId.trim();
    const p = this.byUserId.get(uid);
    if (!p) return;
    this.removeIndexes(uid, p.email);
    void this.persist();
  }

  /**
   * Inbound：邮件网关将投递到某地址的邮件 POST 到此；按收件人匹配待验证记录并解析验证码。
   */
  async applyInbound(params: {
    to: string;
    text?: string;
    html?: string;
    subject?: string;
  }): Promise<{
    matched: boolean;
    userId?: string;
    /** 与 userId 相同，兼容旧字段名 */
    sessionId?: string;
    email?: string;
    extracted: string[];
    message: string;
  }> {
    const addr = parseRecipientToEmail(params.to);
    const userId = this.byEmail.get(addr);
    if (!userId) {
      return { matched: false, extracted: [], message: "无匹配的待验证邮箱" };
    }
    const p = this.getPending(userId);
    if (!p || p.email.toLowerCase() !== addr) {
      return { matched: false, extracted: [], message: "待验证已过期或不存在" };
    }

    const chunks = [params.subject ?? "", params.text ?? "", stripHtml(params.html ?? "")].join("\n");
    const extracted = extractSixDigitCodesFromText(chunks);
    if (extracted.length === 0) {
      return {
        matched: true,
        userId,
        sessionId: userId,
        email: p.email,
        extracted: [],
        message: "已匹配邮箱，正文中未解析到 6 位数字验证码",
      };
    }

    const merged: string[] = [];
    const seen = new Set<string>();
    for (const c of [...extracted, ...p.inboundCodes]) {
      if (!seen.has(c)) {
        seen.add(c);
        merged.push(c);
      }
    }
    p.inboundCodes = merged.slice(0, MAX_INBOUND_CODES);
    this.byUserId.set(userId, p);
    await this.persist();

    return {
      matched: true,
      userId,
      sessionId: userId,
      email: p.email,
      extracted,
      message: "已写入入站验证码",
    };
  }
}
