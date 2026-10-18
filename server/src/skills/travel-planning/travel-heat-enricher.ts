/**
 * 旅游 POI 社交热度回填器（travel-upgrade-plan 数据层）。
 *
 * 职责：规划完成后（fire-and-forget，不阻塞请求）用小红书/抖音聚合搜索结果
 * 给 POI 打「网红/出片/漂亮饭」标签，经 poiCache.updatePOISocial 落库。
 *
 * 数据诚实边界（项目铁律：宁缺毋滥不造假）：
 *   - 来源只有真实社媒搜索聚合（searchXiaohongshu / searchDouyin）
 *   - LLM 只做「名单内归类」，名单里没有的 POI 禁止编造
 *   - 搜索失败/LLM 失败/解析失败 → 静默返回 0，攻略清单自然为空态
 *   - 每目的地 7 天回填一次（enrichedAt 去重表），env TRAVEL_HEAT_ENRICH=off 关闭
 */
import type { CacheEntry } from './poi-cache-manager.js';
import { poiCache } from './poi-cache-manager.js';

/** LLM 侧车接口：与装配层 externalChat.streamCompletion 对齐（一次性取全文） */
export type HeatLlmComplete = (
  prompt: string,
  opts?: { maxTokens?: number },
) => Promise<string>;

/** 社媒搜索口（与 UpstreamSearchService.searchXiaohongshu/searchDouyin 形状一致） */
export type SocialSearchPort = (
  query: string,
  limit?: number,
) => Promise<{ provider: string; raw: string; notes: string[] }>;

export interface HeatEnricherDeps {
  searchXiaohongshu?: SocialSearchPort;
  searchDouyin?: SocialSearchPort;
  llmComplete?: HeatLlmComplete;
}

/** 单 POI 的回填 patch（与 poiCache.updatePOISocial 对齐） */
export interface PoiSocialPatch {
  type: 'attraction' | 'restaurant';
  name: string;
  socialHeat: { level: 'hot' | 'mid'; source?: string };
  photo?: { score: number; spot?: string; bestTime?: string };
  prettyFood?: { vibe?: string; signature?: string };
}

const ENRICH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** 名单规模上限（LLM 归类输入防膨胀：每桶取评分/热度前列） */
const LIST_CAP = 25;

export class TravelHeatEnricher {
  private readonly lastEnrichAt = new Map<string, number>();
  private readonly inflight = new Set<string>();

  constructor(private readonly deps: HeatEnricherDeps) {}

  /** 是否已启用（env TRAVEL_HEAT_ENRICH=off 关闭；缺 LLM/搜索口也视为不可用） */
  get enabled(): boolean {
    return process.env.TRAVEL_HEAT_ENRICH !== 'off'
      && !!this.deps.llmComplete
      && !!(this.deps.searchXiaohongshu || this.deps.searchDouyin);
  }

  /** 触发回填（fire-and-forget；7 天内已回填过/在途则跳过）。返回是否真正启动。 */
  maybeEnrich(destination: string, entry: CacheEntry): boolean {
    if (!this.enabled) return false;
    const key = destination.trim();
    if (!key || this.inflight.has(key)) return false;
    const last = this.lastEnrichAt.get(key) ?? 0;
    if (Date.now() - last < ENRICH_INTERVAL_MS) return false;
    this.inflight.add(key);
    void this.enrichDestination(key, entry)
      .catch(() => { /* 回填失败静默：宁缺毋滥，不阻塞主链路 */ })
      .finally(() => {
        this.lastEnrichAt.set(key, Date.now());
        this.inflight.delete(key);
      });
    return true;
  }

  /**
   * 单目的地回填：搜社媒 → LLM 名单内归类 → 回写 poiCache。
   * 公开供脚本/测试直调（跳过去重）。
   */
  async enrichDestination(destination: string, entry: CacheEntry): Promise<number> {
    const briefs = await this.gatherSocialBriefs(destination);
    if (!briefs.length) return 0;

    const candidates = this.buildCandidateList(entry);
    if (!candidates.length) return 0;

    const raw = await this.deps.llmComplete!(this.buildPrompt(destination, candidates, briefs), {
      maxTokens: 1600,
    });
    const patches = this.parseModelJson(raw);
    if (!patches.length) return 0;

    let count = 0;
    for (const p of patches) {
      const poiId = this.resolvePoiId(entry, p.type, p.name);
      if (!poiId) continue;
      const ok = poiCache.updatePOISocial(destination, p.type, poiId, {
        socialHeat: p.socialHeat,
        ...(p.photo ? { photo: p.photo } : {}),
        ...(p.prettyFood ? { prettyFood: p.prettyFood } : {}),
      });
      if (ok) count++;
    }
    if (count > 0) {
      console.log(`[TravelHeatEnricher] ${destination} 回填社交属性 ${count}/${patches.length} 个 POI`);
    }
    return count;
  }

  // ────────────────────────── 内部 ──────────────────────────

