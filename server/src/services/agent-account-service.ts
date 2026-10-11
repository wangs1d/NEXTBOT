import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomInt, randomUUID } from "crypto";

export type AgentAccountRecord = {
  accountId: string;
  /** 登录主体，与 `boundActorId` / `resolveActorId` 一致 */
  userId: string;
  displayName: string;
  /** 经邮箱验证流程绑定的地址；旧数据或工具直开账号可能为空 */
  email?: string;
  /** QQ 式对外身份短号（6-8 位数字，注册即得、终身不变）；旧账号在 load 时自动补号 */
  agentNumber?: string;
  createdAt: string;
  /** 自导初始化流程是否已标记完成 */
  setupComplete: boolean;
  /** 管理员禁用标记；置位后主对话入口拒绝该用户（管理控制台可开关） */
  disabled?: boolean;
  /** 最近一次活跃（注册/登录/WS session.init）时间；旧数据缺省 */
  lastActiveAt?: string;
};

/** 身份短号格式：6-8 位数字、首位非零（与 generateAgentNumber 的取值域一致）。 */
export const AGENT_NUMBER_PATTERN = /^[1-9]\d{5,7}$/;

type PersistedAccountRow = AgentAccountRecord & { sessionId?: string };

/**
 * 每个登录主体（userId / 旧版 sessionId）至多一个 Agent 账号；持久化 JSON（默认 `data/agent-accounts.json`）。
 */
export class AgentAccountService {
  private readonly byActorId = new Map<string, AgentAccountRecord>();
  /** 身份短号唯一性索引：短号 → actorId（load/register 时同步维护） */
  private readonly byAgentNumber = new Map<string, string>();

  private get persistPath(): string {
    return process.env.AGENT_ACCOUNTS_FILE ?? join(process.cwd(), "data", "agent-accounts.json");
  }

  /**
   * 生成一个未被占用的身份短号（6-8 位数字、首位非零）。
   * 取值域 9000 万，随机 64 次仍撞号则线性探测兜底。
   */
  private generateAgentNumber(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const n = String(randomInt(100_000, 100_000_000));
      if (!this.byAgentNumber.has(n)) return n;
    }
    let n = 100_000;
    while (this.byAgentNumber.has(String(n))) n++;
    return String(n);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as { accounts?: PersistedAccountRow[] };
      const list = data.accounts ?? [];
      this.byActorId.clear();
      this.byAgentNumber.clear();
      // 短号唯一性两遍扫描（QQ 式身份号码 2026-09-30）：
      // 第一遍认领全部已存有效短号（先到先得，存过的号永不被新号抢占）；
      // 第二遍给缺号 / 撞号 / 格式非法的账号补生成——保证全库唯一。
      const needsNumber: AgentAccountRecord[] = [];
      for (const a of list) {
        if (!a?.accountId) continue;
        const actorId = String(a.userId ?? a.sessionId ?? "").trim();
        if (!actorId) continue;
        const record: AgentAccountRecord = {
          accountId: a.accountId,
          userId: actorId,
          displayName: String(a.displayName ?? "").trim() || "Agent",
          ...(a.email ? { email: a.email } : {}),
          createdAt: a.createdAt ?? new Date().toISOString(),
          setupComplete: Boolean(a.setupComplete),
          ...(a.disabled ? { disabled: true } : {}),
          ...(a.lastActiveAt ? { lastActiveAt: a.lastActiveAt } : {}),
        };
        const stored = String(a.agentNumber ?? "").trim();
        if (stored && AGENT_NUMBER_PATTERN.test(stored) && !this.byAgentNumber.has(stored)) {
          record.agentNumber = stored;
          this.byAgentNumber.set(stored, actorId);
        } else {
          needsNumber.push(record);
        }
        this.byActorId.set(actorId, record);
      }
      let migrated = false;
      for (const record of needsNumber) {
        record.agentNumber = this.generateAgentNumber();
        this.byAgentNumber.set(record.agentNumber, record.userId);
        migrated = true;
      }
      if (migrated) await this.persist();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  /**
   * 落盘串行队列。
   *
   * persist 的语义是「全量快照 + 整文件覆盖」，并发调用时若各写各的，
   * Windows 上同一路径的并发 open 会间歇性 EPERM（文件正被上一次写入
   * 或杀毒扫描占用）——批量/并发注册 200 路时必现。
   * 这里把写入排成一条链：快照推迟到真正落盘那一刻才取，
   * 因此后写者必然带上前写者的改动，既串行又不重复写。
   */
  private persistQueue: Promise<void> = Promise.resolve();

