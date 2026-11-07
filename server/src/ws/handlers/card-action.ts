import type { WebSocket } from "ws";

import { ServerEventType } from "../../protocol.js";
import type { ToolContext } from "../../tools/tool-registry.js";
import type { ShoppingOrderService } from "../../services/shopping-order-service.js";
import { BROWSER_SESSION_SITES } from "../../services/browser-session-sites.js";
import { buildToolCard } from "../../services/tool-card-registry.js";

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
  const shopping = payload.actionId.startsWith("shopping.");
  if (!shopping) {
    // 未知族：明确回错误，别让卡片一直转圈
    send({ ok: false, error: `不支持的动作：${payload.actionId}` });
    return true;
  }
  if (!service) {
    send({ ok: false, error: "购物服务未装配" });
    return true;
  }

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
    const handoff = await service.beginLoginHandoff(toolContext, platform, targetUrl, { force });
    if (!handoff.ok) {
      send({ ok: false, error: handoff.error });
      return true;
    }
    if (handoff.alreadyLoggedIn) return false;
    send({
      ok: true,
      card: {
        title: `扫码登录${platformLabel}`,
        items: [],
        footer: `登录一次长期有效 · 只在这台服务上保存${platformLabel}的登录态`,
        cardType: "shopping_login",
        extra: {
          shopping: {
            stage: "login",
            title: `扫码登录${platformLabel}`,
            platform,
            platformLabel,
            ...(handoff.imageUrl ? { qrImage: handoff.imageUrl } : {}),
            note: handoff.imageUrl
              ? `用${platformLabel} App 扫这个码，扫完点下面的按钮`
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
        if (!(await service.hasLoginCookies(toolContext, platform))) {
          if (await sendLoginCard("shopping.place.start", true)) return true;
        }
        const result = await service.placeOrder(
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
        const specResult = await service.fetchProductSpecs(toolContext, platform, item);
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
        const token = str(data.token);
        if (!token) {
          send({ ok: false, error: "登录会话已失效，重新点一次商品" });
          return true;
        }
        const checked = await service.checkLoginHandoff(toolContext, token);
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
        const settled = await service.settleLoginConsent(toolContext, token, data.save === true);
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

      // 阶段二：确认提交（带阶段一 token）。
      case "shopping.place.confirm": {
        const token = str(data.confirmationToken);
        if (!platform || !token) {
          send({ ok: false, error: "确认凭据已失效，请重新选择商品" });
          return true;
        }
        const result = await service.placeOrder(toolContext, platform, item, quantity, true, token);
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
        const result = await service.checkPayment(toolContext, orderId);
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

      case "shopping.track": {
        if (!platform) {
          send({ ok: false, error: "缺少平台" });
          return true;
        }
        const result = await service.trackOrder(toolContext, platform, str(data.orderId) || undefined);
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
