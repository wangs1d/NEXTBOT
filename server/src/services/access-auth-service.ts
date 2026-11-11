/**
 * 设备自绑定鉴权服务（AccessAuthService）—— /api/* 周界鉴权的「身份发放」层。
 *
 * 与 DevicePairingService 的关系：
 *  - DevicePairingService：解决「设备归属」（deviceId ↔ ownerUserId，业务层绑定关系）
 *  - AccessAuthService：解决「请求鉴权」（token ↔ userId，周界准入凭证）
 *
 * 绑定流程（用户驱动，opt-in：仅 ACCESS_AUTH_REQUIRED=1 时强制）：
 *  1. 已绑定设备（或 bootstrap 首台设备）带凭证调 POST /api/auth/pairing-code
 *     → 服务端生成 6 位绑定码（10 分钟有效，一次性）
 *  2. 新设备调 POST /api/auth/bind { code, deviceId, deviceLabel }
 *     → 校验绑定码 → 签发 64 hex 明文 token（仅落 sha256 哈希，绝不存明文）
 *  3. 后续请求带 Authorization: Bearer <token> 或 ?token=<token> 即可通过周界
 *
 * 设计要点：
 *  - token 明文只在 bind 响应里出现一次；持久化仅存 sha256(tokenHash)
 *  - 绑定码内存态（进程重启清空，重新生成即可），同码一次性使用
 *  - verifyToken 更新 lastSeenAt 做防抖落盘（60s 内只标脏一次）
 *  - bootstrap：token 库为空且鉴权开启时，允许免鉴权签发首台设备的绑定码，
 *    并在启动时向控制台打印一枚引导码（wire 在 create-app-services 装配层）
 */
import { getDataDir } from "../config/data-dir.js";
import { accessTokenRefreshGraceMs, accessTokenTtlMs } from "../config/env.js";
import { createHash, randomBytes } from "node:crypto";
import { join } from "path";

import { writeJsonAtomic } from "../storage/atomic-json.js";

/** 单条设备 token 的持久化记录（只有哈希，绝无明文）。 */
export interface AccessTokenRecord {
  tokenId: string;
  /** sha256(明文 token) 的 hex；明文只在签发响应中出现一次 */
  tokenHash: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * 过期时刻（毫秒）。0 / 缺失 = 永不过期（旧文件兼容 + TTL 关闭时）。
   * 过期后 verifyToken 判无效，但仍在宽限期内可 refresh 换新。
   */
  expiresAt: number;
}

interface AccessTokenFileShape {
  version: 1;
  tokens: AccessTokenRecord[];
}

interface PendingBindingCode {
  userId: string;
  code: string;
  expiresAt: number;
  used: boolean;
}

/** 绑定码 TTL：10 分钟（与 DevicePairingService 配对码一致） */
const BINDING_CODE_TTL_MS = 10 * 60 * 1000;
/** 绑定码字母表（剔除易混淆字符 0/O/I/1/L，与 DevicePairingService 一致） */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** 明文 token 长度：32 字节随机 → 64 hex 字符（规格要求 48+ hex） */
const TOKEN_BYTES = 32;
/** lastSeenAt 防抖落盘窗口 */
const LAST_SEEN_FLUSH_DEBOUNCE_MS = 60 * 1000;

export class AccessAuthService {
  private readonly tokens = new Map<string, AccessTokenRecord>();
  /** tokenId 索引：tokenHash → tokenId（verify 查找用） */
  private readonly hashIndex = new Map<string, string>();
  private readonly pendingCodes = new Map<string, PendingBindingCode>();
  private lastSeenDirty = false;
  private lastSeenFlushTimer: NodeJS.Timeout | null = null;

  /**
   * 设备凭据被吊销时的回调（换号登录 / 重复登录 / 主动登出）。
   *
   * 吊销只删凭据表记录，**不会**自动影响已经建立的 WS：那条连接仍以旧
   * actorId 注册着，会继续读写上一个账号的数据直到心跳超时。装配层把这个
   * 回调接到 `WsConnectionRegistry.closeByDevice`，按设备精确踢掉旧连接。
   */
  onDeviceRevoked?: (deviceId: string, userId: string) => void;

  private get persistPath(): string {
    return process.env.ACCESS_TOKENS_FILE ?? join(getDataDir(), "access-tokens.json");
  }

