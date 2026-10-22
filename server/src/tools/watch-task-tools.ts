// 盯梢任务工具（watch.manage）—— 用户对话里说"帮我盯着XXX"，LLM 在创建时
// 从原话提炼 label + keywords（本次调用是全链路唯一一次 LLM），运行期匹配零 LLM。
// 工具域：watch.（DOMAIN_REGISTRY "watch" 域）。
import { resolveActorId } from "../agent/actor-id.js";
import { resolveBaseActorId } from "../agent/master-chat-session.js";
import type { ToolRegistry, ToolContext } from "./tool-registry.js";
import type { WatchTaskStore } from "../proactivity/branches/watch-tasks.js";

export function registerWatchTaskTools(
  registry: ToolRegistry,
  store: WatchTaskStore,
): void {
  registry.register("watch.manage", async (input, context: ToolContext) => {
    const sessionId = resolveActorId(context);
    const actorId = resolveBaseActorId(sessionId);
    const action = String(input.action ?? "").trim();

    if (action === "create") {
      const label = String(input.label ?? "").trim();
      const keywords = Array.isArray(input.keywords) ? input.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
      if (!label) return { ok: false, error: "label 不能为空（用一句人话描述盯什么，如「学校邮件里的选拔通知」）" };
      if (keywords.length === 0) {
        return { ok: false, error: "keywords 不能为空：从用户原话提炼 2-6 个会出现在相关消息里的关键词（每词 2-8 字，如「选拔」「报名」「截止」）" };
      }
      try {
        const t = store.create(actorId, label, keywords);
        return {
          ok: true,
          summary: `盯梢任务已创建：「${t.label}」，关键词 ${t.keywords.join("、")}。相关消息一到就会主动告诉你。请向用户复述任务内容。`,
          taskId: t.id,
          keywords: t.keywords,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    if (action === "list") {
      const tasks = store.list(actorId);
      return {
        ok: true,
        summary: tasks.length === 0
          ? "当前没有盯梢任务。"
          : `共 ${tasks.length} 个盯梢任务：${tasks.map((t) => `「${t.label}」(${t.active ? "盯" : "停"}，关键词：${t.keywords.join("、")})`).join("；")}。请逐条转述。`,
        tasks,
      };
    }

    if (action === "remove" || action === "pause" || action === "resume") {
      const taskId = String(input.taskId ?? "").trim();
      if (!taskId) return { ok: false, error: "taskId 不能为空（先 list 拿到 id）" };
      const done = action === "remove"
        ? store.remove(actorId, taskId)
        : store.setActive(actorId, taskId, action === "resume");
      if (!done) return { ok: false, error: `盯梢任务 ${taskId} 不存在或不属于当前用户` };
      const verb = action === "remove" ? "已删除" : action === "pause" ? "已暂停" : "已恢复";
      return { ok: true, summary: `盯梢任务${verb}。请告知用户。`, taskId };
    }

    return { ok: false, error: `未知 action「${action}」，可选：create / list / remove / pause / resume` };
  });
}