  /** 并行聚合小红书/抖音搜索（每个源两条 query：打卡 + 漂亮饭），失败源静默 */
  private async gatherSocialBriefs(destination: string): Promise<Array<{ source: string; raw: string }>> {
    const queries: Array<{ source: string; port?: SocialSearchPort; q: string }> = [];
    const xhs = this.deps.searchXiaohongshu;
    const douyin = this.deps.searchDouyin;
    if (xhs) {
      queries.push({ source: 'xiaohongshu', port: xhs, q: `${destination} 网红打卡 出片 攻略` });
      queries.push({ source: 'xiaohongshu', port: xhs, q: `${destination} 漂亮饭 网红餐厅` });
    }
    if (douyin) {
      queries.push({ source: 'douyin', port: douyin, q: `${destination} 网红打卡点` });
    }
    const settled = await Promise.allSettled(
      queries.map(async ({ source, port, q }) => ({ source, raw: (await port!(q, 8)).raw })),
    );
    return settled.flatMap((r) =>
      r.status === 'fulfilled' && r.value.raw.trim().length > 40 ? [r.value] : [],
    );
  }

  /** 候选名单：景点+餐厅（hotel 不参与网红归类），名称去重防 LLM 按名重复 */
  private buildCandidateList(entry: CacheEntry): Array<{ type: string; id: string; name: string; rating?: number }> {
    const seen = new Set<string>();
    const out: Array<{ type: string; id: string; name: string; rating?: number }> = [];
    const take = (list: typeof entry.data.attractions, type: 'attraction' | 'restaurant') => {
      const sorted = [...list]
        .filter((p) => p?.id && p?.name)
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, LIST_CAP);
      for (const p of sorted) {
        const k = `${type}:${p.name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ type, id: p.id, name: p.name, rating: p.rating });
      }
    };
    take(entry.data.attractions, 'attraction');
    take(entry.data.restaurants, 'restaurant');
    return out;
  }

  private buildPrompt(
    destination: string,
    candidates: Array<{ type: string; name: string; rating?: number }>,
    briefs: Array<{ source: string; raw: string }>,
  ): string {
    const list = candidates
      .map((c) => `- [${c.type}] ${c.name}${c.rating ? `（评分${c.rating}）` : ''}`)
      .join('\n');
    const brief = briefs
      .map((b) => `【${b.source}】\n${b.raw.slice(0, 3500)}`)
      .join('\n\n');
    return [
      `你在为「${destination}」的旅游攻略标注 POI 的社交热度。下面是候选 POI 名单，以及从小红书/抖音聚合搜索到的真实内容摘录。`,
      '',
      '任务：判断名单中哪些 POI 在社媒内容中被推荐/打卡/称为网红点，并给出出片或漂亮饭属性。',
      '硬性规则：',
      '1. 只允许输出名单里的 POI（按名称精确对应），名单里没有的一个都不许出现；',
      '2. 社媒摘录里完全没有提到的 POI 不要输出——宁缺毋滥；',
      '3. photo.spot / bestTime / prettyFood.vibe / signature 只能基于摘录内容概括，摘录里没有依据就省略该字段；',
      '4. score 是 1-5 的出片指数（依据摘录中的照片描述/推荐语气，拿不准给 3）；',
      '5. 只输出 JSON，不要任何解释或 markdown 围栏。',
      '',
      '输出格式：',
      '{"items":[{"type":"attraction|restaurant","name":"名单中的原名","socialHeat":"hot|mid","photo":{"score":4,"spot":"...","bestTime":"..."},"prettyFood":{"vibe":"...","signature":"..."}}]}',
      '（photo 仅 attraction，prettyFood 仅 restaurant；没有的字段省略）',
      '',
      '候选名单：',
      list,
      '',
      '社媒摘录：',
      brief,
    ].join('\n');
  }

  /** 解析 LLM 输出（容错：剥围栏/截取首段 JSON），并做字段级校验 */
  parseModelJson(raw: string): PoiSocialPatch[] {
    if (!raw) return [];
    let text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    text = text.slice(start, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    const out: PoiSocialPatch[] = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      const type = o.type === 'restaurant' ? 'restaurant' : 'attraction';
      const heat = o.socialHeat === 'hot' || o.socialHeat === 'mid' ? o.socialHeat : null;
      if (!name || !heat) continue;
      const patch: PoiSocialPatch = { type, name, socialHeat: { level: heat, source: '社媒聚合(LLM归类)' } };
      const photo = o.photo as Record<string, unknown> | undefined;
      if (type === 'attraction' && photo && typeof photo === 'object') {
        const score = Number(photo.score);
        patch.photo = {
          score: Number.isFinite(score) ? Math.min(5, Math.max(1, Math.round(score))) : 3,
          ...(typeof photo.spot === 'string' && photo.spot.trim() ? { spot: photo.spot.trim().slice(0, 60) } : {}),
          ...(typeof photo.bestTime === 'string' && photo.bestTime.trim() ? { bestTime: photo.bestTime.trim().slice(0, 24) } : {}),
        };
      }
      const pf = o.prettyFood as Record<string, unknown> | undefined;
      if (type === 'restaurant' && pf && typeof pf === 'object') {
        patch.prettyFood = {
          ...(typeof pf.vibe === 'string' && pf.vibe.trim() ? { vibe: pf.vibe.trim().slice(0, 60) } : {}),
          ...(typeof pf.signature === 'string' && pf.signature.trim() ? { signature: pf.signature.trim().slice(0, 60) } : {}),
        };
      }
      out.push(patch);
    }
    return out.slice(0, LIST_CAP * 2);
  }

  /** 名称 → poiId 精确匹配（name_norm 不可用时的简单规范化匹配） */
  private resolvePoiId(
    entry: CacheEntry,
    type: 'attraction' | 'restaurant',
    name: string,
  ): string | undefined {
    const list = type === 'restaurant' ? entry.data.restaurants : entry.data.attractions;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    const target = norm(name);
    return list.find((p) => norm(p.name) === target)?.id;
  }
}
