/**
 * 按用户加密落盘的凭据仓（AES-256-GCM）。
 *
 * 用途：云端要在客户端离线时替用户干活（主动轮次、邮箱盯梢），凭据必须比连接活得久；
 * 但明文落盘等于把用户的第三方账号密码摊在数据根里。所以一份用户一个密文文件。
 *
 * 口径：
 * - 主密钥来自 env 回退链（每个仓自己声明键名顺序），未配置时**拒绝写盘**——
 *   宁可退回"重启后要重新上送"，也不写一把能用源码常量解开的密文
 * - 密文写 `<数据根>/<dirName>/<净化 id>.enc`，目录 0700、文件 0600
 * - 派生盐按仓独立：轮换一个域的密钥不会连坐另一个域
 * - 没有任何接口回显明文凭据
 *
 * 残余风险：主密钥与密文同机同备份时，泄露数据根≈泄露凭据链，生产应把主密钥放在
 * systemd unit / 外部 secret 里，而不是数据根。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { getDataDir } from "../config/data-dir.js";
import { sanitizeActorKey } from "../agentic-memory/actor-key.js";

/** 回退链里这些值是各项目源码写死的开发常量，不能当生产密钥用 */
const INSECURE_FALLBACKS = new Set([
  "dev-insecure-wellness-key-change-me",
  "dev-insecure-session-key-change-me",
  "change-me",
]);

export interface LoadedRecords<T> {
  entries: T[];
  /** 解不开的份数（多半是主密钥轮换过）：只计数，不外传内容 */
  undecryptable: number;
}

export interface EncryptedRecordStore<T> {
  /** 主密钥是否可用（不可用时仓不写不读，凭据退回纯内存） */
  enabled(): boolean;
  /** 保存一份；主密钥缺失或 id 为空返回 false（调用方继续按内存走） */
  save(id: string, record: T): boolean;
  /** 该 id 是否有落盘密文（有而读不出 = 主密钥轮换/密文损坏，不得回落平台凭据） */
  exists(id: string): boolean;
  /** 取回一份；解不开返回 null */
  load(id: string): T | null;
  remove(id: string): void;
  loadAll(): LoadedRecords<T>;
  count(): number;
}

export interface EncryptedRecordStoreOptions<T> {
  /** 数据根下的子目录名 */
  dirName: string;
  /** 派生盐（每仓独立，轮换域隔离） */
  deriveSalt: string;
  /** 主密钥 env 键名，按序取第一个非空且非开发常量的值 */
  secretEnvNames: ReadonlyArray<string>;
  /** 结构校验：字段不全的密文按「解不开」计数 */
  validate: (parsed: unknown) => parsed is T;
  /** 主密钥来源（默认 process.env，按引用读，运行中改 env 生效） */
  env?: NodeJS.ProcessEnv;
}

export function createEncryptedRecordStore<T>(
  opts: EncryptedRecordStoreOptions<T>,
): EncryptedRecordStore<T> {
  const env = opts.env ?? process.env;

  function secret(): string | null {
    for (const name of opts.secretEnvNames) {
      const v = env[name]?.trim();
      if (v && !INSECURE_FALLBACKS.has(v)) return v;
    }
    return null;
  }

  function deriveKey(master: string): Buffer {
    return scryptSync(master, opts.deriveSalt, 32);
  }

  function dir(create = false): string | null {
    if (!secret()) return null;
    const d = join(getDataDir(), opts.dirName);
    if (create && !existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  function filePath(id: string, create = false): string | null {
    const d = dir(create);
    if (!d) return null;
    return join(d, `${sanitizeActorKey(id)}.enc`);
  }

  function readOne(id: string): T | null {
    const key = String(id ?? "").trim();
    const master = secret();
    const file = key ? filePath(key) : null;
    if (!file || !master || !existsSync(file)) return null;
    try {
      const buf = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
      if (buf.length < 28) throw new Error("载荷过短");
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(master), buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
      const parsed = JSON.parse(plain) as unknown;
      return opts.validate(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return {
    enabled: () => secret() !== null,

    save(id, record) {
      const key = String(id ?? "").trim();
      const master = secret();
      const file = key ? filePath(key, true) : null;
      if (!file || !master) return false;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", deriveKey(master), iv);
      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(record), "utf8")),
        cipher.final(),
      ]);
      writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"), {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        chmodSync(file, 0o600); // 文件已存在时 mode 选项不生效
      } catch {
        /* 权限设置失败不影响密文已落盘 */
      }
      return true;
    },

    exists(id) {
      const key = String(id ?? "").trim();
      const file = key ? filePath(key) : null;
      return Boolean(file && existsSync(file));
    },

    load(id) {
      return readOne(id);
    },

    remove(id) {
      const key = String(id ?? "").trim();
      const file = key ? filePath(key) : null;
      if (file && existsSync(file)) rmSync(file, { force: true });
    },

    loadAll() {
      const d = dir();
      const master = secret();
      if (!d || !master || !existsSync(d)) return { entries: [], undecryptable: 0 };
      const entries: T[] = [];
      let undecryptable = 0;
      for (const name of readdirSync(d).filter((n) => n.endsWith(".enc"))) {
        const parsed = this.load(name.replace(/\.enc$/, ""));
        if (parsed) entries.push(parsed);
        else undecryptable++;
      }
      return { entries, undecryptable };
    },

    count() {
      const d = dir();
      if (!d || !existsSync(d)) return 0;
      return readdirSync(d).filter((n) => n.endsWith(".enc")).length;
    },
  };
}
