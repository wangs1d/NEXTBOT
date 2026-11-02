import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { createPictureKit, type PictureKit } from "@nextbot/picture";
import { resolveActorId } from "../agent/actor-id.js";
import { sanitizeActorKey } from "../agentic-memory/actor-key.js";
import { retentionMaxEntries, RetentionMap, type RetainedStats } from "./resource-pool.js";
import { PictureTrashService } from "./picture-trash-service.js";

/**
 * 图库按 actor 分区：一个 actor 一个 PictureKit，落在 `pictures/<actorKey>/` 下
 * （index.json、assets/、thumbs/、generated/、trash/、wall-owners.json 全在各自目录内）。
 *
 * 分区在目录层，不在过滤层——跨用户的照片不在同一个索引文件里，读不到就是读不到，
 * 不依赖每个查询都记得加 owner 条件。kit 按需创建、空闲淘汰（索引已随每次变更落盘，
 * 淘汰不丢数据），常驻内存只随「最近有人翻过的相册」增长。
 */

export interface PicturePartition {
  actorId: string;
  dirName: string;
  kit: PictureKit;
  trash: PictureTrashService;
}

type KitDeps = {
  rootDir: string;
  batchOutputDir: string;
  generation?: { apiKey?: string; baseUrl?: string; model?: string };
};

/** 同 actor 的并发请求共用一次装配，避免两个 kit 各自持有同一份索引互相覆盖。 */
export class PictureKitRegistry {
  private readonly partitions: RetentionMap<PicturePartition>;
  private readonly inflight = new Map<string, Promise<PicturePartition>>();

  constructor(
    private readonly deps: KitDeps,
    opts: { maxKits?: number; idleMs?: number } = {},
  ) {
    mkdirSync(this.deps.rootDir, { recursive: true });
    this.partitions = new RetentionMap<PicturePartition>("picture-kits", {
      maxEntries: retentionMaxEntries(opts.maxKits ?? 32),
      idleMs: opts.idleMs ?? 10 * 60_000,
    });
  }

  /** 该 actor 的分区目录名（文件系统净化后的 actor 键）。 */
  static dirNameFor(actorId: string): string {
    return sanitizeActorKey(actorId) || "anonymous";
  }

  async forActor(actorId: string): Promise<PicturePartition> {
    const dirName = PictureKitRegistry.dirNameFor(actorId);
    const cached = this.partitions.get(dirName);
    if (cached) return cached;

    const pending = this.inflight.get(dirName);
    if (pending) return pending;

    const creating = this.create(String(actorId ?? "").trim() || "anonymous", dirName);
    this.inflight.set(dirName, creating);
    try {
      const partition = await creating;
      this.partitions.set(dirName, partition);
      return partition;
    } finally {
      this.inflight.delete(dirName);
    }
  }

  /** HTTP 请求归属：query 优先、body 兜底；皆空归 anonymous 桶，绝不回落到共享根。 */
  forRequest(request: { query: unknown; body: unknown }): Promise<PicturePartition> {
    const q = (request.query ?? {}) as { userId?: string; sessionId?: string };
    const b = (request.body ?? {}) as { userId?: string; sessionId?: string };
    return this.forActor(
      resolveActorId({
        userId: q.userId ?? b.userId,
        sessionId: (q.sessionId ?? b.sessionId) ?? "",
      }),
    );
  }

  /** 工具/skill 执行上下文的归属 actor（与 ToolRegistry 的 resolveActorId 同规则）。 */
  forContext(context: { userId?: string | undefined; sessionId: string }): Promise<PicturePartition> {
    return this.forActor(resolveActorId(context));
  }

  /** 已装配的分区（回收/诊断用），不触发加载。 */
  loadedPartitions(): PicturePartition[] {
    return [...this.partitions.entries()].map(([, p]) => p);
  }

  retentionStats(): RetainedStats {
    return this.partitions.stats();
  }

  /** 磁盘上已存在的分区目录名（存量认领与全量扫描用）。 */
  async listActorDirs(): Promise<string[]> {
    try {
      return readdirSync(this.deps.rootDir).filter((name) => {
        try {
          return statSync(join(this.deps.rootDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  private async create(actorId: string, dirName: string): Promise<PicturePartition> {
    const rootDir = join(this.deps.rootDir, dirName);
    const kit = await createPictureKit({
      rootDir,
      batchOutputDir: join(this.deps.batchOutputDir, dirName),
      generation: this.deps.generation,
    });
    return {
      actorId,
      dirName,
      kit,
      trash: new PictureTrashService(`${rootDir}/trash`, kit, actorId),
    };
  }
}
