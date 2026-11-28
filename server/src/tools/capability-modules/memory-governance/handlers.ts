import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { InterestWatcher } from "../../../proactivity/interest-watcher.js";
import type { AuditTrailService } from "../../../proactivity/audit-timeline.js";
import type { GoalBoard } from "../../../proactivity/goal-board.js";
import type { ShoppingCompareService } from "../../../services/shopping-compare-service.js";
import { getMemoryComponents } from "../../../agentic-memory/index.js";
import { getEventMemoryStore } from "../../../agentic-memory/event-store.js";
import { formatEventLine } from "../../../agentic-memory/event-recall.js";
import { isEventMemoryRecallEnabled } from "../../../agentic-memory/env.js";
import { forgetMemoryTarget } from "../../../services/memory-forget-service.js";

/**
 * memory.forget / activity.timeline handler + 注册入口。
 *
 * forget 是「按关键词的定向遗忘」统一入口：四处可见台账（兴趣/降价监控/
 * 计划盯梢/长期记忆）逐处尝试、逐处如实报告，清不了的（如未启用 Mem0）如实说明。
 * 语义记忆的溯源级作废（来源/断言级级联）走既有 memory.invalidate，本工具不重复。
 */
export interface MemoryGovernanceModuleDeps {
  interestWatcher?: InterestWatcher | null;
  shoppingCompareService?: ShoppingCompareService | null;
  goalBoard?: GoalBoard | null;
  auditTrailService?: AuditTrailService | null;
}

export function createForgetHandler(deps: MemoryGovernanceModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const target = typeof input.target === "string" ? input.target.trim() : "";
    if (target.length < 2) return { ok: false, error: "target 至少 2 个字符（要遗忘的对象关键词）" };
    const scope = typeof input.scope === "string" ? input.scope : "auto";
    const kw = target.toLowerCase();
    const cleared: Record<string, number | string[]> = {
      interests: 0,
      watches: 0,
      goals: 0,
      memories: 0,
      facts: 0,
      understandings: 0,
      graphNodes: 0,
    };
    const skipped: string[] = [];
    const hitScope = (s: string): boolean => scope === "auto" || scope === s;

    // 1) 兴趣关注
    if (hitScope("interest")) {
      const watcher = deps.interestWatcher;
      if (!watcher) skipped.push("interest(兴趣池未装配)");
      else {
        const before = watcher.listInterests(actorId).length;
        await watcher.removeInterest(actorId, target);
        cleared.interests = Math.max(0, before - watcher.listInterests(actorId).length);
      }
    }

    // 2) 降价监控
    if (hitScope("watch")) {
      const service = deps.shoppingCompareService;
      if (!service) skipped.push("watch(比价服务未装配)");
      else {
        const watches = service.listWatches(actorId);
        const matched = watches.filter(
          (w) => w.query.toLowerCase().includes(kw) || kw.includes(w.query.toLowerCase()),
        );
        for (const w of matched) await service.removeWatch(actorId, w.id);
        cleared.watches = matched.length;
      }
    }

    // 4) 计划/盯梢目标（系统预执行目标 morning_brief 不在遗忘范围）
    if (hitScope("plan")) {
      const board = deps.goalBoard;
      if (!board) skipped.push("plan(目标板未装配)");
      else {
        let n = 0;
        for (const g of board.list(actorId)) {
          if (g.kind !== "plan" && g.kind !== "track") continue;
          if (!g.title.toLowerCase().includes(kw)) continue;
          if (board.remove(g.goalId, actorId)) n += 1;
        }
        cleared.goals = n;
      }
    }

    // 5) 长期记忆：事实、理解、图、Mem0 与 FTS 统一级联
    if (hitScope("memory")) {
      const forgotten = await forgetMemoryTarget(actorId, target);
      cleared.memories = forgotten.memories;
      cleared.facts = forgotten.facts;
      cleared.understandings = forgotten.understandings;
      cleared.graphNodes = forgotten.graphNodes;
      skipped.push(...forgotten.skipped);
    }

    const total = Object.values(cleared).reduce<number>((sum, n) => sum + (typeof n === "number" ? n : 0), 0);
    return {
      ok: true,
      target,
      ...(typeof input.reason === "string" && input.reason.trim() ? { reason: input.reason.trim() } : {}),
      cleared,
      ...(skipped.length > 0 ? { skipped } : {}),
      hint:
        total > 0
          ? "已按上述范围清除，向用户如实报告各项数量；对话历史原文不删，但不会再被主动引用"
          : "没有匹配到任何台账条目，如实告知用户没找到相关记录，并建议换更具体的关键词",
    };
  };
}

