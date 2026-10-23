/**
 * Adaptive Hierarchical Tool Intelligence System —— Phase-1 Tool-Registry 存储适配层。
 *
 * 三级元数据分级存储：
 *   Level-1 索引  → Qdrant 向量库（按 domain 分 collection 分片）+ Redis 热点缓存
 *   Level-2 能力  → SQLite（resource_capability 表）
 *   Level-3 Schema→ SQLite（resource_schema 表，延迟加载；本层仅提供存取，不预读）
 *   资源主记录    → SQLite（resource_record 表，聚合根只持有 level3_pointer 指针）
 *
 * 服务启动约束（Phase-1 红线）：
 *   initialize() 仅建连接 + 建表（CREATE TABLE IF NOT EXISTS），
 *   绝对不读取任何 Level-3 Schema 数据。Level-3 的延迟加载逻辑由 Phase-7 实现。
 *
 * 复用基础设施：
 *   - QdrantClient 来自 `@qdrant/js-client-rest`（参考 services/qdrant-narrative-store.ts）
 *   - Redis createClient 来自 `redis`（参考 http-rate-limit/redis-rate-limit.ts）
 *   - better-sqlite3 同步 API（项目根 package.json 已声明依赖，替代未部署的 PostgreSQL）
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveDataPath } from "../../../config/data-dir.js";

import { QdrantClient } from "@qdrant/js-client-rest";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { createClient, type RedisClientType } from "redis";

import type {
  Environment,
  Level1IndexMeta,
  Level2CapabilityMeta,
  Level3Schema,
  ResourceRecord,
  ResourceStatus,
} from "./models.js";

// ===== 内部常量 =====

const QDRANT_COLLECTION_PREFIX = "tool_idx_";
const REDIS_L1_KEY_PREFIX = "tool:l1:";
/** resource_id → 所属 domain 列表的反查 key（极小，用于 getLevel1/deleteLevel1 的 Qdrant 回查定位） */
const REDIS_L1_DOMAINS_KEY_PREFIX = "tool:l1:domains:";
const DEFAULT_SQLITE_PATH = "tool-registry.db";
const SCROLL_PAGE_LIMIT = 256;

// ===== SQLite 行类型 =====

type CapabilityRow = {
  resource_id: string;
  input_type: string;
  output_type: string;
  use_cases: string;
  limitations: string;
  preconditions: string;
  dependencies: string;
};

type SchemaRow = {
  resource_id: string;
  schema_type: string;
  schema_json: string;
  updated_at: string;
};

type ResourceRecordRow = {
  resource_id: string;
  level1_json: string;
  level3_pointer: string;
  versions_json: string;
  environment: string;
  tenant_id: string;
  auth_level: string;
  created_at: string;
  updated_at: string;
};

type RouteIndexRow = {
  resource_id: string;
};

export type GraphEdgeRow = {
  source_resource_id: string;
  relation_type: string;
  target_resource_id: string;
  weight: number;
  updated_at: string;
};

export type ToolRegistryStoreOptions = {
  qdrantUrl?: string;
  qdrantApiKey?: string;
  redisUrl?: string;
  sqlitePath?: string;
  /** 强制纯内存模式：跳过 SQLite/Qdrant/Redis 连接，全部落在内存 Map。 */
  memoryOnly?: boolean;
};

/**
 * Tool-Registry 分级存储适配层。
 *
 * 所有方法均加 try/catch + console.warn 日志，禁止静默失败；
 * 但具体业务错误仍向上抛出，由 RegistryService 翻译为 RegisterResult。
 */
export class ToolRegistryStore {
  private readonly qdrantUrl: string | undefined;
  private readonly qdrantApiKey: string | undefined;
  private readonly redisUrl: string | undefined;
  private readonly sqlitePath: string;

  private qdrant: QdrantClient | null = null;
  private redis: RedisClientType | null = null;
  private sqlite: SqliteDatabase | null = null;
  private memoryMode = false;
  private readonly memoryLevel1 = new Map<string, Level1IndexMeta>();
  private readonly memoryLevel2 = new Map<string, Level2CapabilityMeta>();
  private readonly memoryLevel3 = new Map<string, Level3Schema>();
  private readonly memoryRecords = new Map<string, ResourceRecord>();
  private readonly memoryGraphEdges = new Map<string, GraphEdgeRow>();

  /** 每个 domain collection 的 ensureCollection Promise 缓存（参考 qdrant-narrative-store.ts） */
  private readonly collectionReady = new Map<string, Promise<void>>();

  constructor(opts?: ToolRegistryStoreOptions) {
    this.qdrantUrl =
      (opts?.qdrantUrl ?? process.env.AGENT_QDRANT_URL?.trim()) || undefined;
    this.qdrantApiKey =
      (opts?.qdrantApiKey ?? process.env.AGENT_QDRANT_API_KEY?.trim()) || undefined;
    this.redisUrl = (opts?.redisUrl ?? process.env.AGENT_REDIS_URL?.trim()) || undefined;
    this.sqlitePath =
      opts?.sqlitePath ??
      process.env.AGENT_TOOL_REGISTRY_DB_PATH?.trim() ??
      DEFAULT_SQLITE_PATH;
    if (opts?.memoryOnly === true) this.memoryMode = true;
  }

