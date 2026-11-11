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
 *   - 网页搜索（search_web / info.search）**不出卡**：搜索回执只喂给模型做整合，
 *     由模型自己总结成正文（2026-11-05 用户定稿，两端一致，禁止搜索结果卡/来源列表）
 * 新工具按需在 BUILDERS 注册即可，builder 返回 null（结构异常/空数据）时
 * 自动回退既有文本路由，零破坏。
 *
 * 卡 payload 与 AgentResultFormatter 的 AgentResultPayload 同构
 * （前端 agent_result_parser.dart / AgentResultCard 直接消费，无需前端改动）。
 */
import { BROWSER_SESSION_SITES } from "./browser-session-sites.js";
import { platformSupportsCheckout } from "./shopping-platforms/index.js";
import { stableCardId } from "./card-identity.js";

/** 与 agent-result-formatter 的 items 类型推断一致：check/warn/num；条目只承载展示内容，不带网页跳转链接 */
export interface ToolCardItem {
  type: "check" | "warn" | "num";
  text: string;
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
  /** product_compare 卡：评测/试色视频条目 */
  videos?: Array<{ title: string; source?: string }>;
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
    channels?: Array<{ name: string; priceCny: number }>;
  };
  alternatives?: Array<{
    productId: string;
    label: string;
    priceLabel?: string;
    image?: string;
    whenChoose?: string;
  }>;
  /**
   * price_compare 卡（跨平台实时比价 shopping.compare.prices）：
   * 分组报价结构化载荷（每组 = 该商品在某平台的最低价报价）。
   * items 同时保留（兼容旧客户端 fallback 渲染）。
   */
  priceCompare?: {
    query: string;
    groups: Array<{
      priceCny: number | null;
      platform: string;
      /** 平台中文来源名（京东/淘宝/拼多多…），缺省回退 platform id */
      platformLabel?: string;
      title: string;
      shop?: string;
      image?: string;
      similar?: boolean;
      /** 组规格 token（如 ["256g"]），卡片展示规格 chip 用 */
      specTokens?: string[];
      offerCount: number;
    }>;
    bestIndex?: number | null;
  };
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
    posts?: Array<{ title: string }>;
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

/**
 * 降水一行（2026-11-04 用户定稿）：不报概率百分比，只说清「什么时候有雨」。
 * 有可信钟点段（rainWindow 达标 ≥40% 才会带）→「今天 下午 14–18 点有雨」；
 * 已下过 →「今天 下午 14–18 点的雨已下过」；无时段但概率确实高（≥60%）→
 * 退整天口径「今天有雨」；低概率又不给行（「降水 2%」是噪音）。
 */