export function createTimelineHandler(deps: MemoryGovernanceModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const service = deps.auditTrailService;
    if (!service) return { ok: false, error: "审计时间线未装配" };
    const actorId = resolveActorId(context);
    const limitRaw = typeof input.limit === "number" ? Math.floor(input.limit) : 30;
    const limit = Math.min(Math.max(limitRaw, 1), 60);
    const entries = service.timeline(actorId, limit);
    return {
      ok: true,
      count: entries.length,
      entries,
      summary: service.summary(actorId) ?? "",
      hint: "以真实台账回答（办了什么/在忙什么/等确认什么），不要杜撰台账之外的行动",
    };
  };
}

/**
 * memory.recall（事件记忆 L0 检索口）：按时间/对象/结果回忆真实做过的事。
 * 只呈现结果行，不向用户暴露内部检索过程；查不到如实返回 0 条。
 */
export function createRecallHandler(_deps: MemoryGovernanceModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    if (!isEventMemoryRecallEnabled()) {
      return { ok: false, error: "事件回忆未启用" };
    }
    const store = getEventMemoryStore();
    if (!store) return { ok: false, error: "事件记忆未就绪" };
    const actorId = resolveActorId(context);
    const now = Date.now();
    const limitRaw = typeof input.limit === "number" ? Math.floor(input.limit) : 20;
    const limit = Math.min(Math.max(limitRaw, 1), 50);
    const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : new Date(now).toISOString();
    let from: string | undefined;
    if (typeof input.from === "string" && input.from.trim()) {
      from = input.from.trim();
    } else {
      const daysRaw = typeof input.days === "number" ? input.days : 30;
      const days = Math.min(Math.max(daysRaw, 1), 3650);
      from = new Date(now - days * 86_400_000).toISOString();
    }
    const kinds = Array.isArray(input.kinds)
      ? input.kinds.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      : undefined;
    const statuses =
      typeof input.status === "string" && input.status.trim() ? [input.status.trim()] : undefined;
    const query = typeof input.query === "string" ? input.query.trim() : "";

    const events = store.recallEvents({
      actorId,
      from,
      to,
      kinds: kinds?.length ? kinds : undefined,
      statuses,
      query: query || undefined,
      limit,
    });

    const lines = events.map((event) => formatEventLine(event, now));
    return {
      ok: true,
      count: events.length,
      events: events.map((event, i) => ({
        time: event.eventTime,
        kind: event.kind,
        status: event.status,
        line: lines[i],
      })),
      summary: lines.join("\n"),
      hint:
        events.length > 0
          ? "以上是真实发生过的记录。直接用结果回答；不要提及检索、数据库或任何内部查询过程。"
          : "这个范围内没有查到相关记录，如实告诉用户没查到，不要猜测或编造当时的结果。",
    };
  };
}

/** 敏感类目：命中须先获用户明确同意（confirmed=true）才落画像 */
const PROFILE_SENSITIVE_RE =
  /病史|疾病|病症|确诊|用药|抑郁|焦虑|心理咨询|怀孕|流产|性|恋爱|出轨|离婚|分手|吵架|收入|工资|存款|负债|欠款|贷款|借[款钱]|身份证|护照|体检|遗传/;

/**
 * profile.update（2026-09-29 P0-2「说话算话的记」）：agent 在对话中自编辑
 * 用户画像——确定性落位复用聚合器的 applyProfileOps/verifyProfileOps，
 * 写后同步行新鲜度 sidecar。敏感类目未确认即拒绝（needConfirmation）。
 */