  // ===== 生命周期 =====

  /**
   * 启动时调用：仅初始化连接（Qdrant / Redis / SQLite）+ 建表。
   * 绝对不读取任何 Level-3 Schema 数据。
   */
  async initialize(): Promise<void> {
    // memoryOnly：跳过所有外部连接，纯内存模式
    if (this.memoryMode) return;

    // 1. SQLite（同步 API，先建表）
    try {
      const absPath = resolveDataPath(this.sqlitePath);
      const dir = dirname(absPath);
      mkdirSync(dir, { recursive: true });
      this.sqlite = new Database(absPath);
      this.sqlite.pragma("journal_mode = WAL");
      this.sqlite.pragma("foreign_keys = ON");
      this.createTables();
    } catch (e) {
      console.warn("[tool-registry] sqlite initialize failed", e);
      if (process.env.AGENT_TOOL_REGISTRY_STRICT_SQLITE === "1") {
        throw e;
      }
      console.warn("[tool-registry] falling back to in-memory registry store");
      this.sqlite = null;
      this.memoryMode = true;
    }

    // 2. Qdrant（仅创建客户端句柄；collection 按需在 upsertLevel1 时 ensure）
    try {
      if (this.qdrantUrl) {
        this.qdrant = new QdrantClient({
          url: this.qdrantUrl,
          apiKey: this.qdrantApiKey || undefined,
        });
      }
    } catch (e) {
      console.warn("[tool-registry] qdrant client init failed", e);
      this.qdrant = null;
    }

    // 3. Redis（需要 await connect）
    try {
      if (this.redisUrl) {
        const client = createClient({ url: this.redisUrl });
        client.on("error", (err) => {
          console.warn("[tool-registry] redis client error", err);
        });
        await client.connect();
        this.redis = client as RedisClientType;
      }
    } catch (e) {
      console.warn("[tool-registry] redis connect failed", e);
      this.redis = null;
    }
  }

  /** 注销：关闭所有连接。 */
  async close(): Promise<void> {
    try {
      if (this.redis && this.redis.isOpen) {
        await this.redis.quit();
      }
    } catch (e) {
      console.warn("[tool-registry] redis close failed", e);
    }
    try {
      if (this.sqlite) {
        this.sqlite.close();
      }
    } catch (e) {
      console.warn("[tool-registry] sqlite close failed", e);
    }
    this.redis = null;
    this.sqlite = null;
    this.qdrant = null;
    this.collectionReady.clear();
  }

  // ===== Level-1 索引（Qdrant + Redis 热点）=====

  /**
   * 写入 Level-1 索引：
   *   - Qdrant：每个 domain 一个 collection（分片），collection 名 = "tool_idx_" + domain
   *   - Redis：常驻热点，key = "tool:l1:" + resource_id，存 Level1IndexMeta JSON
   *   - 同时写一份极小的 domain 反查 key，供 getLevel1/deleteLevel1 定位 collection
   */
  async upsertLevel1(meta: Level1IndexMeta): Promise<void> {
    this.memoryLevel1.set(meta.resource_id, meta);
    const payload = meta as unknown as Record<string, unknown>;
    const domains = meta.domain.length > 0 ? meta.domain : ["_default"];

    // Qdrant：写入每个 domain collection（多归属资源会在多个 collection 中冗余一份）
    if (this.qdrant) {
      for (const rawDomain of domains) {
        const collectionName = this.collectionName(rawDomain);
        try {
          await this.ensureCollection(collectionName, meta.embedding.length);
          await this.qdrant.upsert(collectionName, {
            wait: true,
            points: [
              {
                id: meta.resource_id,
                vector: meta.embedding,
                payload,
              },
            ],
          });
        } catch (e) {
          console.warn(
            `[tool-registry] qdrant upsert failed (collection=${collectionName})`,
            e,
          );
          throw e;
        }
      }
    }

    // Redis：热点缓存 + domain 反查
    if (this.redis) {
      try {
        await this.redis.set(
          REDIS_L1_KEY_PREFIX + meta.resource_id,
          JSON.stringify(meta),
        );
        await this.redis.set(
          REDIS_L1_DOMAINS_KEY_PREFIX + meta.resource_id,
          JSON.stringify(domains),
        );
      } catch (e) {
        console.warn("[tool-registry] redis upsert L1 failed", e);
        throw e;
      }
    }
  }

  /** 读取 Level-1 索引：Redis 热点优先，miss 时回查 Qdrant。 */
  async getLevel1(resourceId: string): Promise<Level1IndexMeta | null> {
    const memory = this.memoryLevel1.get(resourceId);
    if (memory) return memory;

    // 1. Redis 热点
    if (this.redis) {
      try {
        const raw = await this.redis.get(REDIS_L1_KEY_PREFIX + resourceId);
        if (raw) {
          return this.parseLevel1(raw);
        }
      } catch (e) {
        console.warn("[tool-registry] redis get L1 failed", e);
      }
      // 2. Redis miss → 用 domain 反查 key 定位 Qdrant collection
      try {
        const domainsRaw = await this.redis.get(
          REDIS_L1_DOMAINS_KEY_PREFIX + resourceId,
        );
        if (domainsRaw && this.qdrant) {
          const domains = this.parseStringArray(domainsRaw);
          for (const d of domains) {
            const meta = await this.readLevel1FromQdrant(
              this.collectionName(d),
              resourceId,
            );
            if (meta) {
              // 回填 Redis 热点
              await this.redis.set(
                REDIS_L1_KEY_PREFIX + resourceId,
                JSON.stringify(meta),
              );
              return meta;
            }
          }
        }
      } catch (e) {
        console.warn("[tool-registry] qdrant fallback get L1 failed", e);
      }
    }
    return null;
  }

