import type { WebSocket } from "ws";

import { ServerEventType } from "../../protocol.js";
import type { ToolContext } from "../../tools/tool-registry.js";
import type { ShoppingOrderService } from "../../services/shopping-order-service.js";
import type { ShoppingCompareService } from "../../services/shopping-compare-service.js";
import type { PaymentService } from "../../services/payment-service.js";
import type { BookingService } from "../../services/booking/booking-service.js";
import { BROWSER_SESSION_SITES } from "../../services/browser-session-sites.js";
import { buildToolCard } from "../../services/tool-card-registry.js";
import { getUnifiedPaymentService } from "../../payments/unified-payment-service.js";

/**
 * 卡片内动作（card.action）——「一条回复内连续选择」的服务端半边。
 *
 * 为什么单独开一条通道（2026-11-06 用户定稿）：
 *   旧的 chat.user_action 会被转写成 chat.user_message，于是用户每点一步就
 *   多一条用户气泡 + 一整轮模型生成 + 一条助手回复。一次购物选商品、选平台、
 *   确认、支付，能刷出十几条消息，滚动条拉不到头，观感极差。
 *
 *   本通道点一步只做一件事：把**这张卡**换成下一步的形态。消息数量不变、
 *   不进模型上下文、不落聊天历史（客户端按 messageId 就地替换卡片）。
 *
 * 边界：
 *   - 只接「必须服务端数据才能前进」的动作（下单确认、支付查询、物流）。
 *   - 纯 UI 意图（翻页、选中高亮、展开规格）一律由客户端本地完成，
 *     不发事件——本地能算的绝不占一个网络往返。
 *   - 模型完全不参与：这条链路上没有任何一次 LLM 调用。
 */
export type CardActionContext = {
  socket: WebSocket;
  boundActorId: string;
  sendUnifiedError: (code: string, message: string) => void;
};

export type CardActionDeps = {
  shoppingOrderService?: ShoppingOrderService | null;
  /** 支付服务（可选）：payment.pay.check 卡内确认用，未装配时如实报错 */
  paymentService?: PaymentService | null;
  /**
   * 比价服务（可选，2026-11-13 P1）：登录卡上的「跳过这家 / 重新出码 /
   * 继续比价」都靠它续跑那一轮被登录闸门挂起的比价。未装配时这几个动作
   * 如实报「比价服务未装配」，不影响其它购物动作。
   */
  shoppingCompareService?: ShoppingCompareService | null;
  /**
   * 统一预订服务（可选）：叫车选择卡 / 确认卡的卡内动作。
   * 两阶段确认 token 仍由 BookingService 内生校验，卡只是它的界面。
   */
  bookingService?: BookingService | null;
};

type CardActionPayload = {
  messageId: string;
  cardId: string;
  actionId: string;
  stage: string;
  data: Record<string, unknown>;
};

