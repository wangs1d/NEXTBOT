/**
 * Agent 自主任务状态机编排器
 *
 * 核心职责:
 * 1. 外置持久任务队列 + 状态机做全局进度管理
 * 2. LLM 只做顶层任务拆解、单步原子动作决策和反思纠错(每轮 maxRounds=1)
 * 3. 和真实 Windows 环境做感知-执行-校验闭环
 * 4. 长周期自主执行,脱离纯 Prompt 上下文管理任务进度
 *
 * 闭环循环:
 *   读取环境状态 → LLM 生成下一步动作 → 执行工具 → 校验结果 → 更新外部状态 → 循环直到完成
 *
 * 状态流转:
 *   pending → planning → executing ↔ verifying → done
 *                                    ↓
 *                          awaiting_approval → executing / failed
 *                                    ↓
 *                                  failed / paused
 */

import type { ExternalChatProvider, AgentStreamOptions } from "../external-model/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { AuditService } from "./audit-service.js";
import { getAgentTaskSafety } from "./agent-task-safety.js";
import { getAgentTaskStore } from "./agent-task-store.js";
import { getTaskPlanStore } from "../agent/task-plan-store.js";
import type {
  AgentTask,
  AgentTaskStatus,
  CreateAgentTaskInput,
  LlmStepInput,
  LlmStepOutput,
  SubTask,
  TaskHistoryEntry,
  TaskProgressEvent,
} from "./agent-task-types.js";

/** 编排器依赖 */
export type AgentTaskOrchestratorDeps = {
  provider: ExternalChatProvider;
  toolRegistry: ToolRegistry;
  audit?: AuditService;
};

/** 启动任务执行的选项 */
export interface RunTaskOptions {
  /** WS 事件回调(推送给前端) */
  onProgress?: (event: TaskProgressEvent) => void;
  /** LLM 流式文本回调(实时显示 LLM 思考) */
  onAssistantDelta?: (delta: string) => void;
  /** 工具执行开始回调 */
  onToolExecuteStart?: (info: { id: string; name: string; args: Record<string, unknown> }) => void;
  /** 工具执行完成回调 */
  onToolExecuted?: (info: { id: string; name: string; ok: boolean; result: unknown; durationMs: number }) => void;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 可用工具集(传给 LLM 的 ChatCompletionTool schema) */
export type ToolSchemaProvider = () => Array<{ type: "function"; function: { name: string; [k: string]: unknown } }>;

/** 状态机允许的工具白名单(状态机模式下始终暴露这些,绕过 contextual 筛选) */
export const STATE_MACHINE_TOOL_ALLOWLIST: string[] = [
  // 桌面自动化
  "desktop.open",
  "desktop.run_preset",
  "desktop.run_shell",
  "desktop.uia_query",
  "desktop.run_input",
  "desktop.run_automation",
  "desktop.http_get",
  "desktop.web_search",
  "desktop.web_fetch",
  "desktop.visual.screenshot",
  // 服务端联网工具
  "search_web",
  "search_images",
  "search_videos",
  "fetch_web",
  "http.request",
  "info.inspect_webpage",
  "info.navigate_site",
  // 服务端 Playwright 无头浏览器
  "agent_browser.open",
  "agent_browser.click",
  "agent_browser.type",
  "agent_browser.scroll",
  "agent_browser.screenshot",
  "agent_browser.extract_text",
  "agent_browser.wait_for",
  "agent_browser.close",
];

/** 格式化子任务进度 section(给 system prompt 用) */
function formatSubtasksSection(input: LlmStepInput): string {
  if (input.currentSubtask) {
    return `当前: ${input.currentSubtask.description} (已尝试 ${input.currentSubtask.attempts}/${input.currentSubtask.maxAttempts})`;
  }
  if (input.completedSubtasks.length === 0 && input.remainingSubtasks.length === 0) {
    return "(尚未拆解子任务,请先规划)";
  }
  const parts: string[] = [];
  if (input.completedSubtasks.length > 0) {
    parts.push(`已完成: ${input.completedSubtasks.join("; ")}`);
  }
  if (input.remainingSubtasks.length > 0) {
    parts.push(`待完成: ${input.remainingSubtasks.join("; ")}`);
  }
  return parts.join("\n");
}

export class AgentTaskOrchestrator {
  private readonly provider: ExternalChatProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly audit?: AuditService;
  /** 正在运行的任务 taskId 集合(防并发) */
  private readonly runningTasks = new Set<string>();
  /**
   * 运行期 options 暂存（2026-09-19 P1-1 审批续跑）：createAndRun 时登记，
   * runLoop 退出时按状态取舍——终态清除，awaiting_approval/paused 保留。
   * approveTask 依据它重新拉起 runLoop，消除「批了只翻状态不续跑」的假确认；
   * 进程重启后 stash 丢失，approveTask 诚实返回 false（不再静默假确认）。
   */
  private readonly taskOptions = new Map<string, RunTaskOptions>();
  /** 主动性模块（可选注入）：任务完成时触发主动恭喜 */
  private proactivityHub: import("../proactivity/proactivity-hub.js").ProactivityHub | null = null;

