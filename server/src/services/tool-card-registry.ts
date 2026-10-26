/**
 * 工具结果 → 卡片注册表（B 阶段：结构化直出卡）。
 *
 * 解决「文本很难被触发」的另一半根因：带 schema 的工具结果不该依赖 LLM
 * 抄写成 markdown 列表再被正则猜回来。注册 builder 后，卡由代码从工具
 * 结构化回执**确定性构建**，LLM 的口头回复只作前导正文——LLM 写不写列表
 * 语法都不影响上卡。
 *
 * 与既有确定性路径的分工：
 *   - travel.plan-itinerary → attachTravelItineraryCard（双面板卡，含冷层回捞）
 *   - 媒体搜索 → mediaCards 结构化字段（chat.assistant_done 独立下发）
 *   - search 原始 JSON 回显 → detectRawSearchResultJson 抢救（未注册工具的兜底）
 * 新工具按需在 BUILDERS 注册即可，builder 返回 null（结构异常/空数据）时
 * 自动回退既有文本路由，零破坏。
 *
 * 卡 payload 与 AgentResultFormatter 的 AgentResultPayload 同构
 * （前端 agent_result_parser.dart / AgentResultCard 直接消费，无需前端改动）。
 */

/** 与 agent-result-formatter 的 items 类型推断一致：check/warn/num */
export interface ToolCardItem {
  type: "check" | "warn" | "num";
  text: string;
  /** 搜索结果卡等场景的跳转链接（前端 _SearchResultCard 整条可点击） */
  url?: string;
  source?: string;
  /** 行首缩略图（比价卡商品主图等；客户端通用卡渲染为 40x40 圆角图） */
  thumbnailUrl?: string;
  /** A/B 对比类条目的分侧标注 */
  side?: string;
  sideLabel?: string;
  /** product_compare 卡：分侧大图（商品图/试色图），随 side 标注归属 */
  image?: string;
}

export interface ToolCardPayload {
  title: string;
  items: ToolCardItem[];
  footer?: string;
  /** 前端 _SpecializedCard 的卡型：weather/schedule/wallet/order/file 或空串=通用 */
  cardType: string;
  /** product_compare 卡：分侧大图头部（A/B 两列并排，试色/商品图） */
  sides?: Array<{
    side: string;
    label: string;
    priceLabel?: string;
    image?: string;
  }>;
  /** product_compare 卡：转置参数表（维度为行、sides 为列） */
  compare?: {
    dims: string[];
    rows: Array<{ label: string; values: string[] }>;
  };
  /** product_compare 卡：评测/试色视频入口 */
  videos?: Array<{ title: string; url?: string; source?: string }>;
  /**
   * product_pick 卡（立场化推荐）：主推商品 + 备选定位。
   * sides/items/compare/videos 同时保留（兼容旧客户端 fallback 渲染）。
   */
  pick?: {
    productId: string;
    label: string;
    priceLabel?: string;
    image?: string;
    headline?: string;
    reasons: string[];
    cautions: string[];
    channels?: Array<{ name: string; priceCny: number; url?: string }>;
  };
  alternatives?: Array<{
    productId: string;
    label: string;
    priceLabel?: string;
    image?: string;
    whenChoose?: string;
  }>;
  /**
   * 专用卡型的附加载荷（随卡 JSON 原样透传给前端，AgentResultData.extra 消费）：
   * 如 travel_guide_select 卡的分类候选（多图+推荐度+预选态）。
   */
  extra?: Record<string, unknown>;
  /** product_pick 卡：真实口碑摘要（小红书 UGC，归属主推；无口碑缺省） */
  ugc?: {
    platformLabel?: string;
    mentions?: number;
    pros?: string[];
    cons?: string[];
    posts?: Array<{ title: string; url?: string }>;
  };
  /**
   * 操作按钮（客户端渲染为 AgentActionChoiceCard，点击经 chat.user_action 回传，
   * 由 LLM 按按钮 label 语义理解执行——通用按钮模式，无服务端 actionId 硬路由）。
   * 如支付确认卡：「我已完成支付，帮我确认」/「稍后再说」。
   */
  actions?: Array<{
    id: string;
    label: string;
    variant?: "primary" | "secondary" | "ghost";
    payload?: Record<string, unknown>;
  }>;
}

