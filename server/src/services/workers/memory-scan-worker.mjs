/**
 * 记忆库扫描 Worker（2026-11-01 任务级隔离 C 方案）。
 *
 * 职责：只读扫描 mem0 本地向量库 `vectors` 表，按 actor 变体过滤后把
 * 规整好的记忆条目回传主进程。**不做任何写操作**——TTL 归档/去重/删除/LLM 审查
 * 仍由主进程执行（单写者不变，避免 SQLITE_BUSY 与缓存不一致）。
 *
 * 为什么要搬：主进程里做 JSON.parse + 过滤会把事件循环占住（历史实测单次
 * 1s~7.9s，期间所有流式输出/工具回执都停摆）。搬到 worker 后主线程只等 IPC。
 *
 * 协议：
 *   main → worker: { id, type: "scan", dbPath, actorVariants }
 *   worker → main: { id, ok: true, rows: MemoryScanRow[] }
 *               | { id, ok: false, error: string }
 */

import { parentPort } from "node:worker_threads";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

/** 与 mem0 getAll 返回项对齐：memory=payload.data，metadata=payload 去掉保留键。 */
const EXCLUDED_KEYS = new Set([
  "user_id",
  "agent_id",
  "run_id",
  "hash",
  "data",
  "createdAt",
  "updatedAt",
  "created_at",
  "updated_at",
  "textLemmatized",
  "attributedTo",
]);

function normalizeEntityKeys(payload) {
  // 与 mem0 normalizePayload 一致：仅三个实体键 camel → snake
  if ("userId" in payload && !("user_id" in payload)) {
    payload.user_id = payload.userId;
    delete payload.userId;
  }
  if ("agentId" in payload && !("agent_id" in payload)) {
    payload.agent_id = payload.agentId;
    delete payload.agentId;
  }
  if ("runId" in payload && !("run_id" in payload)) {
    payload.run_id = payload.runId;
    delete payload.runId;
  }
  return payload;
}

function scan({ dbPath, actorVariants }) {
  if (!dbPath || !existsSync(dbPath)) return [];
  const allowed = new Set(Array.isArray(actorVariants) ? actorVariants : []);
  if (allowed.size === 0) return [];

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare("SELECT id, payload FROM vectors").all();
  } finally {
    db.close();
  }

  const out = [];
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    normalizeEntityKeys(payload);
    const uid = typeof payload.user_id === "string" ? payload.user_id : "";
    if (!uid || !allowed.has(uid)) continue;

    const metadata = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!EXCLUDED_KEYS.has(key)) metadata[key] = value;
    }
    out.push({
      id: row.id,
      memory: typeof payload.data === "string" ? payload.data : "",
      createdAt:
        typeof payload.createdAt === "string"
          ? payload.createdAt
          : typeof payload.created_at === "string"
            ? payload.created_at
            : undefined,
      updatedAt:
        typeof payload.updatedAt === "string"
          ? payload.updatedAt
          : typeof payload.updated_at === "string"
            ? payload.updated_at
            : undefined,
      metadata,
    });
  }
  return out;
}

parentPort?.on("message", (msg) => {
  if (!msg || msg.type !== "scan" || typeof msg.id !== "number") return;
  try {
    const rows = scan(msg);
    parentPort.postMessage({ id: msg.id, ok: true, rows });
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
