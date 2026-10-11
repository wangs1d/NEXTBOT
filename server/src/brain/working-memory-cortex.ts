// Agent Brain Center — WorkingMemoryCortex（前额叶工作记忆）
//
// 职责：当前任务上下文、活跃目标、待办事项、最近对话要点。
//   像前额叶皮层维持"正在想的事"，区别于 MemoryCortex（长期记忆）。
//
// 核心机制：
//   1. 工作记忆槽位（slot）：固定容量 7±2（米勒定律），超出按 LRU 淘汰
//   2. 活跃目标栈：当前正在追求的目标（LIFO）
//   3. 待办事项：短时间尺度（24h）的 todos
//   4. 遗忘曲线：30 分钟未触碰的目标降级为"被动"，1 小时自动遗忘
//
// 深度链接：
//   - cognize 阶段 1 读取 WorkingMemory 注入 context.workingMemory
//   - DecisionHub.gatherContext 拉取 WorkingMemory 作为短期上下文
//   - 每轮 cognize 都更新 lastTouchedAt
//
// 设计要点：
//   - 与 MemoryCortex 区分：Memory 是长期（持久化），WorkingMemory 是短期（内存）
//   - 与 TaskSwitchingCortex 配合：暂停任务时快照 WorkingMemory，恢复时还原

import type { MemoryItem } from "./types.js";

/** 工作记忆槽位（最多 7 个，超出 LRU 淘汰） */
export interface WorkingMemorySlot {
  key: string;
  value: string;
  importance: "high" | "medium" | "low";
  createdAt: string;
  lastTouchedAt: string;
  touchCount: number;
}

/** 活跃目标（栈式管理） */
export interface ActiveGoal {
  id: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  createdAt: string;
  lastTouchedAt: string;
  status: "active" | "paused" | "completed" | "forgotten";
  subGoals?: string[];
}

/** 待办事项（24h 尺度） */
export interface TodoItem {
  id: string;
  content: string;
  dueAt?: string;
  status: "pending" | "in_progress" | "done";
  createdAt: string;
}

/** 工作记忆快照（可被 TaskSwitchingCortex 序列化保存） */
export interface WorkingMemorySnapshot {
  actorId: string;
  slots: WorkingMemorySlot[];
  goals: ActiveGoal[];
  todos: TodoItem[];
  capturedAt: string;
}

/** 米勒定律：工作记忆容量 7±2 */
const MAX_SLOTS = 7;
/** 遗忘曲线阈值 */
const DECAY_PASSIVE_MS = 30 * 60_000; // 30 分钟未触碰 → 降级
const DECAY_FORGET_MS = 60 * 60_000; // 1 小时未触碰 → 遗忘
/** 工作记忆整体陈旧阈值（2026-10-09）：全部条目都超过此时长时，摘要里加"可能过时"提示 */
const WM_STALE_MS = 6 * 60 * 60_000;

/**
 * 相对年龄标签（分钟/小时/天粒度）。工作记忆摘要在易变层、每轮本就重算，
 * 细粒度不影响 prefix cache；此处用相对年龄把「多久前」显式交给模型。
 */
