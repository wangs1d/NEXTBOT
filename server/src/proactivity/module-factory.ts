// 统一模块层 · 规则层工厂（方案 B 第一步，2026-11-19 用户拍板「分阶段：先 A 后 B」）。
//
// 把原 create-app-services.ts 里的规则层装配整体搬进来：
//   1. 规则数据源（原 builtinServices：日程/天气/未读/就绪目标/关注话题/记忆/目标上下文）
//   2. MappingExecutor 构造（板 + 规则表 + 活跃 actor 口径）
//   3. onEvent 投递接线（目标桥归属判定 → ArbiterV2 仲裁 → 话术/卡片/来电 → 管道投递 → 审计）
//
// 装配分两阶段（与 bootstrap 的创建顺序对齐，依赖顺序显式化）：
//   · createProactivityRulesLayer(deps)：早期——只需要数据源服务，管线下游还没建
//   · layer.attachDelivery(deps)：晚期——goalSignalBridge/discovery/pipeline/speechHub
//     就绪后接上投递出口
//   · layer.start() / layer.stop()：生命周期
//
// 仍在 bootstrap 的部分（后续步骤再收）：worldBoard 构造与清板、传感器桥接、
// agentPulse、触发器/分支/定时服务。数据源读的 weatherLineByActor / 晚绑定 ref
// 也由 bootstrap 注入（它们有各自的写入方）。

import { join } from "node:path";
import type { MappingExecutor, RuleServices } from "./mapping-executor.js";
import { appendEventAudit, MappingExecutor as MappingExecutorImpl } from "./mapping-executor.js";
import type { EventAuditRecord } from "./mapping-executor.js";
import { buildBoardRules } from "./mapping-rules.js";
import {
  adjustImportanceByGoalRelation,
  appendGoalHint,
} from "./goal-signal-bridge.js";
import type { GoalSignalBridge } from "./goal-signal-bridge.js";
import type { DiscoveryLayer } from "./discovery-layer.js";
import type { ArbiterV2 } from "./arbiter-v2.js";
import type { ProactivePipeline } from "./proactive-pipeline.js";
import type { SpeechHub } from "./speech-express.js";
import type { ProactiveCaller } from "./proactive-caller.js";
import type { ProactivityHub } from "./proactivity-hub.js";
import type { WorldBoard } from "./world-board.js";
import type { GoalBoard } from "./goal-board.js";
import type { InterestWatcher } from "./interest-watcher.js";
import type { BrainCenter } from "../brain/brain-center.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import type { MessageHubService } from "../services/message-hub-service.js";
import type { MessageHubInboundInput } from "../services/message-hub-service.js";
import { inferPlaceKind } from "../services/geofence-service.js";
import type { LocationTrigger } from "./triggers/location-trigger.js";
import { LocationTrigger as LocationTriggerImpl } from "./triggers/location-trigger.js";
import type { PlaceTransitionTrigger } from "./triggers/place-transition-trigger.js";
import { PlaceTransitionTrigger as PlaceTransitionTriggerImpl } from "./triggers/place-transition-trigger.js";
import type { MessageWatchTrigger } from "./triggers/message-watch-trigger.js";
import { MessageWatchTrigger as MessageWatchTriggerImpl } from "./triggers/message-watch-trigger.js";
import type { BranchRegistry } from "./branches/branch-registry.js";
import { BranchRegistry as BranchRegistryImpl } from "./branches/branch-registry.js";
import type { BranchCondenser } from "./branches/branch-condenser.js";
import { BranchCondenser as BranchCondenserImpl } from "./branches/branch-condenser.js";
import type { AssertionConflictWatcher } from "./branches/assertion-conflict-watcher.js";
import { AssertionConflictWatcher as AssertionConflictWatcherImpl } from "./branches/assertion-conflict-watcher.js";
import type { WatchTaskWatcher } from "./branches/watch-tasks.js";
import { WatchTaskWatcher as WatchTaskWatcherImpl } from "./branches/watch-tasks.js";
import type { ScheduleAssertionStore } from "./branches/schedule-assertion-store.js";
import type { WatchTaskStore } from "./branches/watch-tasks.js";
import type { MutableExternalChatProvider } from "../external-model/index.js";
import type { ProactiveProposal } from "./pipeline-types.js";

// ── 依赖契约 ──────────────────────────────────────────────────────────────

