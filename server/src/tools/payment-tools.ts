import QRCode from "qrcode";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { PaymentService } from "../services/payment-service.js";
import type { QrAssistService } from "../services/qr-assist-service.js";
import { getPaymentConfig, getPaymentGuardrailConfig } from "../config/payment-config.js";

const PROVIDERS = ["wechat", "alipay"] as const;
const METHODS = ["native", "h5"] as const;

export function registerPaymentTools(
  registry: ToolRegistry,
  paymentService: PaymentService,
  qrAssist?: QrAssistService,
): void {
  const config = getPaymentConfig();

  registry.register("payment.create_order", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const provider = String(input.provider ?? "").trim().toLowerCase();
    if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) {
      throw new Error(`不支持的支付提供商：${provider}。支持：${PROVIDERS.join(", ")}`);
    }

    const method = String(input.method ?? "native").trim().toLowerCase();
    if (!METHODS.includes(method as typeof METHODS[number])) {
      throw new Error(`不支持的支付方式：${method}。支持：${METHODS.join(", ")}`);
    }

    const amount = Number(input.amount);
    if (!amount || amount <= 0) {
      throw new Error("金额必须大于0");
    }

    const description = String(input.description ?? "").trim();
    if (!description) {
      throw new Error("缺少商品描述 (description)");
    }

    const notifyUrl = config.paymentNotifyBaseUrl
      ? `${config.paymentNotifyBaseUrl}/api/payment/notify/${provider}`
      : undefined;

    // 业务类别（支付护栏的授权粒度）：显式 category 参数优先，兼容 metadata.category
    const category = String(input.category ?? "").trim() ||
      String((input.metadata as Record<string, string> | undefined)?.category ?? "").trim();
    const metadata: Record<string, string> | undefined = {
      ...((input.metadata as Record<string, string> | undefined) ?? {}),
      ...(category ? { category } : {}),
    };

    const result = await paymentService.createOrder({
      amount,
      description,
      actorId,
      provider: provider as "wechat" | "alipay",
      method: method as "native" | "h5",
      outTradeNo: input.outTradeNo ? String(input.outTradeNo).trim() : undefined,
      notifyUrl,
      metadata,
    });

    if (!result.ok) {
      throw new Error(result.error || "支付下单失败");
    }

    let qrCodeDataUrl: string | undefined;
    let qrImageUrl: string | undefined;
    if (result.payUrl) {
      try {
        qrCodeDataUrl = await QRCode.toDataURL(result.payUrl, {
          width: 300,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
      } catch {
        qrCodeDataUrl = undefined;
      }
      // 通用二维码推送：聊天流里直接可见，用户无需等 LLM 转述
      if (qrCodeDataUrl && qrAssist) {
        qrImageUrl =
          (await qrAssist.pushQrImage(
            context,
            {
              title: `请扫码支付（${provider === "wechat" ? "微信支付" : "支付宝"}）`,
              caption: `金额 ¥${result.amount} · ${result.description}`,
            },
            { dataUrl: qrCodeDataUrl },
          )) ?? undefined;
      }
    }

    const providerName = provider === "wechat" ? "微信支付" : "支付宝";
    const methodName = method === "h5" ? "H5支付" : "扫码支付";

    return {
      summary: `${providerName}${methodName}订单已创建`,
      outTradeNo: result.outTradeNo,
      provider: result.provider,
      method: result.method,
      amount: result.amount,
      description: result.description,
      status: result.status,
      qrCodeDataUrl,
      ...(qrImageUrl ? { qrImageUrl } : {}),
      payUrl: result.payUrl,
      createdAt: result.createdAt,
      instruction:
        method === "h5"
          ? `请在浏览器中打开支付链接完成${providerName}付款`
          : `请使用${providerName}扫描二维码完成付款`,
      actorId,
    };
  });

  registry.register("payment.query_order", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const outTradeNo = String(input.outTradeNo ?? "").trim();
    if (!outTradeNo) {
      throw new Error("缺少订单号 (outTradeNo)");
    }

    const provider = String(input.provider ?? "").trim().toLowerCase();
    if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) {
      throw new Error(`不支持的支付提供商：${provider}。支持：${PROVIDERS.join(", ")}`);
    }

    const result = await paymentService.queryOrder(outTradeNo, provider as "wechat" | "alipay", actorId);

    if (!result.ok) {
      throw new Error(result.error || "订单查询失败");
    }

    return {
      summary: result.tradeState === "SUCCESS" || result.tradeState === "TRADE_SUCCESS"
        ? "支付成功"
        : result.tradeStateDesc,
      outTradeNo: result.outTradeNo,
      provider: result.provider,
      tradeState: result.tradeState,
      tradeStateDesc: result.tradeStateDesc,
      amount: result.amount,
      payerInfo: result.payerInfo,
      payTime: result.payTime,
      actorId,
    };
  });

  registry.register("payment.list_methods", async (_input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const methods = [
      {
        provider: "wechat",
        name: "微信支付",
        methods: [
          {
            id: "native",
            name: "扫码支付",
            description: "生成支付二维码，用户使用微信扫码完成支付",
            mode: config.wechatMode,
          },
          {
            id: "h5",
            name: "H5支付",
            description: "生成支付链接，用户在浏览器中打开完成支付",
            mode: config.wechatMode,
          },
        ],
        configured: Boolean(config.wechatAppId && config.wechatMchId),
        mode: config.wechatMode,
      },
      {
        provider: "alipay",
        name: "支付宝",
        methods: [
          {
            id: "native",
            name: "扫码支付",
            description: "生成支付二维码，用户使用支付宝扫码完成支付",
            mode: config.alipayMode,
          },
          {
            id: "h5",
            name: "H5支付",
            description: "生成支付链接，用户在浏览器中打开完成支付",
            mode: config.alipayMode,
          },
        ],
        configured: Boolean(config.alipayAppId && config.alipayPrivateKey),
        mode: config.alipayMode,
      },
    ];

    const guardrails = getPaymentGuardrailConfig();
    return {
      summary: "支付方式列表",
      methods,
      defaultProvider: config.wechatMode === "live" ? "wechat" : config.alipayMode === "live" ? "alipay" : "wechat",
      guardrails: {
        maxSingleAmountCny: guardrails.maxSingleAmountCny,
        dailyBudgetCny: guardrails.dailyBudgetCny,
        allowedCategories: guardrails.allowedCategories,
        note: "create_order 受支付护栏约束：类别未授权/超单笔上限/超当日累计会被拦截，拦截时先向用户说明并确认",
      },
      actorId,
    };
  });

  registry.register("payment.mock_complete", async (input, context) => {
    const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });

    const outTradeNo = String(input.outTradeNo ?? "").trim();
    if (!outTradeNo) {
      throw new Error("缺少订单号 (outTradeNo)");
    }

    const success = paymentService.mockCompletePayment(outTradeNo);
    if (!success) {
      throw new Error(`未找到模拟订单：${outTradeNo}`);
    }

    return {
      summary: "模拟支付成功",
      outTradeNo,
      actorId,
    };
  });
}
