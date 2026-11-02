import { resolveActorId } from "../agent/actor-id.js";
import type { ScheduleIntentService } from "../services/schedule-intent-service.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import {
  buildAdvisorSuggestionText,
  buildSuggestion,
  type ProductCatalog,
} from "../recommendation/index.js";
import {
  applyPersonalization,
  buildPersonalizationUserPrompt,
  PERSONALIZATION_RULES_PROMPT,
  type SuggestPersonalizationPort,
} from "../recommendation/personalize.js";

/** 购物建议的实时个性化依赖（画像摘要 + ephemeral LLM 单轮决策）。 */
export interface SuggestPersonalizationDeps {
  catalog: ProductCatalog;
  personalization?: SuggestPersonalizationPort;
  /**
   * 缺图候选的网搜补图端口（单图，降级路径）：query 检索一张商品图，返回可
   * 直接渲染的本地相对路径，无结果返回 null。未提供多图端口时使用。
   */
  webImageSearch?: (query: string, actorId: string) => Promise<string | null>;
  /**
   * 缺图候选的多图网搜（图片三优先级第二级）：返回 ≤limit 张本地 PNG 地址。
   * 与 pickProductImage 搭配构成「批量搜图 → VLM 选主体图」链路；
   * 未注入时降级 webImageSearch 单图语义。
   */
  webImageCandidates?: (query: string, actorId: string, limit: number) => Promise<string[]>;
  /**
   * 商品图 VLM 质检选图（选图裁判，仅网搜兜底时启用）：对候选图打分返回
   * 最适合「商品主体图」的一张；VLM 不可用/超时/全负分返回 null（调用方取首图）。
   */
  pickProductImage?: (
    candidates: Array<{ url: string }>,
    productName: string,
    deadlineMs: number,
  ) => Promise<string | null>;
  /**
   * 真实口碑聚合端口（P3：小红书 UGC，归属主推商品）：返回 null=无口碑
   * （alias 未配置/失败/空），卡口碑区整体不渲染；6s 死线由 handler 保证。
   */
  ugcSearch?: (productName: string) => Promise<unknown>;
}

// 补图结果缓存：命中永久有效（转存 PNG 不可变且静态路由长缓存）；
// 未命中 10 分钟后允许重试（避开搜索源瞬时故障被记死）。
// 实例级（每次 registerLifeTools 创建）：生产单例语义不变，测试间天然隔离。
const SUGGEST_IMAGE_MISS_RETRY_MS = 10 * 60_000;
// 补图整体死线：shopping.suggest 外圈工具超时默认 30s，给个性化 LLM 留余量
const SUGGEST_IMAGE_FILL_DEADLINE_MS = 9_000;
// 口碑聚合死线：与补图/个性化同预算池（30s 工具超时），收窄到 6s
const SUGGEST_UGC_DEADLINE_MS = 6_000;

type SuggestImageCache = Map<string, { url: string | null; cachedAt: number }>;

/**
 * 对无图候选并行补图（有图候选不动——官方/商品库一手图优先于网搜图）。
 * 图片三优先级：商品库主图＞多图网搜＋
 * VLM 选主体图（webImageCandidates + pickProductImage）＞单图网搜（旧路径）。
 * VLM 选图超时/失败/全负分时取首图兜底，不阻断推荐。
 */
async function fillCandidateImages(
  candidates: Array<{ productId: string; brand: string; name: string; image?: string }>,
  deps: SuggestPersonalizationDeps,
  cache: SuggestImageCache,
  actorId: string,
): Promise<void> {
  const searchMulti = deps.webImageCandidates;
  const searchSingle = deps.webImageSearch;
  if (!searchMulti && !searchSingle) return;
  const pending = candidates.filter((c) => !c.image);
  if (pending.length === 0) return;
  const deadline = Date.now() + SUGGEST_IMAGE_FILL_DEADLINE_MS;
  await Promise.all(
    pending.map(async (c) => {
      const cached = cache.get(c.productId);
      if (cached) {
        const fresh =
          cached.url !== null || Date.now() - cached.cachedAt < SUGGEST_IMAGE_MISS_RETRY_MS;
        if (fresh) {
          if (cached.url) c.image = cached.url;
          return;
        }
      }
      const budget = deadline - Date.now();
      if (budget <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const label = `${c.brand} ${c.name}`.trim();
      const url = await Promise.race([
        (async () => {
          if (searchMulti) {
            try {
              // 「产品图」后缀提高主体图命中率；3 张给 VLM 足够淘汰场景图/水印图
              const urls = await searchMulti(`${label} 产品图`, actorId, 3);
              if (urls.length === 0) return null;
              if (deps.pickProductImage) {
                const best = await deps.pickProductImage(
                  urls.map((u) => ({ url: u })),
                  label,
                  Math.max(1_500, deadline - Date.now()),
                );
                if (best) return best;
              }
              return urls[0] ?? null;
            } catch {
              return null;
            }
          }
          return searchSingle!(label, actorId).catch(() => null);
        })(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), budget);
        }),
      ]).finally(() => clearTimeout(timer));
      cache.set(c.productId, { url: url ?? null, cachedAt: Date.now() });
      if (url) c.image = url;
    }),
  );
}