/** 规则层数据源依赖（bootstrap 注入的服务句柄，模块只读不建） */
export interface RulesLayerDeps {
  board: WorldBoard;
  /** 规则私有状态 + 事件去重指纹落盘目录（原 proactivityFabricPath） */
  dataPath: string;
  defaultActorId: () => string | null;
  hub: ProactivityHub;
  scheduleTasks: ScheduleTaskService;
  /** 天气一行话缓存（bootstrap 的天气轮询写入方持有） */
  weatherLineByActor: Map<string, string | null>;
  messageHub: MessageHubService;
  goalBoard: GoalBoard;
  interestWatcher: InterestWatcher;
  brainCenter: BrainCenter | null;
  /** 晚绑定容器（goalPlanner/discovery 在 bootstrap 后段创建后填充） */
  goalSignalBridgeRef: { current: GoalSignalBridge | null };
  discoveryRef: { current: DiscoveryLayer | null };
}

/** 投递出口依赖（attachDelivery 阶段注入，均在 bootstrap 后段就绪） */
export interface DeliveryLayerDeps {
  goalSignalBridge: GoalSignalBridge;
  discovery: DiscoveryLayer;
  arbiter: ArbiterV2;
  pipeline: ProactivePipeline;
  speechHub: SpeechHub;
  caller: ProactiveCaller;
  /** 审计目录（原 getDataDir()） */
  auditDir: () => string;
}

export interface ProactivityRulesLayer {
  executor: MappingExecutor;
  /** 规则数据源（agentPulse 等其它主动消费方共用同一份，避免重复拼装） */
  services: RuleServices;
  attachDelivery(deps: DeliveryLayerDeps): void;
  start(): void;
  stop(): void;
}

// ── 数据源装配（原 builtinServices，逐字迁移）────────────────────────────

function buildRuleServices(deps: RulesLayerDeps): RuleServices {
  const {
    scheduleTasks,
    weatherLineByActor,
    messageHub,
    goalBoard,
    interestWatcher,
    brainCenter,
    goalSignalBridgeRef,
    discoveryRef,
  } = deps;
  return {
    // 按 actor 查（2026-10-23 跨账号泄漏根修）：listAllTasks() 是全库，规则按 actor
    // tick 时会把别人的日程 / eval 账号的任务写进当前用户的晨报与时间轴。
    listTodayTasks: (actorId: string) => {
      if (!actorId) return [];
      const now = Date.now();
      const horizon = now + 24 * 3600_000;
      return scheduleTasks
        .listTasksBySession(actorId)
        .filter((t) => t.status !== "cancelled")
        // 展示名回退：提醒类任务多由工具建，只有 shortTitle/description（title 为空）。
        // 此前只取 title，主动性审阅拿到的是「18:00 」这种无事项的空行，只能从最近
        // 对话里猜事项，于是编出了「六点整健身和游泳撞一块了」（2026-11-01）。
        .map((t) => ({
          title: (t.title ?? t.shortTitle ?? t.description ?? "").trim(),
          runAt: t.nextRunAt ?? t.runAt,
        }))
        .filter((t) => {
          const at = typeof t.runAt === "number" ? t.runAt : Date.parse(String(t.runAt));
          return Number.isFinite(at) && at > now && at <= horizon;
        })
        .sort((a, b) => {
          const at = (v: { runAt?: number | string }) =>
            typeof v.runAt === "number" ? v.runAt : Date.parse(String(v.runAt));
          return at(a) - at(b);
        })
        .slice(0, 6);
    },
    // 天气一行话：按 tick 的 actor 读自己的缓存（全局单值会把 A 的天气说给 B）
    weatherLine: (actorId: string) => weatherLineByActor.get(actorId) ?? null,
    // 未读发件人（digest/晨报拼接）：MessageHub 会话表中该 actor unreadCount>0 的对端
    unreadSenders: (actorId: string) => {
      if (!actorId) return [];
      try {
        return messageHub
          .listConversations(actorId, { limit: 20 })
          .filter((c) => c.unreadCount > 0)
          .map((c) => c.participantName || c.title || String(c.platform))
          .slice(0, 5);
      } catch {
        return [];
      }
    },
    readyGoals: (actorId: string) =>
      goalBoard.readyTray(actorId).map((g) => ({ title: g.title, body: String(g.payload?.body ?? g.title) })),
    // 无数据返回空数组，不能回 [""]——否则 renderDigestCard 会渲染出
    // 「你关注的话题：」空标题（2026-11-19 根修，agent-pulse 那条路径本就有 trim 过滤）
    interestLines: (actorId: string) => {
      if (!actorId) return [];
      const line = (interestWatcher.listForPrompt(actorId, 3) ?? "").trim();
      return line ? [line] : [];
    },
    recallMemory: async (actorId: string, query: string, limit: number) => {
      if (!brainCenter || !actorId) return [];
      const result = await brainCenter.recall(actorId, query, { domain: "episodic", limit });
      return (result?.items ?? []).map((item) => item.content);
    },
    // 感知 → 目标桥（2026-10-10）+ 共享发现层读点（2026-10-19）：两者都晚绑定
    // （goalPlanner / sourceStore 在 bootstrap 后段创建）。规则文案据此从"碎片化场景"升级为
    // "带目标上下文"，并带上**该目标尚未开口的发现条数**——对话注入与开口闸读的是
    // 同一份发现台账，不再是各读各的。未装配时返回 null，行为不变。
    activeGoalLine: (actorId: string) => {
      const bridge = goalSignalBridgeRef.current;
      const line = bridge?.goalLineFor(actorId) ?? null;
      if (!line) return null;
      const goal = bridge?.activeGoalContext(actorId, 1)[0];
      const pending = goal && discoveryRef.current ? discoveryRef.current.findingsFor(goal.goalId).length : 0;
      return pending > 0 ? `${line}（另有 ${pending} 条相关发现待汇总）` : line;
    },
  };
}