  /** 列出指定 domain 下的全部 Level-1 索引（scroll Qdrant collection）。 */
  async listLevel1ByDomain(domain: string): Promise<Level1IndexMeta[]> {
    if (this.memoryMode) {
      return [...this.memoryLevel1.values()].filter((meta) =>
        meta.domain.includes(domain),
      );
    }
    if (!this.qdrant) return [];
    const collectionName = this.collectionName(domain);
    try {
      const exists = await this.collectionExists(collectionName);
      if (!exists) return [];
      const out: Level1IndexMeta[] = [];
      let offset: string | number | Record<string, unknown> | undefined = undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await this.qdrant.scroll(collectionName, {
          limit: SCROLL_PAGE_LIMIT,
          offset,
          with_payload: true,
          with_vector: false,
        });
        const points = (res as { points?: Array<{ payload?: unknown }> }).points ?? [];
        for (const p of points) {
          const meta = this.parseLevel1FromPayload(p.payload);
          if (meta) out.push(meta);
        }
        if (res.next_page_offset === null || res.next_page_offset === undefined) {
          break;
        }
        offset = res.next_page_offset;
      }
      return out;
    } catch (e) {
      console.warn(
        `[tool-registry] qdrant listLevel1ByDomain failed (collection=${collectionName})`,
        e,
      );
      return [];
    }
  }

  /** 删除 Level-1 索引：先读 domain 反查，再删 Qdrant + Redis。 */
  async deleteLevel1(resourceId: string): Promise<void> {
    this.memoryLevel1.delete(resourceId);
    let domains: string[] = [];
    if (this.redis) {
      try {
        const domainsRaw = await this.redis.get(
          REDIS_L1_DOMAINS_KEY_PREFIX + resourceId,
        );
        if (domainsRaw) domains = this.parseStringArray(domainsRaw);
      } catch (e) {
        console.warn("[tool-registry] redis read domains for delete failed", e);
      }
    }

    // Qdrant：按 ID 删除（每个 domain collection 都删）
    if (this.qdrant && domains.length > 0) {
      for (const d of domains) {
        const collectionName = this.collectionName(d);
        try {
          const exists = await this.collectionExists(collectionName);
          if (!exists) continue;
          await this.qdrant.delete(collectionName, {
            wait: true,
            points: [resourceId],
          });
        } catch (e) {
          console.warn(
            `[tool-registry] qdrant delete failed (collection=${collectionName}, id=${resourceId})`,
            e,
          );
        }
      }
    } else if (this.qdrant && domains.length === 0) {
      console.warn(
        `[tool-registry] deleteLevel1: no domain reverse-index for ${resourceId}, qdrant cleanup skipped (orphan point may remain)`,
      );
    }

    // Redis：删热点 + domain 反查
    if (this.redis) {
      try {
        await this.redis.del(REDIS_L1_KEY_PREFIX + resourceId);
        await this.redis.del(REDIS_L1_DOMAINS_KEY_PREFIX + resourceId);
      } catch (e) {
        console.warn("[tool-registry] redis del L1 failed", e);
      }
    }
  }

  // ===== Level-2 能力描述（SQLite）=====

  async upsertLevel2(meta: Level2CapabilityMeta): Promise<void> {
    if (this.memoryMode) {
      this.memoryLevel2.set(meta.resource_id, meta);
      return;
    }
    this.requireSqlite();
    try {
      this.sqlite!.prepare(
        `INSERT INTO resource_capability (resource_id, input_type, output_type, use_cases, limitations, preconditions, dependencies)
         VALUES (@resource_id, @input_type, @output_type, @use_cases, @limitations, @preconditions, @dependencies)
         ON CONFLICT(resource_id) DO UPDATE SET
           input_type = excluded.input_type,
           output_type = excluded.output_type,
           use_cases = excluded.use_cases,
           limitations = excluded.limitations,
           preconditions = excluded.preconditions,
           dependencies = excluded.dependencies`,
      ).run({
        resource_id: meta.resource_id,
        input_type: meta.input_type,
        output_type: meta.output_type,
        use_cases: JSON.stringify(meta.use_cases),
        limitations: JSON.stringify(meta.limitations),
        preconditions: JSON.stringify(meta.preconditions),
        dependencies: JSON.stringify(meta.dependencies),
      });
    } catch (e) {
      console.warn(`[tool-registry] upsertLevel2 failed (id=${meta.resource_id})`, e);
      throw e;
    }
  }

  async getLevel2(resourceId: string): Promise<Level2CapabilityMeta | null> {
    if (this.memoryMode) return this.memoryLevel2.get(resourceId) ?? null;
    this.requireSqlite();
    try {
      const row = this.sqlite!.prepare(
        "SELECT * FROM resource_capability WHERE resource_id = ?",
      ).get(resourceId) as CapabilityRow | undefined;
      return row ? this.rowToLevel2(row) : null;
    } catch (e) {
      console.warn(`[tool-registry] getLevel2 failed (id=${resourceId})`, e);
      throw e;
    }
  }

  async listLevel2(resourceIds: string[]): Promise<Level2CapabilityMeta[]> {
    if (this.memoryMode) {
      return resourceIds
        .map((id) => this.memoryLevel2.get(id))
        .filter((v): v is Level2CapabilityMeta => v != null);
    }
    this.requireSqlite();
    if (resourceIds.length === 0) return [];
    try {
      const placeholders = resourceIds.map(() => "?").join(",");
      const rows = this.sqlite!.prepare(
        `SELECT * FROM resource_capability WHERE resource_id IN (${placeholders})`,
      ).all(...resourceIds) as CapabilityRow[];
      return rows.map((r) => this.rowToLevel2(r));
    } catch (e) {
      console.warn("[tool-registry] listLevel2 failed", e);
      throw e;
    }
  }

  /** 删除 Level-2 能力描述（注销资源时调用）。 */
  async deleteLevel2(resourceId: string): Promise<void> {
    if (this.memoryMode) {
      this.memoryLevel2.delete(resourceId);
      return;
    }
    this.requireSqlite();
    try {
      this.sqlite!.prepare(
        "DELETE FROM resource_capability WHERE resource_id = ?",
      ).run(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] deleteLevel2 failed (id=${resourceId})`, e);
      throw e;
    }
  }

  // ===== Level-3 执行 Schema（SQLite，延迟加载；本阶段仅提供存取）=====

  async saveLevel3(resourceId: string, schema: Level3Schema): Promise<void> {
    if (this.memoryMode) {
      this.memoryLevel3.set(resourceId, schema);
      return;
    }
    this.requireSqlite();
    const schemaType = this.level3SchemaType(schema);
    try {
      this.sqlite!.prepare(
        `INSERT INTO resource_schema (resource_id, schema_type, schema_json, updated_at)
         VALUES (@resource_id, @schema_type, @schema_json, @updated_at)
         ON CONFLICT(resource_id) DO UPDATE SET
           schema_type = excluded.schema_type,
           schema_json = excluded.schema_json,
           updated_at = excluded.updated_at`,
      ).run({
        resource_id: resourceId,
        schema_type: schemaType,
        schema_json: JSON.stringify(schema),
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[tool-registry] saveLevel3 failed (id=${resourceId})`, e);
      throw e;
    }
  }

  async getLevel3(resourceId: string): Promise<Level3Schema | null> {
    if (this.memoryMode) return this.memoryLevel3.get(resourceId) ?? null;
    this.requireSqlite();
    try {
      const row = this.sqlite!.prepare(
        "SELECT * FROM resource_schema WHERE resource_id = ?",
      ).get(resourceId) as SchemaRow | undefined;
      if (!row) return null;
      return this.parseLevel3(row.schema_type, row.schema_json);
    } catch (e) {
      console.warn(`[tool-registry] getLevel3 failed (id=${resourceId})`, e);
      throw e;
    }
  }

  async deleteLevel3(resourceId: string): Promise<void> {
    if (this.memoryMode) {
      this.memoryLevel3.delete(resourceId);
      return;
    }
    this.requireSqlite();
    try {
      this.sqlite!.prepare(
        "DELETE FROM resource_schema WHERE resource_id = ?",
      ).run(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] deleteLevel3 failed (id=${resourceId})`, e);
      throw e;
    }
  }

  // ===== 资源主记录（SQLite）=====

  async upsertRecord(record: ResourceRecord): Promise<void> {
    if (this.memoryMode) {
      this.memoryRecords.set(record.level1.resource_id, record);
      return;
    }
    this.requireSqlite();
    try {
      this.sqlite!.prepare(
        `INSERT INTO resource_record
           (resource_id, level1_json, level3_pointer, versions_json, environment, tenant_id, auth_level, created_at, updated_at)
         VALUES (@resource_id, @level1_json, @level3_pointer, @versions_json, @environment, @tenant_id, @auth_level, @created_at, @updated_at)
         ON CONFLICT(resource_id) DO UPDATE SET
           level1_json = excluded.level1_json,
           level3_pointer = excluded.level3_pointer,
           versions_json = excluded.versions_json,
           environment = excluded.environment,
           tenant_id = excluded.tenant_id,
           auth_level = excluded.auth_level,
           updated_at = excluded.updated_at`,
      ).run({
        resource_id: record.level1.resource_id,
        level1_json: JSON.stringify(record.level1),
        level3_pointer: record.level3_pointer,
        versions_json: JSON.stringify(record.versions),
        environment: record.environment,
        tenant_id: record.tenant_id,
        auth_level: record.auth_level,
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
      this.upsertRouteIndex(record);
    } catch (e) {
      console.warn(
        `[tool-registry] upsertRecord failed (id=${record.level1.resource_id})`,
        e,
      );
      throw e;
    }
  }

  async getRecord(resourceId: string): Promise<ResourceRecord | null> {
    if (this.memoryMode) return this.memoryRecords.get(resourceId) ?? null;
    this.requireSqlite();
    try {
      const row = this.sqlite!.prepare(
        "SELECT * FROM resource_record WHERE resource_id = ?",
      ).get(resourceId) as ResourceRecordRow | undefined;
      if (!row) return null;
      // Level-2 能力描述存于独立表，按需 join 进来
      const capRow = this.sqlite!.prepare(
        "SELECT * FROM resource_capability WHERE resource_id = ?",
      ).get(resourceId) as CapabilityRow | undefined;
      return this.rowToRecord(row, capRow);
    } catch (e) {
      console.warn(`[tool-registry] getRecord failed (id=${resourceId})`, e);
      throw e;
    }
  }

  async listRecordsByTenant(
    tenantId: string,
    env: Environment,
  ): Promise<ResourceRecord[]> {
    if (this.memoryMode) {
      return [...this.memoryRecords.values()].filter(
        (record) => record.tenant_id === tenantId && record.environment === env,
      );
    }
    this.requireSqlite();
    try {
      const rows = this.sqlite!.prepare(
        "SELECT * FROM resource_record WHERE tenant_id = ? AND environment = ?",
      ).all(tenantId, env) as ResourceRecordRow[];
      // 批量 join Level-2（单次 IN 查询，避免 N+1）
      const ids = rows.map((r) => r.resource_id);
      const capMap = new Map<string, CapabilityRow>();
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        const capRows = this.sqlite!.prepare(
          `SELECT * FROM resource_capability WHERE resource_id IN (${placeholders})`,
        ).all(...ids) as CapabilityRow[];
        for (const c of capRows) capMap.set(c.resource_id, c);
      }
      return rows.map((r) => this.rowToRecord(r, capMap.get(r.resource_id)));
    } catch (e) {
      console.warn(
        `[tool-registry] listRecordsByTenant failed (tenant=${tenantId}, env=${env})`,
        e,
      );
      throw e;
    }
  }

  /**
   * 按租户 / 环境 / domain / capability 路由切片列出资源。
   *
   * 这是后续四级分层路由和检索的关键入口：调用方必须先收敛到 domain /
   * capability，再读该切片内资源，避免从所有已注册资源做全量遍历。
   */
  async listRecordsByRoute(input: {
    tenantId: string;
    env: Environment;
    domains?: string[];
    capabilities?: string[];
    includeStatuses?: ResourceStatus[];
    limit?: number;
  }): Promise<ResourceRecord[]> {
    if (this.memoryMode) {
      const domains = dedupeNonEmpty(input.domains ?? []);
      const capabilities = dedupeNonEmpty(input.capabilities ?? []);
      const statuses = new Set<ResourceStatus>(
        input.includeStatuses?.length ? input.includeStatuses : ["online"],
      );
      const limit = Math.max(1, Math.min(500, input.limit ?? 100));
      return [...this.memoryRecords.values()]
        .filter((record) => {
          if (record.tenant_id !== input.tenantId || record.environment !== input.env) {
            return false;
          }
          if (!statuses.has(record.level1.status)) return false;
          if (
            domains.length > 0 &&
            !record.level1.domain.some((domain) => domains.includes(domain))
          ) {
            return false;
          }
          if (
            capabilities.length > 0 &&
            !record.level1.capability.some((capability) =>
              capabilities.includes(capability),
            )
          ) {
            return false;
          }
          return true;
        })
        .slice(0, limit);
    }
    this.requireSqlite();
    const domains = dedupeNonEmpty(input.domains ?? []);
    const capabilities = dedupeNonEmpty(input.capabilities ?? []);
    const statuses = input.includeStatuses?.length
      ? input.includeStatuses
      : ["online"];
    const limit = Math.max(1, Math.min(500, input.limit ?? 100));

    const where: string[] = ["tenant_id = ?", "environment = ?"];
    const params: Array<string | number> = [input.tenantId, input.env];
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);

    if (domains.length > 0) {
      where.push(`domain IN (${domains.map(() => "?").join(",")})`);
      params.push(...domains);
    }
    if (capabilities.length > 0) {
      where.push(`capability IN (${capabilities.map(() => "?").join(",")})`);
      params.push(...capabilities);
    }

    try {
      const rows = this.sqlite!.prepare(
        `SELECT DISTINCT resource_id
           FROM resource_route_index
          WHERE ${where.join(" AND ")}
          LIMIT ?`,
      ).all(...params, limit) as RouteIndexRow[];
      const records: ResourceRecord[] = [];
      for (const row of rows) {
        const record = await this.getRecord(row.resource_id);
        if (record) records.push(record);
      }
      return records;
    } catch (e) {
      console.warn("[tool-registry] listRecordsByRoute failed", e);
      throw e;
    }
  }

  /** 读取某个资源的依赖列表，供循环依赖检测 / 懒加载依赖存活校验使用。 */
  async getDependencies(resourceId: string): Promise<string[] | null> {
    const level2 = await this.getLevel2(resourceId);
    return level2?.dependencies ?? null;
  }

  /** 更新资源状态，并同步 Level-1、route index 与 Redis/Qdrant 热点。 */
  async updateStatus(
    resourceId: string,
    status: ResourceStatus,
  ): Promise<ResourceRecord | null> {
    const record = await this.getRecord(resourceId);
    if (!record) return null;

    const now = new Date().toISOString();
    const updatedLevel1: Level1IndexMeta = { ...record.level1, status };
    const updatedRecord: ResourceRecord = {
      ...record,
      level1: updatedLevel1,
      updated_at: now,
    };

    try {
      await this.upsertLevel1(updatedLevel1);
      await this.upsertRecord(updatedRecord);
      return updatedRecord;
    } catch (e) {
      console.warn(
        `[tool-registry] updateStatus failed (id=${resourceId}, status=${status})`,
        e,
      );
      throw e;
    }
  }

  /** 删除资源主记录（注销资源时调用；不级联删 Level-2/3，由调用方分别清理）。 */
  async deleteRecord(resourceId: string): Promise<void> {
    if (this.memoryMode) {
      this.memoryRecords.delete(resourceId);
      return;
    }
    this.requireSqlite();
    try {
      this.sqlite!.prepare(
        "DELETE FROM resource_record WHERE resource_id = ?",
      ).run(resourceId);
      this.sqlite!.prepare(
        "DELETE FROM resource_route_index WHERE resource_id = ?",
      ).run(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] deleteRecord failed (id=${resourceId})`, e);
      throw e;
    }
  }

  // ===== 工具知识图谱边（SQLite fallback；Neo4j 未启用时保持同一接口可用）=====

  async upsertGraphEdge(edge: {
    source_resource_id: string;
    relation_type: string;
    target_resource_id: string;
    weight?: number;
  }): Promise<void> {
    if (this.memoryMode) {
      const row: GraphEdgeRow = {
        source_resource_id: edge.source_resource_id,
        relation_type: edge.relation_type,
        target_resource_id: edge.target_resource_id,
        weight: clamp01Number(edge.weight ?? 1),
        updated_at: new Date().toISOString(),
      };
      this.memoryGraphEdges.set(graphEdgeKey(row), row);
      return;
    }
    this.requireSqlite();
    try {
      this.sqlite!.prepare(
        `INSERT INTO resource_graph_edge
           (source_resource_id, relation_type, target_resource_id, weight, updated_at)
         VALUES (@source_resource_id, @relation_type, @target_resource_id, @weight, @updated_at)
         ON CONFLICT(source_resource_id, relation_type, target_resource_id) DO UPDATE SET
           weight = excluded.weight,
           updated_at = excluded.updated_at`,
      ).run({
        source_resource_id: edge.source_resource_id,
        relation_type: edge.relation_type,
        target_resource_id: edge.target_resource_id,
        weight: clamp01Number(edge.weight ?? 1),
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("[tool-registry] upsertGraphEdge failed", e);
      throw e;
    }
  }

  async queryGraphEdges(input: {
    source_resource_id?: string;
    target_resource_id?: string;
    relation_type?: string;
    limit?: number;
  }): Promise<GraphEdgeRow[]> {
    if (this.memoryMode) {
      const limit = Math.max(1, Math.min(100, input.limit ?? 25));
      return [...this.memoryGraphEdges.values()]
        .filter((edge) => {
          if (
            input.source_resource_id &&
            edge.source_resource_id !== input.source_resource_id
          ) {
            return false;
          }
          if (
            input.target_resource_id &&
            edge.target_resource_id !== input.target_resource_id
          ) {
            return false;
          }
          if (input.relation_type && edge.relation_type !== input.relation_type) {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.weight - a.weight || b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit);
    }
    this.requireSqlite();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.source_resource_id) {
      where.push("source_resource_id = ?");
      params.push(input.source_resource_id);
    }
    if (input.target_resource_id) {
      where.push("target_resource_id = ?");
      params.push(input.target_resource_id);
    }
    if (input.relation_type) {
      where.push("relation_type = ?");
      params.push(input.relation_type);
    }
    const limit = Math.max(1, Math.min(100, input.limit ?? 25));
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    try {
      return this.sqlite!.prepare(
        `SELECT source_resource_id, relation_type, target_resource_id, weight, updated_at
           FROM resource_graph_edge
           ${sqlWhere}
          ORDER BY weight DESC, updated_at DESC
          LIMIT ?`,
      ).all(...params, limit) as GraphEdgeRow[];
    } catch (e) {
      console.warn("[tool-registry] queryGraphEdges failed", e);
      throw e;
    }
  }

  async deleteGraphEdgesForResource(resourceId: string): Promise<void> {
    if (this.memoryMode) {
      for (const [key, edge] of this.memoryGraphEdges.entries()) {
        if (
          edge.source_resource_id === resourceId ||
          edge.target_resource_id === resourceId
        ) {
          this.memoryGraphEdges.delete(key);
        }
      }
      return;
    }
    this.requireSqlite();
    try {
      this.sqlite!.prepare(
        `DELETE FROM resource_graph_edge
          WHERE source_resource_id = ? OR target_resource_id = ?`,
      ).run(resourceId, resourceId);
    } catch (e) {
      console.warn(`[tool-registry] deleteGraphEdgesForResource failed (id=${resourceId})`, e);
      throw e;
    }
  }

  // ===== 内部工具方法 =====

  private createTables(): void {
    this.sqlite!.exec(`
      CREATE TABLE IF NOT EXISTS resource_capability (
        resource_id   TEXT PRIMARY KEY,
        input_type    TEXT NOT NULL,
        output_type   TEXT NOT NULL,
        use_cases     TEXT NOT NULL,
        limitations   TEXT NOT NULL,
        preconditions TEXT NOT NULL,
        dependencies  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resource_schema (
        resource_id  TEXT PRIMARY KEY,
        schema_type  TEXT NOT NULL,
        schema_json  TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS resource_record (
        resource_id   TEXT PRIMARY KEY,
        level1_json   TEXT NOT NULL,
        level3_pointer TEXT NOT NULL,
        versions_json TEXT NOT NULL,
        environment   TEXT NOT NULL,
        tenant_id     TEXT NOT NULL,
        auth_level    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_resource_record_tenant_env
        ON resource_record(tenant_id, environment);

      CREATE TABLE IF NOT EXISTS resource_route_index (
        resource_id TEXT NOT NULL,
        tenant_id   TEXT NOT NULL,
        environment TEXT NOT NULL,
        domain      TEXT NOT NULL,
        capability  TEXT NOT NULL,
        status      TEXT NOT NULL,
        auth_level  TEXT NOT NULL,
        PRIMARY KEY (resource_id, domain, capability)
      );

      CREATE INDEX IF NOT EXISTS idx_resource_route_lookup
        ON resource_route_index(tenant_id, environment, domain, capability, status);

      CREATE TABLE IF NOT EXISTS resource_graph_edge (
        source_resource_id TEXT NOT NULL,
        relation_type      TEXT NOT NULL,
        target_resource_id TEXT NOT NULL,
        weight             REAL NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (source_resource_id, relation_type, target_resource_id)
      );

      CREATE INDEX IF NOT EXISTS idx_resource_graph_source
        ON resource_graph_edge(source_resource_id, relation_type, weight);

      CREATE INDEX IF NOT EXISTS idx_resource_graph_target
        ON resource_graph_edge(target_resource_id, relation_type, weight);
    `);
  }

  private requireSqlite(): void {
    if (!this.sqlite) {
      throw new Error(
        "[tool-registry] sqlite not initialized; call initialize() first",
      );
    }
  }

  private collectionName(domain: string): string {
    // 仅保留 [a-zA-Z0-9_-]，避免 collection 名含非法字符
    const safe = domain.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase() || "_default";
    return QDRANT_COLLECTION_PREFIX + safe;
  }

  private async ensureCollection(
    collectionName: string,
    dim: number,
  ): Promise<void> {
    if (!this.qdrant) return;
    if (dim <= 0) {
      throw new Error(
        `[tool-registry] cannot ensure collection ${collectionName}: embedding dim=${dim}`,
      );
    }
    let p = this.collectionReady.get(collectionName);
    if (!p) {
      p = (async () => {
        const exists = await this.collectionExists(collectionName);
        if (!exists) {
          await this.qdrant!.createCollection(collectionName, {
            vectors: { size: dim, distance: "Cosine" },
          });
        }
      })().catch((e) => {
        // 失败时清掉缓存，允许下次重试
        this.collectionReady.delete(collectionName);
        throw e;
      });
      this.collectionReady.set(collectionName, p);
    }
    await p;
  }

  private async collectionExists(collectionName: string): Promise<boolean> {
    if (!this.qdrant) return false;
    try {
      const cols = await this.qdrant.getCollections();
      return cols.collections.some((c) => c.name === collectionName);
    } catch (e) {
      console.warn(
        `[tool-registry] getCollections failed (checking ${collectionName})`,
        e,
      );
      return false;
    }
  }

  private async readLevel1FromQdrant(
    collectionName: string,
    resourceId: string,
  ): Promise<Level1IndexMeta | null> {
    if (!this.qdrant) return null;
    try {
      const exists = await this.collectionExists(collectionName);
      if (!exists) return null;
      const res = await this.qdrant.retrieve(collectionName, {
        ids: [resourceId],
        with_payload: true,
        with_vector: false,
      });
      const points = (res as Array<{ payload?: unknown }>) ?? [];
      const first = points[0];
      if (!first) return null;
      return this.parseLevel1FromPayload(first.payload);
    } catch (e) {
      console.warn(
        `[tool-registry] qdrant retrieve L1 failed (collection=${collectionName})`,
        e,
      );
      return null;
    }
  }

  private parseLevel1(raw: string): Level1IndexMeta | null {
    try {
      const obj = JSON.parse(raw) as Level1IndexMeta;
      return obj && typeof obj.resource_id === "string" ? obj : null;
    } catch (e) {
      console.warn("[tool-registry] parseLevel1 JSON failed", e);
      return null;
    }
  }

  private parseLevel1FromPayload(payload: unknown): Level1IndexMeta | null {
    if (!payload || typeof payload !== "object") return null;
    try {
      const obj = payload as Level1IndexMeta;
      if (typeof obj.resource_id !== "string") return null;
      return obj;
    } catch (e) {
      console.warn("[tool-registry] parseLevel1FromPayload failed", e);
      return null;
    }
  }

  private parseStringArray(raw: string): string[] {
    try {
      const arr = JSON.parse(raw) as unknown;
      return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
    } catch (e) {
      console.warn("[tool-registry] parseStringArray failed", e);
      return [];
    }
  }

  private rowToLevel2(row: CapabilityRow): Level2CapabilityMeta {
    return {
      resource_id: row.resource_id,
      input_type: row.input_type,
      output_type: row.output_type,
      use_cases: this.parseStringArray(row.use_cases),
      limitations: this.parseStringArray(row.limitations),
      preconditions: this.parseStringArray(row.preconditions),
      dependencies: this.parseStringArray(row.dependencies),
    };
  }

  private level3SchemaType(schema: Level3Schema): string {
    if (this.isToolSchema(schema)) return "tool";
    if (this.isSkillSchema(schema)) return "skill";
    return "mcp";
  }

  private isToolSchema(s: Level3Schema): s is Extract<Level3Schema, { parameters: unknown }> {
    return (s as { parameters?: unknown }).parameters !== undefined;
  }

  private isSkillSchema(s: Level3Schema): s is Extract<Level3Schema, { workflow: unknown }> {
    return (s as { workflow?: unknown }).workflow !== undefined;
  }

  private parseLevel3(schemaType: string, json: string): Level3Schema | null {
    try {
      const obj = JSON.parse(json) as unknown;
      // 按 schema_type 校验形状，避免误读
      switch (schemaType) {
        case "tool":
          if (this.isToolSchema(obj as Level3Schema)) return obj as Level3Schema;
          break;
        case "skill":
          if (this.isSkillSchema(obj as Level3Schema)) return obj as Level3Schema;
          break;
        case "mcp":
          if (
            (obj as { transport?: unknown }).transport !== undefined &&
            (obj as { endpoint?: unknown }).endpoint !== undefined
          ) {
            return obj as Level3Schema;
          }
          break;
        default:
          break;
      }
      console.warn(`[tool-registry] parseLevel3 shape mismatch (type=${schemaType})`);
      return null;
    } catch (e) {
      console.warn("[tool-registry] parseLevel3 JSON failed", e);
      return null;
    }
  }

  private rowToRecord(
    row: ResourceRecordRow,
    capRow: CapabilityRow | undefined,
  ): ResourceRecord {
    const level1 = this.parseLevel1(row.level1_json);
    if (!level1) {
      throw new Error(
        `[tool-registry] corrupt level1_json for resource ${row.resource_id}`,
      );
    }
    let versions: ResourceRecord["versions"];
    try {
      versions = JSON.parse(row.versions_json) as ResourceRecord["versions"];
    } catch (e) {
      console.warn(
        `[tool-registry] corrupt versions_json for ${row.resource_id}, fallback to []`,
        e,
      );
      versions = [];
    }
    // Level-2 存于独立表；缺失时回退为空结构（数据不一致告警，不阻塞读）
    const level2: Level2CapabilityMeta = capRow
      ? this.rowToLevel2(capRow)
      : {
          resource_id: row.resource_id,
          input_type: "",
          output_type: "",
          use_cases: [],
          limitations: [],
          preconditions: [],
          dependencies: [],
        };
    if (!capRow) {
      console.warn(
        `[tool-registry] level2 missing for ${row.resource_id}, returning empty capability`,
      );
    }
    return {
      level1,
      level2,
      level3_pointer: row.level3_pointer,
      versions,
      environment: row.environment as Environment,
      tenant_id: row.tenant_id,
      auth_level: row.auth_level as ResourceRecord["auth_level"],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private upsertRouteIndex(record: ResourceRecord): void {
    this.sqlite!.prepare(
      "DELETE FROM resource_route_index WHERE resource_id = ?",
    ).run(record.level1.resource_id);

    const domains = record.level1.domain.length > 0 ? record.level1.domain : ["_default"];
    const capabilities =
      record.level1.capability.length > 0 ? record.level1.capability : ["_default"];
    const stmt = this.sqlite!.prepare(
      `INSERT INTO resource_route_index
         (resource_id, tenant_id, environment, domain, capability, status, auth_level)
       VALUES (@resource_id, @tenant_id, @environment, @domain, @capability, @status, @auth_level)`,
    );
    for (const domain of domains) {
      for (const capability of capabilities) {
        stmt.run({
          resource_id: record.level1.resource_id,
          tenant_id: record.tenant_id,
          environment: record.environment,
          domain,
          capability,
          status: record.level1.status,
          auth_level: record.auth_level,
        });
      }
    }
  }
}

function dedupeNonEmpty(values: string[]): string[] {
  return Array.from(
    new Set(values.map((v) => v.trim()).filter((v) => v.length > 0)),
  );
}

function clamp01Number(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function graphEdgeKey(edge: Pick<GraphEdgeRow, "source_resource_id" | "relation_type" | "target_resource_id">): string {
  return `${edge.source_resource_id}\0${edge.relation_type}\0${edge.target_resource_id}`;
}