type ToolCardBuilder = (result: Record<string, unknown>) => ToolCardPayload | null;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** ISO 时间「2026-09-10T08:00:00」→「09-10 08:00」；纯字符串截取，不经 Date，跨时区稳定 */
function shortTime(value: unknown): string {
  const raw = str(value);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return raw;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

const BUILDERS: Record<string, ToolCardBuilder> = {
  /**
   * search_web / info.search → search_result 卡（L1 确定性绑定）。
   *
   * 搜索是最高频的结构化工具，此前依赖 routeRender 的 search_result hint 从
   * LLM 修正文里切卡（模型写成散文就漏）；现在直接从工具回执 items 构建，
   * 模型口头回复只作前导。items 形态与 detectRawSearchResultJson 的抢救
   * 目标一致（title/url/snippet/source），前端 _SearchResultCard 直接消费。
   */
  "search_web": (r) => buildSearchCardFromItems(r.items),
  "info.search": (r) => buildSearchCardFromItems(r.items),

  /**
   * travel.destination-guide → travel_guide_select 卡（规划前种草选择卡）。
   *
   * 数据源：buildDestinationGuide 的 {view[],stay[],food[]}（真实信号排序、带实拍图）。
   * - extra.guide 携带分类候选（多图+真数指标+排序依据），前端专用卡渲染可勾选网格；
   * - items 平铺兜底（旧客户端通用卡仍可渲染文字清单）；
   * - actions 走 AgentActionChoiceCard 同一回传链：确认按钮 label 由前端拼
   *   「就按这些去规划：必玩 A、B；住宿 C；美食 D」，服务端把 user_action
   *   转写为用户消息，LLM 按语义把选中项填 wishlist/foodWishlist/stayWishlist。
   * 勾选口径：一律 picked=false——选谁全部由用户定，服务端不替用户预选。
   */
  "travel.destination-guide": (r) => {
    if (r.ok !== true) return null;
    const dest = str(r.destination) || "目的地";
    const pickCat = (key: "view" | "stay" | "food"): Array<Record<string, unknown>> => {
      const list = r[key];
      return Array.isArray(list)
        ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        : [];
    };
    const view = pickCat("view");
    const stay = pickCat("stay");
    const food = pickCat("food");
    if (!view.length && !stay.length && !food.length) return null;
    // 指标胶囊由服务端算好（label 是成品文案、source 是这条数的出处），这里只透传不加工
    const guideMetrics = (x: Record<string, unknown>) =>
      (Array.isArray(x.metrics) ? x.metrics : [])
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => ({ kind: str(m.kind), label: str(m.label), source: str(m.source) }))
        .filter((m) => m.label);
    const guideItem = (x: Record<string, unknown>) => ({
      name: str(x.name),
      photos: Array.isArray(x.photos) ? x.photos.map((u) => str(u)).filter(Boolean).slice(0, 3) : [],
      intro: str(x.intro),
      address: str(x.address),
      metrics: guideMetrics(x),
      picked: false,
    });
    const sortNotes = (r.sortNotes ?? {}) as Record<string, unknown>;
    const stayAnchor = r.stayAnchor as Record<string, unknown> | null | undefined;
    const cats = [
      {
        key: "view",
        label: "必玩景点",
        items: view.map(guideItem),
        sortNote: str(sortNotes.view),
      },
      {
        key: "stay",
        label: "住宿推荐",
        items: stay.map(guideItem),
        sortNote: str(sortNotes.stay),
        ...(stayAnchor && str(stayAnchor.label)
          ? {
              anchor: {
                id: str(stayAnchor.id) || "anchor",
                label: str(stayAnchor.label),
                why: str(stayAnchor.why),
              },
            }
          : {}),
      },
      {
        key: "food",
        label: "美食推荐",
        items: food.map(guideItem),
        sortNote: str(sortNotes.food),
      },
    ].filter((c) => c.items.length > 0);
    // 平铺兜底 items：旧客户端通用卡按文字清单渲染
    const catOf: Record<string, string> = { view: "必玩", stay: "住宿", food: "美食" };
    const items: ToolCardItem[] = [];
    for (const c of cats) {
      for (const it of c.items as Array<ReturnType<typeof guideItem>>) {
        const firstMetric = it.metrics[0]?.label;
        items.push({
          type: "check",
          text: `${catOf[c.key]} · ${it.name}${firstMetric ? `（${firstMetric}）` : ""}`,
          thumbnailUrl: it.photos[0],
          side: c.key,
          sideLabel: c.label,
        });
      }
    }
    return {
      title: `🌿 ${dest} · 种草手册`,
      items,
      footer: `想去的打勾，不想要的勾掉 · 剩下的我按你的选择排行程`,
      cardType: "travel_guide_select",
      actions: [
        {
          id: "select_confirm",
          label: "就按勾选的去规划",
          variant: "primary",
          payload: { multiSelect: true },
        },
        {
          id: "select_delegate",
          label: "全部交给你，直接规划",
          variant: "secondary",
        },
      ],
      extra: {
        guide: {
          destination: dest,
          cats: cats.map((c) => ({
            key: c.key,
            label: c.label,
            items: c.items,
            sortNote: c.sortNote,
            ...("anchor" in c ? { anchor: c.anchor } : {}),
          })),
        },
      },
    };
  },

  /**
   * shopping.suggest → product_compare 卡（二分化对比）。
   * 候选按 side A/B/C 分侧（≤3）：sides 承载大图头部（商品图/试色图），
   * items 承载依据(check)与注意点(warn)并带 side/sideLabel 归属；
   * compare 承载转置参数表；videos 承载试色/评测视频入口。
   * 客户端 agent_result_parser 对 cardType=product_compare 消费以上字段。
   */
  "shopping.suggest": (r) => {
    const rec = r.recommendation as
      | {
          query?: unknown;
          candidates?: Array<{
            productId?: unknown;
            brand?: unknown;
            name?: unknown;
            priceLabel?: unknown;
            image?: unknown;
            channels?: unknown;
            reasons?: unknown;
            cautions?: unknown;
            videos?: unknown;
          }>;
          pick?: { productId?: unknown; headline?: unknown };
          alternatives?: Array<{ productId?: unknown; whenChoose?: unknown }>;
          source?: unknown;
          ugc?: Record<string, unknown>;
          compare?: { dims?: unknown; rows?: unknown };
        }
      | undefined
      | null;
    if (!rec || !Array.isArray(rec.candidates) || rec.candidates.length === 0) return null;

    const pickId = typeof rec.pick?.productId === "string" ? rec.pick.productId : "";
    const pickHeadline = typeof rec.pick?.headline === "string" ? rec.pick.headline.trim() : "";
    const altWhen = new Map<string, string>();
    for (const alt of Array.isArray(rec.alternatives) ? rec.alternatives : []) {
      if (
        typeof alt?.productId === "string" &&
        typeof alt?.whenChoose === "string" &&
        alt.whenChoose.trim()
      ) {
        altWhen.set(alt.productId, alt.whenChoose.trim());
      }
    }

    const sides: NonNullable<ToolCardPayload["sides"]> = [];
    const items: ToolCardItem[] = [];
    const videos: NonNullable<ToolCardPayload["videos"]> = [];
    const sideNames = ["A", "B", "C"];
    let index = 0;
    for (const c of rec.candidates.slice(0, 3)) {
      const side = sideNames[index] ?? String(index + 1);
      const pid = typeof c.productId === "string" ? c.productId : "";
      const brand = str(c.brand);
      const name = str(c.name);
      const label = [brand, name].filter(Boolean).join(" ") || `候选${index + 1}`;
      sides.push({
        side,
        label,
        priceLabel: str(c.priceLabel) || undefined,
        image: str(c.image) || undefined,
      });
      for (const t of (Array.isArray(c.reasons) ? c.reasons : []).filter((x) => typeof x === "string")) {
        items.push({ type: "check", text: t as string, side, sideLabel: label });
      }
      for (const t of (Array.isArray(c.cautions) ? c.cautions : []).filter((x) => typeof x === "string")) {
        items.push({ type: "warn", text: t as string, side, sideLabel: label });
      }
      const when = pid ? altWhen.get(pid) : undefined;
      if (when) items.push({ type: "num", text: `▸ 什么时候选它：${when}`, side, sideLabel: label });
      for (const v of (Array.isArray(c.videos) ? c.videos : []).filter(
        (x): x is { title?: unknown; url?: unknown; source?: unknown } => typeof x === "object" && x !== null,
      )) {
        const title = str((v as { title?: unknown }).title);
        if (title) {
          videos.push({
            title,
            url: str((v as { url?: unknown }).url) || undefined,
            source: str((v as { source?: unknown }).source) || undefined,
          });
        }
      }
      index += 1;
    }

    // 参数对比（已由引擎转置：label=维度，values 与 sides 一一对应）
    const cmp = rec.compare;
    const compare =
      cmp && Array.isArray(cmp.dims) && Array.isArray(cmp.rows)
        ? {
            dims: cmp.dims.filter((d): d is string => typeof d === "string"),
            rows: cmp.rows
              .filter(
                (row): row is { label: string; values: string[] } =>
                  typeof row === "object" &&
                  row !== null &&
                  typeof (row as { label?: unknown }).label === "string" &&
                  Array.isArray((row as { values?: unknown }).values),
              )
              .map((row) => ({
                label: row.label,
                values: (row.values as unknown[]).filter((v): v is string => typeof v === "string"),
              })),
          }
        : undefined;

    const first = rec.candidates[0];
    const query = str(r.query) || str(r.item) || "选品";
    const firstIsPick = first && typeof first.productId === "string" && first.productId === pickId;
    const firstLabel = first ? [str(first.brand), str(first.name)].filter(Boolean).join(" ") : "";

    // 立场化结构（product_pick 新卡型）：pick + alternatives + 渠道价 CTA
    const pickPayload = firstIsPick
      ? {
          productId: String(first!.productId),
          label: firstLabel,
          priceLabel: str(first!.priceLabel) || undefined,
          image: str(first!.image) || undefined,
          headline: pickHeadline || undefined,
          reasons: (Array.isArray(first!.reasons) ? first!.reasons : []).filter(
            (x): x is string => typeof x === "string",
          ),
          cautions: (Array.isArray(first!.cautions) ? first!.cautions : []).filter(
            (x): x is string => typeof x === "string",
          ),
          channels: Array.isArray(first!.channels)
            ? (first!.channels as Array<Record<string, unknown>>)
                .map((ch) => ({
                  name: str(ch.name),
                  priceCny: typeof ch.priceCny === "number" ? ch.priceCny : 0,
                  ...(str(ch.url) ? { url: str(ch.url) } : {}),
                }))
                .filter((ch) => ch.name && ch.priceCny > 0)
            : undefined,
        }
      : undefined;
    const alternativesPayload = rec.candidates
      .slice(1, 3)
      .map((c) => {
        const pid = typeof c.productId === "string" ? c.productId : "";
        return {
          productId: pid,
          label: [str(c.brand), str(c.name)].filter(Boolean).join(" ") || "备选",
          priceLabel: str(c.priceLabel) || undefined,
          image: str(c.image) || undefined,
          whenChoose: pid ? altWhen.get(pid) : undefined,
        };
      });

    // 口碑摘要（P3 UGC）：仅透传可信字段（LLM 不参与内容生成，服务端聚合保证）
    const rawUgc = rec.ugc;
    const ugcPayload =
      rawUgc && typeof rawUgc === "object"
        ? {
            platformLabel: str(rawUgc.platformLabel) || undefined,
            mentions: typeof rawUgc.mentions === "number" ? rawUgc.mentions : undefined,
            pros: Array.isArray(rawUgc.pros)
              ? (rawUgc.pros as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3)
              : undefined,
            cons: Array.isArray(rawUgc.cons)
              ? (rawUgc.cons as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 2)
              : undefined,
            posts: Array.isArray(rawUgc.posts)
              ? (rawUgc.posts as Array<Record<string, unknown>>)
                  .map((p) => ({ title: str(p.title), ...(str(p.url) ? { url: str(p.url) } : {}) }))
                  .filter((p) => p.title)
                  .slice(0, 4)
              : undefined,
          }
        : undefined;

    return {
      title:
        firstIsPick && firstLabel
          ? `主推 · ${firstLabel}`
          : rec.candidates.length > 1
            ? `对比结论 · 二选一并排看`
            : `推荐结论 · ${firstLabel || query}`,
      cardType: "product_pick",
      sides,
      items,
      ...(compare && compare.rows.length > 0 ? { compare } : {}),
      ...(videos.length > 0 ? { videos } : {}),
      ...(pickPayload ? { pick: pickPayload } : {}),
      ...(alternativesPayload.length > 0 ? { alternatives: alternativesPayload } : {}),
      ...(ugcPayload && ((ugcPayload.mentions ?? 0) > 0 || (ugcPayload.posts?.length ?? 0) > 0)
        ? { ugc: ugcPayload }
        : {}),
      footer: pickHeadline || "参数来自商品库，价格以实际渠道为准",
    };
  },

  "weather.get_local": (r) => {
    const weatherText = str(r.weatherText);
    const summary = str(r.summary);
    if (!weatherText && !summary) return null;
    const items: ToolCardItem[] = [];
    if (weatherText) items.push({ type: "num", text: weatherText });
    const range = str(r.todayRangeC);
    if (range) items.push({ type: "num", text: `气温 ${range}` });
    const humidity = num(r.humidityPct);
    if (humidity != null) items.push({ type: "num", text: `湿度 ${humidity}%` });
    const wind = num(r.windKmh);
    if (wind != null) items.push({ type: "num", text: `风速 ${wind} km/h` });
    const rain = num(r.peakRainPct);
    if (rain != null) items.push({ type: "num", text: `峰值降水概率 ${rain}%` });
    const location = str(r.locationLabel);
    return {
      title: summary || `${location ? location + " " : ""}天气实况`,
      items,
      footer: str(r.clothingAdvice) || undefined,
      cardType: "weather",
    };
  },

  "wallet.get_balance": (r) => {
    const balance = num(r.balance);
    if (balance == null) return null;
    const currency = str(r.currency) || "CNY";
    return {
      title: "钱包余额",
      items: [{ type: "num", text: `${balance} ${currency}` }],
      footer: str(r.summary) || undefined,
      cardType: "wallet",
    };
  },

  "calendar.list_tasks": (r) => {
    const tasks = Array.isArray(r.tasks) ? r.tasks : [];
    if (tasks.length === 0) return null;
    const items: ToolCardItem[] = tasks.slice(0, 8).map((t) => {
      const rec = (t ?? {}) as Record<string, unknown>;
      const title = str(rec.title) || str(rec.reminderMessage) || "（无标题）";
      const time = shortTime(rec.nextRunAt) || shortTime(rec.runAt);
      return { type: "num", text: time ? `${time} ${title}` : title };
    });
    const count = num(r.count) ?? tasks.length;
    return {
      title: "日程安排",
      items,
      footer: count > 8 ? `共 ${count} 项，仅显示前 8 项` : `共 ${count} 项`,
      cardType: "schedule",
    };
  },

  // 单平台商品搜索（shopping.order.search）：与跨平台比价卡同一版式——
  // 缩略图 + 可点行（链接直达商品页）+ 结算页免责。没有它，模型在比价超时
  // 后改调本工具的结果会退化成 LLM 手写价格列表（2026-10-25 小米 15 实测）。
  "shopping.order.search": (r) => {
    if (r.ok !== true) return null;
    const products = Array.isArray(r.products) ? r.products : [];
    if (products.length === 0) return null;
    const items: ToolCardItem[] = [];
    for (const raw of products) {
      if (items.length >= 6) break;
      const p = (raw ?? {}) as Record<string, unknown>;
      const price = num(p.price);
      const title = str(p.title);
      if (!title) continue;
      const url = str(p.url);
      const image = str(p.imageUrl);
      const shop = str(p.shop);
      const priceText = price != null ? `¥${price}` : "价格待查";
      items.push({
        type: "num",
        text: [priceText, title.slice(0, 40), shop ? `（${shop.slice(0, 12)}）` : ""].filter(Boolean).join(" "),
        ...(url ? { url } : {}),
        ...(image ? { thumbnailUrl: image } : {}),
      });
    }
    if (items.length === 0) return null;
    const platform = str(r.platform);
    const best = products
      .map((p) => num((p as Record<string, unknown>).price))
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b)[0];
    return {
      title: `搜索结果：${str(r.query)}${platform ? ` · ${platform}` : ""}`,
      items,
      footer:
        best != null
          ? `最低 ¥${best} · 行可点直达商品页 · 实时抓取，以下单结算页为准`
          : "行可点直达商品页 · 实时抓取，以下单结算页为准",
      cardType: "",
    };
  },

  // 跨平台比价结果卡（2026-10-24 升级：图 + 可点行 + 决策页入口）。
  // 每组一行：缩略图 + 最低价 + 平台 + 商品名 + 店铺 + 疑似同款标注；
  // 行带 offer.url 整行可点跳平台商品页；
  // 服务端存档了决策页时追加「打开比价决策页」行（决策页 = 大图/报价/口碑一页看全）。
  "shopping.compare.prices": (r) => {
    const groups = Array.isArray(r.groups) ? r.groups : [];
    if (groups.length === 0) return null;
    const items: ToolCardItem[] = [];
    let shown = 0;
    for (const g of groups) {
      if (shown >= 6) break;
      const rec = (g ?? {}) as Record<string, unknown>;
      const offers = Array.isArray(rec.offers) ? rec.offers : [];
      if (offers.length === 0) continue;
      const best = (offers[0] ?? {}) as Record<string, unknown>;
      const price = num(best.priceCny);
      const platform = str(best.platform);
      const title = str(best.title);
      const shop = str(best.shop);
      const url = str(best.url);
      const image = str(best.imageUrl) || str(rec.imageUrl);
      const similar = rec.matchType === "similar";
      const priceText = price != null ? `¥${price}` : "价格待查";
      const parts = [
        priceText,
        `[${platform || "未知平台"}]`,
        title.slice(0, 40),
        shop ? `（${shop.slice(0, 12)}）` : "",
        similar ? "（疑似同款）" : "",
        offers.length > 1 ? ` 等${offers.length}家` : "",
      ].filter(Boolean);
      items.push({
        type: "num",
        text: parts.join(" "),
        ...(url ? { url } : {}),
        ...(image ? { thumbnailUrl: image } : {}),
      });
      shown += 1;
    }
    if (items.length === 0) return null;
    const decisionPageUrl = str(r.decisionPageUrl);
    if (decisionPageUrl) {
      items.push({
        type: "num",
        text: "打开比价决策页（大图 / 全部报价 / 走势一页看全）",
        url: decisionPageUrl,
      });
    }
    const bestOffer = (r.bestOffer ?? {}) as Record<string, unknown>;
    const bestPlatform = str(bestOffer.platform);
    const bestPrice = num(bestOffer.priceCny);
    const footer =
      bestPrice != null && bestPlatform
        ? `最低价 ¥${bestPrice} 来自 ${bestPlatform} · 行可点直达平台商品页 · 信息为实时抓取，以下单结算页为准`
        : "行可点直达平台商品页 · 信息为实时抓取，以下单结算页为准";
    return {
      title: `比价结果：${str(r.query)}`,
      items,
      footer,
      cardType: "",
    };
  },

  // 降价监控建档/列表卡：watch 工具回执 watches[] → 每条监控一行
  // （盯什么/目标价/当前价）；footer 固定说明复查频率与推送去重策略。
  "shopping.compare.watch": (r) => {
    if (r.ok !== true) return null;
    const watches = Array.isArray(r.watches) ? r.watches : [];
    if (watches.length === 0) return null;
    const action = str(r.action);
    const items: ToolCardItem[] = watches.slice(0, 8).map((w) => {
      const rec = (w ?? {}) as Record<string, unknown>;
      const query = str(rec.query);
      const platform = str(rec.platform);
      const target = num(rec.targetPrice);
      const last = num(rec.lastPriceCny);
      const lastText = last != null ? `（当前 ¥${last}）` : "（待首次复查）";
      return {
        type: "num",
        text: `「${query || "（未命名）"}」@${platform || "?"} 目标 ≤¥${target ?? "?"}${lastText}`,
      };
    });
    const count = num(r.count) ?? watches.length;
    const title = action === "add" ? "降价监控 · 已建档" : "降价监控列表";
    const footer =
      (count > 8 ? `共 ${count} 条，仅显示前 8 条 · ` : "") +
      "每 60 分钟自动复查 · 到价即推，新低价需再降 2% 以上，同价位不打扰";
    return { title, items, footer, cardType: "" };
  },

  // 调研比价卡（保险/服务等无法结构化抓价的领域）：sources → 可点来源清单，
  // 复用 search_result 卡型（客户端 _SearchResultCard 整行可点跳外部浏览器）；
  // 对比表本体由 LLM 口头正文承载（disclaimer 已要求整理成表）。
  "shopping.compare.research": (r) => {
    if (r.ok !== true) return null;
    const sources = Array.isArray(r.sources) ? r.sources : [];
    if (sources.length === 0) return null;
    const items: ToolCardItem[] = [];
    const seen = new Set<string>();
    for (const raw of sources) {
      if (items.length >= 8) break;
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const title = str(rec.title);
      const url = str(rec.url);
      if (!title && !url) continue;
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);
      const snippet = str(rec.snippet);
      const source = str(rec.source);
      const text = snippet ? `${title || url}：${snippet.slice(0, 90)}` : title || url;
      items.push({
        type: "num",
        text,
        url: url || undefined,
        source: source || undefined,
      });
    }
    if (items.length === 0) return null;
    return {
      title: `调研对比：${str(r.topic)}`,
      items,
      footer: str(r.disclaimer) || undefined,
      cardType: "search_result",
    };
  },

  // 本地订单列表：so_* 单号 + 状态 + 金额
  "shopping.order.list": (r) => {
    const orders = Array.isArray(r.orders) ? r.orders : [];
    if (orders.length === 0) return null;
    const statusLabel: Record<string, string> = {
      pending_payment: "待支付",
      paid: "已支付",
      shipped: "已发货",
      completed: "已完成",
      cancelled: "已取消",
      failed: "失败",
    };
    const items: ToolCardItem[] = orders.slice(0, 8).map((o) => {
      const rec = (o ?? {}) as Record<string, unknown>;
      const platform = str(rec.platform);
      const title = str(rec.title) || "（无标题）";
      const amount = num(rec.amountCny);
      const status = statusLabel[str(rec.status)] ?? (str(rec.status) || "未知");
      return {
        type: amount != null && amount > 0 ? "num" : "check",
        text: `[${platform}] ${title.slice(0, 36)} · ${status}${amount != null && amount > 0 ? ` ¥${amount}` : ""}`,
      };
    });
    const count = num(r.count) ?? orders.length;
    return {
      title: "购物订单",
      items,
      footer: count > 8 ? `共 ${count} 条，仅显示前 8 条` : `共 ${count} 条`,
      cardType: "order",
    };
  },

  /**
   * shopping.pay.submit → 支付确认按钮卡（L1 确定性附卡，不依赖 LLM 转发）。
   * 收银台已拉起（内置浏览器打开或 alipay-bot 代付）后，给用户
   * 「我已完成支付」/「稍后再说」按钮；点击经 chat.user_action 转为等价
   * user_message，由 LLM 调 shopping.pay.check 同步状态。按钮不直接触发
   * 资金动作——支付前的确认仍由两阶段 confirmationToken 把守。
   */
  "shopping.pay.submit": (r) => {
    if (r.ok !== true) return null;
    const localOrderId = str(r.orderId) || str(r.localOrderId);
    if (!localOrderId) return null;
    const platform = str(r.platform);
    const amount = num(r.amountCny);
    const itemTitle = str(r.itemTitle);
    const items: ToolCardItem[] = [
      {
        type: "check",
        text: `订单：${itemTitle || localOrderId}`,
      },
      {
        type: amount != null && amount > 0 ? "num" : "check",
        text: `平台：${platform || "未知"}${amount != null && amount > 0 ? ` · 金额：¥${amount}` : ""}`,
      },
    ];
    return {
      title: "💳 支付确认",
      items,
      footer: "完成支付后点击确认，我会同步订单状态",
      cardType: "order",
      actions: [
        {
          id: "shopping_pay_done",
          label: "我已完成支付，帮我确认",
          variant: "primary",
          payload: { localOrderId, platform },
        },
        { id: "shopping_pay_later", label: "稍后再说", variant: "secondary" },
      ],
    };
  },
};

