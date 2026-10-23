import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BetaWhitelistSnapshot = {
  /** 注册闸是否生效：名单非空即设闸；名单文件缺失 = 未配置 = 不设闸 */
  enabled: boolean;
  /** 名单内邮箱（小写归一、去重） */
  emails: string[];
  /** 名单最后更新时间；从未配置过为 null */
  updatedAt: string | null;
  /** 名单文件存在但读取/解析失败（fail-closed：按设闸+空名单处理，后台重新保存即修复） */
  corrupt?: boolean;
};

type PersistedWhitelist = { emails?: unknown; updatedAt?: unknown };

/**
 * 内测注册白名单：邮箱名单落 JSON（默认 `data/beta-whitelist.json`，可用
 * BETA_WHITELIST_FILE 覆盖），每次校验实时读盘 —— 后台改完即生效，无需重启
 * （与 client-manifest 同策略；文件小，读盘成本可忽略）。
 *
 * 语义（注册闸本身在 routes/http/accounts.ts 的 /accounts/register）：
 * - 名单文件缺失或 emails 为空 = 不设闸：本地开发与未配置的部署照常开放注册；
 * - 名单非空 = 收紧：仅名单内邮箱可新建账号，已注册账号重新登录不受影响；
 * - 只约束邮箱形态的注册主体，inst_* / session-* 等机器身份一律豁免；
 * - 名单文件损坏按 fail-closed 处理（视为设闸+空名单）：宁可短暂拒新注册，
 *   也不静默退回无闸裸奔；后台重新添加名单即可修复。
 */
export class BetaWhitelistService {
  private get persistPath(): string {
    return process.env.BETA_WHITELIST_FILE ?? join(getDataDir(), "beta-whitelist.json");
  }

  /** 邮箱归一：白名单与登录身份同一主键语义，统一小写。 */
  static normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  static isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  }

  /** 实时读取名单快照。 */
  async snapshot(): Promise<BetaWhitelistSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.persistPath, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return { enabled: false, emails: [], updatedAt: null };
      console.warn("[beta-whitelist] 名单读取失败，按设闸+空名单处理:", err.message);
      return { enabled: true, emails: [], updatedAt: null, corrupt: true };
    }
    try {
      const data = JSON.parse(raw) as PersistedWhitelist;
      const emails = Array.isArray(data.emails)
        ? [
            ...new Set(
              data.emails
                .map((e) => BetaWhitelistService.normalize(String(e)))
                .filter((e) => e.length > 0),
            ),
          ]
        : [];
      return {
        enabled: emails.length > 0,
        emails,
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      };
    } catch (e) {
      console.warn("[beta-whitelist] 名单文件损坏，按设闸+空名单处理:", e instanceof Error ? e.message : e);
      return { enabled: true, emails: [], updatedAt: null, corrupt: true };
    }
  }

  /** 注册闸判定：未设闸或邮箱在名单内 → 放行。 */
  async allows(email: string): Promise<boolean> {
    const snap = await this.snapshot();
    if (!snap.enabled) return true;
    return snap.emails.includes(BetaWhitelistService.normalize(email));
  }

  /** 加入名单（幂等，格式非法抛错）。返回写后快照。 */
  async add(email: string): Promise<BetaWhitelistSnapshot> {
    const normalized = BetaWhitelistService.normalize(email);
    if (!BetaWhitelistService.isValidEmail(normalized)) throw new Error("邮箱格式无效");
    const snap = await this.snapshot();
    if (!snap.emails.includes(normalized)) snap.emails.push(normalized);
    return this.persist(snap.emails);
  }

  /** 移出名单（幂等）。注意只挡后续新注册，已注册账号的处置走用户禁用。 */
  async remove(email: string): Promise<BetaWhitelistSnapshot> {
    const normalized = BetaWhitelistService.normalize(email);
    const snap = await this.snapshot();
    return this.persist(snap.emails.filter((e) => e !== normalized));
  }

  private async persist(emails: string[]): Promise<BetaWhitelistSnapshot> {
    const unique = [...new Set(emails)];
    const data = { emails: unique, updatedAt: new Date().toISOString() };
    const path = this.persistPath;
    await mkdir(dirname(path), { recursive: true });
    // 临时文件 + 原子改名：避免写一半被并发校验读到残缺（残缺会触发 fail-closed）
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path);
    return { enabled: unique.length > 0, emails: unique, updatedAt: data.updatedAt };
  }
}
