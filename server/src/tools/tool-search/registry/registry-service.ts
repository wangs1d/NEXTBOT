/**
 * Adaptive Hierarchical Tool Intelligence System —— Phase-1 注册服务 + 版本管理。
 *
 * 职责：
 *   - register：三级元数据分级写入（L1→Qdrant+Redis, L2→SQLite, L3→SQLite, 主记录→SQLite）
 *   - get / listByTenant：资源查询
 *   - publishVersion / rollbackVersion / listVersions：语义化版本管理 + 灰度标记
 *   - unregister：删除三级元数据 + 主记录
 *
 * 设计要点：
 *   - resource_id 用 crypto.randomUUID() 生成（Node 内置，无需新依赖）
 *   - version 用 semver 正则校验：^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$
 *   - 冷启动保护：base_score 默认 0.5，确保新资源不排在末尾
 *   - environment 从 process.env.AGENT_ENV 读取，默认 "dev"
 *   - DUPLICATE_RESOURCE 通过 name+version 在同租户同环境下查重
 */

import { randomUUID } from "node:crypto";

import { checkCircularDependency } from "./dependency-checker.js";
import type { ToolRegistryStore } from "./store.js";
import type {
  AuthLevel,
  Environment,
  Level1IndexMeta,
  Level2CapabilityMeta,
  Level3Schema,
  ResourceRecord,
  ResourceStatus,
  ResourceType,
  ResourceVersion,
} from "./models.js";

// ===== 错误码 =====

export const RegistryErrorCode = {
  InvalidVersionFormat: "INVALID_VERSION_FORMAT",
  ResourceNotFound: "RESOURCE_NOT_FOUND",
  DuplicateResource: "DUPLICATE_RESOURCE",
  VersionNotFound: "VERSION_NOT_FOUND",
  CircularDependencyDetected: "CIRCULAR_DEPENDENCY_DETECTED",
  RegisterFailed: "REGISTER_FAILED",
} as const;
export type RegistryErrorCode = (typeof RegistryErrorCode)[keyof typeof RegistryErrorCode];

export type RegisterResult =
  | { ok: true; resource_id: string; version: string }
  | { ok: false; error_code: string; error_message: string };

// ===== 常量 =====

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const DEFAULT_BASE_SCORE = 0.5;
const DEFAULT_AUTH_LEVEL: AuthLevel = "default";

// ===== 注册入参 =====

export type RegisterInput = {
  /** 允许迁移 / 测试传入稳定 id；未传时由服务生成 uuid。 */
  resource_id?: string;
  resource_type: ResourceType;
  name: string;
  description: string;
  domain: string[];
  capability: string[];
  tags: string[];
  version: string;
  /** 冷启动基础分（0~1），默认 0.5 */
  base_score?: number;
  embeddings?: number[][];
  /** 单向量注册输入仅用于兼容旧调用方，服务会规范化为 embeddings。 */
  embedding?: number[];
  level2: Level2CapabilityMeta;
  level3: Level3Schema;
  tenant_id: string;
  /** 鉴权级别，默认 "default" */
  auth_level?: AuthLevel;
  /** 注册时同步写入工具图谱的附加边；depends_on 会从 level2.dependencies 自动生成。 */
  graph_relations?: Array<{
    relation_type: string;
    target_resource_id: string;
    weight?: number;
  }>;
};

export type PublishVersionInput = {
  /** 要发布的新版本号（必须 semver） */
  version: string;
  /** 是否灰度发布，默认 false */
  is_canary?: boolean;
};

export type RollbackInput = {
  /** 回退到的目标版本号（必须已存在） */
  target_version: string;
};

/**
 * 资源注册服务：编排三级元数据分级写入 + 版本管理。
 * 不直接持有连接，全部委托 ToolRegistryStore。
 */
export class RegistryService {
  constructor(private store: ToolRegistryStore) {}

  // ===== 注册 =====

