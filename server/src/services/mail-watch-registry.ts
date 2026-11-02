/**
 * 邮箱盯梢注册表（多租户形态，2026-11-02）——一个用户一个邮箱账号。
 *
 * 为什么不能让整机共用一个邮箱槽：
 *   1. 自助配号互相顶掉：A 在设置页填授权码会把 B 正在盯的账号换掉（机器级单槽）；
 *   2. 归属错投：新邮件的 actorId 取的是部署方默认账号，A 的验证码/账单会落进
 *      别人的消息中心与主动链路。
 * 所以每台服务器按 actor 维护：各自凭据、各自已处理 UID 文件、各自轮询与状态。
 *
 * 凭据留存口径：
 *   - 授权码只进加密仓（secret-vault），accounts.json 里不落明文；
 *   - 主密钥缺失时**拒写盘**，授权码只在本次运行内生效，并在返回里如实说明——
 *     既不写明文，也不假装已经持久化；
 *   - env 里的 MAIL_WATCH_PASS 没有归属时，只在本机唯一一个自动接入账号且他自己
 *     没提交过授权码时收编（家用/桌面装机形态）；多账号机器要部署方用
 *     MAIL_WATCH_PASS_OWNER=<userId> 点名归谁，认领后即刻按该 actor 加密落盘。
 *     两条都不成立就忽略，不分给任何租户。
 *
 * 开关层级：MAIL_WATCH_ENABLED=0 是部署级硬闸，优先于任何账号（含自动接入、
 * 用户自助配号）；账号级没有单独开关——没配凭据就是不盯，状态如实说明。
 */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import { getDataDir } from "../config/data-dir.js";
import { sanitizeActorKey } from "../agentic-memory/actor-key.js";
import { isEphemeralActorId } from "../agent/actor-id.js";
import { readJson, writeJson } from "../proactivity/persist-file.js";
import { resolveImapHost, type ResolvedMailAccount } from "../proactivity/auto-mail-account.js";
import { createEncryptedRecordStore } from "./secret-vault.js";
import {
  MailWatchService,
  readMailWatchConfig,
  type IncomingMail,
  type MailWatchConfig,
  type MailWatchDeps,
  type MailWatchStatus,
  type MailboxAccount,
} from "./mail-watch-service.js";

/** 注册表对外的账号形态（含归属与来源，不含明文授权码） */
export interface MailboxAccountView {
  actorId: string;
  host: string;
  port: number;
  user: string;
  mailbox: string;
  /** env=部署方自用；auto=注册邮箱自动接入；user=用户在设置页/对话里自助配 */
  source: "env" | "auto" | "user";
  updatedAt: string;
  hasPass: boolean;
  /** 授权码是否已加密落盘（false = 只在本次运行内存里，重启要重填） */
  passStored: boolean;
}

export interface MailboxAccountInput {
  /** 归属用户（必填且不能是匿名会话号：不然这份凭据没人能用） */
  actorId: string;
  /** 邮箱地址（= IMAP 登录名）。省略时沿用已绑定的地址，再退到 actorId 本身 */
  email?: string;
  host?: string;
  port?: number;
  mailbox?: string;
  pass?: string;
}

export type SaveAccountResult =
  | { ok: true; status: MailWatchStatus; persisted: boolean; account: MailboxAccountView }
  | { ok: false; error: string };

export type MailWatchRegistryDeps = Omit<MailWatchDeps, "persistPath" | "account"> & {
  /** 邮箱盯梢数据目录（默认 <数据根>/mail-watch）；测试注入临时目录 */
  stateDir?: string;
  /**
   * 单机装机形态：请求没带账号身份时，把授权码认给本机唯一的邮箱账号。
   * 多租户云端必须为 false——那种时候"没带身份"就该拒，不能替别人收凭据。
   */
  allowAnonymousFallback?: boolean;
};

interface StoredMailboxPass {
  actorId: string;
  pass: string;
  savedAt: string;
}