// ── 规则层工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建规则层（原 bootstrap「映射执行器」装配段）。
 * 此时管线下游（arbiter/pipeline/speechHub/caller）可能还没建——投递出口由
 * attachDelivery 晚绑定。活跃 actor 口径：7 天内有交互（P0 配额窃取根修）。
 */
export function createProactivityRulesLayer(deps: RulesLayerDeps): ProactivityRulesLayer {
  const services = buildRuleServices(deps);
  const executor: MappingExecutor = new MappingExecutorImpl({
    board: deps.board,
    rules: buildBoardRules(services),
    defaultActorId: deps.defaultActorId,
    // 规则私有状态 + 事件去重指纹落盘：重启不重发、马拉松计时不清零
    dataPath: deps.dataPath,
    // P0 配额窃取根修（2026-10-01）：板上是测试 actor 坟场（143 个 E2E/bench
    // 永不过期），规则去重/节流若按插入序全局消费，先到的测试 actor 吃掉当天
    // 配额——审计实证真实用户 16 天 0 事件。tick 只评估 7 天内交互过的用户。
    isActiveActor: (actorId) => {
      const hit = deps.hub
        .exportActors()
        .find((a) => a.actorId === actorId);
      return !!hit && Date.now() - hit.lastInteractionAt < 7 * 24 * 60 * 60_000;
    },
  });
  return {
    executor,
    services,
    attachDelivery: (d) => attachDeliveryLayer(executor, d, deps.hub),
    start: () => executor.start(),
    stop: () => executor.stop(),
  };
}

// ── 投递出口接线（原 mappingExecutor.onEvent 整段，逐字迁移）──────────────