  async persist(): Promise<void> {
    const next = this.persistQueue.then(() => this.writePersistedSnapshot());
    // 单次落盘失败不污染队列，后续写入照常排队
    this.persistQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async writePersistedSnapshot(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const accounts = Array.from(this.byActorId.values()).map((a) => ({
      ...a,
      sessionId: a.userId,
    }));
    await writeFile(this.persistPath, JSON.stringify({ accounts }, null, 2), "utf8");
  }

  getByActorId(actorId: string): AgentAccountRecord | undefined {
    return this.byActorId.get(actorId.trim());
  }

  /** 按身份短号查账号（不存在或格式不符返回 undefined）。 */
  getByAgentNumber(agentNumber: string): AgentAccountRecord | undefined {
    const t = agentNumber.trim();
    if (!AGENT_NUMBER_PATTERN.test(t)) return undefined;
    const actorId = this.byAgentNumber.get(t);
    return actorId ? this.byActorId.get(actorId) : undefined;
  }

  /** 全部账号（管理统计用）。 */
  listAll(): AgentAccountRecord[] {
    return [...this.byActorId.values()];
  }

  /**
   * 好友发现/搜索：displayName / userId / email 大小写不敏感子串匹配；
   * `q` 为空时返回最近注册的账号（浏览模式）。跳过 disabled 账号，
   * 结果按注册时间倒序，默认 20 条、上限 50 条。
   */
  searchAccounts(
    query: { q?: string; limit?: number; excludeActorId?: string } = {}
  ): AgentAccountRecord[] {
    const q = query.q?.trim().toLowerCase() ?? "";
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const exclude = query.excludeActorId?.trim();
    const hits: AgentAccountRecord[] = [];
    for (const a of this.byActorId.values()) {
      if (a.disabled) continue;
      if (exclude && a.userId === exclude) continue;
      if (!q) {
        hits.push(a);
        continue;
      }
      if (
        a.displayName.toLowerCase().includes(q) ||
        a.userId.toLowerCase().includes(q) ||
        (a.email && a.email.toLowerCase().includes(q)) ||
        (a.agentNumber && a.agentNumber.includes(q))
      ) {
        hits.push(a);
      }
    }
    return hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** 按绑定的验证邮箱反查账号（财务入站邮件记账：收件人 → actorId）。 */
  getByEmail(email: string): AgentAccountRecord | undefined {
    const e = email.trim().toLowerCase();
    if (!e) return undefined;
    for (const a of this.byActorId.values()) {
      if (a.email && a.email.toLowerCase() === e) return a;
    }
    return undefined;
  }

  /** @deprecated 使用 {@link getByActorId}（参数为登录主体 id） */
  getBySession(sessionId: string): AgentAccountRecord | undefined {
    return this.getByActorId(sessionId);
  }

  /**
   * 新建账号；若该主体已有账号则抛错。
   * @param email 可选；邮箱流程传入已验证地址，将写入账号。
   */
  async register(actorId: string, displayName: string, email?: string): Promise<AgentAccountRecord> {
    const id = actorId.trim();
    if (!id) throw new Error("登录主体 id 不能为空");
    const name = displayName.trim();
    if (!name) throw new Error("显示名称不能为空");
    if (name.length > 120) throw new Error("显示名称过长");
    if (email !== undefined) {
      const e = email.trim();
      if (!e) throw new Error("邮箱不能为空");
      if (e.length > 254) throw new Error("邮箱过长");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        throw new Error("邮箱格式无效");
      }
    }
    if (this.byActorId.has(id)) {
      throw new Error("该用户已存在 Agent 账号，无需重复注册");
    }
    const record: AgentAccountRecord = {
      accountId: randomUUID(),
      userId: id,
      displayName: name,
      agentNumber: this.generateAgentNumber(),
      ...(email !== undefined ? { email: email.trim() } : {}),
      createdAt: new Date().toISOString(),
      setupComplete: false,
      lastActiveAt: new Date().toISOString(),
    };
    this.byActorId.set(id, record);
    this.byAgentNumber.set(record.agentNumber!, id);
    await this.persist();
    return record;
  }

  async markSetupComplete(actorId: string): Promise<AgentAccountRecord | undefined> {
    const id = actorId.trim();
    const r = this.byActorId.get(id);
    if (!r) return undefined;
    r.setupComplete = true;
    this.byActorId.set(id, r);
    await this.persist();
    return r;
  }

  /** 账号是否被管理员禁用（未注册的主体视为未禁用）。 */
  isDisabled(actorId: string): boolean {
    return Boolean(this.byActorId.get(actorId.trim())?.disabled);
  }

  /**
   * 记录一次活跃（管理后台「最近活跃」指标的数据源）。内存即时生效，
   * 落盘按服务级 60s 节流——WS session.init / 登录都是高频入口，
   * 不节流的话每连一次就全量重写账号 JSON。
   */
  touchLastActive(actorId: string, at: Date = new Date()): void {
    const r = this.byActorId.get(actorId.trim());
    if (!r) return;
    r.lastActiveAt = at.toISOString();
    const now = Date.now();
    if (now - this.lastActivePersistAt < 60_000) return;
    this.lastActivePersistAt = now;
    void this.persist().catch(() => {});
  }
  private lastActivePersistAt = 0;

  /**
   * 管理员禁用/恢复账号。禁用后主对话入口拒绝该用户；账号本身保留，
   * 恢复启用即回到原状态。账号不存在返回 undefined。
   */
  async setDisabled(actorId: string, disabled: boolean): Promise<AgentAccountRecord | undefined> {
    const id = actorId.trim();
    const r = this.byActorId.get(id);
    if (!r) return undefined;
    if (disabled) r.disabled = true;
    else delete r.disabled;
    this.byActorId.set(id, r);
    await this.persist();
    return r;
  }

  /**
   * 更新展示名（已存在账号时）。
   */
  async updateDisplayName(actorId: string, displayName: string): Promise<AgentAccountRecord> {
    const id = actorId.trim();
    const name = displayName.trim();
    if (!id) throw new Error("登录主体 id 不能为空");
    if (!name) throw new Error("显示名称不能为空");
    if (name.length > 120) throw new Error("显示名称过长");
    const r = this.byActorId.get(id);
    if (!r) throw new Error("尚未创建 Agent 账号，请先注册");
    r.displayName = name;
    this.byActorId.set(id, r);
    await this.persist();
    return r;
  }
}