interface PersistedAccount {
  actorId: string;
  host: string;
  port: number;
  user: string;
  mailbox: string;
  source: "env" | "auto" | "user";
  updatedAt: string;
}

interface AccountsFile {
  version: 1;
  accounts: PersistedAccount[];
}

/** 内存态账号：凭据 + 落盘标记（字段一律实值，可选性只留在入参形态里） */
interface LiveAccount {
  actorId: string;
  host: string;
  port: number;
  user: string;
  mailbox: string;
  /** 授权码明文只驻内存；落盘走加密仓 */
  pass: string;
  source: "env" | "auto" | "user";
  updatedAt: string;
  passStored: boolean;
}

function isStoredMailboxPass(v: unknown): v is StoredMailboxPass {
  const r = v as Partial<StoredMailboxPass> | null;
  return Boolean(r?.actorId && r.pass);
}

function looksLikeEmail(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
}

export class MailWatchRegistry {
  private readonly env: NodeJS.ProcessEnv;
  private readonly base: MailWatchConfig;
  /** 各账号引擎共用的装配（IMAP 工厂 / 新邮件回调 / 消息中心 / 日志 / 窗口） */
  private readonly serviceDeps: Omit<MailWatchDeps, "persistPath" | "account">;
  private readonly dir: string;
  private readonly accountsPath: string;
  private readonly legacyStatePath: string;
  private readonly vault: ReturnType<typeof createEncryptedRecordStore<StoredMailboxPass>>;
  /** env 里孤悬的 MAIL_WATCH_PASS（没有归属地址时按单机形态收编，见文件头） */
  private readonly envOrphanPass: string;
  private readonly accounts = new Map<string, LiveAccount>();
  private readonly engines = new Map<string, MailWatchService>();
  /** 只用于产出"这个账号还没配邮箱"的同形状状态，永不启动 */
  private readonly statusShell: MailWatchService;
  private started = false;
  private migratedLegacyState = false;
  private readonly allowAnonymousFallback: boolean;

  constructor(deps: MailWatchRegistryDeps = {}) {
    this.env = deps.env ?? process.env;
    this.base = readMailWatchConfig(this.env);
    const { stateDir, ...service } = deps;
    this.serviceDeps = service;
    this.dir = stateDir ?? join(getDataDir(), "mail-watch");
    this.accountsPath = join(this.dir, "accounts.json");
    this.legacyStatePath = join(this.dir, "processed-uids.json");
    this.vault = createEncryptedRecordStore<StoredMailboxPass>({      dirName: join("mail-watch", "pass"),
      deriveSalt: "nextbot-mailbox-pass-v1",
      secretEnvNames: ["MODEL_KEY_SECRET", "WELLNESS_DATA_SECRET", "BROWSER_SESSION_SECRET", "SESSION_SECRET"],
      validate: isStoredMailboxPass,
      env: this.env,
    });
    this.statusShell = new MailWatchService({ env: this.env });
    this.envOrphanPass = this.base.pass;
    this.allowAnonymousFallback = deps.allowAnonymousFallback ?? false;
    this.loadPersistedAccounts();
    this.seedFromEnv();
  }

  // ---------------- 装配 ----------------

  /** 已落盘的自助/自动接入账号 + 加密仓里的授权码 → 内存态。 */
  private loadPersistedAccounts(): void {
    const file = readJson<AccountsFile | null>(this.accountsPath, null);
    for (const a of file?.accounts ?? []) {
      if (!a?.actorId || !a.host || !a.user) continue;
      const stored = this.vault.load(a.actorId);
      this.accounts.set(this.key(a.actorId), {
        actorId: a.actorId,
        host: a.host,
        port: a.port > 0 ? a.port : 993,
        user: a.user,
        mailbox: a.mailbox || "INBOX",
        pass: stored?.pass ?? "",
        source: a.source === "user" ? "user" : "auto",
        updatedAt: a.updatedAt ?? new Date(0).toISOString(),
        passStored: Boolean(stored?.pass),
      });
    }
  }

