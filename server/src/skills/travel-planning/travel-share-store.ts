/**
 * 行程分享码存储（单例，JSON 单文件）
 *
 * 职责：行程面板「分享」按钮生成的 8 位分享码 → planId 映射，持久化到
 * data/travel-share-codes.json；持有分享码的任何人可经
 * GET /travel/share/:code 读取完整行程（只读视图）。
 *
 * 规则：同一 planId 重复分享复用已有码（一个行程一个码）；码字符表去掉
 * 易混淆的 0/O/1/I/L，随机源用 crypto（非业务计价，允许随机）。
 *
 * 存储风格与 travel-plan-store.ts 一致：单文件同步读写（分享是低频事件），
 * 测试可用 TRAVEL_SHARE_STORE_FILE 覆盖文件路径。
 */
import { getDataDir } from "../../config/data-dir.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 码字符表：去掉易混淆的 0/O/1/I/L（32 个字符，5 bit/字符） */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

class TravelShareStore {
  /** 映射文件路径（测试可覆盖） */
  private file: string;
  /** shareCode → planId（进程内缓存，磁盘为权威源） */
  private map = new Map<string, string>();

  constructor() {
    this.file = path.resolve(
      process.env.TRAVEL_SHARE_STORE_FILE ||
        path.join(getDataDir(), "travel-share-codes.json"),
    );
    this.load();
  }

  /** 取 planId 的分享码：已有则复用，否则生成新码并落盘 */
  codeFor(planId: string): string {
    for (const [code, pid] of this.map) {
      if (pid === planId) return code;
    }
    let code = this.generate();
    while (this.map.has(code)) code = this.generate();
    this.map.set(code, planId);
    this.persist();
    return code;
  }

  /** 按分享码取 planId（大小写不敏感，未命中返回 null） */
  resolve(code: string): string | null {
    const key = code.trim().toUpperCase();
    return this.map.get(key) ?? null;
  }

  /** 行程删除时清理其分享码映射（无映射则静默） */
  removeForPlan(planId: string): void {
    let touched = false;
    for (const [code, pid] of this.map) {
      if (pid === planId) {
        this.map.delete(code);
        touched = true;
      }
    }
    if (touched) this.persist();
  }

  /** 生成 8 位分享码（crypto 随机源） */
  private generate(): string {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    return out;
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, string>;
      for (const [code, planId] of Object.entries(raw)) {
        if (typeof code === "string" && typeof planId === "string") {
          this.map.set(code.toUpperCase(), planId);
        }
      }
    } catch {
      // 文件不存在/损坏 → 空表（下次写入重建）
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8");
    } catch (err) {
      console.error("[TravelShareStore] persist failed:", err);
    }
  }
}

export const travelShareStore = new TravelShareStore();