  async register(input: RegisterInput): Promise<RegisterResult> {
    // 1. 校验 version 语义化版本格式
    if (!SEMVER_REGEX.test(input.version)) {
      return fail(
        RegistryErrorCode.InvalidVersionFormat,
        `version "${input.version}" is not valid semver (expected X.Y.Z[-pre])`,
      );
    }

    const environment = currentEnvironment();
    const resourceId = input.resource_id?.trim() || randomUUID();
    const now = new Date().toISOString();
    const baseScore =
      typeof input.base_score === "number"
        ? clamp01(input.base_score)
        : DEFAULT_BASE_SCORE;
    const authLevel = input.auth_level ?? DEFAULT_AUTH_LEVEL;

    // 2. 校验 level2 / level3 的 resource_id 与新生成的 id 对齐
    //    （调用方可能传空 resource_id，这里统一覆盖）
    const level2: Level2CapabilityMeta = {
      ...input.level2,
      resource_id: resourceId,
    };
    const level3: Level3Schema = {
      ...(input.level3 as object),
      resource_id: resourceId,
    } as Level3Schema;

    // Skill / 资源依赖环检测：对待注册资源的 dependencies 与已注册图合并后 DFS。
    const depCheck = await checkCircularDependency(
      resourceId,
      level2.dependencies,
      (id) => this.store.getDependencies(id),
    );
    if (!depCheck.ok) {
      return fail(depCheck.error_code, depCheck.error_message);
    }

    // 3. DUPLICATE_RESOURCE 查重：同租户 + 同环境 + 同 name + 同 version
    try {
      const existing = await this.store.listRecordsByTenant(
        input.tenant_id,
        environment,
      );
      const dup = existing.find(
        (r) =>
          r.level1.name === input.name && r.level1.version === input.version,
      );
      if (dup) {
        return fail(
          RegistryErrorCode.DuplicateResource,
          `resource name="${input.name}" version="${input.version}" already exists in tenant=${input.tenant_id} env=${environment}`,
        );
      }
    } catch (e) {
      // 查重失败不阻塞注册，但记录告警（fail-open，避免基础设施抖动卡死注册）
      console.warn(
        "[tool-registry] duplicate check failed, proceeding with register",
        e,
      );
    }

    // 4. 组装 Level-1 索引
    const level1: Level1IndexMeta = {
      resource_id: resourceId,
      resource_type: input.resource_type,
      name: input.name,
      description: input.description,
      domain: input.domain,
      capability: input.capability,
      tags: input.tags,
      version: input.version,
      status: "online" as ResourceStatus,
      base_score: baseScore,
      embeddings:
        input.embeddings && input.embeddings.length > 0
          ? input.embeddings
          : input.embedding
            ? [input.embedding]
            : [],
      // HTTP 注册面（管理/查询用途）无真实时延数据，用域无关默认值；生产检索
      // 路径的 adaptive-catalog 会按域估算（inferLatencyMs）
      latency_ms: 20,
    };

    // 5. 版本记录（首个版本即激活版本）
    const versions: ResourceVersion[] = [
      {
        version: input.version,
        released_at: now,
        is_canary: false,
        is_active: true,
      },
    ];

    // 6. 主记录（level3_pointer 指向 resource_id；当前实现 L3 存 SQLite 同表）
    const record: ResourceRecord = {
      level1,
      level2,
      level3_pointer: resourceId,
      versions,
      environment,
      tenant_id: input.tenant_id,
      auth_level: authLevel,
      created_at: now,
      updated_at: now,
    };

    // 7. 三级元数据分级写入（任一失败 → 整体失败回滚）
    try {
      await this.store.upsertLevel1(level1);
      await this.store.upsertLevel2(level2);
      await this.store.saveLevel3(resourceId, level3);
      await this.store.upsertRecord(record);
      for (const dep of level2.dependencies) {
        await this.store.upsertGraphEdge({
          source_resource_id: resourceId,
          relation_type: "depends_on",
          target_resource_id: dep,
          weight: 1,
        });
      }
      for (const rel of input.graph_relations ?? []) {
        await this.store.upsertGraphEdge({
          source_resource_id: resourceId,
          relation_type: rel.relation_type,
          target_resource_id: rel.target_resource_id,
          weight: rel.weight,
        });
      }
    } catch (e) {
      console.warn(`[tool-registry] register write failed (id=${resourceId})`, e);
      // 尽力清理已写入的脏数据（best-effort，不掩盖原始错误）
      await this.bestEffortCleanup(resourceId);
      return fail(
        RegistryErrorCode.RegisterFailed,
        `failed to persist resource: ${describeError(e)}`,
      );
    }

    return { ok: true, resource_id: resourceId, version: input.version };
  }

  // ===== 查询 =====

  async get(resourceId: string): Promise<ResourceRecord | null> {
    return this.store.getRecord(resourceId);
  }

  async listByTenant(tenantId: string): Promise<ResourceRecord[]> {
    return this.store.listRecordsByTenant(tenantId, currentEnvironment());
  }

  // ===== 版本管理 =====

  /**
   * 发布新版本：旧激活版本 is_active=false，新版本 is_active=true。
   * 同时更新 Level-1 的 version 字段。
   */
  async publishVersion(
    resourceId: string,
    version: string,
    isCanary = false,
  ): Promise<RegisterResult> {
    if (!SEMVER_REGEX.test(version)) {
      return fail(
        RegistryErrorCode.InvalidVersionFormat,
        `version "${version}" is not valid semver (expected X.Y.Z[-pre])`,
      );
    }
    const record = await this.store.getRecord(resourceId);
    if (!record) {
      return fail(
        RegistryErrorCode.ResourceNotFound,
        `resource ${resourceId} not found`,
      );
    }
    // 不允许发布已存在的同版本号
    if (record.versions.some((v) => v.version === version)) {
      return fail(
        RegistryErrorCode.DuplicateResource,
        `version ${version} already exists for resource ${resourceId}`,
      );
    }

    const now = new Date().toISOString();
    const newVersions: ResourceVersion[] = record.versions.map((v) => ({
      ...v,
      // 灰度发布不抢占当前激活版本（除非当前无激活版本）
      is_active: isCanary ? v.is_active : false,
    }));
    newVersions.push({
      version,
      released_at: now,
      is_canary: isCanary,
      is_active: !isCanary || !newVersions.some((v) => v.is_active),
    });

    // 更新 Level-1 的 version 字段（指向当前激活版本）
    const activeVersion =
      newVersions.find((v) => v.is_active)?.version ?? version;
    const updatedLevel1: Level1IndexMeta = {
      ...record.level1,
      version: activeVersion,
    };

    try {
      await this.store.upsertLevel1(updatedLevel1);
      await this.store.upsertRecord({
        ...record,
        level1: updatedLevel1,
        versions: newVersions,
        updated_at: now,
      });
    } catch (e) {
      console.warn(
        `[tool-registry] publishVersion failed (id=${resourceId}, ver=${version})`,
        e,
      );
      return fail(
        RegistryErrorCode.RegisterFailed,
        `failed to publish version: ${describeError(e)}`,
      );
    }
    return { ok: true, resource_id: resourceId, version };
  }