export function registerLifeTools(
  registry: ToolRegistry,
  scheduleTaskService: ScheduleTaskService,
  scheduleIntentService: ScheduleIntentService,
  /** 购物建议依赖：商品库 + 实时个性化（画像/习惯 → 每轮实时决策话术） */
  suggestDeps?: SuggestPersonalizationDeps,
): void {
  const suggestImageCache: SuggestImageCache = new Map();
  registry.register("budget.calculate", async (input) => {
    const income = Number(input.income ?? 0);
    const rent = Number(input.rent ?? 0);
    const food = Number(input.food ?? 0);
    const transport = Number(input.transport ?? 0);
    const remain = income - rent - food - transport;
    return {
      summary: "预算计算完成",
      remain,
      advice: remain >= 0 ? "收支健康，可适度储蓄" : "收支为负，建议降低可选消费",
    };
  });

  // 购物建议（runtime 内置能力，卡片由 tool-card-registry 从本回执确定性直出：
  // 候选 ≤3、≥2 附转置对比表；字段来自商品库（参数/价格/口碑）+ 缺图网搜补图，
  // 可溯源）。未命中时如实返回，由模型给泛选购建议并明说库里没有。
  registry.register("shopping.suggest", async (input, context) => {
    const item = String(input.item ?? "").trim();
    const budget = typeof input.budget === "number" && input.budget > 0 ? input.budget : undefined;
    const userRequest = String(input.userRequest ?? "").trim();
    if (!item) return { ok: false, error: "缺少 item（商品名或品类）" };
    if (!suggestDeps?.catalog) {
      return {
        ok: true,
        summary: "本地商品库未装配",
        item,
        budget,
        suggestion: "向用户说明当前没有可查的商品库，只能给泛选购建议，不假装有货。",
      };
    }

    // ① 确定性检索：商品库真实数据圈定候选（视频/价格/对比表都出自这里；
    //    图片出自官方主图/商品库 + 缺图时网搜补齐）
    let recommendation = buildSuggestion(suggestDeps.catalog, { item, budget });
    if (!recommendation) {
      return {
        ok: true,
        summary: `商品库中「${item}」无匹配商品`,
        item,
        budget,
        suggestion: "如实告知库里没有匹配商品，可给泛选购建议；不编造在售商品。",
      };
    }
    // ①.5 缺图候选网搜补图（确定性，非 LLM 编造），保证卡片默认带图
    try {
      await fillCandidateImages(
        recommendation.candidates,
        suggestDeps,
        suggestImageCache,
        resolveActorId(context),
      );
    } catch {
      // 补图失败静默降级：候选保持无图，不阻断推荐
    }

    // ①.6 真实口碑聚合（P3：小红书 UGC，归属主推商品）：6s 死线 race，
    //    失败/空 → 不附口碑（卡片无口碑区），不阻断推荐。
    if (suggestDeps.ugcSearch && recommendation.pick) {
      const pickBase = suggestDeps.catalog.get(recommendation.pick.productId);
      const pickLabel = pickBase
        ? `${pickBase.brand} ${pickBase.name}`.trim()
        : item;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ugc = await Promise.race([
          Promise.resolve(suggestDeps.ugcSearch(pickLabel)).catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), SUGGEST_UGC_DEADLINE_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (ugc && typeof ugc === "object") {
          recommendation.ugc = ugc as typeof recommendation.ugc;
        }
      } catch {
        // 口碑失败静默降级：无口碑区
      }
    }

    // ② 每轮实时决策：结合用户画像/习惯，由 LLM 当轮重排候选并改写推荐话术
    //    （ephemeral 单轮调用，不落会话线程；失败/不可用降级为商品库原始文案）
    const personalization = suggestDeps.personalization;
    if (personalization?.llmComplete) {
      try {
        const actorId = resolveActorId(context);
        const userContext = await personalization.buildUserContext(actorId, userRequest);
        if (userContext) {
          const candidatesJson = JSON.stringify(
            recommendation.candidates.map((c) => {
              const full = suggestDeps.catalog.get(c.productId);
              return {
                productId: c.productId,
                brand: c.brand,
                name: c.name,
                priceLabel: c.priceLabel,
                specs: full?.specs ?? [],
                reviewSummary: full?.reviewSummary ?? null,
              };
            }),
          );
          const raw = await personalization.llmComplete(
            PERSONALIZATION_RULES_PROMPT,
            buildPersonalizationUserPrompt({
              userRequest: userRequest || item,
              userContext,
              candidatesJson,
            }),
          );
          const { result: personalized, applied } = applyPersonalization(recommendation, raw);
          return {
            ok: true,
            summary: personalized.summary,
            budget,
            recommendation: personalized,
            suggestionText: buildAdvisorSuggestionText(personalized),
            personalized: applied,
          };
        }
      } catch {
        // 个性化失败静默降级（下方返回商品库原始文案）
      }
    }

    return {
      ok: true,
      summary: recommendation.summary,
      budget,
      recommendation,
      suggestionText: buildAdvisorSuggestionText(recommendation),
    };
  });

}
