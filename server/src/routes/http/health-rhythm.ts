import type { FastifyInstance } from "fastify";
import { parseProfileLines } from "../../brain/profile-lines-meta.js";
import { UserProfileStore } from "../../services/user-personalization/user-profile-store.js";
import { resolveHealthRhythm } from "../../services/health-rhythm-service.js";

/**
 * 健康节奏接口（2026-10-23）：桌面端灵动岛久坐提醒的参数源。
 *
 * 对症下药：从结构化事实库（职业/公司/技术栈等档案字段）+ 用户画像 markdown
 * 的基本信息区收集身份线索 → resolveHealthRhythm 映射档位。认不出身份时
 * 返回保守默认，绝不把「上班族指南」硬套给所有人。
 * 护眼、喝水提醒均已删除，本接口只下发久坐参数。
 */
export function registerHealthRhythmRoutes(app: FastifyInstance): void {
  app.get("/api/health/rhythm", async (request, reply) => {
    const query = request.query as { actorId?: string };
    const actorId = String(query.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });

    // 身份线索收集：事实库档案字段优先（职业/公司/技术栈/身份类自定义字段），
    // 画像 markdown 基本信息区兜底（事实库未装配时唯一来源）。
    const clues: string[] = [];
    try {
      const { getMemoryComponents } = await import("../../agentic-memory/index.js");
      const factStore = getMemoryComponents().factStore;
      const facts = factStore?.getActiveFacts?.(actorId) ?? [];
      for (const f of facts) {
        const field = String((f as { field?: unknown }).field ?? "");
        const value = String((f as { value?: unknown }).value ?? "").trim();
        if (!value) continue;
        if (field === "职业" || field === "公司" || field === "技术栈" || field.includes("身份") || field.includes("职业")) {
          clues.push(`${field}:${value}`);
        }
      }
    } catch {
      /* 记忆系统未启用 → 走画像兜底 */
    }
    try {
      const markdown = await new UserProfileStore().read(actorId);
      for (const { section, line } of parseProfileLines(markdown)) {
        if (section === "基本信息") clues.push(line);
      }
    } catch {
      /* 画像不可读 → 忽略 */
    }

    const profile = resolveHealthRhythm(clues);
    return { ok: true, actorId, profile, clueCount: clues.length };
  });
}
