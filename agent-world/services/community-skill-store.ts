/**
 * 社区技能：持久化用户上传的 Skill（skill.json + skill.handler.js），供技能商店展示与他人购买使用。
 * 注意：handler 在服务端以当前 Node 进程权限执行，仅适合可信环境；生产环境应配合审核与更强隔离。
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

import { getDataDir } from "../config/data-dir.js";
import type {
  CommunitySkillPersistMetadata,
  HttpRouteDepsLike,
  SkillManagerLike,
} from "../host-types.js";

const MAX_HANDLER_BYTES = 128 * 1024;
const UPLOAD_HANDLER_MIN_LEN = 20;

function communityRoot(): string {
  return join(getDataDir(), "community-skills");
}

function wrapHandlerCode(code: string): string {
  const t = code.trim();
  if (t.startsWith("export ")) {
    return code.endsWith("\n") ? code : `${code}\n`;
  }
  return `export default async function (input, context) {\n${code}\n}\n`;
}

function asCommunitySkillMetadata(raw: unknown): CommunitySkillPersistMetadata {
  if (!raw || typeof raw !== "object") {
    throw new Error("metadata 必须是对象");
  }
  return raw as CommunitySkillPersistMetadata;
}

export async function loadPersistedCommunitySkills(skillManager: SkillManagerLike): Promise<void> {
  const root = communityRoot();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
    return;
  }

  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const jsonPath = join(dir, "skill.json");
    if (!existsSync(jsonPath)) continue;
    const loadFromFile = skillManager.loadFromFile;
    if (!loadFromFile) continue;
    try {
      await loadFromFile.call(skillManager, jsonPath, { autoEnable: true });
    } catch (e) {
      console.error(`[community-skills] 启动加载失败 (${name}):`, e);
    }
  }
}

export type UploadCommunitySkillResult =
  | { ok: true; skillId: string; storageId: string }
  | { ok: false; reason: string; message: string; details?: unknown };

/**
 * **仅校验**社区技能候选人（不写盘、不在 SkillManager 注册）。
 * — `handlerCode` 未传或为空白时跳过 handler 体量检查（适合仅校验 `metadata` 形状）。
 */
export async function validateCommunitySkillCandidate(
  deps: Pick<HttpRouteDepsLike, "skillManager" | "skillMetadataValidator">,
  input: {
    metadata: unknown;
    /** 不提供或空串则跳过 handler 相关检查 */
    handlerCode?: string;
    authorDisplayName?: string;
  },
): Promise<UploadCommunitySkillResult> {
  const { skillManager, skillMetadataValidator } = deps;
  let meta: CommunitySkillPersistMetadata;
  try {
    meta = asCommunitySkillMetadata(input.metadata);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "INVALID_METADATA", message: msg };
  }

  const handlerRaw = input.handlerCode?.trim() ?? "";
  if (handlerRaw.length > 0) {
    if (handlerRaw.length < UPLOAD_HANDLER_MIN_LEN) {
      return {
        ok: false,
        reason: "HANDLER_TOO_SHORT",
        message: `processor 至少需要 ${UPLOAD_HANDLER_MIN_LEN} 个字符`,
      };
    }
    const handlerBuf = Buffer.from(handlerRaw, "utf8");
    if (handlerBuf.length > MAX_HANDLER_BYTES) {
      return {
        ok: false,
        reason: "HANDLER_TOO_LARGE",
        message: `处理器源码不得超过 ${MAX_HANDLER_BYTES} 字节`,
      };
    }
  }

  meta.kind = "community";
  if (input.authorDisplayName?.trim()) {
    meta.author = input.authorDisplayName.trim();
  }
  meta.createdAt = meta.createdAt ?? new Date().toISOString();
  meta.updatedAt = new Date().toISOString();

  const metaErrors = skillMetadataValidator.validateMetadata(meta);
  if (metaErrors.length > 0) {
    return {
      ok: false,
      reason: "METADATA_VALIDATION_FAILED",
      message: metaErrors.map((e) => `${e.field}: ${e.message}`).join("; "),
      details: metaErrors,
    };
  }

  const existing = skillManager.get(meta.name);
  if (existing) {
    return {
      ok: false,
      reason: "SKILL_NAME_TAKEN",
      message: `技能标识「${meta.name}」已存在，请更换 name 后重试`,
    };
  }

  return { ok: true, skillId: meta.name, storageId: "__validation_preview__" };
}

/**
 * 校验元数据、落盘并注册到 SkillManager（与内置技能同一商店列表）。
 * `skillMetadataValidator` 由宿主注入，避免 agent-world 包依赖具体 SkillValidator 实现。
 */
export async function persistUploadedCommunitySkill(
  deps: Pick<HttpRouteDepsLike, "skillManager" | "skillMetadataValidator">,
  input: {
    metadata: unknown;
    handlerCode: string;
    authorDisplayName?: string;
  },
): Promise<UploadCommunitySkillResult> {
  const { skillManager, skillMetadataValidator } = deps;

  let meta: CommunitySkillPersistMetadata;
  try {
    meta = asCommunitySkillMetadata(input.metadata);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "INVALID_METADATA", message: msg };
  }

  const handlerBuf = Buffer.from(input.handlerCode, "utf8");
  if (handlerBuf.length > MAX_HANDLER_BYTES) {
    return {
      ok: false,
      reason: "HANDLER_TOO_LARGE",
      message: `处理器源码不得超过 ${MAX_HANDLER_BYTES} 字节`,
    };
  }

  meta.kind = "community";
  if (input.authorDisplayName?.trim()) {
    meta.author = input.authorDisplayName.trim();
  }
  meta.createdAt = meta.createdAt ?? new Date().toISOString();
  meta.updatedAt = new Date().toISOString();

  const metaErrors = skillMetadataValidator.validateMetadata(meta);
  if (metaErrors.length > 0) {
    return {
      ok: false,
      reason: "METADATA_VALIDATION_FAILED",
      message: metaErrors.map((e) => `${e.field}: ${e.message}`).join("; "),
      details: metaErrors,
    };
  }

  const existing = skillManager.get(meta.name);
  if (existing) {
    return {
      ok: false,
      reason: "SKILL_NAME_TAKEN",
      message: `技能标识「${meta.name}」已存在，请更换 name 后重试`,
    };
  }

  const storageId = randomUUID();
  const dir = join(communityRoot(), storageId);
  mkdirSync(dir, { recursive: true });

  const jsonPath = join(dir, "skill.json");
  const handlerPath = join(dir, "skill.handler.js");

  try {
    const wrapped = wrapHandlerCode(input.handlerCode);
    writeFileSync(jsonPath, JSON.stringify(meta, null, 2), "utf8");
    writeFileSync(handlerPath, wrapped, "utf8");

    const loadFromFile = skillManager.loadFromFile;
    if (!loadFromFile) {
      throw new Error("SkillManager 未实现 loadFromFile，无法注册社区技能");
    }
    await loadFromFile.call(skillManager, jsonPath, { autoEnable: true });
  } catch (e) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "LOAD_FAILED", message: msg };
  }

  return { ok: true, skillId: meta.name, storageId };
}