function wmAgeLabel(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "未知";
  const min = Math.floor((nowMs - t) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

/**
 * 工作记忆皮层。
 *
 * 维持"当前正在想的事"——区别于 MemoryCortex 的长期记忆。
 * 容量受限（7±2），有遗忘曲线，是任务上下文的核心载体。
 */
export class WorkingMemoryCortex {
  /** actorId → 工作记忆 */
  private readonly store = new Map<string, WorkingMemorySnapshot>();
  /** 统计：读取次数 */
  private readCount = 0;
  /** 统计：写入次数 */
  private writeCount = 0;
  /** 统计：遗忘次数 */
  private decayedCount = 0;

  /** 加载某 actor 的工作记忆，不存在时初始化空记忆 */
  load(actorId: string): WorkingMemorySnapshot {
    this.readCount++;
    const wm =
      this.store.get(actorId) ??
      ({
        actorId,
        slots: [],
        goals: [],
        todos: [],
        capturedAt: new Date().toISOString(),
      } as WorkingMemorySnapshot);
    this.store.set(actorId, wm);
    return wm;
  }

  /** 保存工作记忆（更新 capturedAt） */
  save(actorId: string, wm: WorkingMemorySnapshot): void {
    this.writeCount++;
    wm.capturedAt = new Date().toISOString();
    this.store.set(actorId, wm);
  }

  /** 添加槽位（超出 MAX_SLOTS 时按 LRU 淘汰最旧 low importance 的） */
  setSlot(actorId: string, key: string, value: string, importance: WorkingMemorySlot["importance"] = "medium"): void {
    const wm = this.load(actorId);
    const now = new Date().toISOString();
    const existing = wm.slots.find((s) => s.key === key);
    if (existing) {
      existing.value = value;
      existing.importance = importance;
      existing.lastTouchedAt = now;
      existing.touchCount++;
    } else {
      wm.slots.push({
        key,
        value,
        importance,
        createdAt: now,
        lastTouchedAt: now,
        touchCount: 1,
      });
      // 容量超限时淘汰：优先淘汰 low + 最久未触碰
      if (wm.slots.length > MAX_SLOTS) {
        wm.slots.sort((a, b) => {
          if (a.importance !== b.importance) {
            const order = { low: 0, medium: 1, high: 2 };
            return order[a.importance] - order[b.importance];
          }
          return new Date(a.lastTouchedAt).getTime() - new Date(b.lastTouchedAt).getTime();
        });
        wm.slots.shift(); // 淘汰最旧的 low
      }
    }
    this.save(actorId, wm);
  }

  /** 推入目标到栈顶 */
  /**
   * 推入新目标到工作记忆。
   *
   * 性能优化（方案 C）：接受外部已加载的 wm，避免内部重复 load（complex 路径
   * decidePassive 会先 load 一次用于路由，再调 pushGoal，避免第二次 load）。
   */
  pushGoal(
    actorId: string,
    description: string,
    priority: ActiveGoal["priority"] = "medium",
    existingWm?: WorkingMemorySnapshot,
  ): string {
    const wm = existingWm ?? this.load(actorId);
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    wm.goals.push({
      id,
      description,
      priority,
      createdAt: now,
      lastTouchedAt: now,
      status: "active",
    });
    this.save(actorId, wm);
    return id;
  }

  /** 弹出栈顶目标（标记为 completed） */
  popGoal(actorId: string): ActiveGoal | null {
    const wm = this.load(actorId);
    for (let i = wm.goals.length - 1; i >= 0; i--) {
      if (wm.goals[i].status === "active") {
        wm.goals[i].status = "completed";
        this.save(actorId, wm);
        return wm.goals[i];
      }
    }
    return null;
  }

  /** 获取当前活跃目标（栈顶 active） */
  getCurrentGoal(actorId: string): ActiveGoal | null {
    const wm = this.load(actorId);
    for (let i = wm.goals.length - 1; i >= 0; i--) {
      if (wm.goals[i].status === "active") return wm.goals[i];
    }
    return null;
  }

  /** 添加待办 */
  addTodo(actorId: string, content: string, dueAt?: string): string {
    const wm = this.load(actorId);
    const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    wm.todos.push({
      id,
      content,
      dueAt,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    this.save(actorId, wm);
    return id;
  }

  /** 触摸某槽位（更新 lastTouchedAt，避免遗忘） */
  /**
   * 触摸 slot/goal 保持活跃。
   *
   * 性能优化（方案 C）：接受外部已加载的 wm，避免内部重复 load。
   * 注意：若调用方已修改 wm 并打算后续 save，传入 wm 时本方法不会重复 save。
   */
  touch(
    actorId: string,
    slotKey?: string,
    goalId?: string,
    existingWm?: WorkingMemorySnapshot,
  ): void {
    const wm = existingWm ?? this.load(actorId);
    const now = new Date().toISOString();
    if (slotKey) {
      const slot = wm.slots.find((s) => s.key === slotKey);
      if (slot) {
        slot.lastTouchedAt = now;
        slot.touchCount++;
      }
    }
    if (goalId) {
      const goal = wm.goals.find((g) => g.id === goalId);
      if (goal) goal.lastTouchedAt = now;
    }
    this.save(actorId, wm);
  }

  /**
   * 应用遗忘曲线：
   *   - 30 分钟未触碰 → 降级为 paused（目标）/降低 importance（槽位）
   *   - 1 小时未触碰 → 标记 forgotten / 移除
   * 应由 BrainStem 定期调用（如每 5 分钟）。
   */
  decay(): { decayed: number; forgotten: number } {
    const now = Date.now();
    let decayed = 0;
    let forgotten = 0;

    for (const [actorId, wm] of this.store) {
      let changed = false;
      for (const goal of wm.goals) {
        if (goal.status !== "active") continue;
        const age = now - new Date(goal.lastTouchedAt).getTime();
        if (age > DECAY_FORGET_MS) {
          goal.status = "forgotten";
          forgotten++;
          changed = true;
        } else if (age > DECAY_PASSIVE_MS) {
          goal.status = "paused";
          decayed++;
          changed = true;
        }
      }
      // 槽位遗忘：1 小时未触碰的 low 槽位移除
      wm.slots = wm.slots.filter((s) => {
        const age = now - new Date(s.lastTouchedAt).getTime();
        if (age > DECAY_FORGET_MS && s.importance === "low") {
          forgotten++;
          return false;
        }
        return true;
      });
      if (changed) this.save(actorId, wm);
    }

    this.decayedCount += decayed + forgotten;
    return { decayed, forgotten };
  }

  /** 导出为 MemoryItem（持久化到 MemoryCortex 用） */
  toMemoryItems(actorId: string): MemoryItem[] {
    const wm = this.load(actorId);
    const now = new Date().toISOString();
    const items: MemoryItem[] = [];
    for (const goal of wm.goals.filter((g) => g.status === "active")) {
      items.push({
        actorId,
        kind: "event",
        domain: "episodic",
        content: `活跃目标：${goal.description}（优先级=${goal.priority}）`,
        importance: goal.priority,
        metadata: { tags: ["working_memory", "goal"], goalId: goal.id },
        source: "system",
        timestamp: now,
      });
    }
    for (const todo of wm.todos.filter((t) => t.status === "pending")) {
      items.push({
        actorId,
        kind: "event",
        domain: "episodic",
        content: `待办：${todo.content}${todo.dueAt ? `（截止 ${todo.dueAt}）` : ""}`,
        importance: "medium",
        metadata: { tags: ["working_memory", "todo"], todoId: todo.id },
        source: "system",
        timestamp: now,
      });
    }
    // 槽位也导出为语义记忆（图链接：让槽位成为图谱节点）
    for (const slot of wm.slots) {
      items.push({
        actorId,
        kind: "fact",
        domain: "semantic",
        content: `${slot.key}：${slot.value}`,
        importance: slot.importance,
        metadata: { tags: ["working_memory", "slot"], slotKey: slot.key, touchCount: slot.touchCount },
        source: "system",
        timestamp: now,
      });
    }
    return items;
  }

  /**
   * 提取工作记忆摘要（注入 streamCompletion 的 system prompt 用）。
   *
   * 性能优化：纯内存操作，<0.1ms。
   * 深度链接：BrainCenter.cognize 返回值携带 → agent-core.ts 注入 prompt。
   *
   * 时间锚（2026-10-09）：槽位/目标附带「更新于 X」相对年龄，并在整体陈旧时给出
   * 「可能已过时」提示——此前槽位只有 key/value 无时间，模型会把旧槽位当现事复述
   * （「刚才你说好饿」家族的另一处入口）。纯展示层标注，不改淘汰逻辑。
   */
  toSummary(actorId: string): string {
    const wm = this.load(actorId);
    const parts: string[] = [];
    const nowMs = Date.now();

    // 活跃目标（最多 3 个，按优先级和时间排序）
    const activeGoals = wm.goals
      .filter((g) => g.status === "active")
      .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3 };
        return order[a.priority] - order[b.priority];
      })
      .slice(0, 3);
    if (activeGoals.length > 0) {
      parts.push(
        `当前目标：${activeGoals
          .map((g) => `${g.description}（${g.priority}·${wmAgeLabel(g.lastTouchedAt, nowMs)}）`)
          .join("；")}`,
      );
    }

    // 工作记忆槽位（最多 7 个，按重要性和最近触碰排序）
    const recentSlots = [...wm.slots]
      .sort((a, b) => {
        if (a.importance !== b.importance) {
          const order = { high: 0, medium: 1, low: 2 };
          return order[a.importance] - order[b.importance];
        }
        return new Date(b.lastTouchedAt).getTime() - new Date(a.lastTouchedAt).getTime();
      })
      .slice(0, MAX_SLOTS);
    if (recentSlots.length > 0) {
      parts.push(
        `已知信息：${recentSlots
          .map((s) => `${s.key}=${s.value}（更新于${wmAgeLabel(s.lastTouchedAt, nowMs)}）`)
          .join("；")}`,
      );
    }

    // 待办（最多 3 个 pending）
    const pendingTodos = wm.todos.filter((t) => t.status === "pending").slice(0, 3);
    if (pendingTodos.length > 0) {
      parts.push(
        `待办：${pendingTodos.map((t) => `${t.content}${t.dueAt ? `（截止 ${t.dueAt}）` : ""}`).join("；")}`,
      );
    }

    // 时效提示：全部条目均较旧（>6h）时显式标注，避免模型把陈旧工作记忆当"此刻"
    const newestTouched = Math.max(
      0,
      ...recentSlots.map((s) => new Date(s.lastTouchedAt).getTime()),
      ...activeGoals.map((g) => new Date(g.lastTouchedAt).getTime()),
    );
    if (parts.length > 0 && newestTouched > 0 && nowMs - newestTouched > WM_STALE_MS) {
      parts.unshift("（以下工作记忆已有一段时间未更新，可能过时；仅在话题相关时参考，不要当作「刚刚/此刻」的事实）");
    }

    return parts.join("\n");
  }

  /**
   * 自动提取对话要点并写入槽位（让 setSlot 真正被使用）。
   *
   * 规则驱动，不调 LLM：
   *  - 识别实体（人名/数字/时间）→ 写入 slot
   *  - 识别意图关键词 → 写入 slot
   *  - 容量超限时 LRU 淘汰
   *
   * 深度链接：BrainCenter.cognize 阶段 3 调用，让工作记忆真正"记住"对话内容。
   */
  extractAndSetSlots(actorId: string, userText: string): void {
    if (!userText) return;

    // 规则 1：数字 + 单位（如 "500 元"、"3 点"）
    const numberMatches = userText.match(/(\d+(?:\.\d+)?)\s*(元|块|点|分|号|个|次|分钟|小时|天|周|月|年)/g);
    if (numberMatches) {
      for (const m of numberMatches.slice(0, 3)) {
        this.setSlot(actorId, `数量_${m}`, m, "medium");
      }
    }

    // 规则 2：人名（简单规则：张/李/王/刘/陈 + 单字名）
    const nameMatches = userText.match(/[张李王刘陈赵周吴徐孙]\S{1,2}(?=\s|$|，|。|，|给|对|和)/g);
    if (nameMatches) {
      for (const n of [...new Set(nameMatches)].slice(0, 2)) {
        this.setSlot(actorId, `人物_${n}`, n, "medium");
      }
    }

    // 规则 3：时间表达
    const timeMatches = userText.match(/(今天|明天|后天|下周|下个月|明年|早上|下午|晚上|现在|稍后|等会儿)/g);
    if (timeMatches) {
      for (const t of [...new Set(timeMatches)].slice(0, 2)) {
        this.setSlot(actorId, `时间_${t}`, t, "medium");
      }
    }

    // 规则 4：关键动作
    const actionKeywords = ["转账", "查询", "打开", "关闭", "发送", "创建", "删除", "修改", "下载", "上传"];
    for (const kw of actionKeywords) {
      if (userText.includes(kw)) {
        this.setSlot(actorId, `动作_${kw}`, kw, "high");
      }
    }
  }

  /**
   * 由 LLM 提取主题词后写入槽位（取代硬编码主题词列表）。
   *
   * 调用方：BrainCenter.cognize 阶段异步调一次轻量 LLM，把识别到的 1-3 个主题词
   * 通过此方法写入工作记忆，让 toSummary 真正反映"在聊什么"。
   */
  setTopicSlots(actorId: string, topics: string[]): void {
    const seen = new Set<string>();
    for (const topic of topics.slice(0, 3)) {
      const trimmed = topic.trim();
      if (!trimmed || trimmed.length > 12 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      this.setSlot(actorId, `主题_${trimmed}`, trimmed, "medium");
    }
  }

  /** 快照：供 TaskSwitchingCortex 在暂停任务时调用 */
  snapshot(actorId: string): WorkingMemorySnapshot {
    return JSON.parse(JSON.stringify(this.load(actorId)));
  }

  /** 从快照恢复（TaskSwitchingCortex resume 时调用） */
  restore(actorId: string, snap: WorkingMemorySnapshot): void {
    this.store.set(actorId, JSON.parse(JSON.stringify(snap)));
    this.writeCount++;
  }

  getStats(): {
    activeActors: number;
    readCount: number;
    writeCount: number;
    decayedCount: number;
  } {
    return {
      activeActors: this.store.size,
      readCount: this.readCount,
      writeCount: this.writeCount,
      decayedCount: this.decayedCount,
    };
  }

  async start(): Promise<void> {
    console.log("[WorkingMemoryCortex] 启动完成（容量上限 %d）", MAX_SLOTS);
  }
  async stop(): Promise<void> {
    this.store.clear();
    console.log("[WorkingMemoryCortex] 已停止");
  }
}
