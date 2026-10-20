import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";

import { BetaWhitelistService } from "./beta-whitelist-service.js";

export type BetaInviteCode = {
  code: string;
  note?: string;
  /** 最大可用次数；0 = 不限次 */
  maxUses: number;
  uses: number;
  createdAt: string;
  disabled?: boolean;
};

export type BetaWaitlistRequest = {
  email: string;
  note?: string;
  ip?: string;
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
};

export type BetaApplyResult = {
  email: string;
  status: "pending" | "approved" | "rejected";
  /** 该邮箱已在白名单内（无需排队，直接可注册登录） */
  whitelisted: boolean;
};

/** 邀请码字符集：去掉 0/O/1/I 等易混字符，QQ 群里手抄不出错 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-Z0-9-]{4,32}$/;

/**
 * 内测自助通道（运营审批制，替代挨个收邮箱）：
 *
 * - BetaWaitlistService 候补队列：用户在登录页自己填邮箱排队，运营在后台
 *   看到队列后批量「通过/拒绝」；通过 = 加入注册白名单。
 * - BetaInviteService 邀请码：群里发一个码，用户在登录页填码自助过闸；
 *   支持每码限次与停用，码泄露即换。
 *
 * 两个库都落 JSON 热读（改完即生效，与 beta-whitelist 同策略）。
 * 队列不是安全边界，文件损坏按空处理（fail-open）；邀请码是注册闸的
 * 放行凭证，文件损坏按「无有效码」处理（fail-closed）。
 */
export class BetaWaitlistService {
  private get persistPath(): string {
    return process.env.BETA_WAITLIST_FILE ?? join(process.cwd(), "data", "beta-waitlist.json");
  }

  async list(): Promise<BetaWaitlistRequest[]> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as { requests?: BetaWaitlistRequest[] };
      return Array.isArray(data.requests) ? data.requests.filter((r) => r?.email) : [];
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== "ENOENT") {
        console.warn("[beta-waitlist] 队列文件损坏，按空队列处理:", e instanceof Error ? e.message : e);
      }
      return [];
    }
  }

  /**
   * 提交申请：新邮箱/被拒过的进入 pending；已在队列或已通过的幂等返回现状。
   */
  async apply(email: string, note?: string, ip?: string): Promise<BetaApplyResult> {
    const normalized = BetaWhitelistService.normalize(email);
    const requests = await this.list();
    const existing = requests.find((r) => BetaWhitelistService.normalize(r.email) === normalized);
    if (existing && existing.status !== "rejected") {
      return { email: normalized, status: existing.status, whitelisted: false };
    }
    const row: BetaWaitlistRequest = {
      email: normalized,
      ...(note?.trim() ? { note: note.trim().slice(0, 200) } : {}),
      ...(ip ? { ip } : {}),
      requestedAt: new Date().toISOString(),
      status: "pending",
    };
    if (existing) Object.assign(existing, row);
    else requests.push(row);
    await this.persist(requests);
    return { email: normalized, status: "pending", whitelisted: false };
  }

  /** 批量审批；返回受影响的邮箱。 */
  async decide(emails: string[], status: "approved" | "rejected"): Promise<string[]> {
    const targets = new Set(emails.map((e) => BetaWhitelistService.normalize(e)));
    const requests = await this.list();
    const decided: string[] = [];
    for (const r of requests) {
      const key = BetaWhitelistService.normalize(r.email);
      if (targets.has(key)) {
        r.status = status;
        r.decidedAt = new Date().toISOString();
        decided.push(key);
      }
    }
    if (decided.length) await this.persist(requests);
    return decided;
  }

  private async persist(requests: BetaWaitlistRequest[]): Promise<void> {
    const path = this.persistPath;
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify({ requests }, null, 2), "utf8");
    await rename(tmp, path);
  }
}

export class BetaInviteService {
  private get persistPath(): string {
    return process.env.BETA_INVITE_CODES_FILE ?? join(process.cwd(), "data", "beta-invite-codes.json");
  }

  private static normalize(code: string): string {
    return code.trim().toUpperCase();
  }

  async list(): Promise<BetaInviteCode[]> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as { codes?: BetaInviteCode[] };
      return Array.isArray(data.codes) ? data.codes.filter((c) => c?.code) : [];
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== "ENOENT") {
        console.warn("[beta-invite] 码库文件损坏，按无有效码处理:", e instanceof Error ? e.message : e);
      }
      return [];
    }
  }

  /**
   * 注册闸兑换：码有效（存在、未停用、未超限）则占用一次并放行。
   * 仅在白名单闸即将拒绝时调用（名单内/未设闸不烧次数）。
   */
  async redeem(code: string): Promise<boolean> {
    const normalized = BetaInviteService.normalize(code);
    if (!normalized) return false;
    const codes = await this.list();
    const hit = codes.find((c) => c.code === normalized);
    if (!hit || hit.disabled) return false;
    if (hit.maxUses > 0 && hit.uses >= hit.maxUses) return false;
    hit.uses += 1;
    await this.persist(codes);
    return true;
  }

  /** 新建码；code 缺省自动生成。返回创建后的码记录。 */
  async create(input: { code?: string; maxUses?: number; note?: string }): Promise<BetaInviteCode> {
    const code = input.code?.trim()
      ? BetaInviteService.normalize(input.code)
      : BetaInviteService.autoGenerate();
    if (!CODE_PATTERN.test(code)) throw new Error("邀请码格式须为 4-32 位字母/数字/连字符");
    const codes = await this.list();
    if (codes.some((c) => c.code === code)) throw new Error("邀请码已存在");
    const maxUses = Number.isFinite(input.maxUses) ? Math.max(0, Math.floor(input.maxUses as number)) : 0;
    const row: BetaInviteCode = {
      code,
      ...(input.note?.trim() ? { note: input.note.trim().slice(0, 100) } : {}),
      maxUses,
      uses: 0,
      createdAt: new Date().toISOString(),
    };
    codes.push(row);
    await this.persist(codes);
    return row;
  }

  async setDisabled(code: string, disabled: boolean): Promise<BetaInviteCode | undefined> {
    const normalized = BetaInviteService.normalize(code);
    const codes = await this.list();
    const hit = codes.find((c) => c.code === normalized);
    if (!hit) return undefined;
    if (disabled) hit.disabled = true;
    else delete hit.disabled;
    await this.persist(codes);
    return hit;
  }

  async remove(code: string): Promise<boolean> {
    const normalized = BetaInviteService.normalize(code);
    const codes = await this.list();
    const next = codes.filter((c) => c.code !== normalized);
    if (next.length === codes.length) return false;
    await this.persist(next);
    return true;
  }

  private static autoGenerate(): string {
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return `NEXTBOT-${suffix}`;
  }

  private async persist(codes: BetaInviteCode[]): Promise<void> {
    const path = this.persistPath;
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify({ codes }, null, 2), "utf8");
    await rename(tmp, path);
  }
}
