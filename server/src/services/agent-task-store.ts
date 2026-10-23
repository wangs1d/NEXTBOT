/**
 * Agent 自主任务持久化层
 *
 * 设计参考 chat-thread-persist.ts:JSON 文件 + 防抖写 + 启动加载 + 异常处理。
 * 内存缓存作为唯一真相源,所有写操作通过 persistChain 串行化落盘,
 * 避免高频写盘与并发冲突。
 */

import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AgentTask,
  AgentTaskPersistShape,
  AgentTaskStatus,
  CreateAgentTaskInput,
} from "./agent-task-types.js";

/** 生成 6 位随机后缀(小写字母+数字) */
function randomSuffix6(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

/** 生成任务 ID:task-{毫秒时间戳}-{随机6位} */
function generateTaskId(): string {
  return `task-${Date.now()}-${randomSuffix6()}`;
}

export class AgentTaskStore {
  /** 内存缓存(唯一真相源) */
  private data: AgentTaskPersistShape = { tasks: {} };
  /** 落盘文件路径 */
  private readonly filePath: string;
  /** 串行化写入链,保证写操作按顺序执行,避免并发冲突 */
  private persistChain: Promise<void> = Promise.resolve();
  /** 防抖间隔(毫秒) */
  private readonly debounceMs = 250;
  /** 每个 taskId 对应的防抖定时器 */
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(filePath?: string) {
    const defaultDir = getDataDir();
    this.filePath =
      filePath?.trim() ||
      process.env.AGENT_TASK_PERSIST_FILE?.trim() ||
      join(defaultDir, "agent-tasks.json");
  }

  /** 获取落盘文件路径(仅用于调试 / 单测) */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * 启动时加载持久化数据。
   * 文件不存在(ENOENT)静默忽略,其他错误向上抛出。
   */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AgentTaskPersistShape;
      if (!parsed?.tasks || typeof parsed.tasks !== "object") return;
      this.data = parsed;
    } catch (e: unknown) {
      const code =
        e && typeof e === "object" && "code" in e
          ? String((e as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw e;
    }
  }

  /** 创建任务并入队,返回新建的任务对象 */
  create(input: CreateAgentTaskInput): AgentTask {
    const now = new Date().toISOString();
    const task: AgentTask = {
      id: generateTaskId(),
      actorId: input.actorId,
      sessionId: input.sessionId,
      chatUserMessageId: input.chatUserMessageId,
      goal: input.goal,
      status: "pending",
      subtasks: [],
      currentRound: 0,
      maxRounds: input.maxRounds ?? 30,
      history: [],
      requiresApproval: false,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      priority: input.priority ?? 10,
      tags: input.tags ?? [],
    };
    this.data.tasks[task.id] = task;
    this.scheduleSave(task.id);
    return task;
  }

  /** 获取单个任务,不存在返回 undefined */
  get(taskId: string): AgentTask | undefined {
    return this.data.tasks[taskId];
  }

  /** 列出任务,可按 actorId / status 过滤 */
  list(filter?: { actorId?: string; status?: AgentTaskStatus }): AgentTask[] {
    const all = Object.values(this.data.tasks);
    if (!filter) return all;
    return all.filter((t) => {
      if (filter.actorId !== undefined && t.actorId !== filter.actorId) return false;
      if (filter.status !== undefined && t.status !== filter.status) return false;
      return true;
    });
  }

  /**
   * 列出可执行任务:pending(待开始) / paused(恢复) / executing(未完成)。
   * 按优先级升序(数字越小越优先),同优先级按创建时间升序(FIFO)。
   */
  listRunnable(): AgentTask[] {
    const runnableStatuses: ReadonlySet<AgentTaskStatus> = new Set([
      "pending",
      "paused",
      "executing",
    ]);
    return Object.values(this.data.tasks)
      .filter((t) => runnableStatuses.has(t.status))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }

  /**
   * 更新任务:传入 updater 函数就地修改 task 字段。
   * 自动刷新 updatedAt 并安排防抖落盘,返回更新后的任务。
   * 任务不存在时返回 undefined。
   */
  update(taskId: string, updater: (task: AgentTask) => void): AgentTask | undefined {
    const task = this.data.tasks[taskId];
    if (!task) return undefined;
    updater(task);
    task.updatedAt = new Date().toISOString();
    this.scheduleSave(taskId);
    return task;
  }

  /**
   * 防抖落盘:同一 taskId 在 debounceMs 内的多次更新只触发一次写盘。
   * 实际写操作串行挂到 persistChain 上,保证顺序一致。
   */
  scheduleSave(taskId: string): void {
    const prev = this.debounceTimers.get(taskId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      this.persistChain = this.persistChain.then(() => this.flushToDisk());
    }, this.debounceMs);
    this.debounceTimers.set(taskId, timer);
  }

  /**
   * 立即落盘:清空所有挂起的防抖定时器,把当前内存数据写入磁盘,
   * 并等待 persistChain 完全收敛。
   */
  async flush(): Promise<void> {
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.persistChain = this.persistChain.then(() => this.flushToDisk());
    await this.persistChain;
  }

  /** 删除任务:从内存移除,清理对应防抖定时器,并立即安排一次落盘 */
  delete(taskId: string): void {
    delete this.data.tasks[taskId];
    const prev = this.debounceTimers.get(taskId);
    if (prev) clearTimeout(prev);
    this.debounceTimers.delete(taskId);
    this.persistChain = this.persistChain.then(() => this.flushToDisk());
  }

  /** 实际写盘:确保目录存在后写入整个 JSON(美化格式 + 末尾换行) */
  private async flushToDisk(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}

let sharedStore: AgentTaskStore | null = null;

/** 获取 AgentTaskStore 单例(参考 getChatThreadStore 模式) */
export function getAgentTaskStore(): AgentTaskStore {
  if (!sharedStore) {
    sharedStore = new AgentTaskStore();
  }
  return sharedStore;
}

/** 仅供单测重置单例 */
export function resetAgentTaskStoreForTests(): void {
  sharedStore = null;
}
