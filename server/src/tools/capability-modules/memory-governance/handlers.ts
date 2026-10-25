import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { InterestWatcher } from "../../../proactivity/interest-watcher.js";
import type { AuditTrailService } from "../../../proactivity/audit-timeline.js";
import type { GoalBoard } from "../../../proactivity/goal-board.js";
import type { ShoppingCompareService } from "../../../services/shopping-compare-service.js";
import { getAgenticMemoryRuntime } from "../../../agentic-memory/index.js";
import { actorIdVariants } from "../../../agentic-memory/actor-key.js";

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

    // 4) 计划/盯梢目标（系统预执行目标 meeting_prep/morning_brief 不在遗忘范围）
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

    // 5) 长期记忆（Mem0：按关键词检索后按 id 删除；未启用时如实说明）
    if (hitScope("memory")) {
      const runtime = getAgenticMemoryRuntime();
      if (!runtime?.memory || !runtime?.lifecycle) {
        skipped.push("memory(长期记忆系统未启用)");
      } else {
        try {
          // mem0ai v3 getAll 强制 filters.user_id；actor 存量数据两种形式并存，逐形式扫
          const records: Array<{ id: string; memory?: string; metadata?: { actorId?: string } }> = [];
          for (const variant of actorIdVariants(actorId)) {
            const all = (await runtime.memory.getAll({
              topK: 10000,
              filters: { user_id: variant },
            })) as { results?: Array<{ id: string; memory?: string; metadata?: { actorId?: string } }> };
            records.push(...(all.results ?? []));
          }
          const ids = records
            .filter((m) => (m.metadata?.actorId ?? actorId) === actorId)
            .filter((m) => String(m.memory ?? "").toLowerCase().includes(kw))
            .map((m) => m.id);
          if (ids.length > 0) {
            const deleted = await runtime.lifecycle.deleteByIds(ids);
            cleared.memories = deleted.length;
          }
        } catch (err) {
          skipped.push(`memory(删除失败：${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }

    const total = (cleared.interests as number) + (cleared.watches as number) + (cleared.goals as number) + (cleared.memories as number);
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

    const { applyProfileOps, verifyProfileOps } = await import(
      "../../../brain/user-profile-aggregator.js"
    );
    const { UserProfileStore } = await import(
      "../../../services/user-personalization/user-profile-store.js"
    );
    const { touchProfileLines } = await import("../../../brain/profile-lines-meta.js");

    const store = new UserProfileStore();
    const current = await store.read(actorId);
    const { profile: next, applied } = applyProfileOps(current, [
      { op: op as "ADD" | "UPDATE" | "DELETE", section: section as "basic" | "interest" | "communication" | "note", ...(line ? { line } : {}), ...(match ? { match } : {}) },
    ]);
    if (applied.length === 0) {
      return {
        ok: false,
        error: "没有产生任何变更（ADD 幂等：该行已存在，或定位词没匹配到旧行）",
        hint: "如实告诉用户这条已经在档案里了，或换个更贴近旧行原文的 match 再试一次",
      };
    }
    await store.write(actorId, next);
    const written = await store.read(actorId);
    const failures = verifyProfileOps(written, applied);
    try {
      await touchProfileLines(
        actorId,
        written,
        applied.map((a) => a.expectLine ?? "").filter(Boolean),
      );
    } catch {
      /* sidecar 失败不影响主流程 */
    }
    return {
      ok: failures.length === 0,
      appliedCount: applied.length,
      section,
      recorded: line || match,
      hint: failures.length === 0
        ? "已写入画像。回复里自然带过即可（如「记上了」），不要复述档案字段、分区或写入过程"
        : "写入未生效。先用更贴近旧行原文的定位词重试一次；仍失败则一句话说明这条没记上即可，不要向用户展开校验、字段或档案结构细节",
    };
  };
}

export function registerMemoryGovernanceTools(registry: ToolRegistry, deps: MemoryGovernanceModuleDeps): void {
  registry.register("memory.forget", createForgetHandler(deps));
  registry.register("activity.timeline", createTimelineHandler(deps));
  registry.register("profile.update", createProfileUpdateHandler(deps));
}