  /**
   * 回退到指定版本：目标版本 is_active=true，其余 is_active=false。
   * 同时更新 Level-1 的 version 字段。
   */
  async rollbackVersion(
    resourceId: string,
    targetVersion: string,
  ): Promise<RegisterResult> {
    const record = await this.store.getRecord(resourceId);
    if (!record) {
      return fail(
        RegistryErrorCode.ResourceNotFound,
        `resource ${resourceId} not found`,
      );
    }
    const target = record.versions.find((v) => v.version === targetVersion);
    if (!target) {
      return fail(
        RegistryErrorCode.VersionNotFound,
        `version ${targetVersion} not found for resource ${resourceId}`,
      );
    }

    const now = new Date().toISOString();
    const newVersions: ResourceVersion[] = record.versions.map((v) => ({
      ...v,
      is_active: v.version === targetVersion,
      // 回退后取消灰度标记（回退视为稳定操作）
      is_canary: v.version === targetVersion ? false : v.is_canary,
    }));

    const updatedLevel1: Level1IndexMeta = {
      ...record.level1,
      version: targetVersion,
    };

    try {
      await this.store.upsertLevel1(updatedLevel1);
      await this.store.upsertRecord({
        ...record,
        level1: updatedLevel1,
        versions: newVersions,
        updated_at: now,
      });
    } catch (e) {
      console.warn(
        `[tool-registry] rollbackVersion failed (id=${resourceId}, ver=${targetVersion})`,
        e,
      );
      return fail(
        RegistryErrorCode.RegisterFailed,
        `failed to rollback version: ${describeError(e)}`,
      );
    }
    return { ok: true, resource_id: resourceId, version: targetVersion };
  }

  async listVersions(resourceId: string): Promise<ResourceVersion[]> {
    const record = await this.store.getRecord(resourceId);
    return record?.versions ?? [];
  }

  // ===== 注销 =====

  async unregister(resourceId: string): Promise<RegisterResult> {
    const record = await this.store.getRecord(resourceId);
    if (!record) {
      return fail(
        RegistryErrorCode.ResourceNotFound,
        `resource ${resourceId} not found`,
      );
    }
    try {
      await this.store.deleteLevel1(resourceId);
      await this.store.deleteLevel3(resourceId);
      await this.store.deleteLevel2(resourceId);
      await this.store.deleteRecord(resourceId);
      await this.store.deleteGraphEdgesForResource(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] unregister failed (id=${resourceId})`, e);
      return fail(
        RegistryErrorCode.RegisterFailed,
        `failed to unregister resource: ${describeError(e)}`,
      );
    }
    return {
      ok: true,
      resource_id: resourceId,
      version: record.level1.version,
    };
  }

  // ===== 内部工具 =====

  /**
   * 尽力清理已写入的三级元数据 + 主记录（注册失败回滚时调用）。
   * 逐项 try/catch，不掩盖原始错误。
   */
  private async bestEffortCleanup(resourceId: string): Promise<void> {
    try {
      await this.store.deleteLevel1(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] cleanup deleteLevel1 failed (id=${resourceId})`, e);
    }
    try {
      await this.store.deleteLevel3(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] cleanup deleteLevel3 failed (id=${resourceId})`, e);
    }
    try {
      await this.store.deleteLevel2(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] cleanup deleteLevel2 failed (id=${resourceId})`, e);
    }
    try {
      await this.store.deleteRecord(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] cleanup deleteRecord failed (id=${resourceId})`, e);
    }
    try {
      await this.store.deleteGraphEdgesForResource(resourceId);
    } catch (e) {
      console.warn(`[tool-registry] cleanup deleteGraphEdges failed (id=${resourceId})`, e);
    }
  }
}

// ===== 辅助函数 =====

function currentEnvironment(): Environment {
  const raw = process.env.AGENT_ENV?.trim().toLowerCase();
  if (raw === "staging") return "staging";
  if (raw === "prod" || raw === "production") return "prod";
  return "dev";
}

export function getCurrentToolRegistryEnvironment(): Environment {
  return currentEnvironment();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BASE_SCORE;
  return Math.min(1, Math.max(0, n));
}

function fail(error_code: string, error_message: string): RegisterResult {
  return { ok: false, error_code, error_message };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