function attachDeliveryLayer(executor: MappingExecutor, deps: DeliveryLayerDeps, proactivityHub: ProactivityHub): void {
  const {
    goalSignalBridge,
    discovery,
    arbiter: arbiterV2,
    pipeline: proactivePipeline,
    speechHub,
    caller: proactiveCaller,
    auditDir,
  } = deps;
  executor.onEvent((event) => {
    const actorId = event.actorId ?? "local_user";
    // ── 社交开口类 → 统一主动出口（2026-10-26 用户拍板）──
    // （away_return 的 BrainCenter/LifeSignal 专用出口已随规则下线移除，2026-11-19）
    // 归属判定（2026-10-19）：这条场景信号是不是在说某个在办目标的事？
    // 命中时**就地替换局部副本**——等级与正文都改由目标状态决定（卡在用户身上的
    // 目标该抢注意力），未命中时下面逐字不变（零风险回退）。生产者的等级从此不是
    // 唯一依据，"规则写死 medium" 这件事被去掉了。
    const relation = goalSignalBridge.relatedGoalFor(actorId, `${event.title} ${event.body}`);
    // 共享发现层收口已下沉到 proactivePipeline.submitProposal（所有触发源的共同底）：
    // 归属判定只在这里按目标状态调一次等级并随提案下传（subject=goalId / needsUser）；
    // 发现登记、开口前读合成、按 verdict 消费都由管道统一负责——本出口不再重复一份。
    const graded = adjustImportanceByGoalRelation(event.importance, relation);
    const goalRepeat = relation
      ? discovery.previewOpen(relation.goalId, event.importance, relation.needsUser === true).repeat
      : false;
    if (relation) {
      event = {
        ...event,
        importance: graded,
        body: appendGoalHint(event.body, relation),
      };
    }
    // 事件审计：每一次主动事件的仲裁动作与管道 verdict 全链留痕（events.ndjson）
    const audit: EventAuditRecord = {
      at: Date.now(),
      eventId: event.id,
      kind: event.kind,
      urgency: event.urgency,
      actorId,
      action: "pending",
      title: event.title,
      ...(relation ? { goalId: relation.goalId, goalMatchedOn: relation.matchedOn, goalRepeat } : {}),
    };
    const action = arbiterV2.admit({
      actorId,
      urgency: event.urgency,
      tier: event.tier,
      label: event.title,
      deliver: () => {
        // 话术统一走 SpeechHub light（2026-10-27 模板层删除）：评估器事件正文
        // 一律 LLM 基于素材（title/body/summary）组织语言，生产者成稿仅作兜底。
        // 例外：morning_brief 是多行数据卡片（不是话术），保持直投；
        // viaCall 走真实来电汇报（caller 内部自带话术）。
        // LLM 失败且无成稿（body 为空）→ 沉默，绝不吐系统态素材。
        const cardKinds = ["morning_brief"];
        // 呼叫路由：PROACTIVE_CALL_KINDS 白名单（默认行程变化）+
        // 任意 critical 事件——遇到事情打电话汇报，通话内可对话
        const callKinds = (process.env.PROACTIVE_CALL_KINDS ?? "schedule_change")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        const viaCall =
          event.callPolicy === "always" ||
          callKinds.includes(event.kind) ||
          event.importance === "critical";
        const submit = (bodyText: string): void => {
          const decision = proactivePipeline.submitProposal({
            proposalId: event.id,
            actorId,
            kind: event.proposalKind,
            tier: event.tier,
            importance: event.importance,
            dedupKey: event.dedupKey,
            title: event.title,
            summary: (event.summary || event.body).slice(0, 120),
            directText: bodyText || undefined,
            evidence: [`evaluator:${event.kind}`],
            createdAt: Date.now(),
            source: `evaluator:${event.kind}`,
            // 共同键 + 是否请用户拍板随提案下传：管道的单开口闸据此合并同目标/同实体的
            // 他人发现（不再由本出口自己 compose）
            ...(relation ? { subject: relation.goalId, needsUser: relation.needsUser } : {}),
            ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
            ...(event.confirmLabel ? { confirmAction: { label: event.confirmLabel } } : {}),
            ...(event.notifyOptions?.length ? { notifyOptions: event.notifyOptions } : {}),
          });
          audit.verdict = decision.verdict;
          // 投递成功记入防重复记忆：同一事件不再被 LLM 通用路径重复表达
          if (decision.verdict === "delivered") proactivityHub.noteInitiative(actorId, event.kind, event.title);
          console.log(
            `[ArbiterV2] 事件投递 kind=${event.kind} verdict=${decision.verdict} urgency=${event.urgency}`,
          );
        };
        if (viaCall) {
          // 真实来电汇报 + 通话内对话；无应答/离线自动文本兜底（caller 内部处理）
          void proactiveCaller
            .callAndReport({
              actorId,
              kind: event.kind,
              importance: event.importance === "critical" ? "critical" : "high",
              title: event.title,
              report: event.body,
              context: event.summary,
            })
            .catch((err) => {
              // callAndReport 内部已覆盖全部降级（disabled/cooldown/no_device/no_response
              // → 文本兜底）；到这里的外层异常只记日志，防止兜底后二次投递
              console.log(`[ArbiterV2] 通话异常（忽略）kind=${event.kind}: ${err}`);
            });
        } else if (cardKinds.includes(event.kind)) {
          // 结构化数据卡片：不是话术，直投
          submit(event.body);
        } else {
          void (async () => {
            const polished = await speechHub.speak({
              kind: event.kind,
              sessionId: actorId,
              facts: {
                title: event.title,
                ...(event.body ? { body: event.body } : {}),
                ...(event.summary ? { 背景: event.summary } : {}),
              },
              // 生产者成稿兜底（可为空 → 话术失败时沉默）
              fallback: event.body,
              tier: "light",
              // 统一话术（2026-10-27）：不传 importance——润色不设重要度门槛
            });
            // 话术为空且无成稿 → 沉默（材料是系统态的，绝不原样投递）
            if (!polished.trim()) {
              console.log(`[ArbiterV2] 话术为空，沉默 kind=${event.kind}`);
              return;
            }
            submit(polished);
          })().catch((err) => {
            // 话术异常：有成稿用成稿兜底，否则沉默；不二次 submit 防双发
            console.log(`[ArbiterV2] 话术生成失败 kind=${event.kind}: ${err}`);
            if (event.body.trim()) submit(event.body);
          });
        }
      },
    });
    audit.action = action.action;
    audit.cost = action.cost;
    appendEventAudit(join(auditDir(), "proactivity", "events.ndjson"), audit);
  });
}