  /** 启动时从 data/access-tokens.json 恢复（文件缺失 = 尚无绑定设备，进入 bootstrap）。 */
  async load(): Promise<void> {
    const path = this.persistPath;
    if (!path) return;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(path, "utf8");
      const data = JSON.parse(raw) as AccessTokenFileShape;
      this.tokens.clear();
      this.hashIndex.clear();
      for (const rec of data.tokens ?? []) {
        if (!rec.tokenId || !rec.tokenHash || !rec.userId) continue;
        this.tokens.set(rec.tokenId, rec);
        this.hashIndex.set(rec.tokenHash, rec.tokenId);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  /** 是否已有任何绑定设备（false = bootstrap 模式：允许免鉴权签发首个绑定码）。 */
  hasAnyTokens(): boolean {
    return this.tokens.size > 0;
  }

  // ------------------------------------------------------------------ //
  // 绑定码（内存态，一次性）
  // ------------------------------------------------------------------ //

  /**
   * 为指定用户签发绑定码（TTL 10 分钟，一次性；同一用户同时只保留一个有效码）。
   * 鉴权把关在 HTTP 路由层（bootstrap 免鉴权 / 已绑定须 Bearer token），服务层不重复校验。
   */
  issueBindingCode(userId: string): string {
    if (!userId?.trim()) throw new Error("userId 不能为空");
    this.cleanupExpiredCodes();
    // 同一用户同时只能有一个有效码（避免混乱）；先清理旧的
    for (const [code, pending] of this.pendingCodes) {
      if (pending.userId === userId) this.pendingCodes.delete(code);
    }
    const code = generateBindingCode();
    this.pendingCodes.set(code, {
      userId: userId.trim(),
      code,
      expiresAt: Date.now() + BINDING_CODE_TTL_MS,
      used: false,
    });
    return code;
  }

  /**
   * 消费绑定码：校验（存在 / 未过期 / 未使用）→ 签发设备 token。
   * 成功后码立即作废（一次性）。失败抛错（消息面向用户展示）。
   */
  async consumeBindingCode(
    code: string,
    deviceId: string,
    deviceLabel?: string,
  ): Promise<{ token: string; userId: string; record: AccessTokenRecord }> {
    const normalized = code.trim().toUpperCase();
    if (!deviceId?.trim()) throw new Error("deviceId 不能为空");
    this.cleanupExpiredCodes();
    const pending = this.pendingCodes.get(normalized);
    if (!pending || pending.used) {
      throw new Error("绑定码不存在或已使用");
    }
    if (pending.expiresAt <= Date.now()) {
      this.pendingCodes.delete(normalized);
      throw new Error("绑定码已过期（10 分钟有效），请重新生成");
    }
    pending.used = true;
    this.pendingCodes.delete(normalized);
    const token = generateToken();
    const ttlMs = accessTokenTtlMs();
    const record: AccessTokenRecord = {
      tokenId: `at_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      tokenHash: sha256Hex(token),
      userId: pending.userId,
      deviceId: deviceId.trim(),
      deviceLabel: (deviceLabel ?? "").trim() || deviceId.trim(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    };
    this.tokens.set(record.tokenId, record);
    this.hashIndex.set(record.tokenHash, record.tokenId);
    await this.persist();
    return { token, userId: record.userId, record };
  }

  /**
   * 为已认证账号直接签发设备 token —— 账号登录/注册成功后调用。
   *
   * 与 [consumeBindingCode] 的区别：不需要 6 位绑定码。邮箱验证码本身
   * 已经证明「这个邮箱是我的」，再叠一层配对码只是历史包袱（配对码是给
   * 「另一台设备接管已有账号」用的，不是登录的必经环节）。
   *
   * 主流做法是认证即发证：登录成功拿到 token，连接与 HTTP 全部以 token
   * 归属为身份权威，客户端不再自报 userId（见 connection.ts 身份钉死）。
   *
   * 同一 deviceId 重复登录：撤销该设备的旧 token 再签发新的，避免每次
   * 登录都往 access-tokens.json 里堆记录（一台手机一天几十条）。
   */
  async issueDeviceToken(
    userId: string,
    deviceId: string,
    deviceLabel?: string,
  ): Promise<{
    token: string;
    tokenId: string;
    userId: string;
    deviceId: string;
    expiresAt: number;
  }> {
    const actor = userId?.trim();
    const device = deviceId?.trim();
    if (!actor) throw new Error("userId 不能为空");
    if (!device) throw new Error("deviceId 不能为空");
    // 撤销同设备旧 token：一台设备只保留最新一枚有效凭据。
    // 不按 userId 过滤——同设备换账号登录时，上一个账号的凭据也必须失效，
    // 否则旧 token 仍能通过校验、把连接绑到已经登出的账号上。
    const revokedUsers: string[] = [];
    for (const [tokenId, rec] of this.tokens) {
      if (rec.deviceId !== device) continue;
      this.hashIndex.delete(rec.tokenHash);
      this.tokens.delete(tokenId);
      revokedUsers.push(rec.userId);
    }
    const token = generateToken();
    const ttlMs = accessTokenTtlMs();
    const record: AccessTokenRecord = {
      tokenId: `at_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      tokenHash: sha256Hex(token),
      userId: actor,
      deviceId: device,
      deviceLabel: (deviceLabel ?? "").trim() || device,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    };
    this.tokens.set(record.tokenId, record);
    this.hashIndex.set(record.tokenHash, record.tokenId);
    await this.persist();
    // 旧凭据已废：踢掉该设备上仍以旧身份活着的连接（换号时尤其重要）。
    if (revokedUsers.length > 0) {
      try {
        this.onDeviceRevoked?.(device, revokedUsers[revokedUsers.length - 1] ?? actor);
      } catch {
        /* 踢连接失败不影响发证 */
      }
    }
    return {
      token,
      tokenId: record.tokenId,
      userId: actor,
      deviceId: device,
      expiresAt: record.expiresAt,
    };
  }

  // ------------------------------------------------------------------ //
  // 校验 / 管理
  // ------------------------------------------------------------------ //

  /**
   * 校验明文 token：命中且未过期 → { userId, tokenId } 并（防抖）刷新 lastSeenAt；
   * 未命中或已过期 → null。
   */
  verifyToken(token: string): { userId: string; tokenId: string; expiresAt: number } | null {
    // 注意：**不删除**过期记录。宽限期内的 refresh 还要靠这条记录认出
    // 「是哪台设备」，删了就变成「过期即必须重登」。真正的清理在启动时
    // cleanupExpiredTokens() 里做（只清超过宽限期的）。
    const state = this.inspectToken(token, { allowExpired: true });
    if (state.status !== "ok") return null;
    return { userId: state.userId, tokenId: state.tokenId, expiresAt: state.expiresAt };
  }

  /**
   * 清理「过期已超过宽限期」的记录（启动时调用）。
   *
   * 只清这批：留在宽限期内的要能续期，清早了用户就得重登。返回清理条数，
   * 供启动日志确认 token 库规模。
   */
  cleanupExpiredTokens(): number {
    const graceMs = accessTokenRefreshGraceMs();
    const now = Date.now();
    let removed = 0;
    for (const [tokenId, rec] of this.tokens) {
      const expiresAt = rec.expiresAt ?? 0;
      if (expiresAt <= 0) continue;
      if (now - expiresAt <= graceMs) continue;
      this.hashIndex.delete(rec.tokenHash);
      this.tokens.delete(tokenId);
      removed += 1;
    }
    if (removed > 0) void this.persist();
    return removed;
  }

  /**
   * 详细校验结果：区分「不存在」与「已过期」。
   *
   * 分开的意义是错误文案与动作不同——不存在 = 换机登陆/被吊销，只能重新登录；
   * 已过期 = 还能静默续期，客户端应该先 refresh 而不是把用户踢回登录页。
   */
  inspectToken(
    token: string,
    opts: { allowExpired?: boolean } = {},
  ): {
    status: "ok" | "expired" | "not_found";
    userId: string;
    tokenId: string;
    tokenHash: string;
    expiresAt: number;
    deviceId: string;
    deviceLabel: string;
  } {
    const empty = {
      userId: "",
      tokenId: "",
      tokenHash: "",
      expiresAt: 0,
      deviceId: "",
      deviceLabel: "",
    };
    const hash = sha256Hex(token);
    const tokenId = this.hashIndex.get(hash);
    if (!tokenId) return { status: "not_found", ...empty };
    const rec = this.tokens.get(tokenId);
    if (!rec) return { status: "not_found", ...empty };
    const expiresAt = rec.expiresAt ?? 0;
    const base = {
      userId: rec.userId,
      tokenId: rec.tokenId,
      tokenHash: rec.tokenHash,
      expiresAt,
      deviceId: rec.deviceId,
      deviceLabel: rec.deviceLabel,
    };
    if (expiresAt > 0 && Date.now() >= expiresAt) {
      return { status: "expired", ...base };
    }
    rec.lastSeenAt = Date.now();
    this.scheduleLastSeenFlush();
    return { status: "ok", ...base };
  }

  /**
   * 用旧 token 换新 token（滑动续期）。
   *
   * 允许两种输入：仍在有效期内的 token（客户端主动提前续），或过期未超过
   * 宽限期的 token（用户久未打开 App）。超过宽限期才算真的失效，必须重登。
   *
   * 换新时沿用原 deviceId/deviceLabel：`issueDeviceToken` 会顺带吊销同设备
   * 旧 token，所以换完之后旧凭据立即作废，不留可用副本。
   */
  async refreshToken(token: string): Promise<{
    token: string;
    tokenId: string;
    userId: string;
    deviceId: string;
    expiresAt: number;
  } | { error: "NOT_FOUND" | "EXPIRED" }> {
    const state = this.inspectToken(token, { allowExpired: true });
    if (state.status === "not_found") return { error: "NOT_FOUND" };
    if (state.status === "expired") {
      const graceMs = accessTokenRefreshGraceMs();
      // state.expiresAt 已过期：now - expiresAt 超过宽限期就不再认这台设备。
      if (Date.now() - state.expiresAt > graceMs) return { error: "EXPIRED" };
    }
    return this.issueDeviceToken(state.userId, state.deviceId, state.deviceLabel);
  }

  /** 从 Authorization: Bearer 头或 ?token= 提取明文 token（供 hook / WS 复用）。 */
  static extractToken(source: { authorization?: string | undefined; queryToken?: string | undefined }): string | null {
    const auth = source.authorization?.trim() ?? "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      const t = auth.slice(7).trim();
      if (t) return t;
    }
    const q = source.queryToken?.trim() ?? "";
    return q || null;
  }

  /** 吊销 token（只能吊自己的：调用方先校验归属）。返回是否成功。 */
  async revokeToken(tokenId: string, userId?: string): Promise<boolean> {
    const rec = this.tokens.get(tokenId);
    if (!rec) return false;
    if (userId !== undefined && rec.userId !== userId) return false;
    this.tokens.delete(tokenId);
    this.hashIndex.delete(rec.tokenHash);
    await this.persist();
    try {
      this.onDeviceRevoked?.(rec.deviceId, rec.userId);
    } catch {
      /* 踢连接失败不影响吊销结果 */
    }
    return true;
  }

  /** 列出某用户的全部设备 token（不含哈希等敏感字段）。 */
  listTokens(userId: string): Array<
    Pick<
      AccessTokenRecord,
      "tokenId" | "userId" | "deviceId" | "deviceLabel" | "createdAt" | "lastSeenAt" | "expiresAt"
    >
  > {
    return [...this.tokens.values()]
      .filter((t) => t.userId === userId)
      .map(({ tokenId, userId: u, deviceId, deviceLabel, createdAt, lastSeenAt, expiresAt }) => ({
        tokenId,
        userId: u,
        deviceId,
        deviceLabel,
        createdAt,
        lastSeenAt,
        expiresAt: expiresAt ?? 0,
      }));
  }

  // ------------------------------------------------------------------ //
  // 持久化（writeJsonAtomic：崩溃安全；lastSeenAt 防抖）
  // ------------------------------------------------------------------ //

  async persist(): Promise<void> {
    const path = this.persistPath;
    if (!path) return;
    await writeJsonAtomic(path, {
      version: 1,
      tokens: [...this.tokens.values()],
    } satisfies AccessTokenFileShape);
    this.lastSeenDirty = false;
  }

  private scheduleLastSeenFlush(): void {
    this.lastSeenDirty = true;
    if (this.lastSeenFlushTimer) return;
    this.lastSeenFlushTimer = setTimeout(() => {
      this.lastSeenFlushTimer = null;
      if (!this.lastSeenDirty) return;
      this.persist().catch((err) => {
        console.warn("[access-auth] lastSeenAt 落盘失败（忽略）:", err);
      });
    }, LAST_SEEN_FLUSH_DEBOUNCE_MS);
    this.lastSeenFlushTimer.unref?.();
  }

  private cleanupExpiredCodes(): void {
    const now = Date.now();
    for (const [code, pending] of this.pendingCodes) {
      if (pending.expiresAt <= now || pending.used) this.pendingCodes.delete(code);
    }
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

function generateBindingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}
