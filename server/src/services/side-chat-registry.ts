// 旁聊注册表（2026-11-07）：手机端侧边栏「旁聊」列表的唯一数据源。
//
// 设计：
//  - 每个 actor 一个 JSON 文件：data/side-chats/{actorId}.json
//  - 条目只存元数据（id / title / createdAt / updatedAt）；消息本体在
//    chat-thread-store 的 `side:<actor>:<id>` 线程里（与主会话物理隔离）。
//  - 懒加载 + 内存缓存；变更时单 actor 落盘，失败静默降级。
//  - 列表预览/条数由路由从线程实时派生，注册表不重复存内容。
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getDataDir } from "../config/data-dir.js";

export interface SideChatEntry {
  /** 旁聊短 id（拼成 `side:<actor>:<id>` 的线程键） */
  id: string;
  actorId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

type PersistedShape = { chats?: SideChatEntry[] };

/** 每 actor 旁聊条数上限（防膨胀；超限淘汰最久未更新的）。 */
const MAX_ENTRIES_PER_ACTOR = 100;

function parseEntry(value: unknown, expectActor: string): SideChatEntry | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return null;
  const actorId = typeof o.actorId === "string" ? o.actorId : "";
  if (!actorId || actorId !== expectActor) return null;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  return {
    id,
    actorId,
    title: title || "新旁聊",
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString(),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
  };
}

export class SideChatRegistry {
  private readonly byActor = new Map<string, SideChatEntry[]>();
  private readonly dirPath: string;
  private loadPromise: Promise<void> | null = null;

  constructor(opts?: { dirPath?: string }) {
    this.dirPath =
      opts?.dirPath ?? process.env.SIDE_CHAT_DIR ?? join(getDataDir(), "side-chats");
  }

  private async loadAll(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dirPath);
    } catch {
      return; // 目录不存在 = 无历史旁聊
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const actorId = file.slice(0, -".json".length);
      if (!actorId) continue;
      try {
        const raw = await readFile(join(this.dirPath, file), "utf8");
        const data = JSON.parse(raw) as PersistedShape;
        const list: SideChatEntry[] = [];
        for (const item of data.chats ?? []) {
          const entry = parseEntry(item, actorId);
          if (entry) list.push(entry);
        }
        this.byActor.set(actorId, list);
      } catch {
        /* 单文件损坏跳过 */
      }
    }
  }

  /** 惰性加载（首次访问时读盘），并发安全。 */
  ready(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.loadAll();
    return this.loadPromise;
  }

  private async persist(actorId: string): Promise<void> {
    try {
      await mkdir(this.dirPath, { recursive: true });
      const payload: PersistedShape = { chats: this.byActor.get(actorId) ?? [] };
      await writeFile(
        join(this.dirPath, `${actorId}.json`),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
    } catch (err) {
      console.log(`[SideChatRegistry] 落盘失败（忽略，内存态仍生效）actor=${actorId}: ${err}`);
    }
  }

  /** 列表（按最近更新倒序；q 命中标题/预览由调用方过滤）。 */
  async list(actorId: string): Promise<SideChatEntry[]> {
    await this.ready();
    const list = [...(this.byActor.get(actorId) ?? [])];
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return list;
  }

  /** 新建旁聊（默认标题「新旁聊」；id 由服务端生成）。 */
  async create(actorId: string, title?: unknown): Promise<SideChatEntry> {
    await this.ready();
    const now = new Date().toISOString();
    const entry: SideChatEntry = {
      id: randomUUID().replace(/-/g, "").slice(0, 12),
      actorId,
      title: String(title ?? "").trim().slice(0, 40) || "新旁聊",
      createdAt: now,
      updatedAt: now,
    };
    const list = this.byActor.get(actorId) ?? [];
    list.unshift(entry);
    if (list.length > MAX_ENTRIES_PER_ACTOR) list.length = MAX_ENTRIES_PER_ACTOR;
    this.byActor.set(actorId, list);
    await this.persist(actorId);
    return entry;
  }

  /** 重命名（长按列表项触发）。 */
  async rename(actorId: string, id: string, title: unknown): Promise<SideChatEntry | null> {
    await this.ready();
    const next = String(title ?? "").trim().slice(0, 40);
    if (!next) return null;
    const entry = (this.byActor.get(actorId) ?? []).find((e) => e.id === id);
    if (!entry) return null;
    entry.title = next;
    await this.persist(actorId);
    return entry;
  }

  /** 删除（线程清理由路由负责）。 */
  async remove(actorId: string, id: string): Promise<boolean> {
    await this.ready();
    const list = this.byActor.get(actorId) ?? [];
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.byActor.set(actorId, list);
    await this.persist(actorId);
    return true;
  }

  /** 消息落库后刷新最近更新时间（列表排序用）。 */
  async touch(actorId: string, id: string): Promise<void> {
    await this.ready();
    const entry = (this.byActor.get(actorId) ?? []).find((e) => e.id === id);
    if (!entry) return;
    entry.updatedAt = new Date().toISOString();
    await this.persist(actorId);
  }
}

let singleton: SideChatRegistry | null = null;

export function getSideChatRegistry(): SideChatRegistry {
  if (!singleton) singleton = new SideChatRegistry();
  return singleton;
}