// ── 分支层工厂（方案 B 第二步，原 bootstrap 树枝注册表 + 入站监察装配）──────

/** 分支层依赖（bootstrap 注入；store 的写入方与外部聊天宿主留在 bootstrap） */
export interface BranchesLayerDeps {
  /** 配置落盘目录（原 getDataDir()：branches.json 写 dataDir/proactivity/） */
  dataDir: () => string;
  /** 外部聊天宿主（L3 精简器的 LLM 供给；未启用时精简器全模板兜底） */
  externalChat: MutableExternalChatProvider;
  scheduleAssertionStore: ScheduleAssertionStore;
  watchTaskStore: WatchTaskStore;
  scheduleTasks: ScheduleTaskService;
  pipeline: { submitProposal(p: ProactiveProposal): unknown };
  speechHub: SpeechHub;
}

export interface BranchesLayer {
  branchRegistry: BranchRegistry;
  /** L3 精简器实例（诊断面读 stats() 用） */
  branchCondenser: BranchCondenser;
  messageWatchTrigger: MessageWatchTrigger;
  assertionConflictWatcher: AssertionConflictWatcher;
  watchTaskWatcher: WatchTaskWatcher;
  /** 入站消息聚合入口：三个监察器按序分发（bootstrap 的 inboundHandlers 调用） */
  handleInbound(input: MessageHubInboundInput): void;
}