function rainText(dayPrefix: string, pct: number, period: string): string | null {
  if (period) {
    // rainWindowSuffixText 两种尾巴：「下午 14–18 点最明显」/「下午 14–18 点已下过」
    if (period.endsWith("已下过")) {
      return `${dayPrefix} ${period.slice(0, -"已下过".length)}的雨已下过`;
    }
    return `${dayPrefix} ${period.replace(/最明显$/, "")}有雨`;
  }
  return pct >= 60 ? `${dayPrefix}有雨` : null;
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
   * 注意（2026-11-05 用户定稿）：search_web / info.search **不再注册 builder**。
   * 搜索回执只作为模型上下文，正文由模型自己总结；不允许出现「搜索结果」卡、
   * 来源清单或原始条目（桌面端与手机端一致）。历史上这里曾直接从 items 建
   * search_result 卡，已整体退役——不要再加回来。
   */

  /**
   * travel.destination-guide → travel_guide_select 卡（规划前种草选择卡）。
   *
   * 数据源：buildDestinationGuide 的 {view[],stay[]}（真实信号排序、带实拍图）。
   * 2026-11-07 食物改为用户自行决定，不进规划：种草卡不再下发 food 分类。
   * - extra.guide 携带分类候选（多图+真数指标+排序依据），前端专用卡渲染可勾选网格；
   * - items 平铺兜底（旧客户端通用卡仍可渲染文字清单）；
   * - actions 走 AgentActionChoiceCard 同一回传链：确认按钮 label 由前端拼
   *   「就按这些去规划：必玩 A、B；住宿 C」，服务端把 user_action
   *   转写为用户消息，LLM 按语义把选中项填 wishlist/stayWishlist。
   * 勾选口径：一律 picked=false——选谁全部由用户定，服务端不替用户预选。
   */
  "travel.destination-guide": (r) => {
    if (r.ok !== true) return null;
    const dest = str(r.destination) || "目的地";
    const pickCat = (key: "view" | "stay"): Array<Record<string, unknown>> => {
      const list = r[key];
      return Array.isArray(list)
        ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        : [];
    };
    const view = pickCat("view");
    const stay = pickCat("stay");
    if (!view.length && !stay.length) return null;
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
    ].filter((c) => c.items.length > 0);
    // 平铺兜底 items：旧客户端通用卡按文字清单渲染
    const catOf: Record<string, string> = { view: "必玩", stay: "住宿" };
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
        (x): x is { title?: unknown; source?: unknown } => typeof x === "object" && x !== null,
      )) {
        const title = str((v as { title?: unknown }).title);
        if (title) {
          videos.push({
            title,
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
                  .map((p) => ({ title: str(p.title) }))
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

    // 明日聚焦回执（2026-11-05，focusDay="tomorrow"）：只构建明天的行——
    // 现象/气温区间/明天降雨，不掺今天与当前实况；字段名是 tomorrow* 专属命名。
    if (str(r.focusDay) === "tomorrow") {
      const itemsT: ToolCardItem[] = [];
      if (weatherText) itemsT.push({ type: "num", text: weatherText });
      const rangeT = str(r.tomorrowRangeC);
      if (rangeT) itemsT.push({ type: "num", text: `气温 ${rangeT}` });
      const rainTomorrowT = num(r.tomorrowRainPct);
      const rainLineT =
        rainTomorrowT != null
          ? rainText("明天", rainTomorrowT, str(r.tomorrowRainPeriod))
          : null;
      if (rainLineT) itemsT.push({ type: "num", text: rainLineT });
      return {
        title: summary || `${str(r.locationLabel) ? str(r.locationLabel) + " " : ""}明日天气`,
        items: itemsT,
        cardType: "weather",
      };
    }

    const items: ToolCardItem[] = [];
    if (weatherText) items.push({ type: "num", text: weatherText });
    const range = str(r.todayRangeC);
    if (range) items.push({ type: "num", text: `气温 ${range}` });
    const humidity = num(r.humidityPct);
    if (humidity != null) items.push({ type: "num", text: `湿度 ${humidity}%` });
    const wind = num(r.windKmh);
    if (wind != null) items.push({ type: "num", text: `风速 ${wind} km/h` });
    const rain = num(r.peakRainPct);
    const rainToday = rain != null ? rainText("今天", rain, str(r.todayRainPeriod)) : null;
    if (rainToday) items.push({ type: "num", text: rainToday });
    const rainTomorrow = num(r.tomorrowRainPct);
    const rainTomorrowLine =
      rainTomorrow != null ? rainText("明天", rainTomorrow, str(r.tomorrowRainPeriod)) : null;
    if (rainTomorrowLine) items.push({ type: "num", text: rainTomorrowLine });
    const location = str(r.locationLabel);
    return {
      title: summary || `${location ? location + " " : ""}天气实况`,
      items,
      // 2026-11-04 用户定稿：着装不放卡片，留给 LLM 正文最后一句自然带出
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

  // 2026-11-11 复合：calendar 单入口按 action 分流，日程列表卡只认 action=list_tasks 的回执。
  "calendar": (r) => {
    if (str(r.action) !== "list_tasks") return null;
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
  // 缩略图 + 报价行（卡内只展示，不跳页）+ 结算页免责。没有它，模型在比价超时
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
      const image = str(p.imageUrl);
      const shop = str(p.shop);
      const priceText = price != null ? `¥${price}` : "价格待查";
      items.push({
        type: "num",
        text: [priceText, title.slice(0, 40), shop ? `（${shop.slice(0, 12)}）` : ""].filter(Boolean).join(" "),
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
          ? `最低 ¥${best} · 实时抓取，以下单结算页为准`
          : "实时抓取，以下单结算页为准",
      cardType: "",
    };
  },

  // 跨平台比价结果卡（2026-10-28 升级：专属 price_compare 卡型）。
  // 每组一行：缩略图 + 最低价 + 平台 + 商品名 + 店铺 + 疑似同款标注；
  // 卡内只展示报价，不带平台跳转。
  // items 保留为通用回退（旧客户端），结构化分组走 priceCompare 由专属卡消费。
  "shopping.compare.prices": (r) => {
    const groups = Array.isArray(r.groups) ? r.groups : [];
    if (groups.length === 0) return null;
    // 平台中文来源名（注明来源要求）：BROWSER_SESSION_SITES 的 label，未收录回退 id
    const labelOf = (p: string) =>
      (BROWSER_SESSION_SITES as Record<string, { label: string } | undefined>)[p]?.label ?? p;
    const items: ToolCardItem[] = [];
    const priceGroups: NonNullable<ToolCardPayload["priceCompare"]>["groups"] = [];
    // 手机端候选轮播卡自己的条目数组（含商品链接）：卡内点「就这家」时客户端
    // 要把 url 原样回传给 card.action，服务端才能直接去结算页，不必再问模型。
    const shopItems: Array<Record<string, unknown>> = [];
    let shown = 0;
    for (const g of groups) {
      if (shown >= 6) break;
      const rec = (g ?? {}) as Record<string, unknown>;
      const offers = Array.isArray(rec.offers) ? rec.offers : [];
      if (offers.length === 0) continue;
      const best = (offers[0] ?? {}) as Record<string, unknown>;
      const price = num(best.priceCny);
      const platform = str(best.platform);
      const label = labelOf(platform);
      const title = str(best.title);
      const shop = str(best.shop);
      const image = str(best.imageUrl) || str(rec.imageUrl);
      const similar = rec.matchType === "similar";
      const specTokens = Array.isArray(rec.specTokens)
        ? rec.specTokens.filter((s): s is string => typeof s === "string" && !!s.trim()).slice(0, 3)
        : [];
      const priceText = price != null ? `¥${price}` : "价格待查";
      const parts = [
        priceText,
        `[${label}]`,
        title.slice(0, 40),
        shop ? `（${shop.slice(0, 12)}）` : "",
        similar ? "（疑似同款）" : "",
        offers.length > 1 ? ` 等${offers.length}家` : "",
      ].filter(Boolean);
      items.push({
        type: "num",
        text: parts.join(" "),
        ...(image ? { thumbnailUrl: image } : {}),
      });
      priceGroups.push({
        priceCny: price,
        platform: platform || "未知平台",
        ...(label !== platform ? { platformLabel: label } : {}),
        title: title.slice(0, 60),
        ...(shop ? { shop: shop.slice(0, 12) } : {}),
        ...(image ? { image } : {}),
        ...(similar ? { similar: true } : {}),
        ...(specTokens.length > 0 ? { specTokens } : {}),
        offerCount: offers.length,
      });
      shopItems.push({
        title: title.slice(0, 60),
        ...(price != null ? { price } : {}),
        platform: platform || "",
        ...(label !== platform ? { platformLabel: label } : {}),
        ...(shop ? { shop: shop.slice(0, 12) } : {}),
        ...(image ? { image } : {}),
        ...(similar ? { badge: "疑似同款" } : {}),
        // 商品直达链接：卡内下单的唯一凭据（客户端回传，不展示）
        ...(str(best.url) ? { url: str(best.url) } : {}),
        // 这家能不能真的下单（2026-11-06 改判据）：看 adapter 的 supportsCheckout
        // ——只有情报站（什么值得买）不可下单。苏宁这类「搜索免登录、结算要登录」
        // 的平台依然 true：登录在卡内扫码完成，不再一票否决（否则免登录源全被
        // 禁用，整张卡永远走不到「下单→扫码」那一步）。
        orderable: platformSupportsCheckout(platform),
      });
      shown += 1;
    }
    if (items.length === 0) return null;
    // footer 不再回显「最低价 ¥X 来自 平台」搜索源内容（与列表行重复，2026-10-28 移除），
    // 仅保留实时抓取免责说明；各组规格不一致（bestIndex=null）时补充说明，避免
    // 用户把 256GB 与 512GB 的报价误读成同一规格的最低价比。
    const bestIndex = typeof r.bestIndex === "number" ? r.bestIndex : null;
    // 什么值得买是「好价爆料」情报站，价格不等于结算页实时价——必须标出来，
    // 否则用户会把爆料价当成官方现价（苏宁等实时价源不需要这句）。
    const hasAggregatedPrice = priceGroups.some((g) => g.platform === "smzdm");
    const footer = [
      bestIndex == null && priceGroups.length > 1
        ? "各组规格不一致（如容量/数量不同），仅列报价不作最低价结论"
        : "",
      hasAggregatedPrice ? "含什么值得买爆料价（历史好价参考，非结算实时价）" : "",
      "信息为实时抓取，以下单结算页为准",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      title: `比价结果：${str(r.query)}`,
      items,
      footer,
      // cardType 保持 price_compare：手机端见到 extra.shopping 会渲染新轮播卡，
      // 旧客户端/历史消息继续走 price_compare 专用卡，契约不破。
      cardType: "price_compare",
      // 手机端候选轮播卡载荷（2026-11-06 设计稿）：一屏露出 2.5 张、逐卡吸附。
      // priceCompare 同时保留——历史消息与旧客户端仍按 price_compare 卡渲染。
      extra: {
        shopping: {
          stage: "candidates",
          title:
            priceGroups.length > 1 && priceGroups.length <= 4
              ? `${str(r.query)} · ${priceGroups.length}选一`
              : `比价结果：${str(r.query)}`,
          sortLabel: "按到手价",
          bestIndex,
          ...(bestIndex == null ? {} : { bestLabel: "最合适" }),
          items: shopItems,
          footer,
        },
      },
      ...(priceGroups.length > 0
        ? {
            priceCompare: {
              query: str(r.query),
              groups: priceGroups,
              // 仅当各组同规格可比时才标最低价（bestIndex=null 客户端不打章）
              bestIndex,
            },
          }
        : {}),
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

  // 调研比价（shopping.compare.research）不再出卡（2026-11-05）：
  // 它的载荷是 web 调研的资料清单（标题 + 摘要），与搜索结果卡同形——
  // 资料只作模型素材，对比表由 LLM 正文承载（disclaimer 已要求整理成表）。

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
   * shopping.order.place（阶段一 needsConfirmation）→ 确认下单卡。
   *
   * 这是购物链路唯一的硬闸：卡上摊开商品/数量/单价/收货/合计 + 令牌倒计时，
   * 并明说「确认后只提交订单、不扣款」。阶段二（已提交）不出本卡。
   * 载荷里的 expiresAt 由服务端注入（禁止前端拿渲染时刻起算，否则历史消息
   * 回看时倒计时会重新跑）。
   */
  "shopping.order.place": (r) => {
    if (r.ok !== true || r.needsConfirmation !== true) return null;
    const platform = str(r.platform);
    const platformLabel =
      (BROWSER_SESSION_SITES as Record<string, { label: string } | undefined>)[platform]?.label ??
      platform;
    const itemTitle = str(r.itemTitle);
    const qty = num(r.quantity) ?? 1;
    const unit = num(r.unitPrice);
    const total = num(r.totalPrice);
    const address = str(r.addressSummary);
    const expiresAt = num(r.expiresAt);

    const rows: Array<{ k: string; v: string }> = [];
    if (itemTitle) rows.push({ k: "商品", v: itemTitle });
    rows.push({ k: "数量", v: `${qty} 件` });
    if (unit != null) rows.push({ k: "单价", v: `¥${unit}` });
    if (address) rows.push({ k: "收货", v: address });
    if (platformLabel) rows.push({ k: "渠道", v: platformLabel });

    return {
      title: "待你确认",
      items: rows.map((row) => ({ type: "num" as const, text: `${row.k}：${row.v}` })),
      footer: "确认后只提交订单，不会自动扣款",
      cardType: "shopping_confirm",
      extra: {
        shopping: {
          stage: "confirm",
          title: "待你确认",
          ...(expiresAt != null
            ? { expiresAt: new Date(expiresAt).toISOString() }
            : {}),
          rows,
          ...(total != null ? { total: `¥${total}`, totalLabel: "合计" } : {}),
          note: "确认令牌有时效，过期需重新生成 · 确认后只提交订单，扣款在支付环节由你确认",
          // cardAction 是卡内动作的**唯一**触发凭据（2026-11-06）：客户端点击后
          // 经 card.action 送回，服务端只换这张卡，不再转写成用户消息。
          // 没有 cardAction 的按钮仍走老路（chat.user_action → 一轮问答）。
          buttons: [
            { label: "确认下单", variant: "primary", cardAction: "shopping.place.confirm" },
            { label: "先不下", variant: "secondary", cardAction: "local.dismiss" },
          ],
          actions: {
            platform,
            ...(str(r.item) ? { item: str(r.item) } : {}),
            ...(str(r.confirmationToken) ? { confirmationToken: str(r.confirmationToken) } : {}),
          },
        },
      },
    };
  },

  /**
   * shopping.order.status → 物流/订单状态卡。
   *
   * 节点按平台订单状态机推进（待支付→已支付→已发货→已签收），只渲染
   * 回执里真有的时间与物流摘要：平台没给承运商/运单号就不显示，
   * 不编造「顺丰 SF…」这种查不到的细节。
   */
  "shopping.order.status": (r) => {
    if (r.ok !== true) return null;
    const orders = Array.isArray(r.orders) ? r.orders : [];
    const first = (orders[0] ?? null) as Record<string, unknown> | null;
    if (!first) return null;

    const status = str(first.status);
    const rank: Record<string, number> = {
      pending_payment: 0,
      paid: 1,
      shipped: 2,
      completed: 3,
    };
    const current = rank[status] ?? 0;
    const labels = ["已下单", "已支付", "已发货", "已签收"];
    const createdAt = str(first.createdAt).replace("T", " ").slice(0, 16);
    const logistics = str(first.logisticsSummary);
    const nodes = labels.map((label, i) => ({
      label,
      state: i < current ? "done" : i === current ? "now" : "todo",
      ...(i === 0 && createdAt ? { detail: createdAt } : {}),
      ...(i === current && logistics ? { detail: logistics } : {}),
    }));
    const statusLabel =
      status === "pending_payment"
        ? "待支付"
        : status === "paid"
          ? "已支付"
          : status === "shipped"
            ? "运输中"
            : status === "completed"
              ? "已签收"
              : status === "cancelled"
                ? "已取消"
                : status === "failed"
                  ? "下单失败"
                  : "处理中";
    const title = str(first.itemTitle) || "订单物流";

    return {
      title,
      items: nodes.map((n) => ({
        type: (n.state === "todo" ? "num" : "check") as "num" | "check",
        text: `${n.label}${n.detail ? ` · ${n.detail}` : ""}`,
      })),
      footer: "状态取自平台订单页 · 平台未提供物流细节时不展示",
      cardType: "shopping_shipment",
      extra: {
        shopping: {
          stage: "shipment",
          title,
          statusLabel,
          nodes,
        },
      },
    };
  },

  /**
   * shopping.pay.submit → 支付卡（金额 + 收银台 + 已完成支付按钮）。
   *
   * 收银台已拉起（内置浏览器打开或 alipay-bot 代付）后，给用户
   * 「我已完成支付」/「稍后再说」按钮；点击经 chat.user_action 转为等价
   * user_message，由 LLM 调 shopping.pay.check 同步状态。按钮不直接触发
   * 资金动作——支付前的确认仍由两阶段 confirmationToken 把守。
   */
  // 支付下单卡（2026-11-10）：payment.create_order（微信/支付宝 native 收款码）。
  // 复用手机端 ShoppingPayCard 的 extra.shopping stage=pay 载荷（零客户端改动）：
  // 金额 + 订单号 + 二维码（服务端生成的 dataURI，手机卡内直接可扫）。
  // 「我已完成支付」走 card.action → payment.pay.check → queryOrder 原地换卡。
  // ── 预订族报价卡（2026-11-10）：travel_booking.search / ride_hailing.quote /
  // restaurant.search / home_service.search 共用 BookingService.search 的选项
  // 形状（BookingOption[]）。此前零卡片——四族报价全部塌成正文长文本。通用
  // 列表卡（cardType=""）手机端现成渲染，每行一个选项：价格 + 名称 + 价格来源
  // 如实标注（api/scraped/database/estimated），模拟报价必须带标记。
  // book 阶段仍由模型带着 optionId 走两阶段确认，卡不代点。
  "travel_booking.search": buildBookingSearchCard,
  "ride_hailing.quote": buildBookingSearchCard,
  "restaurant.search": buildBookingSearchCard,
  "home_service.search": buildBookingSearchCard,

  "payment.create_order": (r) => {
    const outTradeNo = str(r.outTradeNo);
    if (!outTradeNo) return null;
    const provider = str(r.provider) === "alipay" ? "alipay" : "wechat";
    const providerName = provider === "alipay" ? "支付宝" : "微信支付";
    const amount = num(r.amount);
    const description = str(r.description);
    const qrImage = str(r.qrCodeDataUrl);
    const items: ToolCardItem[] = [
      { type: "check", text: `订单：${description || outTradeNo}` },
      {
        type: amount != null && amount > 0 ? "num" : "check",
        text: `金额：${amount != null ? `¥${amount}` : "见收银台"} · ${providerName}`,
      },
    ];
    return {
      title: "💳 支付确认",
      items,
      footer:
        str(r.instruction) ||
        `请使用${providerName}扫码完成付款，完成后点下方确认`,
      cardType: "shopping_pay",
      extra: {
        shopping: {
          stage: "pay",
          title: `${providerName} · 待支付`,
          amount: amount != null ? `${amount}` : "",
          amountLabel: "应付金额",
          orderNo: outTradeNo,
          platformLabel: providerName,
          // dataURI 二维码（服务端生成）：ShoppingPayCard 内嵌展示，手机直接扫
          ...(qrImage ? { qrImage } : {}),
          note: "我不保存你的支付信息，也不代你扣款 · 支付完成后点下面确认",
        },
      },
      actions: [
        {
          id: "payment_pay_done",
          label: "我已完成支付，帮我确认",
          variant: "primary",
          cardAction: "payment.pay.check",
          payload: { outTradeNo, provider },
        },
        { id: "payment_later", label: "稍后再说", variant: "secondary" },
      ],
    };
  },

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
      cardType: "shopping_pay",
      // 手机端支付卡载荷：金额 + 订单号 + 收银台提示。二维码只在服务端
      // 真拿到平台码图时才下发（data URI），没有就不画假码。
      extra: {
        shopping: {
          stage: "pay",
          title: "订单已提交 · 待支付",
          amount: amount != null ? `${amount}` : "",
          amountLabel: "应付金额",
          orderNo: str(r.platformOrderId) || localOrderId,
          platformLabel: platform,
          note: "我不保存你的支付信息，也不代你扣款 · 支付完成后点下面确认",
        },
      },
      actions: [
        {
          id: "shopping_pay_done",
          label: "我已完成支付，帮我确认",
          variant: "primary",
          // 卡内动作：服务端直接查支付态并把这张卡推进到物流/订单态
          cardAction: "shopping.pay.check",
          payload: { localOrderId, platform },
        },
        { id: "shopping_pay_later", label: "稍后再说", variant: "secondary" },
      ],
    };
  },
};

/**
 * 复合工具 shopping.compare：按回执形状分派到原来的三个 builder。
 * 旧名（prices/research/watch）继续保留——历史事件与回放里的老工具名仍需能建卡，
 * 但新对话只会有 shopping.compare。
 */
BUILDERS["shopping.compare"] = (r) => {
  const name = Array.isArray(r.watches)
    ? "shopping.compare.watch"
    : Array.isArray(r.sources)
      ? "shopping.compare.research"
      : "shopping.compare.prices";
  return BUILDERS[name]?.(r) ?? null;
};

/** 预订族报价来源标签（价格按来源如实标注，估算不得当实价汇报）。 */
const BOOKING_PRICE_SOURCE_LABELS: Record<string, string> = {
  api: "实时接口",
  scraped: "页面代查",
  database: "价格库",
  list: "价格库",
  estimated: "估算",
};

/** 预订族报价 → 通用列表卡（travel/ride/restaurant/home_service 四族共用）。 */
function buildBookingSearchCard(r: Record<string, unknown>): ToolCardPayload | null {
  const rawOptions = Array.isArray(r.options) ? r.options : [];
  if (rawOptions.length === 0) return null;
  const providerLabel = str(r.providerLabel) || str(r.provider);
  const items: ToolCardItem[] = [];
  for (const raw of rawOptions.slice(0, 8)) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const price = num(o.amountCny);
    const title = str(o.title).slice(0, 40);
    if (!title) continue;
    const desc = str(o.description).slice(0, 30);
    const extra = (o.extra ?? {}) as Record<string, unknown>;
    const sourceLabel = BOOKING_PRICE_SOURCE_LABELS[str(extra.priceSource)] ?? "";
    const simulated = o.simulated === true;
    const parts = [
      price != null && price > 0 ? `¥${price}` : "价格以平台为准",
      title,
      desc ? `（${desc}）` : "",
      sourceLabel ? ` · 来源：${sourceLabel}` : "",
      simulated ? " · 模拟报价" : "",
    ].filter(Boolean);
    items.push({ type: price != null && price > 0 ? "num" : "check", text: parts.join(" ") });
  }
  if (items.length === 0) return null;
  const note = str(r.note);
  const footer = [
    providerLabel ? `来源：${providerLabel}` : "",
    note,
    "价格按来源如实标注，下单结算以平台实价为准",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    title: "📋 可选报价",
    items,
    footer,
    cardType: "",
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
 * weather.get_local 已并入进程内延迟目录检索（不强制路由），常规对话轮 LLM
 * 在 tool-loop 内自主调用天气工具，末轮只输出口语正文、reply.toolName 为空 →
 * 单工具直跑路径的 processAssistantText({toolName,toolResult}) 拿不到回执，
 * 天气卡恒附不上（真实回归：天气回答恒为纯文本）。这里从 onExternalToolExecuted
 * 聚合的真实结果建 weather 卡；多次调用（多地对比）合并为一张多地卡，每个城市一行。
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
  for (const r of results) {
    const location = str(r.locationLabel);
    const weatherText = str(r.weatherText) || str(r.summary);
    const range = str(r.todayRangeC);
    if (!weatherText && !range) continue;
    const parts = [weatherText, range ? `气温 ${range}` : ""].filter(Boolean);
    const rain = num(r.peakRainPct);
    const rainLine = rain != null ? rainText("今天", rain, str(r.todayRainPeriod)) : null;
    if (rainLine) parts.push(rainLine);
    items.push({
      type: "num",
      text: `${location ? location + " " : ""}${parts.join("，")}`,
    });
    if (!title) title = str(r.summary) || (location ? `${location} 天气实况` : "天气实况");
  }
  if (items.length === 0) return null;
  return {
    title: results.length > 1 ? "多地天气" : title,
    items,
    // 2026-11-04 用户定稿：着装不放卡片，留给 LLM 正文最后一句自然带出
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

/**
 * 与 agent-result-formatter 的 cardId 规则一致（cardType 非空才生成）。
 * 2026-11-12 根修：cardId 改为 payload 内容寻址（card-identity.ts）——
 * 同一张卡跨阶段重算（full 主链路 + done 兜底）cardId 恒一致，附卡去重
 * 才能幂等；时间戳随机 id 曾致提醒确认卡两端双卡。
 */
export function buildCardMarker(payload: ToolCardPayload, leadText: string): string {
  // 场景自带语义 cardId（如行程需求卡 req_days）时保留；否则内容寻址生成
  const selfId = (payload as unknown as Record<string, unknown>).cardId;
  const cardId =
    typeof selfId === "string" && selfId.trim() ? selfId : stableCardId(payload);
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
    // product_pick 的立场化主推/备选定位/渠道价 CTA；
    // price_compare 的跨平台分组报价/决策页入口）
    ...(payload.sides ? { sides: payload.sides } : {}),
    ...(payload.compare ? { compare: payload.compare } : {}),
    ...(payload.videos ? { videos: payload.videos } : {}),
    ...(payload.pick ? { pick: payload.pick } : {}),
    ...(payload.alternatives ? { alternatives: payload.alternatives } : {}),
    ...(payload.ugc ? { ugc: payload.ugc } : {}),
    ...(payload.priceCompare ? { priceCompare: payload.priceCompare } : {}),
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