  /** env 显式配的 MAIL_WATCH_HOST/USER 视为部署方自用邮箱（优先于任何自动接入）。 */
  private seedFromEnv(): void {
    if (!this.base.host || !this.base.user) return;
    const k = this.key(this.base.actorId);
    if (this.accounts.has(k)) return; // 用户自助改过的地址为准（env 只是开机初值）
    const stored = this.vault.load(this.base.actorId);
    this.accounts.set(k, {
      actorId: this.base.actorId,
      host: this.base.host,
      port: this.base.port,
      user: this.base.user,
      mailbox: this.base.mailbox,
      // 这个人在设置页提交过的授权码优先于 env 里那份（env 是部署方的）
      pass: stored?.pass ?? this.base.pass,
      source: "env",
      updatedAt: new Date(0).toISOString(),
      passStored: Boolean(stored?.pass),
    });
  }

  /**
   * 注册登录留下的邮箱逐个接入（每个用户盯自己的）。
   * 已有账号（env 自用 / 用户自助改过 / 上次接入后补过授权码）不覆盖；
   * 授权码服务端无从得知——缺时状态如实报"等待授权码"。
   */
  attachAutoAccounts(list: readonly ResolvedMailAccount[]): void {
    const envOwnsCredentials = Boolean(this.env.MAIL_WATCH_HOST?.trim() || this.env.MAIL_WATCH_USER?.trim());
    const envPassClaimable = Boolean(this.envOrphanPass) && !envOwnsCredentials;
    const ownerKey =
      this.base.passOwner && !isEphemeralActorId(this.base.passOwner) ? this.key(this.base.passOwner) : "";
    let changed = false;
    /** 认领了机器级授权码的账号（日志只报数量，不报地址） */
    const adopted: string[] = [];
    for (const acct of list) {
      const k = this.key(acct.actorId);
      // 那份机器级授权码认给谁：整机唯一自动账号（家用装机形态），或部署方用
      // MAIL_WATCH_PASS_OWNER 点名的人；两条都不成立就不认给任何租户。
      const orphanPass =
        envPassClaimable && (list.length === 1 || k === ownerKey) ? this.envOrphanPass : "";
      let existing = this.accounts.get(k);
      if (!existing) {
        const sameMailbox = [...this.accounts.values()].find(
          (a) => a.user.toLowerCase() === acct.email.toLowerCase(),
        );
        if (sameMailbox) {
          if (sameMailbox.source !== "env") continue; // 这只邮箱已有人盯着，不再挂第二份引擎
          // env 自用邮箱与注册账号是同一只邮箱：归属换成注册表里那个已验证的 actorId，
          // 否则新邮件全落到 MAIL_WATCH_ACTOR_ID（缺省 default_user）名下，真人收不到自己的账单/验证码
          this.rebindActorId(sameMailbox.actorId, acct.actorId);
          existing = this.accounts.get(k);
          const stored = this.vault.load(acct.actorId);
          if (existing && stored?.pass) {
            existing.pass = stored.pass;
            existing.passStored = true;
          }
          changed = true;
        }
      }
      if (existing) {
        if (orphanPass && !existing.pass && existing.source === "auto") {
          existing.pass = orphanPass;
          adopted.push(existing.actorId);
          changed = true;
        }
        continue;
      }
      const stored = this.vault.load(acct.actorId);
      const account: LiveAccount = {
        actorId: acct.actorId,
        host: acct.imapHost,
        port: acct.imapPort,
        user: acct.email,
        mailbox: this.base.mailbox,
        pass: stored?.pass ?? orphanPass,
        source: "auto",
        updatedAt: new Date().toISOString(),
        passStored: Boolean(stored?.pass),
      };
      if (!stored?.pass && orphanPass) adopted.push(acct.actorId);
      this.accounts.set(k, account);
      changed = true;
    }
    // 认领过来的机器级授权码立刻按 actor 加密落盘：之后删掉 env 那行、或开周界鉴权
    // 后启动不再回放 env，这份凭据都还在
    for (const actorId of adopted) {
      const acct = this.accounts.get(this.key(actorId));
      if (!acct?.pass) continue;
      acct.passStored = this.vault.save(actorId, {
        actorId,
        pass: acct.pass,
        savedAt: new Date().toISOString(),
      });
    }
    if (adopted.length) {
      const stored = adopted.filter((a) => this.accounts.get(this.key(a))?.passStored).length;
      this.log(
        "info",
        `邮箱授权码归属：env 里那份机器级授权码认给 ${adopted.length} 个账号，其中 ${stored} 个已按账号加密落盘` +
          (stored < adopted.length ? "（其余的因主密钥缺失只在本次运行内有效）" : ""),
      );
    }
    if (changed || adopted.length) this.persistAccounts();
    const autoCount = [...this.accounts.values()].filter((a) => a.source === "auto").length;
    if (autoCount > 0) {
      this.log("info", `邮箱自动接入：${autoCount} 个注册邮箱已挂上，缺授权码的如实报"等待授权码"`);
    }
    if (this.started) {
      for (const acct of list) {
        const account = this.accounts.get(this.key(acct.actorId));
        if (account) this.syncEngine(account);
      }
    }
  }