export function createBranchesLayer(deps: BranchesLayerDeps): BranchesLayer {
  // 树枝注册表（2026-10-22 树状架构 Phase 1）：可插拔信息源的声明与用户启停配置面。
  // 配置落盘 data/proactivity/branches.json，缺配置回落内置默认（零配置启动门禁：
  // 不 throw）。message 树枝的闸语义现役由 message-gate 承担（ingestInbound 直调），
  // Phase 2 迁移为经本注册表按树枝分发——先立接缝，不动行为。
  const branchRegistry = new BranchRegistryImpl({
    configPath: join(deps.dataDir(), "proactivity", "branches.json"),
  });
  // L3 精简器（Phase 2）：挂在注册表统一编排入口（ingest），按树枝配置决定
  // 是否花 LLM；全模板兜底。熔断/kill switch 与 SpeechHub 同纪律。
  const branchCondenser = new BranchCondenserImpl({
    chat: () => (deps.externalChat?.isEnabled() ? deps.externalChat : null),
  });
  branchRegistry.attachCondenser(branchCondenser);
  console.log(
    `[Bootstrap] 树枝注册表已装配：${branchRegistry.list().map((b) => `${b.id}(${b.mode})${b.enabled ? "" : "[停用]"}`).join(" / ")}`,
  );

  // 断言冲突监察（消息树枝 × 上传树枝，零 LLM）：日程变动信号撞上已导入的
  // 课表/行程表主张 → "模型修正"提案 → 主动性板块开口（批量导入 ≥3 条才入库）。
  const assertionConflictWatcher = new AssertionConflictWatcherImpl({
    store: deps.scheduleAssertionStore,
    submitProposal: (p) => {
      deps.pipeline.submitProposal(p);
    },
  });

  // 盯梢任务触发器（2026-10-22 Muse 对齐件）：用户点名要盯的事命中入站消息 →
  // 主动提案（must 层：用户自己下的单）。截止时间可抽且日历有缺口 → 升级为
  // "要我设个提醒吗"（Muse 体育选拔案例的确定性实现）。运行期零 LLM。
  const watchTaskWatcher = new WatchTaskWatcherImpl({
    store: deps.watchTaskStore,
    submitProposal: (p) => {
      // 盯梢命中 = 内容型场景：LLM 基于命中原话润色话术（模板兜底，润色失败不双发），
      // 再进统一管道（must 层必达语义不变）——与 messageWatchTrigger 同范式。
      void (async () => {
        if (p.directText) {
          p.directText = await deps.speechHub
            .speak({
              kind: "watch_task_hit",
              sessionId: p.actorId,
              facts: {
                task: p.detail?.["任务"] ?? p.subject ?? "",
                excerpt: p.detail?.["原文"] ?? p.summary,
                keyword: (p.evidence.find((e) => e.startsWith("keyword:")) ?? "").slice(8),
                ...(p.detail?.["截止"] ? { deadline: p.detail["截止"] } : {}),
              },
              fallback: p.directText,
              tier: "light",
              importance: p.importance,
            })
            .catch(() => p.directText!);
        }
        deps.pipeline.submitProposal(p);
      })().catch((err) => {
        console.log(`[watch-task] 提案润色失败（忽略）: ${err instanceof Error ? err.message : err}`);
      });
    },
    hasRelatedEntry: (actorId, keywords, startMs, endMs) =>
      deps.scheduleTasks.listAllTasks().some((t) => {
        if (t.status !== "active") return false;
        const at = Date.parse(t.nextRunAt ?? t.runAt ?? "");
        if (!Number.isFinite(at) || at < startMs || at > endMs) return false;
        const hay = `${t.title ?? ""} ${t.shortTitle ?? ""} ${t.description}`;
        return keywords.some((k) => hay.includes(k));
      }),
  });

  const messageWatchTrigger = new MessageWatchTriggerImpl({
    submitProposal: (p) => {
      // 行程/安排变化 = 内容型场景：LLM 基于消息原话生成主动回复（模板兜底），
      // 再进统一管道（must 层必达语义不变）
      void (async () => {
        if (p.directText) {
          // 仅话术生成可失败（回退模板）；提交只执行一次，避免异常路径双发
          p.directText = await deps.speechHub.speak({
            kind: "message_watch",
            sessionId: p.actorId,
            facts: {
              sender: p.detail?.["发件人"] ?? "",
              excerpt: p.detail?.["原文"] ?? p.summary,
              verb: (p.evidence.find((e) => e.startsWith("keyword:")) ?? "").slice(8),
            },
            fallback: p.directText,
            tier: "light",
            // 重要性分配：低于门槛（默认 high）的消息提醒直接模板直投
            importance: p.importance,
          }).catch(() => p.directText!);
        }
        deps.pipeline.submitProposal(p);
      })().catch((err) => {
        console.log(`[MessageWatch] 提案处理失败（忽略）: ${err}`);
      });
    },
    // MESSAGE_WATCH_IMPORTANCE=critical 时夜间立即投递（默认 high：静默时段顺延到早7点）
    importance:
      process.env.MESSAGE_WATCH_IMPORTANCE?.trim().toLowerCase() === "critical"
        ? "critical"
        : undefined,
  });

  return {
    branchRegistry,
    branchCondenser,
    messageWatchTrigger,
    assertionConflictWatcher,
    watchTaskWatcher,
    handleInbound: (input) => {
      messageWatchTrigger.handleInbound(input);
      // 断言冲突监察（上传树枝 × 消息树枝，零 LLM）：变动信号撞上已导入的课表/行程
      // 主张 → 专门冲突提案（比通用日程变动提醒更具体：指名哪节课、哪个时间）
      assertionConflictWatcher.handleInbound(input);
      // 盯梢任务触发器（用户点名要盯的事命中 → 主动报告；Muse 任务驱动盯梢对齐件）
      watchTaskWatcher.handleInbound(input);
    },
  };
}

// ── 位置触发器工厂（方案 B 第二步，原 bootstrap 位置方案 D/E 装配）──────────

// ── 位置触发器工厂（方案 B 第二步，原 bootstrap 位置方案 D/E 装配，逐字迁移）──