/** 搜索回执 items → search_result 卡 payload；空结果返回 null（回退文本路由） */
function buildSearchCardFromItems(rawItems: unknown): ToolCardPayload | null {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  const items: ToolCardItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    if (items.length >= 8) break;
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const title = str(rec.title);
    const url = str(rec.url);
    if (!title && !url) continue;
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    const snippet = str(rec.snippet);
    const source = str(rec.source);
    const desc = [snippet, source ? `来源:${source}` : ""].filter(Boolean).join("  ");
    const text = desc ? `${title || url}: ${desc}` : title || url;
    items.push({ type: "num", text, url: url || undefined, source: source || undefined });
  }
  if (items.length === 0) return null;
  return {
    title: "搜索结果",
    items,
    footer: `共 ${items.length} 条结果`,
    cardType: "search_result",
  };
}

/** 查注册 builder；未注册返回 null */
export function lookupToolCardBuilder(toolName: string): ToolCardBuilder | null {
  return BUILDERS[toolName.trim()] ?? null;
}

/** 由结构化结果建卡 payload；结构异常/空数据返回 null（调用方回退文本路由） */
export function buildToolCard(
  toolName: string,
  result: Record<string, unknown>,
): ToolCardPayload | null {
  const builder = lookupToolCardBuilder(toolName);
  if (!builder) return null;
  try {
    return builder(result);
  } catch {
    return null;
  }
}