  /**
   * 保存/更新某个用户的邮箱账号（设置页与对话入口都走这里）。
   * 只影响这一个账号：别人的邮箱连接、UID 基线、状态都不动。
   */
  saveAccount(input: MailboxAccountInput): SaveAccountResult {
    let actorId = String(input.actorId ?? "").trim();
    if (!actorId && this.allowAnonymousFallback) actorId = this.defaultActorId() ?? "";
    if (!actorId || isEphemeralActorId(actorId)) {
      return { ok: false, error: "这条请求没带账号身份，不能为它绑定邮箱凭据" };
    }
    const k = this.key(actorId);
    const existing = this.accounts.get(k);
    const user = (input.email?.trim() || existing?.user || (looksLikeEmail(actorId) ? actorId : "")).trim();
    if (!user) {
      return { ok: false, error: "缺邮箱地址：本机无法从账号名推断，请一并上送 email" };
    }
    const mapped = resolveImapHost(user);
    const host = (input.host?.trim() || existing?.host || mapped?.host || "").trim();
    if (!host) {
      return {
        ok: false,
        error: `未收录 ${user.split("@")[1] ?? ""} 这个邮箱域，请同时填 IMAP 服务器地址（host）`,
      };
    }
    const pass = input.pass?.trim() || existing?.pass || "";
    const account: LiveAccount = {
      actorId,
      host,
      port: Math.trunc(input.port ?? existing?.port ?? mapped?.port ?? 993) || 993,
      user,
      mailbox: (input.mailbox?.trim() || existing?.mailbox || this.base.mailbox).trim(),
      pass,
      source: "user",
      updatedAt: new Date().toISOString(),
      passStored: false,
    };
    // 授权码落盘：主密钥缺失时拒写，只在内存里用这一次
    account.passStored = pass ? this.vault.save(actorId, { actorId, pass, savedAt: account.updatedAt }) : false;
    this.accounts.set(k, account);
    this.persistAccounts();
    const engine = this.syncEngine(account);
    if (pass && !account.passStored) {
      this.log(
        "warn",
        `邮箱授权码未持久化（主密钥缺失，如 MODEL_KEY_SECRET）：${actorId} 的授权码只在本次运行内有效，重启需重填`,
      );
    }
    return {
      ok: true,
      status: engine.status(),
      persisted: account.passStored,
      account: this.view(account),
    };
  }