export function createProfileUpdateHandler(_deps: MemoryGovernanceModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const actorId = resolveActorId(context);
    const op = String(input.op ?? "").trim();
    const section = String(input.section ?? "").trim();
    const line = typeof input.line === "string" ? input.line.trim() : "";
    const match = typeof input.match === "string" ? input.match.trim() : "";
    const confirmed = input.confirmed === true;

    if (!["ADD", "UPDATE", "DELETE"].includes(op)) {
      return { ok: false, error: "op 必须是 ADD/UPDATE/DELETE" };
    }
    if (!["basic", "interest", "communication", "note"].includes(section)) {
      return { ok: false, error: "section 必须是 basic/interest/communication/note" };
    }
    if ((op === "ADD" || op === "UPDATE") && !line) {
      return { ok: false, error: `${op} 需要 line（新内容，一行）` };
    }
    if ((op === "UPDATE" || op === "DELETE") && !match) {
      return { ok: false, error: `${op} 需要 match（定位旧行的关键词）` };
    }
    if (PROFILE_SENSITIVE_RE.test(`${line} ${match}`) && !confirmed) {
      return {
        ok: false,
        needConfirmation: true,
        hint:
          "这是敏感信息（健康/婚恋/财务/证件类）。请先向用户复述要记的内容并明确询问「要我记在长期画像里吗」，" +
          "用户同意后重新调用并带 confirmed=true。不要默认记录。",
      };
    }

    const { UserProfileAggregator } = await import(
      "../../../brain/user-profile-aggregator.js"
    );
    const result = await new UserProfileAggregator().updateProfile(actorId, [
      { op: op as "ADD" | "UPDATE" | "DELETE", section: section as "basic" | "interest" | "communication" | "note", ...(line ? { line } : {}), ...(match ? { match } : {}) },
    ]);
    if (!result.changed) {
      return {
        ok: false,
        error: result.skipped.length > 0
          ? `该内容不符合画像写入门槛，未写入：${result.skipped[0]}`
          : "没有产生任何变更（ADD 幂等：该行已存在，或定位词没匹配到旧行）",
        hint: result.skipped.length > 0
          ? "如实告诉用户这条不适合长期画像，不要硬记"
          : "如实告诉用户这条已经在档案里了，或换个更贴近旧行原文的 match 再试一次",
      };
    }
    return {
      ok: result.verified,
      appliedCount: 1,
      section,
      recorded: line || match,
      hint: result.verified
        ? "已写入画像。回复里自然带过即可（如「记上了」），不要复述档案字段、分区或写入过程"
        : "写入未生效。先用更贴近旧行原文的定位词重试一次；仍失败则一句话说明这条没记上即可，不要向用户展开校验、字段或档案结构细节",
    };
  };
}

/**
 * memory.invalidate（溯源作废）：用户撤回消息/否认说过，或某条断言被证伪。
 *
 * schema 一直由 MEMORY_INVALIDATION_CHAT_TOOLS 下发给模型，但此前没有注册
 * 执行器——模型真调用时会拿到「未知工具」。级联能力（账本标记 void、Mem0
 * 删除、认知图节点 overridden）早已在 ProvenanceService 里实现，这里只做
 * 参数校验与接线，不重复实现删除逻辑。
 */
export function createInvalidateHandler(_deps: MemoryGovernanceModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>) => {
    const sourceRef = typeof input.sourceRef === "string" ? input.sourceRef.trim() : "";
    const claimId = typeof input.claimId === "string" ? input.claimId.trim() : "";
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) return { ok: false, error: "reason 必填（说明为什么要作废）" };
    if (!sourceRef && !claimId) {
      return { ok: false, error: "sourceRef 与 claimId 至少提供一个" };
    }

    const provenance = getMemoryComponents().provenance;
    if (!provenance) return { ok: false, error: "溯源作废未启用（AGENT_PROVENANCE 关闭）" };

    const report = sourceRef
      ? await provenance.invalidateSource(sourceRef, reason)
      : await provenance.invalidateClaim(claimId, reason);
    const touched = report.ledgerSuperseded + report.mem0Deleted + report.graphOverridden;
    return {
      ok: true,
      ...(sourceRef ? { sourceRef } : {}),
      ...(claimId ? { claimId } : {}),
      ...report,
      hint:
        touched > 0
          ? "已作废并完成级联清理。向用户简短确认即可，不要展开内部存储细节。"
          : "没有找到可作废的记录（来源/断言不存在或已作废）。如实告诉用户没找到，不要编造。",
    };
  };
}

export function registerMemoryGovernanceTools(registry: ToolRegistry, deps: MemoryGovernanceModuleDeps): void {
  registry.register("memory.forget", createForgetHandler(deps));
  registry.register("activity.timeline", createTimelineHandler(deps));
  registry.register("memory.recall", createRecallHandler(deps));
  registry.register("profile.update", createProfileUpdateHandler(deps));
  registry.register("memory.invalidate", createInvalidateHandler(deps));
}