/**
 * 工具循环路径的天气结果确定性附卡（L1）。
 *
 * 与 attachSearchResultCardFromExecuted 同理：weather.get_local 已并入进程内
 * 延迟目录检索（不强制路由），常规对话轮 LLM 在 tool-loop 内自主调用天气工具，
 * 末轮只输出口语正文、reply.toolName 为空 → 单工具直跑路径的
 * processAssistantText({toolName,toolResult}) 拿不到回执，天气卡恒附不上
 * （真实回归：天气回答恒为纯文本）。这里从 onExternalToolExecuted 聚合的
 * 真实结果建 weather 卡；多次调用（多地对比）合并为一张多地卡，每个城市一行。
 * 正文已带结构化标记时不动（单工具直跑路径已附卡，防双重包裹）。
 */
export function attachWeatherResultCardFromExecuted(
  text: string,
  executed: ReadonlyArray<{ toolName: string; result: Record<string, unknown> }>,
): string {
  if (containsStructuredMarker(text)) return text;
  const weatherResults = executed
    .filter((mt) => mt.toolName === "weather.get_local")
    .map((mt) => mt.result);
  if (weatherResults.length === 0) return text;
  const payload =
    weatherResults.length === 1
      ? buildToolCard("weather.get_local", weatherResults[0])
      : buildMergedWeatherCard(weatherResults);
  if (!payload || payload.items.length === 0) return text;
  return buildCardMarker(payload, text);
}