import type { LocationHistoryService } from "../services/location-history-service.js";
import type { GeofenceService } from "../services/geofence-service.js";
import type { PlaceSemanticsService } from "../services/place-semantics-service.js";
import type { ProactiveIntent } from "./proactivity-types.js";

export interface LocationTriggersDeps {
  /** 位置历史服务（未开启时为 null，整条到达链路静默） */
  locationHistory: LocationHistoryService | null;
  geofence: GeofenceService;
  placeSemantics: PlaceSemanticsService;
  /** 统一意图提交口（ProactivityHub.submitIntent） */
  submitIntent: (intent: ProactiveIntent) => void;
}

export interface LocationTriggersLayer {
  locationTrigger: LocationTrigger;
  placeTransitionTrigger: PlaceTransitionTrigger;
}

export function createLocationTriggers(deps: LocationTriggersDeps): LocationTriggersLayer {
  // ── 位置方案 D：到达常去地点 → 主动问候（走 hub 统一频控/话术闭环）──
  const locationTrigger = new LocationTriggerImpl({
    history: deps.locationHistory,
    submitIntent: deps.submitIntent,
  });
  // ── 地点语义转换（方案 E）：回家/离家/到公司/到外地 → 交给 hub，由模型决定是否开口 ──
  // 只把「高置信或用户已确认」的地点当成语义事实；推断中的地点不当铁定事实用。
  const placeTransitionTrigger = new PlaceTransitionTriggerImpl({
    resolvePlace: (actorId, loc) => {
      // 用户显式建的「家/公司」围栏优先级最高：它是用户亲口说的，不需要推断
      const fence = deps.geofence.matchPlace(actorId, loc);
      if (fence) {
        return {
          placeId: fence.fence.id,
          kind: fence.kind,
          latitude: fence.fence.latitude,
          longitude: fence.fence.longitude,
          label: fence.fence.name,
          radiusMeters: fence.fence.radiusMeters,
          confirmed: true,
        };
      }
      const hit = deps.placeSemantics.matchCached(actorId, loc);
      if (!hit) return null;
      // 主动转换比 prompt 展示更严格：未确认的地点至少要有 3 天证据，
      // 否则「在朋友小区住了两晚」会被误判成「到家了」。
      if (
        !hit.record.confirmed &&
        (hit.record.confidence < 0.6 || hit.record.distinctDays < 3)
      ) {
        return null;
      }
      return {
        placeId: hit.record.id,
        kind: hit.record.kind,
        latitude: hit.record.latitude,
        longitude: hit.record.longitude,
        ...(hit.record.label ? { label: hit.record.label } : {}),
        radiusMeters: hit.record.radiusMeters,
        confirmed: hit.record.confirmed,
      };
    },
    resolveHome: (actorId) => {
      const fence = deps.geofence
        .list(actorId)
        .find((item) => item.enabled && inferPlaceKind(item.name) === "home");
      if (fence) {
        return {
          placeId: fence.id,
          kind: "home" as const,
          latitude: fence.latitude,
          longitude: fence.longitude,
          label: fence.name,
          radiusMeters: fence.radiusMeters,
          confirmed: true,
        };
      }
      const home = deps.placeSemantics.findPlace(actorId, "home");
      if (
        !home ||
        (!home.confirmed && (home.confidence < 0.55 || home.distinctDays < 3))
      ) {
        return null;
      }
      return {
        placeId: home.id,
        kind: "home" as const,
        latitude: home.latitude,
        longitude: home.longitude,
        ...(home.label ? { label: home.label } : {}),
        radiusMeters: home.radiusMeters,
        confirmed: home.confirmed,
      };
    },
    submitIntent: deps.submitIntent,
  });
  return { locationTrigger, placeTransitionTrigger };
}

// ── 传感器层工厂（方案 B 第三步，原 bootstrap 感知内核核心簇装配，逐字迁移）──

import type { SensorKernel } from "./sensors/kernel.js";
import { SensorKernel as SensorKernelImpl, registerFeeder } from "./sensors/kernel.js";
import type { Signal } from "./sensors/types.js";
import { ScheduleSensor as ScheduleSensorImpl } from "./sensors/schedule-sensor.js";
import { FileWatcherSensor as FileWatcherSensorImpl } from "./sensors/file-watcher.js";
import { registerPerceptionOverviewTool } from "../tools/perception-tools.js";
import type { PresenceService } from "./presence-service.js";