  constructor(deps: AgentTaskOrchestratorDeps) {
    this.provider = deps.provider;
    this.toolRegistry = deps.toolRegistry;
    this.audit = deps.audit;
  }

  /** 注入主动性模块（任务完成 → 主动恭喜的触发接线） */
  setProactivityHub(hub: import("../proactivity/proactivity-hub.js").ProactivityHub | null): void {
    this.proactivityHub = hub;
  }

  /**
   * 创建并启动一个自主任务。
   * 立即返回 taskId,后台异步执行主循环。
   */
  createAndRun(input: CreateAgentTaskInput, options: RunTaskOptions): string {
    const store = getAgentTaskStore();
    const task = store.create(input);
    this.taskOptions.set(task.id, options);

    // 异步启动主循环,不阻塞调用方
    void this.runLoop(task.id, options).catch((err) => {
      console.error(`[agent-task-orchestrator] 任务 ${task.id} 主循环异常:`, err);
      store.update(task.id, (t) => {
        t.status = "failed";
        t.error = err instanceof Error ? err.message : String(err);
        t.completedAt = new Date().toISOString();
      });
      options.onProgress?.({
        taskId: task.id,
        actorId: task.actorId,
        sessionId: task.sessionId,
        type: "task_failed",
        message: `任务异常: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
    });

    return task.id;
  }

  async runToCompletion(input: CreateAgentTaskInput, options: RunTaskOptions): Promise<AgentTask> {
    const store = getAgentTaskStore();
    const task = store.create(input);
    await this.runLoop(task.id, options);
    const finished = store.get(task.id);
    if (!finished) {
      throw new Error(`Task ${task.id} disappeared while running`);
    }
    return finished;
  }

  /**
   * 创建并后台执行一个「通用复杂任务」（非桌面自动化状态机）。
   *
   * 与 createAndRun 共享「后台 fire-and-forget + 任务持久化 + WS 事件推送」骨架，
   * 但执行逻辑由 executor 决定（子 Agent 委派 / plan_execute 等），
   * 不经过 runLoop 的桌面自动化状态机（planning→executing→verifying）。
   *
   * executor 内部应通过 options.onAssistantDelta 流式推送最终回复，
   * 通过 options.onToolExecuteStart / onToolExecuted 推送工具进度。
   */
  createAndRunGeneric(
    input: CreateAgentTaskInput,
    executor: (taskId: string, options: RunTaskOptions) => Promise<void>,
    options: RunTaskOptions,
  ): string {
    const store = getAgentTaskStore();
    const task = store.create(input);

    void (async () => {
      try {
        this.emitProgress(task, "task_created", `复杂任务已开始: ${task.goal.slice(0, 80)}`, options);
        await executor(task.id, options);
        store.update(task.id, (t) => {
          t.status = "done";
          t.completedAt = new Date().toISOString();
        });
        this.emitProgress(task, "task_completed", "复杂任务已完成", options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agent-task-orchestrator] 通用复杂任务 ${task.id} 异常:`, err);
        store.update(task.id, (t) => {
          t.status = "failed";
          t.error = msg;
          t.completedAt = new Date().toISOString();
        });
        this.emitProgress(task, "task_failed", `复杂任务失败: ${msg}`, options);
      }
    })();

    return task.id;
  }