/** 多次天气调用 → 一张多地 weather 卡：每个城市一行「地点 天气，气温」，建议取最后一条 */
function buildMergedWeatherCard(
  results: ReadonlyArray<Record<string, unknown>>,
): ToolCardPayload | null {
  const items: ToolCardItem[] = [];
  let title = "";
  let footer = "";
  for (const r of results) {
    const location = str(r.locationLabel);
    const weatherText = str(r.weatherText) || str(r.summary);
    const range = str(r.todayRangeC);
    const rain = num(r.peakRainPct);
    if (!weatherText && !range) continue;
    const parts = [weatherText, range ? `气温 ${range}` : ""].filter(Boolean);
    if (rain != null) parts.push(`降水 ${rain}%`);
    items.push({
      type: "num",
      text: `${location ? location + " " : ""}${parts.join("，")}`,
    });
    if (!title) title = str(r.summary) || (location ? `${location} 天气实况` : "天气实况");
    footer = str(r.clothingAdvice) || footer;
  }
  if (items.length === 0) return null;
  return {
    title: results.length > 1 ? "多地天气" : title,
    items,
    footer: footer || undefined,
    cardType: "weather",
  };
}

/**
 * 已带「卡片/摘要类」标记的正文不重复附卡（防双重包裹）。
 * 注意 [RENDER_AS:xxx]（structured/brief 等正文形态声明）**不在拦截集**：
 * 富文本正文 + 尾部来源卡是并存的正确形态（结构化回答不排斥附上搜索来源），
 * 此前整段拦截会让带意图词的搜索轮次永远丢卡（真实场景回归发现）。
 */