  /** 删除某用户的邮箱账号（连凭据密文一起清）；只认这一个账号。 */
  removeAccount(actorId: string): { ok: boolean; error?: string } {
    const k = this.key(String(actorId ?? "").trim());
    const account = this.accounts.get(k);
    if (!account) return { ok: false, error: "这个账号没有绑定邮箱" };
    if (account.source === "env") {
      return { ok: false, error: "这是部署方在 env 里配的邮箱，请在服务端配置里改" };
    }
    this.engines.get(k)?.stop();
    this.engines.delete(k);
    this.accounts.delete(k);
    this.vault.remove(account.actorId);
    this.persistAccounts();
    return { ok: true };
  }

  // ---------------- 生命周期 ----------------

  /** 起盯全部账号（幂等）。启动时顺带把单机存量的 UID 文件收编到唯一账号名下。 */
  start(): void {
    this.migrateLegacyUidState();
    for (const account of this.accounts.values()) this.syncEngine(account);
    this.started = true;
    for (const engine of this.engines.values()) engine.start();
  }

  stop(): void {
    this.started = false;
    for (const engine of this.engines.values()) engine.stop();
  }

  /** 立即拉一轮：带 actorId 只拉这个账号的邮箱，不带 = 全部（内核/手动刷新用）。 */
  wake(actorId?: string, reason = "manual"): void {
    if (actorId) this.engines.get(this.key(actorId))?.wake(reason);
    else for (const engine of this.engines.values()) engine.wake(reason);
  }

  /** 单轮全量拉取（测试/巡检用）：逐账号各拉一轮，互不串。 */
  async pollAll(): Promise<void> {
    for (const engine of this.engines.values()) await engine.pollOnce();
  }

  /**
   * 单机存量收编：`processed-uids.json` 是整机共用一个邮箱时代的已处理 UID。
   * 只有当本机恰好一个账号、且该账号还没有自己的 UID 文件时才改名归它——
   * 多账号时不知道该给谁，宁可留着不动，也不把历史基线塞给某个用户。
   */
  private migrateLegacyUidState(): void {
    if (this.migratedLegacyState || this.accounts.size !== 1) return;
    if (!existsSync(this.legacyStatePath)) return;
    const only = [...this.accounts.keys()][0]!;
    const target = this.statePathFor(only);
    this.migratedLegacyState = true;
    if (existsSync(target)) return;
    try {
      renameSync(this.legacyStatePath, target);
    } catch {
      /* 挪不动就维持原状：最坏是第一轮按新基线走，不轰炸历史邮件 */
    }
  }

  // ---------------- 查询 ----------------

  /** 这个用户的邮箱盯梢状态（含诚实失败原因；没配邮箱也回同形状状态供设置页展示）。 */
  statusFor(actorId: string): MailWatchStatus {
    const engine = this.engines.get(this.key(actorId));
    if (engine) return engine.status();
    const account = this.accounts.get(this.key(actorId));
    if (account) return this.syncEngine(account).status();
    // host/user 一律清空：部署方自用邮箱的地址不是这个账号的信息
    return {
      ...this.statusShell.status(),
      host: "",
      user: "",
      actorId,
      enabled: !this.base.hardStop,
      configured: false,
      running: false,
      reason: this.base.hardStop
        ? "MAIL_WATCH_ENABLED=0：本机已停用邮箱盯梢（部署级开关）"
        : "这个账号还没绑定邮箱：填 IMAP 授权码即接入（常见邮箱域自动识别，企业邮箱请一并填 IMAP 地址）",
    };
  }

  /** 账号清单（不含任何凭据），供管理面/日志。 */
  list(): MailboxAccountView[] {
    return [...this.accounts.values()].map((a) => this.view(a));
  }

  /** 已在跑的账号数（启动日志与自检用）。 */
  runningCount(): number {
    let n = 0;
    for (const engine of this.engines.values()) if (engine.status().running) n += 1;
    return n;
  }