  /**
   * 状态机主循环。
   *
   * 每轮:
   * 1. 读取 task 当前状态
   * 2. 根据状态决定 LLM 调用的 system prompt
   * 3. 调 provider.streamCompletion(maxRounds=1),LLM 产出 1 个动作或反思
   * 4. 执行工具(若有)
   * 5. 校验结果(可选 screenshot/uia_query)
   * 6. 更新 task 状态 + 持久化
   * 7. 循环直到 done/failed/awaiting_approval/paused
   */
  private async runLoop(taskId: string, options: RunTaskOptions): Promise<void> {
    if (this.runningTasks.has(taskId)) {
      throw new Error(`任务 ${taskId} 已在运行中`);
    }
    this.runningTasks.add(taskId);

    try {
      const store = getAgentTaskStore();

      while (!options.signal?.aborted) {
        const task = store.get(taskId);
        if (!task) {
          throw new Error(`任务 ${taskId} 不存在`);
        }

        // 终态检查
        if (task.status === "done" || task.status === "failed" || task.status === "paused" || task.status === "awaiting_approval") {
          break;
        }

        // 轮次上限检查
        if (task.currentRound >= task.maxRounds) {
          this.transitionTo(taskId, "failed", `轮次上限 ${task.maxRounds} 已达`, options);
          break;
        }

        // 状态机分发
        await this.runOneRound(taskId, options);

        // 短暂让出事件循环,避免 busy loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      this.runningTasks.delete(taskId);
      // options 暂存按状态取舍（2026-09-19 P1-1）：终态清除；等待审批/暂停
      // 保留——approveTask/resume 依赖它续跑。
      const finalStatus = getAgentTaskStore().get(taskId)?.status;
      if (finalStatus && finalStatus !== "awaiting_approval" && finalStatus !== "paused") {
        this.taskOptions.delete(taskId);
      }
    }
  }

  /** 执行一轮 LLM 调用 + 工具执行 + 状态迁移 */
  private async runOneRound(taskId: string, options: RunTaskOptions): Promise<void> {
    const store = getAgentTaskStore();
    const task = store.get(taskId)!;
    const round = task.currentRound + 1;

    // 发送 round_started 事件
    this.emitProgress(task, "round_started", `第 ${round}/${task.maxRounds} 轮开始`, options, { round });

    // 根据当前状态决定阶段
    let phase: AgentTaskStatus = task.status;
    if (phase === "pending") {
      phase = "planning";
      this.transitionTo(taskId, "planning", "开始规划", options);
    }

    // 确定当前子任务
    const currentSubtask = this.getCurrentSubtask(task);
    if (currentSubtask && currentSubtask.status === "pending") {
      store.update(taskId, (t) => {
        const st = t.subtasks.find((s) => s.id === currentSubtask.id);
        if (st) {
          st.status = "in_progress";
          st.startedAt = new Date().toISOString();
        }
      });
      this.emitProgress(task, "subtask_started", `开始子任务: ${currentSubtask.description}`, options, { subtaskId: currentSubtask.id });
    }

    // 构造 LLM 输入
    const stepInput: LlmStepInput = {
      goal: task.goal,
      currentSubtask: currentSubtask ?? undefined,
      completedSubtasks: task.subtasks.filter((s) => s.status === "done").map((s) => s.description),
      remainingSubtasks: task.subtasks.filter((s) => s.status === "pending" || s.status === "in_progress").map((s) => s.description),
      recentHistory: this.compressRecentHistory(task.history, 5),
      phase,
      roundInfo: { current: round, max: task.maxRounds },
    };

    // 构造 system prompt
    const systemPrompt = this.buildSystemPrompt(stepInput);

    // 构造 user prompt(环境感知)
    const userPrompt = this.buildUserPrompt(stepInput);

    // 调用 LLM(maxRounds=1, ephemeral 不污染主 thread)
    const sessionId = `task-${taskId}`;
    const streamOpts: AgentStreamOptions = {
      ephemeralTurn: true,
      systemPromptOverride: systemPrompt,
      toolLoop: { maxRounds: 1 },
      agentAccessMode: "full",
      desktopBridgeOnline: true,
      phoneBridgeOnline: false,
      pinnedToolNames: STATE_MACHINE_TOOL_ALLOWLIST,
    };

    let assistantText = "";
    const collectedToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    const collectedToolResults: NonNullable<TaskHistoryEntry["toolResults"]> = [];

    try {
      const finalText = await this.provider.streamCompletion(
        sessionId,
        { text: userPrompt },
        (delta) => {
          assistantText += delta;
          options.onAssistantDelta?.(delta);
        },
        {
          executeTool: async (name, args) => {
            const startTime = Date.now();
            const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            collectedToolCalls.push({ id: callId, name, arguments: args });
            options.onToolExecuteStart?.({ id: callId, name, args });

            // 安全检查
            const safety = getAgentTaskSafety();
            const check = safety.checkToolCall(name, args);
            if (check.action === "deny") {
              const errMsg = `操作被拒绝: ${check.reason}`;
              collectedToolResults.push({ id: callId, name, ok: false, error: errMsg, durationMs: Date.now() - startTime });
              return { ok: false, result: { error: errMsg } };
            }
            if (check.action === "require_approval") {
              // 转入待审批状态,暂停执行
              store.update(taskId, (t) => {
                t.status = "awaiting_approval";
                t.requiresApproval = true;
              });
              this.emitProgress(task, "approval_required", `需要人工审批: ${check.reason}`, options, { toolName: name, args });
              const errMsg = `操作需要人工审批: ${check.reason}`;
              collectedToolResults.push({ id: callId, name, ok: false, error: errMsg, durationMs: Date.now() - startTime });
              return { ok: false, result: { error: errMsg } };
            }

            // 执行工具
            const result = await this.toolRegistry.execute(name, args, {
              sessionId: task.sessionId,
              userId: task.actorId,
              chatUserMessageId: task.chatUserMessageId,
              agentAccessMode: "full",
              desktopBridgeOnline: true,
            });

            const durationMs = Date.now() - startTime;
            const ok = result.ok;
            const resultData = result.result ?? {};
            // 诊断日志:打印 tool result 摘要,确认 elements 数据是否传递到 orchestrator
            const resultKeys = typeof resultData === "object" && resultData !== null ? Object.keys(resultData) : [];
            const resultPreview = JSON.stringify(resultData).slice(0, 800);
            console.log(`[orchestrator-diag] tool=${name} ok=${ok} keys=[${resultKeys.join(",")}] preview=${resultPreview}`);
            options.onToolExecuted?.({ id: callId, name, ok, result: resultData, durationMs });
            collectedToolResults.push({ id: callId, name, ok, result: resultData, durationMs });

            // 审计
            await safety.audit(taskId, name, args, resultData).catch(() => undefined);

            return { ok, result: resultData };
          },
        },
        streamOpts,
      );
      // streamCompletion 返回最终文本(可能已含工具调用后的总结)
      if (finalText && !assistantText) {
        assistantText = finalText;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[agent-task-orchestrator] LLM 调用失败:`, errMsg);
      // 记录失败,但不直接终止任务,让状态机决定是否重试
      store.update(taskId, (t) => {
        const entry: TaskHistoryEntry = {
          round,
          phase,
          timestamp: new Date().toISOString(),
          assistantText: "",
          stateTransition: { from: phase, to: phase, reason: `LLM 调用失败: ${errMsg}` },
        };
        t.history.push(entry);
        t.currentRound = round;
      });
      this.emitProgress(task, "log", `LLM 调用失败: ${errMsg}`, options);
      return;
    }

    // 解析 LLM 输出
    const stepOutput = this.parseLlmOutput(assistantText);

    // 记录历史
    store.update(taskId, (t) => {
      const entry: TaskHistoryEntry = {
        round,
        phase,
        timestamp: new Date().toISOString(),
        assistantText: assistantText.slice(0, 2000),
        toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
        toolResults: collectedToolResults.length > 0 ? collectedToolResults : undefined,
      };
      t.history.push(entry);
      t.currentRound = round;
    });

    // 处理 LLM 输出的状态迁移建议
    this.handleLlmOutput(taskId, stepOutput, options);

    // 发送 round_completed 事件
    this.emitProgress(task, "round_completed", `第 ${round} 轮完成`, options, { round, assistantText: assistantText.slice(0, 200) });
  }

  /** 获取当前应该执行的子任务 */
  private getCurrentSubtask(task: AgentTask): SubTask | undefined {
    if (task.subtasks.length === 0) return undefined;
    // 优先返回 in_progress
    const inProgress = task.subtasks.find((s) => s.status === "in_progress");
    if (inProgress) return inProgress;
    // 否则返回第一个 pending
    return task.subtasks.find((s) => s.status === "pending");
  }

  /** 压缩最近 N 轮历史为字符串数组 */
  private compressRecentHistory(history: TaskHistoryEntry[], count: number): string[] {
    const recent = history.slice(-count);
    return recent.map((h, i) => {
      const parts: string[] = [`轮${h.round}(${h.phase})`];
      if (h.assistantText) parts.push(`文本: ${h.assistantText.slice(0, 200)}`);
      if (h.toolCalls?.length) {
        parts.push(`调用: ${h.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 100)})`).join(", ")}`);
      }
      if (h.toolResults?.length) {
        parts.push(`结果: ${h.toolResults.map((r) => `${r.name}=${r.ok ? "ok" : "fail"}`).join(", ")}`);
      }
      return parts.join(" | ");
    });
  }

  /** 构造 system prompt(状态机驱动,非自由对话) */
  private buildSystemPrompt(input: LlmStepInput): string {
    const phaseDesc: Record<string, string> = {
      planning: "你正在【规划阶段】:分析任务目标,拆解为可执行的原子子任务。每个子任务应该是单个工具能完成的粒度。",
      executing: "你正在【执行阶段】:根据当前子任务和真实环境状态,产出下一步原子动作(调用一个工具)。",
      verifying: "你正在【校验阶段】:检查上一步工具执行结果是否达成了当前子任务的目标。",
      pending: "你正在【启动阶段】:分析任务,准备开始执行。",
    };

    return `你是自主任务执行 Agent 的决策大脑,由外部状态机驱动,负责长周期任务的逐步执行。

${phaseDesc[input.phase] ?? input.phase}

## 任务目标
${input.goal}

## 子任务进度
${formatSubtasksSection(input)}

## 最近历史
${input.recentHistory.length > 0 ? input.recentHistory.join("\n") : "(暂无历史)"}

## 当前轮次
第 ${input.roundInfo.current} / ${input.roundInfo.max} 轮

## 工作方式(严格遵守)
1. 每轮只产出**一个动作**:要么调用一个工具,要么输出一段反思文本
2. 使用可用的工具(function calling)完成当前子任务,不要声称没有工具
3. 不要凭空假设坐标或状态,必须基于工具返回的真实数据决策
4. 上一步工具结果未达预期时,反思原因并调整策略(换 selector / 换工具 / 换路径)
5. **禁止重复无效查询**:对同一 selector 调用 uia_query 超过 2 次仍无结果,必须换策略
6. 完成当前子任务后,在文本里说"子任务完成"
7. 全部子任务完成后,在文本里说"任务完成"
8. 遇到不可恢复的错误,在文本里说"任务失败: <原因>"

## 桌面自动化操作策略(核心)

桌面应用分两类,必须先判断再用对应策略:

### A. 标准 Win32/WPF/WinForms 应用(支持 UIA 控件树,优先走原生控件)
- **优先用 desktop.run_automation**(零鼠标零截图零前台要求,最稳定)
  - selector 支持 name/name_contains/control_type/class_name/automation_id
  - 点按钮/菜单: action=click (调 InvokePattern)
  - 输入文本框: action=set_value (调 ValuePattern.SetValue,无需窗口在前台)
  - 读文本框: action=get_value
  - 复选框/单选: action=toggle
- 仅当 run_automation 返回 ok:false(元素不支持 pattern)时,降级到 run_input 按 bbox 坐标操作

### B. 自绘 UI 应用(uia_query/run_automation 返回 count:0 或 ok:false)
微信新版(mmui)、QQ、腾讯视频、抖音、Electron 应用等自绘框架,UIA 只能看到顶层窗口,读不到内部控件,**run_automation 一定走不通**。
当 uia_query/run_automation 返回 count:0 时,**立即切换到视觉策略**:
1. desktop.visual.screenshot 截图看清屏幕当前状态
2. 根据截图内容判断当前界面(登录页/主界面/搜索框/聊天列表等)
3. 用 desktop.run_input 按坐标点击/输入(坐标基于截图中的元素位置)
4. 每次操作后重新截图验证效果

### C. 前置状态处理(应用未就绪)
打开应用后可能遇到前置状态(登录窗口/引导页/弹窗等),这是任务的一部分,必须先处理:
- 看到登录窗口 → 截图判断登录方式(扫码/账号密码/手机验证)
  - 扫码登录:提示"请在屏幕上扫码登录",然后每 5-10 秒截图一次,等待登录完成后继续
  - 按钮登录:点击对应按钮
- 看到引导页/弹窗 → 点击关闭或跳过
- 前置状态处理完成后,重新截图确认进入主界面,再继续原任务

## 桌面自动化工具使用要点
- desktop.open {target, path}: 打开软件/文件/网页(自动跨盘搜索,WeChat↔Weixin 别名)
- desktop.run_automation {action, selector, value?}: **UIA 友好应用首选**,不模拟鼠标,不抢焦点
- desktop.uia_query {mode, selector}: UIA 只读查询(探查控件树,判断应用是否支持 UIA)
- desktop.run_input {action, x, y, text, key, keys}: 键鼠模拟(click/type/key/shortcut),坐标来自截图或 uia_query 的 bbox
- desktop.run_preset {preset}: 预设命令(list_dir/processes)
- desktop.run_shell {command}: 受控 shell
- desktop.http_get {url, headers?, timeoutMs?}: **原生 HTTP GET,替代 shell curl**。调外部 API 获取实时信息(天气/股价/翻译/汇率等)。仅 GET,带 SSRF 防护
- desktop.web_search {query, limit?}: **桌面端联网搜索**(Bing CN),返回标题+URL+摘要。子任务需要查资料时首选
- desktop.web_fetch {url}: **桌面端抓取网页正文**,返回标题+摘要+纯文本。search 拿到 URL 后用此读全文
- desktop.visual.screenshot {}: 截屏看清当前状态,自绘 UI 应用的主要感知手段

## 联网能力(服务端工具)
当任务需要"上网查信息"时,优先用以下工具,不要用 shell curl:
- search_web {query, limit?}: **服务端联网搜索**,返回标题+URL+摘要。支持多查询并行
- search_images {query, limit?}: **服务端图片搜索**,返回可预览图片 URL + 来源页 URL
- search_videos {query, limit?}: **服务端视频搜索**,返回视频标题 + 播放页 URL + 缩略图
- fetch_web {url, include_links?}: **服务端抓取网页正文**,自动去噪(导航栏/广告/页脚)
- http.request {url, method?, headers?, body?, timeoutMs?}: **通用 HTTP 客户端**(GET/POST/PUT/DELETE 等),带 SSRF 防护。调外部 API/Webhook 用此工具
- info.inspect_webpage {url}: 巡检网页,返回链接列表(便于继续导航)
- info.navigate_site {startUrl, goalKeywords?}: 同站多页 BFS 爬取
- weather.get_local {latitude?, longitude?, city?, days?}: 获取天气与穿衣建议（days=预报天数 1-16，默认 2；问后天/周末等多日时传）

## 浏览器自动化(服务端 Playwright 无头浏览器)
当任务需要"在网页上操作"(填表单/点按钮/多步交互/JS 渲染页面)时用以下工具:
- agent_browser.open {url}: 打开 URL,返回 sessionId(后续操作都须传此 ID)
- agent_browser.click {sessionId, selector}: 点击元素(CSS/text=/xpath= 选择器)
- agent_browser.type {sessionId, selector, text}: 在输入框输入文本
- agent_browser.scroll {sessionId, selector?/deltaY?/x?/y?}: 滚动页面
- agent_browser.extract_text {sessionId, selector?}: **提取页面文本+可交互元素列表**,比截图省 token
- agent_browser.screenshot {sessionId, fullPage?}: 截图(仅在复杂页面需要视觉定位时用)
- agent_browser.wait_for {sessionId, selector}: 等待元素出现
- agent_browser.close {sessionId}: 关闭会话(完成后应主动调用)

## 输出格式
- 如果要调用工具:直接产出 tool_call(OpenAI function calling 格式)
- 如果要反思/汇报:产出纯文本,不要调工具`;
  }

  /** 构造 user prompt(环境感知注入) */
  private buildUserPrompt(input: LlmStepInput): string {
    const parts: string[] = [];
    if (input.currentSubtask) {
      parts.push(`当前子任务: ${input.currentSubtask.description}`);
    }
    if (input.environmentSnapshot) {
      parts.push(`环境感知:\n${input.environmentSnapshot}`);
    }
    if (parts.length === 0) {
      parts.push("请根据任务目标和当前进度,决定下一步动作。");
    }
    return parts.join("\n\n");
  }

  /** 解析 LLM 输出文本为结构化结果 */
  private parseLlmOutput(text: string): LlmStepOutput {
    const output: LlmStepOutput = { text };
    if (!text) return output;

    // 检测任务完成标记
    if (/任务完成|全部完成|已完成所有/.test(text)) {
      output.markTaskDone = true;
    }
    // 检测子任务完成标记
    if (/子任务完成|当前子任务.*完成|这一步.*完成/.test(text)) {
      output.markSubtaskDone = true;
    }
    // 检测任务失败标记
    if (/任务失败|无法完成|不可恢复/.test(text)) {
      output.suggestedTransition = { to: "failed", reason: text.slice(0, 200) };
    }
    // 检测审批请求
    const approvalMatch = text.match(/需要审批|需要人工|高危操作[:：]\s*(.+)/);
    if (approvalMatch) {
      output.requestApproval = { action: "tool_call", reason: approvalMatch[1] };
    }

    return output;
  }

  /** 处理 LLM 输出,执行状态迁移 */
  private handleLlmOutput(taskId: string, output: LlmStepOutput, options: RunTaskOptions): void {
    const store = getAgentTaskStore();
    const task = store.get(taskId);
    if (!task) return;

    // 标记子任务完成
    if (output.markSubtaskDone) {
      const current = this.getCurrentSubtask(task);
      if (current) {
        store.update(taskId, (t) => {
          const st = t.subtasks.find((s) => s.id === current.id);
          if (st) {
            st.status = "done";
            st.completedAt = new Date().toISOString();
            st.resultSummary = output.text?.slice(0, 200);
          }
        });
        this.emitProgress(task, "subtask_completed", `子任务完成: ${current.description}`, options, { subtaskId: current.id });
      }
    }

    // 标记整个任务完成
    if (output.markTaskDone) {
      // 标记所有剩余子任务为完成
      store.update(taskId, (t) => {
        for (const st of t.subtasks) {
          if (st.status === "pending" || st.status === "in_progress") {
            st.status = "done";
            st.completedAt = new Date().toISOString();
          }
        }
      });
      this.transitionTo(taskId, "done", "任务完成", options);
      return;
    }

    // 处理建议的状态迁移
    if (output.suggestedTransition) {
      this.transitionTo(taskId, output.suggestedTransition.to, output.suggestedTransition.reason, options);
      return;
    }

    // 处理审批请求
    if (output.requestApproval) {
      store.update(taskId, (t) => {
        t.status = "awaiting_approval";
        t.requiresApproval = true;
      });
      this.emitProgress(task, "approval_required", `需要人工审批: ${output.requestApproval.reason}`, options);
      return;
    }

    // 子任务的唯一来源（2026-10-19）：planning 阶段若本会话已有 TaskPlan，
    // 直接映射成 subtasks。`plannedSubtasks`（agent-task-types:226）全仓零写入
    // 零消费，与其去修那条解析链，不如让 TaskPlan 成为唯一来源——否则
    // `planning && subtasks>0 → executing` 这个条件永远不成立。
    let updatedTask = store.get(taskId)!;
    if (updatedTask.status === "planning" && updatedTask.subtasks.length === 0) {
      const plan = getTaskPlanStore()?.get(updatedTask.sessionId);
      if (plan && plan.steps.length > 0) {
        store.update(taskId, (t) => {
          const now = new Date().toISOString();
          t.subtasks = plan.steps.map((s) => ({
            id: s.id,
            description: s.title,
            status: s.status === "done" ? "done" : s.status === "running" ? "in_progress" : "pending",
            attempts: 0,
            maxAttempts: 3,
            createdAt: now,
          }));
        });
        updatedTask = store.get(taskId)!;
      }
    }
    if (updatedTask.status === "planning" && updatedTask.subtasks.length > 0) {
      this.transitionTo(taskId, "executing", "规划完成,开始执行", options);
    }
  }

  /** 执行状态迁移 */
  private transitionTo(taskId: string, to: AgentTaskStatus, reason: string, options: RunTaskOptions): void {
    const store = getAgentTaskStore();
    const task = store.get(taskId);
    if (!task) return;

    const from = task.status;
    if (from === to) return;

    store.update(taskId, (t) => {
      t.status = to;
      if (to === "done" || to === "failed") {
        t.completedAt = new Date().toISOString();
      }
      if (to === "failed" && !t.error) {
        t.error = reason;
      }
    });

    this.emitProgress(task, "state_transition", `状态迁移: ${from} → ${to} (${reason})`, options, { from, to, reason });

    if (to === "done") {
      this.emitProgress(task, "task_completed", "任务已完成", options);
    } else if (to === "failed") {
      this.emitProgress(task, "task_failed", `任务失败: ${reason}`, options);
    }
  }

  /** 发送进度事件 */
  private emitProgress(
    task: AgentTask,
    type: TaskProgressEvent["type"],
    message: string,
    options: RunTaskOptions,
    data?: Record<string, unknown>,
  ): void {
    // 任务完成 → 通知主动性模块（主动恭喜触发源；此前只走 WS 回调，
    // 主动决策层看不到任务完成事件，恭喜链路是断的）
    if (type === "task_completed" && this.proactivityHub) {
      try {
        this.proactivityHub.onAgentTaskCompleted(task.actorId, task.goal);
      } catch (err) {
        console.log(`[agent-task-orchestrator] 主动恭喜触发失败（忽略）: ${err}`);
      }
    }
    options.onProgress?.({
      taskId: task.id,
      actorId: task.actorId,
      sessionId: task.sessionId,
      type,
      message,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  /**
   * 人工审批:批准任务继续执行。
   * 2026-09-19 P1-1 修复「假确认」：此前只翻状态、不恢复已退出的主循环，
   * 批准后任务永远停在 executing。现在依据 createAndRun 暂存的 options
   * 重新拉起 runLoop 真续跑；stash 丢失（进程重启）时诚实返回 false。
   */
  approveTask(taskId: string, approvedBy: string): boolean {
    const store = getAgentTaskStore();
    const task = store.get(taskId);
    if (!task || task.status !== "awaiting_approval") return false;

    store.update(taskId, (t) => {
      t.status = "executing";
      t.requiresApproval = false;
      t.approvedBy = approvedBy;
      t.approvedAt = new Date().toISOString();
    });

    const resumeOptions = this.taskOptions.get(taskId);
    if (!resumeOptions) {
      // 续跑上下文缺失（进程重启/内存任务被清）：按拒绝处理，不假确认
      console.warn(`[agent-task-orchestrator] 任务 ${taskId} 批准但缺少续跑上下文，标记失败`);
      store.update(taskId, (t) => {
        t.status = "failed";
        t.error = "任务已批准但执行上下文丢失（可能因服务重启），请重新发起";
        t.completedAt = new Date().toISOString();
      });
      this.taskOptions.delete(taskId);
      return false;
    }
    void this.runLoop(taskId, resumeOptions).catch((err) => {
      console.error(`[agent-task-orchestrator] 任务 ${taskId} 审批后续跑异常:`, err);
      store.update(taskId, (t) => {
        t.status = "failed";
        t.error = err instanceof Error ? err.message : String(err);
        t.completedAt = new Date().toISOString();
      });
    });
    return true;
  }

  /**
   * 人工审批:拒绝任务继续执行
   */
  rejectTask(taskId: string, rejectedBy: string): boolean {
    const store = getAgentTaskStore();
    const task = store.get(taskId);
    if (!task || task.status !== "awaiting_approval") return false;

    store.update(taskId, (t) => {
      t.status = "failed";
      t.error = `被 ${rejectedBy} 拒绝`;
      t.completedAt = new Date().toISOString();
    });
    this.taskOptions.delete(taskId);
    return true;
  }

  /** 暂停任务 */
  pauseTask(taskId: string): boolean {
    const store = getAgentTaskStore();
    const task = store.get(taskId);
    if (!task) return false;
    if (task.status === "done" || task.status === "failed") return false;

    store.update(taskId, (t) => {
      t.status = "paused";
    });
    return true;
  }

  /**
   * 恢复任务：重新启动主循环继续执行。
   * 可用于人工恢复暂停任务，也用于服务重启后自动恢复未完成的自主任务。
   *
   * 可恢复状态：pending / planning / executing / verifying / paused（未到终态）。
   *  - paused（用户主动暂停）：恢复时置为 executing 重新进入主循环
   *  - pending / planning / executing / verifying：保持原状态，runLoop 从断点继续
   * 不可恢复状态：done / failed / awaiting_approval（终态或等待人工审批，不得自动放行）
   */
  resumeTask(taskId: string, options: RunTaskOptions): boolean {
    const store = getAgentTaskStore();
    const task = store.get(taskId);
    if (!task) return false;
    if (
      task.status === "done" ||
      task.status === "failed" ||
      task.status === "awaiting_approval"
    ) {
      return false;
    }

    if (task.status === "paused") {
      store.update(taskId, (t) => {
        t.status = "executing";
      });
    }

    // 重新启动主循环
    void this.runLoop(taskId, options).catch((err) => {
      console.error(`[agent-task-orchestrator] 恢复任务 ${taskId} 异常:`, err);
    });
    return true;
  }

  /** 获取任务状态(供外部查询) */
  getTask(taskId: string): AgentTask | undefined {
    return getAgentTaskStore().get(taskId);
  }

  /** 列出用户的所有任务 */
  listTasks(actorId?: string): AgentTask[] {
    return getAgentTaskStore().list({ actorId });
  }
}

// ── 单例 ──
let orchestratorInstance: AgentTaskOrchestrator | null = null;

export function initAgentTaskOrchestrator(deps: AgentTaskOrchestratorDeps): AgentTaskOrchestrator {
  orchestratorInstance = new AgentTaskOrchestrator(deps);
  return orchestratorInstance;
}

export function getAgentTaskOrchestrator(): AgentTaskOrchestrator | null {
  return orchestratorInstance;
}

