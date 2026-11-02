import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";

/**
 * 身份 / 记忆 Markdown 文档 → agent-memory-sync KV 的幂等种子。
 *
 *   - agent/USER.md    → `user_profile`   ：userProfile 后备用户画像
 *   - agent/MEMORY.md  → `memory_document`：长期记忆文档（非保留键，自动进 memorySummary）
 *
 * agent/SOUL.md 不种进 KV：人格正文由 soul-store 直接读文件（唯一出口，避免
 * 同一份人格有 KV 与文件两个源、两份改写路径）。
 *
 * 幂等性：
 *   - 进程内：seededInProcess 集合保证每个 actor 每进程只读一次 md。
 *   - KV 层：seedIfAbsent 仅当目标键不存在才写入，跨重启不会覆盖运行时学习到的
 *     用户画像 / 长期事实。
 *
 * 路径可用环境变量覆盖：AGENT_USER_MD_PATH / AGENT_MEMORY_MD_PATH
 */

const seededInProcess = new Set<string>();

export interface IdentityMarkdownPaths {
  user?: string;
  memory?: string;
}

export function resolveIdentityMarkdownPaths(): IdentityMarkdownPaths {
  const base = process.cwd();
  return {
    user: process.env.AGENT_USER_MD_PATH?.trim() || join(base, "agent", "USER.md"),
    memory: process.env.AGENT_MEMORY_MD_PATH?.trim() || join(base, "agent", "MEMORY.md"),
  };
}

async function readOptional(path?: string): Promise<string | null> {
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export async function seedIdentityMarkdown(
  sync: AgentMemorySyncService | null,
  actorId: string,
): Promise<void> {
  if (!sync || seededInProcess.has(actorId)) return;
  seededInProcess.add(actorId);

  const { user, memory } = resolveIdentityMarkdownPaths();
  const [userText, memoryText] = await Promise.all([
    readOptional(user),
    readOptional(memory),
  ]);

  await Promise.all([
    userText ? sync.seedIfAbsent(actorId, "user_profile", userText) : Promise.resolve(false),
    memoryText ? sync.seedIfAbsent(actorId, "memory_document", memoryText) : Promise.resolve(false),
  ]);
}