const STRUCTURED_MARKERS = [
  "[AGENT_RESULT_CARD_START]",
  "[CONTENT_SUMMARY_V2_START]",
  "[IMAGE_RESULT_START]",
];

function containsStructuredMarker(text: string): boolean {
  return STRUCTURED_MARKERS.some((m) => text.includes(m));
}

/** 与 agent-result-formatter 的 cardId 规则一致（cardType 非空才生成） */
function buildCardMarker(payload: ToolCardPayload, leadText: string): string {
  const cardId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const json = JSON.stringify({
    avatar: "NB",
    avatarStyle: "default",
    title: payload.title,
    items: payload.items,
    footer: payload.footer ?? "",
    cardType: payload.cardType,
    // 带按钮的确认卡（支付确认等）：非空时客户端渲染为 AgentActionChoiceCard
    actions: payload.actions ?? [],
    speak: "",
    cardId,
    // 扩展卡型的附加协议字段（product_compare 的分侧大图/转置对比表/视频入口；
    // product_pick 的立场化主推/备选定位/渠道价 CTA）
    ...(payload.sides ? { sides: payload.sides } : {}),
    ...(payload.compare ? { compare: payload.compare } : {}),
    ...(payload.videos ? { videos: payload.videos } : {}),
    ...(payload.pick ? { pick: payload.pick } : {}),
    ...(payload.alternatives ? { alternatives: payload.alternatives } : {}),
    ...(payload.ugc ? { ugc: payload.ugc } : {}),
    ...(payload.extra ? { extra: payload.extra } : {}),
  });
  const parts: string[] = [];
  if (leadText.trim()) parts.push(leadText.trim());
  parts.push(`[AGENT_RESULT_CARD_START]\n${json}\n[AGENT_RESULT_CARD_END]`);
  return parts.join("\n\n");
}