  /** 内核收编读口：合并各账号最近处理过的邮件（按到达时间升序）。 */
  fetchNewSince(since: number): Array<{ uid: number; at: number; mail: IncomingMail; importance: string }> {
    const out: Array<{ uid: number; at: number; mail: IncomingMail; importance: string }> = [];
    for (const engine of this.engines.values()) out.push(...engine.fetchNewSince(since));
    return out.sort((a, b) => a.at - b.at);
  }

  /** 这个账号盯的邮箱地址（回信/注入模拟邮件时的 to）。 */
  mailboxOf(actorId: string): { user: string; host: string; mailbox: string } | null {
    const a = this.accounts.get(this.key(actorId));
    return a ? { user: a.user, host: a.host, mailbox: a.mailbox } : null;
  }

  /** 该账号的处理引擎（没绑邮箱返回 null）：注入模拟邮件走它，归属不会被顶包。 */
  engineOf(actorId: string): MailWatchService | null {
    const account = this.accounts.get(this.key(actorId));
    return account ? this.syncEngine(account) : null;
  }

  /**
   * 无显式身份时的缺省归属：只有"整机就一个邮箱账号"时才敢给，
   * 多账号时返回 null——调用方必须自己带上是谁。
   */
  defaultActorId(): string | null {
    if (this.accounts.size === 1) return [...this.accounts.values()][0]!.actorId;
    const envAccount = [...this.accounts.values()].find((a) => a.source === "env");
    return envAccount?.actorId ?? null;
  }

  // ---------------- 内部 ----------------

  private key(actorId: string): string {
    return sanitizeActorKey(String(actorId ?? "").trim());
  }

  /** 换绑归属：账号（含授权码与已处理 UID 基线）整体挪到新 actorId 名下。 */
  private rebindActorId(oldActorId: string, newActorId: string): void {
    const oldKey = this.key(oldActorId);
    const account = this.accounts.get(oldKey);
    if (!account) return;
    this.accounts.delete(oldKey);
    const engine = this.engines.get(oldKey);
    if (engine) {
      engine.stop();
      this.engines.delete(oldKey);
    }
    account.actorId = newActorId;
    this.accounts.set(this.key(newActorId), account);
  }

  private view(a: LiveAccount): MailboxAccountView {
    return {
      actorId: a.actorId,
      host: a.host,
      port: a.port,
      user: a.user,
      mailbox: a.mailbox,
      source: a.source,
      updatedAt: a.updatedAt,
      hasPass: Boolean(a.pass),
      passStored: a.passStored,
    };
  }

  private statePathFor(actorKey: string): string {
    return join(this.dir, `uids-${actorKey}.json`);
  }

  /** 取（或就地换绑）这个账号的引擎；本机已进入轮询态时补齐授权码即刻起盯。 */
  private syncEngine(a: LiveAccount): MailWatchService {
    const k = this.key(a.actorId);
    const account: MailboxAccount = {
      actorId: a.actorId,
      host: a.host,
      port: a.port,
      user: a.user,
      mailbox: a.mailbox,
      pass: a.pass,
    };
    let engine = this.engines.get(k);
    if (engine) engine.applyAccount(account);
    else {
      engine = new MailWatchService({
        ...this.serviceDeps,
        env: this.env,
        account,
        persistPath: this.statePathFor(k),
      });
      this.engines.set(k, engine);
    }
    if (this.started) engine.start();
    return engine;
  }

  private persistAccounts(): void {
    const file: AccountsFile = {
      version: 1,
      accounts: [...this.accounts.values()]
        .filter((a) => a.source !== "env")
        .map((a) => ({
          actorId: a.actorId,
          host: a.host,
          port: a.port,
          user: a.user,
          mailbox: a.mailbox,
          source: a.source,
          updatedAt: a.updatedAt,
        })),
    };
    writeJson(this.accountsPath, file);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    const logger = this.serviceDeps.logger;
    if (logger) logger(level, message);
    else console[level === "info" ? "log" : level](`[MailWatch] ${message}`);
  }
}