function readPayload(raw: unknown): CardActionPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const messageId = typeof p.messageId === "string" ? p.messageId.trim() : "";
  const actionId = typeof p.actionId === "string" ? p.actionId.trim() : "";
  if (!messageId || !actionId) return null;
  return {
    messageId,
    cardId: typeof p.cardId === "string" ? p.cardId : "",
    actionId,
    stage: typeof p.stage === "string" ? p.stage : "",
    data: p.payload && typeof p.payload === "object"
      ? (p.payload as Record<string, unknown>)
      : {},
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 平台 id → 中文来源名（多平台登录卡点名用）。 */
function platformLabelOf(id: string): string {
  return (BROWSER_SESSION_SITES as Record<string, { label?: string } | undefined>)[id]?.label ?? id;
}

/**
 * 多平台登录卡（2026-11-13 P1）——**卡形态的唯一真相源**。
 *
 * 三处都要用它：首次推码、跳过一家后的重发、二维码失效后的重推。
 * 之所以要统一：卡是用户操作的唯一界面，一旦各处自己拼载荷，用户就会看到
 * 「有的卡能跳这家、有的卡不能」这种不一致（2026-11-06 定稿的老毛病）。
 *
 * 载荷里给三样东西：
 *   · qrItems         —— 每家的二维码（可为空 = 没截到码）
 *   · pendingPlatforms—— 待登录清单（用户能逐家「跳过这家 / 重新出码」）
 *   · actions.platforms—— 卡内动作回传时带上的平台名单
 */
function buildMultiLoginCard(opts: {
  platforms: string[];
  qrItems: Array<{ platform: string; platformLabel: string; qrImage: string; qrLink?: string; qrLinkFallback?: string }>;
  title: string;
  note: string;
  primaryLabel: string;
  secondaryLabel: string;
  primaryAction: string;
  secondaryAction?: string;
  stage?: "login" | "login-consent";
  readyPlatforms?: string[];
  /** 次按钮要带的额外参数（如「先比已登录的」的 skipPending=true）。 */
  secondaryPayload?: Record<string, unknown>;
  extraActions?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    title: opts.title,
    items: [],
    footer: opts.note,
    cardType: "shopping_login",
    extra: {
      shopping: {
        stage: opts.stage ?? "login",
        title: opts.title,
        multiLogin: true,
        qrItems: opts.qrItems,
        // 待登录清单（P1-2）：用户能逐家处理，不用回到对话里再说一遍
        pendingPlatforms: opts.platforms.map((p) => ({
          platform: p,
          platformLabel: platformLabelOf(p),
        })),
        ...(opts.readyPlatforms
          ? {
              readyPlatforms: opts.readyPlatforms,
              // 已登录平台的中文名（客户端要给人看中文，不能甩 id）
              readyPlatformLabels: opts.readyPlatforms.map((p) => platformLabelOf(p)),
            }
          : {}),
        note: opts.note,
        primaryLabel: opts.primaryLabel,
        secondaryLabel: opts.secondaryLabel,
        primaryAction: opts.primaryAction,
        secondaryAction: opts.secondaryAction ?? "local.dismiss",
        ...(opts.secondaryPayload ? { secondaryPayload: opts.secondaryPayload } : {}),
        actions: {
          platforms: opts.platforms,
          ...(opts.extraActions ?? {}),
        },
      },
    },
  };
}

/**
 * 重新出码（2026-11-13 P1）：给待登录平台换一批新的二维码。
 *
 * 二维码会过期（平台侧一般 2–5 分钟），用户扫得慢、中途切走都会失效。
 * 失效后必须能在卡里换一张新的，而不是让用户回到对话里问一句。
 *
 * 只落盘**不推流**：新码通过 card.update 原地换卡，聊天里不会堆两张码
 * （用户会分不清哪张是能扫的那张）。
 */
async function refreshLoginQrs(
  shoppingService: ShoppingOrderService,
  compareService: ShoppingCompareService | null | undefined,
  toolContext: ToolContext,
  platforms: string[],
  query: string,
): Promise<Array<{ platform: string; platformLabel: string; qrImage: string; qrLink?: string; qrLinkFallback?: string }>> {
  if (platforms.length === 0) return [];
  let fresh: Array<{ platform: string; label: string; imageUrl: string; qrLink?: string; qrLinkFallback?: string }> = [];
  try {
    fresh = await shoppingService.captureBatchLoginQrs(toolContext, platforms, query);
  } catch {
    fresh = [];
  }
  // 记进待登录会话：续跑时卡上拿到的仍是最新那张码（点码深链一并更新）
  compareService?.updatePendingQrImages(
    toolContext,
    fresh.map((f) => ({
      platform: f.platform,
      imageUrl: f.imageUrl,
      ...(f.qrLink ? { qrLink: f.qrLink } : {}),
      ...(f.qrLinkFallback ? { qrLinkFallback: f.qrLinkFallback } : {}),
    })),
  );
  return fresh.map((f) => ({
    platform: f.platform,
    platformLabel: f.label,
    qrImage: f.imageUrl,
    ...(f.qrLink ? { qrLink: f.qrLink } : {}),
    ...(f.qrLinkFallback ? { qrLinkFallback: f.qrLinkFallback } : {}),
  }));
}

/** 规格卡带回来的「维度名 → 选项文案」，直接交给 settlement 前点选。 */
function readPickedSpecs(data: Record<string, unknown>): Record<string, string> | undefined {
  const raw = data.specs;
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function handleCardActionEvent(
  ctx: CardActionContext,
  raw: unknown,
  deps: CardActionDeps,
): Promise<boolean> {
  const payload = readPayload(raw);
  if (!payload) {
    ctx.sendUnifiedError("BAD_CARD_ACTION", "card.action 缺少 messageId 或 actionId");
    return true;
  }

  const send = (body: Record<string, unknown>): void => {
    try {
      ctx.socket.send(
        JSON.stringify({
          type: ServerEventType.CardUpdate,
          payload: { messageId: payload.messageId, cardId: payload.cardId, ...body },
        }),
      );
    } catch {
      /* 连接已断：卡片停在 loading，重连后按历史 payload 恢复，不影响一致性 */
    }
  };

  const service = deps.shoppingOrderService;
  const paymentService = deps.paymentService;
  const isShopping = payload.actionId.startsWith("shopping.");
  const isPayment = payload.actionId.startsWith("payment.");
  const isRide = payload.actionId.startsWith("ride.");
  if (!isShopping && !isPayment && !isRide) {
    // 未知族：明确回错误，别让卡片一直转圈
    send({ ok: false, error: `不支持的动作：${payload.actionId}` });
    return true;
  }
  if (isShopping && !service) {
    send({ ok: false, error: "购物服务未装配" });
    return true;
  }
  if (isPayment && !paymentService) {
    send({ ok: false, error: "支付服务未装配" });
    return true;
  }
  if (isRide && !deps.bookingService) {
    send({ ok: false, error: "预订服务未装配" });
    return true;
  }
  // 收窄：shopping 族动作走到这里时 service 必非空（上方闸已回）；
  // payment 族不经过它，别名仅 shopping 分支消费。
  const shoppingService = service as ShoppingOrderService;

  const toolContext: ToolContext = {
    sessionId: ctx.boundActorId,
    userId: ctx.boundActorId,
    chatUserMessageId: payload.messageId,
  };
  const data = payload.data;
  const platform = str(data.platform);
  const item = str(data.item) || str(data.url);
  const quantity = num(data.quantity) ?? 1;

  const platformLabel =
    (BROWSER_SESSION_SITES as Record<string, { label?: string } | undefined>)[platform]?.label ??
    platform;

  /**
   * 卡内扫码登录（用户 2026-11-06 定稿）：没有登录态就把二维码**放进这张卡**，
   * 用户扫完点一下就继续，不再推一张独立图、也不再有「你说一句我扫了」那一轮。
   *
   * @returns true = 已经发了登录卡（调用方停止当前动作）；false = 已登录，继续原流程
   */
  const sendLoginCard = async (nextAction: string, force = false): Promise<boolean> => {
    const targetUrl = item || `https://www.${platform}.com`;
    const handoff = await shoppingService.beginLoginHandoff(toolContext, platform, targetUrl, { force });
    if (!handoff.ok) {
      send({ ok: false, error: handoff.error });
      return true;
    }
    if (handoff.alreadyLoggedIn) return false;
    send({
      ok: true,
      card: {
        title: `登录${platformLabel}`,
        items: [],
        footer: `登录一次长期有效 · 只在这台服务上保存${platformLabel}的登录态`,
        cardType: "shopping_login",
        extra: {
          shopping: {
            stage: "login",
            title: `登录${platformLabel}`,
            platform,
            platformLabel,
            ...(handoff.imageUrl ? { qrImage: handoff.imageUrl } : {}),
            ...(handoff.qrLink ? { qrLink: handoff.qrLink } : {}),
            ...(handoff.qrLinkFallback ? { qrLinkFallback: handoff.qrLinkFallback } : {}),
            note: handoff.imageUrl
              ? "点「点码登录」拉起 App 确认，或用 App 扫这个码，完成后点下面的按钮"
              : "登录页没截到二维码，稍后重试一次",
            primaryLabel: "我扫好了",
            secondaryLabel: "先不买",
            primaryAction: "shopping.login.check",
            secondaryAction: "local.dismiss",
            actions: {
              platform,
              item,
              quantity,
              token: handoff.token,
              nextAction,
            },
          },
        },
      },
    });
    return true;
  };

  try {
    switch (payload.actionId) {
      // 上车点地图卡 → 报价：用户在地图上确认后，用选中的坐标直接报价，
      // 换卡为车型选择（不进模型、不新增消息）。坐标优先于地址文本，
      // 避免「自定义上车点」这种泛化标签被地理编码到区中心。
      case "ride.pickup.quote": {
        const booking = deps.bookingService;
        if (!booking) {
          send({ ok: false, error: "预订服务未装配" });
          return true;
        }
        const dropoff = str(data.dropoff);
        if (!dropoff) {
          send({ ok: false, error: "缺少目的地，请重新发起叫车" });
          return true;
        }
        const pickup = str(data.pickup) || "自定义上车点";
        const provider = str(data.provider);
        const city = str(data.city);
        const lat = num(data.latitude);
        const lng = num(data.longitude);
        const pickupCoords =
          lat != null && lng != null ? { lat, lng } : undefined;
        const result = await booking.search(
          toolContext,
          "ride",
          {
            city: city || undefined,
            scheduleAt: null,
            params: {
              dropoff,
              pickup,
              ...(pickupCoords ? { pickupCoords } : {}),
            },
          },
          provider || undefined,
        );
        if (!result.ok) {
          send({ ok: false, error: result.error });
          return true;
        }
        const card = buildToolCard("ride_hailing.quote", {
          ...result,
          rideRequest: {
            pickup,
            dropoff,
            ...(city ? { city } : {}),
            ...(pickupCoords ? { pickupCoords } : {}),
          },
        });
        send(card ? { ok: true, card } : { ok: false, error: "报价卡生成失败，请稍后重试" });
        return true;
      }

      // 叫车选择卡 → 阶段一：重新报价定位车型、校验限额、铸造确认 token，
      // 把这张卡换成统一确认卡（与购物同款 shopping_confirm）。
      case "ride.book.prepare": {
        const booking = deps.bookingService;
        if (!booking) {
          send({ ok: false, error: "预订服务未装配" });
          return true;
        }
        const optionId = str(data.optionId);
        const dropoff = str(data.dropoff);
        if (!optionId || !dropoff) {
          send({ ok: false, error: "缺少车型或目的地，请重新报价" });
          return true;
        }
        const pickup = str(data.pickup);
        const provider = str(data.provider);
        const city = str(data.city);
        const scheduleAt = str(data.scheduleAt);
        const pickupCoordsRaw =
          data.pickupCoords && typeof data.pickupCoords === "object"
            ? (data.pickupCoords as Record<string, unknown>)
            : null;
        const pickupLat = pickupCoordsRaw ? num(pickupCoordsRaw.lat) : undefined;
        const pickupLng = pickupCoordsRaw ? num(pickupCoordsRaw.lng) : undefined;
        const result = await booking.book(toolContext, "ride", {
          provider: provider || undefined,
          optionId,
          params: {
            dropoff,
            ...(pickup ? { pickup } : {}),
            ...(pickupLat != null && pickupLng != null
              ? { pickupCoords: { lat: pickupLat, lng: pickupLng } }
              : {}),
          },
          city: city || undefined,
          scheduleAt: scheduleAt || null,
          confirm: false,
        });
        if (!result.ok) {
          send({ ok: false, error: result.error });
          return true;
        }
        const card = buildToolCard("ride_hailing.book", {
          ...result,
          dropoff,
          ...(pickup ? { pickup } : {}),
          ...(city ? { city } : {}),
        });
        send(card ? { ok: true, card } : { ok: false, error: "确认卡生成失败，请重新报价" });
        return true;
      }

      // 叫车确认卡 → 阶段二：token 校验通过后真实（或模拟）下单，
      // 卡面推进到订单/统一支付卡。全程不产生用户消息、不跑模型。
      case "ride.book.confirm": {
        const booking = deps.bookingService;
        if (!booking) {
          send({ ok: false, error: "预订服务未装配" });
          return true;
        }
        const optionId = str(data.optionId);
        const dropoff = str(data.dropoff);
        const provider = str(data.provider);
        if (!optionId) {
          send({ ok: false, error: "报价已失效，请重新选择车型" });
          return true;
        }
        const result = await booking.book(toolContext, "ride", {
          provider: provider || undefined,
          optionId,
          params: { dropoff },
          confirm: true,
          confirmationToken: str(data.confirmationToken) || undefined,
        });
        if (!result.ok) {
          send({ ok: false, error: result.error });
          return true;
        }
        const card = buildToolCard("ride_hailing.book", result);
        send(card ? { ok: true, card } : { ok: false, error: "订单卡生成失败，请查看订单状态" });
        return true;
      }

      // 阶段一：把「选中的这个商品」变成可确认的下单摘要（金额/店铺/收货/截图）。
      // 用户点的是一次「就这家」，服务端当场去结算页捞真实数据 —— 这条链路
      // 原本要发一条 user_message 让模型再调工具，现在一张卡换来同样的结果。
      case "shopping.place.start": {
        if (!platform || !item) {
          send({ ok: false, error: "缺少平台或商品链接" });
          return true;
        }
        // 下单必须登录（2026-11-06 定稿语义）：没有授权 Cookie 就地出码，
        // 不再开商品页预检——苏宁这类商品页匿名能看、结算页才拦的平台，
        // 预检只会误判「已登录」然后在结算那一步炸掉。有 Cookie 直接去结算。
        if (!(await shoppingService.hasLoginCookies(toolContext, platform))) {
          if (await sendLoginCard("shopping.place.start", true)) return true;
        }
        const result = await shoppingService.placeOrder(
          toolContext,
          platform,
          item,
          quantity,
          false,
          undefined,
          readPickedSpecs(data),
        );
        // 商品页匿名能看、结算页才要登录（苏宁就这样）：placeOrder 撞墙后
        // 带 loginRequired 回来，force 交接直接开平台登录页截码。
        if ((result as { loginRequired?: unknown }).loginRequired) {
          if (await sendLoginCard("shopping.place.start", true)) return true;
        }
        const card = result.ok
          ? buildToolCard("shopping.order.place", result as unknown as Record<string, unknown>)
          : null;
        if (!card) {
          // 只透传 placeOrder 的真实错误，不写死「没走到结算页」这类警示文案
          send({ ok: false, error: str((result as { error?: unknown }).error) });
          return true;
        }
        send({ ok: true, card });
        return true;
      }

      // 选规格（2026-11-06 用户要求）：商家给的全部组合都要摆出来让用户选。
      // 读不到规格就直接进结算——用户只点一次，不多问一轮、不塞空规格页。
      case "shopping.spec.load": {
        if (!platform || !item) {
          send({ ok: false, error: "缺少平台或商品链接" });
          return true;
        }
        const specResult = await shoppingService.fetchProductSpecs(toolContext, platform, item);
        const rawSpecs = (specResult as { specs?: unknown }).specs;
        const specs = Array.isArray(rawSpecs) ? (rawSpecs as Array<Record<string, unknown>>) : [];
        if (specResult.ok && specs.length > 0) {
          send({
            ok: true,
            card: {
              title: "选规格",
              items: [],
              footer: "商家提供的全部组合都在这里 · 灰的是没货",
              cardType: "shopping_spec",
              extra: {
                shopping: {
                  stage: "spec",
                  title:
                    str((specResult as { itemTitle?: unknown }).itemTitle) ||
                    str(data.title) ||
                    "选规格",
                  subtitle: "选好组合，去结算",
                  specs,
                  note: "无货的组合已标灰 · 最终金额以结算页为准",
                  primaryLabel: "就这个，去结算",
                  secondaryLabel: "先不买",
                  primaryAction: "shopping.place.start",
                  secondaryAction: "local.dismiss",
                  actions: { platform, item, quantity },
                },
              },
            },
          });
          return true;
        }
        // 读不到规格：先判断是不是缺登录态（综合电商的商品详情页都要登录），
        // 是就地把二维码放进这张卡；已登录还读不到才如实说没规格。
        if (await sendLoginCard("shopping.spec.load")) return true;
        send({
          ok: false,
          error: `没读到${platformLabel}的规格——这个商品可能确实没有可选项，也可能是页面还没加载出来，再点一次试试。`,
        });
        return true;
      }

      // 卡内扫码完成：校验登录态 → 落 Cookie → 接着把原动作做完。
      case "shopping.login.check": {
        // 多平台登录卡（2026-11-13 P0-2）：一次推齐几家的码，用户点「我扫好了」
        // 时逐家确认——扫了哪几家就绪、哪几家还差，如实回报，不假装全好了。
        const multiPlatforms = Array.isArray(data.platforms)
          ? (data.platforms as unknown[]).map((p) => str(p)).filter(Boolean)
          : [];
        if (multiPlatforms.length > 0) {
          const checked = await shoppingService.checkMultiPlatformLogin(
            toolContext,
            multiPlatforms,
          );
          const compareService = deps.shoppingCompareService;
          const pendingSession = compareService?.getPendingCompare(toolContext) ?? null;
          if (checked.ready.length === 0) {
            // 一家都没扫成功：二维码多半已经过期（平台侧一般 2–5 分钟失效）。
            // 这时不只报错——**把卡换成带「重新出码 / 跳过这家」的版本**，
            // 让用户能在卡里直接处理，而不是回到对话里问一句。
            const freshQrs = await refreshLoginQrs(
              shoppingService,
              compareService,
              toolContext,
              multiPlatforms,
              pendingSession?.query ?? "",
            );
            send({
              ok: true,
              card: buildMultiLoginCard({
                platforms: multiPlatforms,
                qrItems: freshQrs,
                title: `请扫码登录（${multiPlatforms.map((p) => platformLabelOf(p)).join("、")}）`,
                note: "还没检测到登录成功——码可能已过期，点「重新出码」换一张新的再扫",
                primaryLabel: "我扫好了",
                secondaryLabel: "先不比了",
                primaryAction: "shopping.login.check",
                stage: "login",
                extraActions: { readyPlatforms: checked.ready },
              }),
            });
            return true;
          }
          const readyLabels = checked.ready.map((p) => platformLabelOf(p));
          const pendingLabels = checked.pending.map((p) => platformLabelOf(p));
          // 有待登录比价在等 → 主按钮直接**续跑比价**（用户要的「登录完再统一
          // 取价、一次性交付」），不要让用户再说一句「我扫好了」。
          const canResume = !!compareService && !!pendingSession;
          send({
            ok: true,
            card: buildMultiLoginCard({
              platforms: checked.pending.length > 0 ? checked.pending : checked.ready,
              qrItems: [],
              title:
                pendingLabels.length > 0
                  ? `${readyLabels.join("、")}登录成功`
                  : "登录成功",
              note:
                pendingLabels.length > 0
                  ? `还差：${pendingLabels.join("、")}（可重新出码，或跳过这家只比其余平台）`
                  : canResume
                    ? "全部登录完成，点「继续比价」我把这轮的价格一次性给你"
                    : "登录都好了，但刚才那轮比价已经过期——回一句「继续比价」我重新来一轮",
              primaryLabel:
                pendingLabels.length > 0 ? "继续比价（补齐剩余平台）" : "继续比价",
              secondaryLabel: "先比已登录的",
              primaryAction: canResume ? "shopping.compare.resume" : "shopping.login.check",
              // 「先比已登录的」= 剩下的不等了，只比已登录的（服务端据此把剩下
              // 的记成「已跳过」，不是「没价」）
              secondaryAction: canResume ? "shopping.compare.resume" : "local.dismiss",
              secondaryPayload: canResume
                ? { skipPending: true }
                : undefined,
              stage: "login-consent",
              readyPlatforms: checked.ready,
              extraActions: { readyPlatforms: checked.ready },
            }),
          });
          return true;
        }
        const token = str(data.token);
        if (!token) {
          send({ ok: false, error: "登录会话已失效，重新点一次商品" });
          return true;
        }
        const checked = await shoppingService.checkLoginHandoff(toolContext, token);
        if (!checked.ok) {
          send({ ok: false, error: checked.error, stillWaiting: checked.stillWaiting });
          return true;
        }
        // 扫码成功（2026-11-06 用户定稿）：保存 Cookie 前先问用户。同一张卡
        // 变成同意卡——「保存登录」落库（下次免扫码），「不保存」直接继续
        // （登录态只在内存里活着，够走完这一单）。
        send({
          ok: true,
          card: {
            title: `${platformLabel}登录成功`,
            items: [],
            footer: "保存 = 加密存在这台服务上，只用于替你执行你交代的事",
            cardType: "shopping_login",
            extra: {
              shopping: {
                stage: "login-consent",
                title: `${platformLabel}登录成功`,
                platformLabel,
                platform,
                note: "要我把这次的登录状态保存下来吗？保存后下次不用再扫码。",
                primaryLabel: "保存登录",
                secondaryLabel: "不保存",
                primaryAction: "shopping.login.consent",
                secondaryAction: "shopping.login.consent",
                actions: {
                  platform,
                  item,
                  quantity,
                  token,
                  save: true,
                  nextAction: str(data.nextAction) || "shopping.place.start",
                },
              },
            },
          },
        });
        return true;
      }

      // 用户对「是否保存登录」的选择：save=true 落库，false 直接放行；
      // 两种选择都接着把原动作做完（resume nextAction）。
      case "shopping.login.consent": {
        const token = str(data.token);
        if (!token) {
          send({ ok: false, error: "登录会话已失效，重新点一次商品" });
          return true;
        }
        const settled = await shoppingService.settleLoginConsent(toolContext, token, data.save === true);
        if (!settled.ok) {
          send({ ok: false, error: settled.error });
          return true;
        }
        const next = str(data.nextAction) || "shopping.place.start";
        const nextData: Record<string, unknown> = {
          ...data,
          ...(data.specs ? { specs: data.specs } : {}),
        };
        delete nextData.token;
        delete nextData.nextAction;
        delete nextData.save;
        return await handleCardActionEvent(
          ctx,
          { messageId: payload.messageId, cardId: payload.cardId, actionId: next, stage: payload.stage, payload: nextData },
          deps,
        );
      }

      // 「跳过这家」（2026-11-13 P1）：用户放弃某个待登录平台。
      //
      // 语义严格：**只是不再等这家**，不是「这家没有价」。跳过后这家会进
      // 「未取到报价」清单（原因=已跳过），模型不得替它编价；等剩下的平台
      // 都处理完，统一取价、一次性交付。
      case "shopping.login.skip": {
        const compareService = deps.shoppingCompareService;
        if (!compareService) {
          send({ ok: false, error: "比价服务未装配" });
          return true;
        }
        const target = str(data.platform);
        const skipped = compareService.skipLoginPlatform(toolContext, target);
        if (!skipped) {
          send({ ok: false, error: "这次登录会话已经过期了，重新说一次要比的东西就行" });
          return true;
        }
        const remaining = skipped.remaining;
        if (remaining.length === 0) {
          // 没有待登录平台了 → 立刻续跑：统一取价、一次性交付比价卡
          const resumed = await compareService.resumeCompareAfterLogin(toolContext);
          if (!resumed.ok) {
            send({
              ok: false,
              error: resumed.error,
              ...(resumed.stillWaiting ? { stillWaiting: true } : {}),
            });
            return true;
          }
          const card = buildToolCard("shopping.compare.prices", resumed.result);
          if (!card) {
            send({ ok: false, error: "比价没取到结果，再试一次" });
            return true;
          }
          send({ ok: true, card });
          return true;
        }
        // 还剩几家要登录 → 卡上撤掉跳过的那家，其余原样留着继续扫
        const qrMap = new Map(skipped.session.qrItems.map((q) => [q.platform, q]));
        const qrItems = remaining.map((p) => {
          const q = qrMap.get(p);
          return {
            platform: p,
            platformLabel: platformLabelOf(p),
            qrImage: q?.qrImage ?? "",
            ...(q?.qrLink ? { qrLink: q.qrLink } : {}),
            ...(q?.qrLinkFallback ? { qrLinkFallback: q.qrLinkFallback } : {}),
          };
        });
        send({
          ok: true,
          card: buildMultiLoginCard({
            platforms: remaining,
            qrItems,
            title: `请扫码登录（${remaining.map((p) => platformLabelOf(p)).join("、")}）`,
            note: `已跳过${target ? platformLabelOf(target) : "这家"}，其余扫码后我一起比给你`,
            primaryLabel: "我扫好了",
            secondaryLabel: "先不比了",
            primaryAction: "shopping.login.check",
            stage: "login",
          }),
        });
        return true;
      }

      // 「重新出码」（2026-11-13 P1）：二维码过期了，换一张新的原地换卡。
      case "shopping.login.refresh": {
        const compareService = deps.shoppingCompareService;
        const session = compareService?.getPendingCompare(toolContext) ?? null;
        const many = Array.isArray(data.platforms)
          ? (data.platforms as unknown[]).map((p) => str(p)).filter(Boolean)
          : [];
        const one = str(data.platform);
        const targets = many.length > 0 ? many : one ? [one] : [];
        if (targets.length === 0) {
          send({ ok: false, error: "缺少平台" });
          return true;
        }
        const query = str(data.query) || session?.query || "";
        const fresh = await refreshLoginQrs(
          shoppingService,
          compareService,
          toolContext,
          targets,
          query,
        );
        if (fresh.length === 0) {
          send({
            ok: false,
            error: "没截到新的二维码——这家可能已经登录成功了，点「我扫好了」再试一次",
          });
          return true;
        }
        // 没重出的那几家沿用旧码（图和点码深链都不变），整张卡一次性换掉
        const oldMap = new Map((session?.qrItems ?? []).map((q) => [q.platform, q]));
        const freshMap = new Map(fresh.map((f) => [f.platform, f]));
        const scope = new Set<string>([...(session?.loginPlatforms ?? []), ...targets]);
        const qrItems = [...scope].map((p) => {
          const q = freshMap.get(p) ?? oldMap.get(p);
          return {
            platform: p,
            platformLabel: platformLabelOf(p),
            qrImage: q?.qrImage ?? "",
            ...(q?.qrLink ? { qrLink: q.qrLink } : {}),
            ...(q?.qrLinkFallback ? { qrLinkFallback: q.qrLinkFallback } : {}),
          };
        });
        send({
          ok: true,
          card: buildMultiLoginCard({
            platforms: [...scope],
            qrItems,
            title: `请扫码登录（${[...scope].map((p) => platformLabelOf(p)).join("、")}）`,
            note: "已换新的二维码，扫完点「我扫好了」",
            primaryLabel: "我扫好了",
            secondaryLabel: "先不比了",
            primaryAction: "shopping.login.check",
            stage: "login",
          }),
        });
        return true;
      }

      // 「继续比价」（2026-11-13 P1）：登录处理完 → 统一取价、一次性交付。
      //
      // 这是整条链路的收口：预检登录态 → 推齐二维码 → 等用户处理 → 同批次
      // 统一取价 → 事实清单校验 → 横向轮播卡一次性交付，中间不出半成品答案。
      case "shopping.compare.resume": {
        const compareService = deps.shoppingCompareService;
        if (!compareService) {
          send({ ok: false, error: "比价服务未装配" });
          return true;
        }
        const resumed = await compareService.resumeCompareAfterLogin(toolContext, {
          skipPending: data.skipPending === true,
        });
        if (!resumed.ok) {
          send({
            ok: false,
            error: resumed.error,
            ...(resumed.stillWaiting ? { stillWaiting: true } : {}),
          });
          return true;
        }
        const card = buildToolCard("shopping.compare.prices", resumed.result);
        if (!card) {
          send({ ok: false, error: "比价没取到结果，再试一次" });
          return true;
        }
        send({ ok: true, card });
        return true;
      }

      // 阶段二：确认提交（带阶段一 token）。
      case "shopping.place.confirm": {
        const token = str(data.confirmationToken);
        if (!platform || !token) {
          send({ ok: false, error: "确认凭据已失效，请重新选择商品" });
          return true;
        }
        const result = await shoppingService.placeOrder(toolContext, platform, item, quantity, true, token);
        const card = buildToolCard("shopping.order.place", result as unknown as Record<string, unknown>);
        if (!card) {
          // 不再兜底写死警示文案（2026-11-06 用户定稿：服务端不编话，由真实错误如实透出）
          send({ ok: false, error: str((result as { error?: unknown }).error) });
          return true;
        }
        send({ ok: true, card });
        return true;
      }

      // 支付状态 + 物流：都不产生新消息，只把这张卡推进到「已付/在途」。
      case "shopping.pay.check": {
        const orderId = str(data.orderId);
        if (!orderId) {
          send({ ok: false, error: "缺少订单号" });
          return true;
        }
        const result = await shoppingService.checkPayment(toolContext, orderId);
        const card = buildToolCard(
          "shopping.order.status",
          result as unknown as Record<string, unknown>,
        );
        // 失败只透传服务层真实错误，不写死警示文案（2026-11-06 用户定稿）
        send(
          card
            ? { ok: true, card }
            : { ok: false, error: str((result as { error?: unknown }).error) },
        );
        return true;
      }

      // 收款单卡内确认（2026-11-10）：payment.create_order 卡的「我已完成支付」。
      // 直接查支付网关真实状态：SUCCESS → 卡面翻成已支付；未付 → 卡面原样 +
      // 提示还没到账，绝不说「已支付」（实数只认真值，同一契约）。
      case "payment.pay.check": {
        const payment = paymentService;
        const outTradeNo = str(data.outTradeNo);
        const provider = str(data.provider) === "alipay" ? "alipay" : "wechat";
        if (!payment) {
          send({ ok: false, error: "支付服务未装配" });
          return true;
        }
        if (!outTradeNo) {
          send({ ok: false, error: "缺少订单号" });
          return true;
        }
        const result = await payment.queryOrder(outTradeNo, provider, ctx.boundActorId);
        if (!result.ok) {
          send({ ok: false, error: result.error || "订单查询失败" });
          return true;
        }
        const paid =
          result.tradeState === "SUCCESS" || result.tradeState === "TRADE_SUCCESS";
        const providerName = provider === "alipay" ? "支付宝" : "微信支付";
        const description =
          (result as unknown as { description?: string }).description || outTradeNo;
        send({
          ok: true,
          card: {
            title: paid ? "✅ 支付成功" : "💳 待支付",
            items: [
              { type: "check", text: `订单：${description}` },
              {
                type: result.amount != null ? "num" : "check",
                text: `金额：${result.amount != null ? `¥${result.amount}` : "见收银台"} · ${providerName}`,
              },
            ],
            footer: paid
              ? `已确认到账（${result.tradeStateDesc || "SUCCESS"}）${result.payTime ? ` · ${result.payTime}` : ""}`
              : "还没查到到账记录——扫码支付后几秒内到账，稍等片刻再点一次确认",
            cardType: "shopping_pay",
            extra: {
              shopping: {
                stage: paid ? "shipment" : "pay",
                title: paid ? `${providerName} · 支付成功` : `${providerName} · 待支付`,
                ...(result.amount != null ? { amount: `${result.amount}` } : {}),
                amountLabel: "实付金额",
                orderNo: outTradeNo,
                platformLabel: providerName,
                note: paid
                  ? "这笔收款已确认，无需再操作"
                  : "还没查到到账记录 · 扫码支付后稍等几秒再点确认",
              },
            },
          },
        });
        return true;
      }

      // 统一支付卡内继续（2026-11-13）：三个动作都直接调统一支付服务，不经 LLM。
      //   resume  —— 用户刚在授权页点了同意，重跑授权判定并继续
      //   confirm —— 用户在卡上明确确认，立即扣款/出收款码（这就是两阶段确认的第二步）
      //   check   —— 用户说付完了，向渠道核对真实状态（绝不按用户口述判成功）
      case "payment.intent.resume":
      case "payment.intent.confirm":
      case "payment.intent.check": {
        const unified = getUnifiedPaymentService();
        if (!unified) {
          send({ ok: false, error: "统一支付服务未装配" });
          return true;
        }
        const intentId = str(data.intentId);
        if (!intentId) {
          send({ ok: false, error: "缺少支付意图 ID" });
          return true;
        }
        const result =
          payload.actionId === "payment.intent.confirm"
            ? await unified.confirmIntent({
                intentId,
                actorId: ctx.boundActorId,
                confirmToken: str(data.confirmToken),
              })
            : payload.actionId === "payment.intent.resume"
              ? await unified.resumeIntent(intentId, ctx.boundActorId)
              : await unified.queryIntent(intentId, ctx.boundActorId);
        const card = buildToolCard("payment.pay", result as unknown as Record<string, unknown>);
        send(card ? { ok: true, card } : { ok: false, error: result.message });
        return true;
      }

      case "shopping.track": {
        if (!platform) {
          send({ ok: false, error: "缺少平台" });
          return true;
        }
        const result = await shoppingService.trackOrder(
          toolContext,
          platform,
          str(data.orderId) || undefined,
        );
        const card = buildToolCard(
          "shopping.order.status",
          result as unknown as Record<string, unknown>,
        );
        send(
          card
            ? { ok: true, card }
            : { ok: false, error: str((result as { error?: unknown }).error) },
        );
        return true;
      }

      default:
        send({ ok: false, error: `不支持的动作：${payload.actionId}` });
        return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ ok: false, error: message });
    return true;
  }
}