/**
 * 尝试把注册工具的结构化结果附卡到回复文本上。
 * 返回 null 表示未附卡（工具未注册/builder 建卡失败/正文已含结构化标记），
 * 调用方回退既有文本路由；返回值即最终文本（LLM 口头回复作前导 + 卡标记）。
 */
export function tryAttachToolResultCard(
  text: string,
  toolName: string | undefined,
  toolResult: Record<string, unknown> | undefined,
): string | null {
  if (!toolName || !toolResult || typeof toolResult !== "object") return null;
  if (!lookupToolCardBuilder(toolName)) return null;
  if (containsStructuredMarker(text)) return null;
  const payload = buildToolCard(toolName, toolResult);
  if (!payload || payload.items.length === 0) return null;
  return buildCardMarker(payload, text);
}

/**
 * 工具循环路径的搜索结果确定性附卡（L1）。
 *
 * tool-loop 内执行的 search_web/info.search 不经过 reply.toolName/toolResult
 * （与媒体/行程同理），必须从 onExternalToolExecuted 聚合的真实结果附卡。
 * 多次搜索的条目按 url 去重合并为一张 search_result 卡（上限 8 条），
 * 避免逐次附卡刷屏。正文已带结构化标记时不动（优先级让位给 L2/其他 L1 路径）。
 *
 * yieldToSearchMedia（意图仲裁，2026-09-22）：本轮搜索类媒体
 * （search_images/search_images_batch/search_videos）有真实产出时整卡让位——
 * 照片/视频已是本轮主形态，找图场景再附 8 条文字列表属冗余。媒体 0 产出时
 * 调用方不传该标志，文字卡照常附（兜底保证本轮仍有结构化结果）。
 */
export function attachSearchResultCardFromExecuted(
  text: string,
  executed: ReadonlyArray<{ toolName: string; result: Record<string, unknown> }>,
  opts?: { yieldToSearchMedia?: boolean },
): string {
  if (opts?.yieldToSearchMedia) return text;
  if (containsStructuredMarker(text)) return text;
  const searchResults = executed.filter((mt) =>
    mt.toolName === "search_web" || mt.toolName === "info.search",
  );
  if (searchResults.length === 0) return text;
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const mt of searchResults) {
    const items = Array.isArray(mt.result.items) ? mt.result.items : [];
    for (const it of items) {
      if (merged.length >= 12) break;
      const url = it && typeof it === "object" ? str((it as Record<string, unknown>).url) : "";
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);
      merged.push(it);
    }
  }
  const payload = buildSearchCardFromItems(merged);
  if (!payload || payload.items.length === 0) return text;
  return buildCardMarker(payload, text);
}