export interface SensorLayerDeps {
  /** 内核 signals 日志落盘目录（原 proactivityFabricPath） */
  dataPath: string;
  scheduleTasks: ScheduleTaskService;
  /** 感知回溯查询工具挂载面（toolRegistry） */
  toolRegistry: Parameters<typeof registerPerceptionOverviewTool>[0];
  hub: ProactivityHub;
  presence: PresenceService;
}

export interface SensorLayer {
  kernel: SensorKernel;
  /** 日程传感器（触达决策的「距下一安排分钟数」读点） */
  scheduleSensor: ScheduleSensorImpl;
  /** 目标板 feeder（goalBoard 产出→ goal 流） */
  goalFeeder: ReturnType<typeof registerFeeder>;
  /** 入站消息 feeder（MessageHub onInbound 推送） */
  messageFeeder: ReturnType<typeof registerFeeder>;
  /** 物理设备 feeder 缓存（sensorId → emit；device-signal 上行入口用） */
  deviceFeeders: Map<string, (signal: { actorId?: string; at: number; fingerprint: string; salience: "high" | "medium" | "low"; payload?: Record<string, unknown> }) => void>;
  /** 主活跃用户口径（最近交互优先；规则 tick 与晨报共用） */
  primaryActor: () => string | null;
  /** 屏幕信号回看（rhythm 引擎的 ScreenFocusSensor 数据源） */
  recentScreenSignals: (n: number) => Signal[];
  start(): void;
}

export function createSensorLayer(deps: SensorLayerDeps): SensorLayer {
  const kernel = new SensorKernelImpl({ dataPath: deps.dataPath });
  // 屏幕状态条件化信号源：内核 signals 日志（落盘持久，重启不丢；最近 600 条覆盖数日窗口）
  const recentScreenSignals = (n: number) => kernel.recentLog(n);
  const scheduleSensor = new ScheduleSensorImpl({ listTasks: () => deps.scheduleTasks.listAllTasks() });
  kernel.register(scheduleSensor);
  // ─── 持续感知补全：文件系统传感器 ───
  // file_watcher：fs.watch 递归监听（env AGENT_FILE_WATCH_DIRS，缺省下载目录），
  //   只报文件名/动作不读内容。
  //   感知回溯查询经 perception.overview 工具暴露给对话面。
  const fileWatcherSensor = new FileWatcherSensorImpl();
  kernel.register(fileWatcherSensor);
  registerPerceptionOverviewTool(deps.toolRegistry, {
    kernel,
    screenFocus: () => null,
  });
  const goalFeeder = registerFeeder(kernel, "goal_board", "goal");
  const messageFeeder = registerFeeder(kernel, "message_hub", "message");
  const deviceFeeders = new Map<string, (signal: { actorId?: string; at: number; fingerprint: string; salience: "high" | "medium" | "low"; payload?: Record<string, unknown> }) => void>();
  const primaryActor = (): string | null => {
    const actors = deps.hub.exportActors();
    return actors.sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)[0]?.actorId ?? null;
  };
  // presence 追踪传感器：轮询每个活跃用户的在场状态，变化才产出信号
  // （presence 是晨间简报唤醒判断的数据源）。按 actor 记录上次状态，不能共用一个变量。
  const lastPresenceByActor = new Map<string, string>();
  kernel.register({
    id: "presence_tracker",
    stream: "presence",
    pollIntervalMs: 60_000,
    collect: () => {
      const now = Date.now();
      const cutoff = now - 24 * 3600_000;
      const out = [];
      for (const { actorId, lastInteractionAt } of deps.hub.exportActors()) {
        if (lastInteractionAt < cutoff) continue;
        const state = deps.presence.getPresence(actorId, now);
        if (lastPresenceByActor.get(actorId) === state) continue;
        lastPresenceByActor.set(actorId, state);
        out.push({
          stream: "presence" as const,
          actorId,
          at: now,
          fingerprint: `presence:${actorId}:${state}:${Math.floor(now / 60_000)}`,
          salience: "low" as const,
          delta: `用户当前状态：${state}`,
          payload: { state },
        });
      }
      return out;
    },
  });
  return {
    kernel,
    scheduleSensor,
    goalFeeder,
    messageFeeder,
    deviceFeeders,
    primaryActor,
    recentScreenSignals,
    start: () => kernel.start(),
  };
}
