// 树枝游标（L2 增量去重）——「闸」的第二段：已上报过的内容不再上报。
//
// 与 MessageHub 的 external_message_id 判重分工：那是入库层（同一条消息不重复
// 落库）；树枝游标是**上报层**——同一内容换了 messageId/重新上传/重扫，只要
// 指纹命中就不再进管道。upload 树枝重传同一份课表、file-watcher 重扫同目录
// 都靠这一层收敛。
//
// 持久化：data/proactivity/branch-cursors.json（写穿，重启不丢）。
// 治理：每树枝指纹上限 + 7 天 TTL（旧指纹过期后理论上可重新上报——对课表
// 这类长期事实无害，因为权威层按内容判重，不按指纹）。
import { createHash } from "node:crypto";

import { readJson, writeJson } from "../persist-file.js";

export type BranchCursorDeps = {
  persistPath: string;
  /** 指纹保留时长（缺省 7 天） */
  ttlMs?: number;
  /** 单树枝指纹上限（缺省 5000，超出丢最旧） */
  capPerBranch?: number;
  nowFn?: () => number;
};

type PersistedCursors = Record<string, Record<string, number>>;

export class BranchCursor {
  private readonly seen = new Map<string, Map<string, number>>();
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly nowFn: () => number;

  constructor(private readonly deps: BranchCursorDeps) {
    this.ttlMs = deps.ttlMs ?? 7 * 24 * 3600_000;
    this.cap = deps.capPerBranch ?? 5000;
    this.nowFn = deps.nowFn ?? Date.now;
    const raw = readJson<PersistedCursors>(deps.persistPath, {});
    for (const [branch, entries] of Object.entries(raw)) {
      this.seen.set(branch, new Map(Object.entries(entries)));
    }
  }

  /** 稳定指纹：树枝内内容级判重的唯一依据（调用方给什么就认什么） */
  static fingerprint(parts: Array<string | number | undefined>): string {
    return createHash("sha1").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 16);
  }

  flush(): void {
    const out: PersistedCursors = {};
    for (const [branch, entries] of this.seen) {
      out[branch] = Object.fromEntries(entries);
    }
    writeJson(this.deps.persistPath, out);
  }

  /** 是否已上报过（不落新指纹）。过期指纹顺手清理。 */
  has(branchId: string, fingerprint: string): boolean {
    const now = this.nowFn();
    const entries = this.seen.get(branchId);
    if (!entries) return false;
    const at = entries.get(fingerprint);
    if (at === undefined) return false;
    if (now - at > this.ttlMs) {
      entries.delete(fingerprint);
      return false;
    }
    return true;
  }

  /** 查询并落指纹（原子上报闸用）：返回 false = 首次，已记下；true = 重复 */
  checkAndMark(branchId: string, fingerprint: string): boolean {
    if (this.has(branchId, fingerprint)) return true;
    let entries = this.seen.get(branchId);
    if (!entries) {
      entries = new Map();
      this.seen.set(branchId, entries);
    }
    entries.set(fingerprint, this.nowFn());
    while (entries.size > this.cap) {
      const oldest = [...entries.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) break;
      entries.delete(oldest[0]);
    }
    this.flush();
    return false;
  }
}
