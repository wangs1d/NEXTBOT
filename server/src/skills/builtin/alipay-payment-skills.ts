import { resolveActorId } from "../../agent/actor-id.js";
import type { AlipayBotService } from "../../services/alipay-bot-service.js";
import type { QrAssistService } from "../../services/qr-assist-service.js";
import type { SkillDefinition } from "../types.js";

type Deps = {
  alipayBotService: AlipayBotService;
  /** 通用二维码推送（把 CLI 产出的绑定/收款二维码实时推到聊天流）。缺省时不推。 */
  qrAssist?: QrAssistService;
};

/** 按当前会话/用户解析出的稳定用户标识，取该用户的独立钱包实例。 */
function walletFor(context: { userId?: string | undefined; sessionId: string }, alipayBotService: AlipayBotService): AlipayBotService {
  return alipayBotService.forUser(resolveActorId(context));
}

/**
 * 从 apply-wallet 的 CLI 输出中提取支付宝官方开通链接。
 *
 * 已知输出格式：
 * ```
 * [支付宝官方开启链接](<https://u.alipay.cn/xxxx>)
 * MEDIA: file:///.../qrcode/wallet-bind-xxx.png
 * ```
 * 优先取 markdown 包裹的链接，其次直接匹配 `https://u.alipay.cn/` 开头的 URL。
 * 提取不到时返回空串。
 */
function extractAuthLink(stdout: string): string {
  if (!stdout) return "";
  const md = /\[[^\]]*\]\(\s*<([^>]+)>\s*\)/.exec(stdout);
  if (md && /^https?:\/\//i.test(md[1])) return md[1];
  const bare = /(https?:\/\/u\.alipay\.cn\/\S+)/.exec(stdout);
  if (bare) return bare[1].replace(/[)\]>,;\s]+$/, "");
  return "";
}

/**
 * 内置 Skill：支付宝 AI 支付（真实购买能力）。
 *
 * 把支付宝官方 `alipay-bot` CLI（已内置到 `server/alipay-bot-cli/`）封装成
 * 一组 Skill，让 agent 可以真实完成：
 *   - 支付能力开通/状态查询（check-wallet / apply-wallet / bind-wallet）
 *   - 收银台支付（submit-payment / query-payment-status）
 *   - HTTP 402 协议支付（402-buyer-pay / 402-query-payment-status）
 *
 * 钱包按用户隔离：所有 handler 都用 `walletFor(context)` 解析当前用户的
 * 独立钱包（目录 `data/alipay-bot-state/users/<userId>/`）。用户首次表达
 * 支付意图时走「check-wallet → apply-wallet（返回二维码）→ 用户扫码授权
 * → bind-wallet」的首次授权流程；绑定后该用户的支付都从本人支付宝扣款。
 *
 * 与现有能力的边界：
 *   - payment.*：真实提交/记账
 *   - shopping.order.*：无头浏览器下单到结算页，不自动支付
 *   - payment.create_order：走商户号支付网关（需商户资质配置）
 *   本 skill 走支付宝官方 AI 支付通道，用户扫二维码即可完成真实付款。
 */
export function createAlipayPaymentBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { alipayBotService, qrAssist } = deps;

  /** 1. 查询支付能力状态 */
  const check_wallet: SkillDefinition = {
    metadata: {
      name: "alipay.check-wallet",
      version: "1.0.0",
      displayName: "查询支付宝支付能力状态",
      description:
        "查询当前用户支付宝 AI 支付能力是否已开通。返回 enabled（已开通）/ applied_unbound（已申请待授权）/ not_opened（未开通）。" +
        "钱包按用户隔离，每个用户独立授权。用户表达支付、付款、买单、结账意图时，先调用本 skill 确认该用户支付能力状态；" +
        "未开通时引导首次授权：调 alipay.apply-wallet 生成二维码 → 用户用支付宝扫码 → alipay.bind-wallet 完成绑定，" +
        "此后该用户支付均从本人支付宝账户扣款。",
      kind: "builtin",
      tags: ["alipay", "payment", "wallet", "支付", "购买"],
      icon: "💳",
      parameters: [],
      outputSchema: {
        code: "状态码：200=已开通/待授权，500=未开通",
        message: "状态说明",
        status: "enabled | applied_unbound | not_opened | unknown",
        reason: "未开通原因（如有）",
      },
      permissions: ["wallet:read"],
      timeoutMs: 30_000,
    },
    handler: async (_input, context) => {
      const actorId = resolveActorId(context);
      const status = await walletFor(context, alipayBotService).checkWallet();
      return {
        ok: true,
        actorId,
        code: status.code,
        message: status.message,
        status: status.status,
        reason: status.reason,
        summary:
          status.code === 200
            ? status.status === "applied_unbound"
              ? "支付宝支付功能已申请，等待用户完成支付宝侧授权"
              : "支付宝支付功能已开启"
            : status.status === "not_opened"
              ? "支付宝支付功能尚未开通，需要先申请开通"
              : "查询支付能力状态失败",
      };
    },
  };

  /** 2. 申请开通支付功能 */
  const apply_wallet: SkillDefinition = {
    metadata: {
      name: "alipay.apply-wallet",
      version: "1.0.0",
      displayName: "申请开通支付宝支付功能",
      description:
        "申请开通支付宝 AI 支付能力（当前用户独立钱包，目录 data/alipay-bot-state/users/<userId>/）。返回支付宝官方开通链接或二维码图片，" +
        "用户需在支付宝 App 中扫码/点链接完成授权。这是每个用户首次使用支付功能时的必经步骤：" +
        "用户说「开启支付宝支付功能」「开通支付」「我要支付/买奶茶」且该用户未开通时调用，扫码授权后调 alipay.bind-wallet 完成绑定。可选参数 agentName（Agent 名称）与 code（开通口令）。",
      kind: "builtin",
      tags: ["alipay", "payment", "wallet", "开通", "授权"],
      icon: "🔑",
      parameters: [
        {
          name: "agentName",
          type: "string",
          required: false,
          description: "Agent 名称（用于钱包创建标识），通常可省略",
        },
        {
          name: "code",
          type: "string",
          required: false,
          description: "开通口令/用户账号token（enrollment code）。与 agentName 互斥",
        },
      ],
      outputSchema: {
        stdout: "CLI 原始输出（含开通链接与二维码 MEDIA 行）",
        media: "二维码图片文件路径列表",
        ok: "命令是否成功执行",
      },
      permissions: ["wallet:write"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const agentName = typeof input.agentName === "string" && input.agentName.trim()
        ? input.agentName.trim()
        : undefined;
      const code = typeof input.code === "string" && input.code.trim()
        ? input.code.trim()
        : undefined;
      const result = await walletFor(context, alipayBotService).applyWallet({ agentName, code });
      const link = result.ok ? extractAuthLink(result.stdout) : "";
      // 通用二维码推送：CLI 产出的绑定二维码直接推到聊天流（best-effort）
      let qrImageUrl: string | undefined;
      if (result.ok && qrAssist && Array.isArray(result.media) && result.media.length > 0) {
        qrImageUrl =
          (await qrAssist.pushQrImage(
            context,
            { title: "请扫码开通支付宝支付", caption: "扫码完成授权后即可帮你真实付款" },
            { filePath: String(result.media[0]) },
          )) ?? undefined;
      }
      return {
        ok: result.ok,
        actorId,
        stdout: result.stdout,
        stderr: result.stderr,
        media: result.media,
        error: result.error,
        ...(qrImageUrl ? { qrImageUrl } : {}),
        summary: result.ok
          ? link
            ? `已生成开通链接。请向用户发送引导（自然语气，无需自我介绍）：先授权支付宝支付，之后才能帮你下单付款。链接用 markdown 可点击格式： [点此开通支付宝支付](${link})，附原文：${link}${qrImageUrl ? "。二维码已推送到聊天" : ""}`
            : "已生成支付宝支付功能开通入口，请向用户提供链接完成授权"
          : "申请开通失败，请查看 error",
      };
    },
  };

  /** 3. 绑定开通码 */
  const bind_wallet: SkillDefinition = {
    metadata: {
      name: "alipay.bind-wallet",
      version: "1.0.0",
      displayName: "绑定支付宝开通码",
      description:
        "用当前用户开通过程产生的 OTP、验证码或六位授权码绑定支付宝支付功能（绑定到该用户自己的钱包）。仅处理当前开通流程的验证码，不处理开通口令。",
      kind: "builtin",
      tags: ["alipay", "payment", "wallet", "验证码", "授权码", "绑定"],
      icon: "🔐",
      parameters: [
        {
          name: "code",
          type: "string",
          required: true,
          description: "开通流程返回的 OTP / 验证码 / 六位授权码",
        },
      ],
      outputSchema: {
        stdout: "CLI 原始输出",
        ok: "命令是否成功执行",
      },
      permissions: ["wallet:write"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const code = typeof input.code === "string" ? input.code.trim() : "";
      if (!code) {
        return { ok: false, error: "缺少 code（开通流程验证码/授权码）", actorId };
      }
      const result = await walletFor(context, alipayBotService).bindWallet(code);
      return {
        ok: result.ok,
        actorId,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      };
    },
  };

  /** 4. 收银台支付 */
  const submit_payment: SkillDefinition = {
    metadata: {
      name: "alipay.submit-payment",
      version: "1.0.0",
      displayName: "提交支付宝收银台支付",
      description:
        "用收银台链接或订单串发起支付宝支付（从当前用户自己的钱包/账户扣款，用户手机确认）。sessionId 必填（当前会话 ID），paymentLink 为收银台链接（cashier*.alipay.com / qr.alipay.com 等），" +
        "intentSummary 格式：`服务内容：xxx，支付金额：¥xx，支付对象：xxx`。" +
        "支付前应先用 alipay.check-wallet 确认当前用户支付能力已开通。支付完成后可调用 alipay.query-payment 查询状态。",
      kind: "builtin",
      tags: ["alipay", "payment", "收银台", "支付", "付款", "买单"],
      icon: "🧾",
      parameters: [
        {
          name: "sessionId",
          type: "string",
          required: true,
          description: "真实业务会话 ID（UUID）",
        },
        {
          name: "paymentLink",
          type: "string",
          required: true,
          description: "支付宝收银台链接或订单串",
        },
        {
          name: "intentSummary",
          type: "string",
          required: true,
          description: "意图摘要：服务内容：xxx，支付金额：¥xx，支付对象：xxx",
        },
      ],
      outputSchema: {
        stdout: "CLI 原始输出（含订单号、支付方式链接）",
        media: "二维码图片文件路径列表",
        ok: "命令是否成功执行",
      },
      permissions: ["wallet:write"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : context.sessionId;
      const paymentLink = typeof input.paymentLink === "string" ? input.paymentLink.trim() : "";
      const intentSummary = typeof input.intentSummary === "string" ? input.intentSummary.trim() : "";
      if (!sessionId) {
        return { ok: false, error: "缺少 sessionId（当前会话 ID）", actorId };
      }
      if (!paymentLink) {
        return { ok: false, error: "缺少 paymentLink（收银台链接或订单串）", actorId };
      }
      if (!intentSummary) {
        return { ok: false, error: "缺少 intentSummary（意图摘要）", actorId };
      }
      const result = await walletFor(context, alipayBotService).submitPayment(sessionId, paymentLink, intentSummary);
      // 通用二维码推送：收银台/收款码二维码直接推到聊天流（best-effort）
      let payQrImageUrl: string | undefined;
      if (result.ok && qrAssist && Array.isArray(result.media) && result.media.length > 0) {
        payQrImageUrl =
          (await qrAssist.pushQrImage(
            context,
            { title: "请扫码完成支付宝支付", caption: intentSummary.slice(0, 60) },
            { filePath: String(result.media[0]) },
          )) ?? undefined;
      }
      return {
        ok: result.ok,
        actorId,
        stdout: result.stdout,
        stderr: result.stderr,
        media: result.media,
        error: result.error,
        ...(payQrImageUrl ? { qrImageUrl: payQrImageUrl } : {}),
      };
    },
  };

  /** 5. 查询支付状态 */
  const query_payment: SkillDefinition = {
    metadata: {
      name: "alipay.query-payment",
      version: "1.0.0",
      displayName: "查询支付宝支付状态",
      description:
        "查询当前用户收银台支付状态。outShakeNo（订单号/查询单号）与 launchUrl（支付方式链接）二选一。" +
        "用户在支付后询问「付了吗」「订单到哪了」「支付成功了吗」时调用。",
      kind: "builtin",
      tags: ["alipay", "payment", "查询", "订单", "状态"],
      icon: "🔍",
      parameters: [
        {
          name: "outShakeNo",
          type: "string",
          required: false,
          description: "订单号/查询单号（来自 submit 输出的对客标签）",
        },
        {
          name: "launchUrl",
          type: "string",
          required: false,
          description: "支付方式链接（无订单号时的回退查询入口）",
        },
      ],
      outputSchema: {
        stdout: "CLI 原始输出",
        ok: "命令是否成功执行",
      },
      permissions: ["wallet:read"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const outShakeNo = typeof input.outShakeNo === "string" ? input.outShakeNo.trim() : undefined;
      const launchUrl = typeof input.launchUrl === "string" ? input.launchUrl.trim() : undefined;
      if (!outShakeNo && !launchUrl) {
        return { ok: false, error: "缺少 outShakeNo 或 launchUrl（需要查询材料）", actorId };
      }
      const result = await walletFor(context, alipayBotService).queryPaymentStatus({ outShakeNo, launchUrl });
      return {
        ok: result.ok,
        actorId,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      };
    },
  };

  /** 6. HTTP 402 协议支付 */
  const pay_402: SkillDefinition = {
    metadata: {
      name: "alipay.pay-402",
      version: "1.0.0",
      displayName: "HTTP 402 协议支付",
      description:
        "当 HTTP 请求返回 402 Payment Required（响应头 Payment-Needed / amtPaymentLink）时，用此 skill 从当前用户自己的钱包完成买家支付。" +
        "sessionId 必填；amtPaymentLink（响应头原文）与 file（402 needed 文件路径）只能传一个；" +
        "resourceUrl 为触发 402 的原资源 URL。Payment-Needed 会被原样保存到本地后通过 -f 提交（官方 A2M 规范，禁止改写）；" +
        "intentSummary 必须用「原始请求：xxx」格式（来自触发 402 的用户请求，不得用账单/链接替代）。" +
        "支付成功后会自动重新请求资源并发送履约回执，可用 alipay.query-payment 相关流程查询状态。",
      kind: "builtin",
      tags: ["alipay", "payment", "402", "amtPaymentLink", "支付"],
      icon: "⚡",
      parameters: [
        {
          name: "sessionId",
          type: "string",
          required: true,
          description: "真实业务会话 ID（UUID）",
        },
        {
          name: "amtPaymentLink",
          type: "string",
          required: false,
          description: "402 响应头 amtPaymentLink 的值（与 file 互斥）",
        },
        {
          name: "file",
          type: "string",
          required: false,
          description: "Payment-Needed 待支付需求文件路径（与 amtPaymentLink 互斥）",
        },
        {
          name: "resourceUrl",
          type: "string",
          required: true,
          description: "触发 402 的原资源 URL（支付后重新请求履约）",
        },
        {
          name: "intentSummary",
          type: "string",
          required: true,
          description: "原始请求摘要，格式：原始请求：xxx",
        },
        {
          name: "method",
          type: "string",
          required: false,
          description: "原请求 HTTP method（POST 时与 data/header 一起传）",
        },
        {
          name: "data",
          type: "string",
          required: false,
          description: "原请求 POST body",
        },
        {
          name: "headers",
          type: "array",
          required: false,
          description: "原请求自定义 header 列表，格式 ['key:value', ...]",
        },
      ],
      outputSchema: {
        stdout: "CLI 原始输出",
        ok: "命令是否成功执行",
      },
      permissions: ["wallet:write"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : context.sessionId;
      const amtPaymentLink = typeof input.amtPaymentLink === "string" && input.amtPaymentLink.trim()
        ? input.amtPaymentLink.trim()
        : undefined;
      const file = typeof input.file === "string" && input.file.trim() ? input.file.trim() : undefined;
      const resourceUrl = typeof input.resourceUrl === "string" ? input.resourceUrl.trim() : "";
      const intentSummary = typeof input.intentSummary === "string" ? input.intentSummary.trim() : "";
      if (!sessionId) return { ok: false, error: "缺少 sessionId（当前会话 ID）", actorId };
      if (!resourceUrl) return { ok: false, error: "缺少 resourceUrl（触发 402 的资源 URL）", actorId };
      if (!intentSummary) return { ok: false, error: "缺少 intentSummary（原始请求摘要）", actorId };

      const headers = Array.isArray(input.headers)
        ? input.headers.filter((h): h is string => typeof h === "string")
        : [];
      const result = await walletFor(context, alipayBotService).pay402(sessionId, {
        amtPaymentLink,
        file,
        resourceUrl,
        intentSummary,
        method: typeof input.method === "string" && input.method.trim() ? input.method.trim() : undefined,
        data: typeof input.data === "string" ? input.data : undefined,
        headers,
      });
      return {
        ok: result.ok,
        actorId,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      };
    },
  };

  /** 7. 代理商家下单接口（像千问一样直接发起购买） */
  const proxy_trade: SkillDefinition = {
    metadata: {
      name: "alipay.proxy-trade",
      version: "1.0.0",
      displayName: "代理商家下单获取收银台链接",
      description:
        "调用商家的下单接口（HTTP 或 MCP），从响应中提取支付宝支付 payload（orderStr 订单串或收银台链接），" +
        "返回 alipay_ 别名。这是「直接发起购买」的关键第一步：agent 向商家下单拿到收银台链接后，" +
        "再用 alipay.submit-payment 从当前用户自己的钱包完成真实支付。用户表达「买一杯xxx」「下单购买」「帮我点奶茶」等意图，" +
        "且商家有下单接口时使用。protocol 必填（http/mcp），url 为商家下单接口地址；" +
        "HTTP 协议下可用 method/query/body/header 描述请求，MCP 协议下用 mcpMethod/params。",
      kind: "builtin",
      tags: ["alipay", "payment", "下单", "购买", "proxy", "trade", "收银台"],
      icon: "🛒",
      parameters: [
        { name: "protocol", type: "string", required: true, description: "协议：http（标准 HTTP 下单接口）或 mcp（MCP Streamable HTTP）" },
        { name: "url", type: "string", required: true, description: "商家下单接口 URL" },
        { name: "sessionId", type: "string", required: false, description: "业务会话 ID（默认取当前会话）" },
        { name: "extractPath", type: "string", required: false, description: "提取支付 payload 的 JSON 路径（默认 $.alipayMetadata.orderStr）" },
        { name: "payloadType", type: "string", required: false, description: "payload 类型：link / orderString / auto（默认 auto）" },
        { name: "method", type: "string", required: false, description: "HTTP method（默认 POST）" },
        { name: "query", type: "string", required: false, description: "查询参数（JSON 对象字符串）" },
        { name: "body", type: "string", required: false, description: "请求体（JSON 或纯文本）" },
        { name: "headers", type: "array", required: false, description: "请求头列表，格式 ['key:value', ...]" },
        { name: "mcpMethod", type: "string", required: false, description: "MCP JSON-RPC method（mcp 协议必填）" },
        { name: "params", type: "string", required: false, description: "MCP JSON-RPC params（JSON 对象或数组）" },
      ],
      outputSchema: {
        stdout: "CLI 原始输出（含 alipay_ 别名与提取到的收银台链接）",
        ok: "命令是否成功执行",
      },
      permissions: ["wallet:read", "wallet:write"],
      timeoutMs: 30_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const protocol = typeof input.protocol === "string" && (input.protocol === "http" || input.protocol === "mcp")
        ? input.protocol
        : undefined;
      const url = typeof input.url === "string" ? input.url.trim() : "";
      if (!protocol) return { ok: false, error: "缺少 protocol（http 或 mcp）", actorId };
      if (!url) return { ok: false, error: "缺少 url（商家下单接口地址）", actorId };
      const sessionId = typeof input.sessionId === "string" && input.sessionId.trim()
        ? input.sessionId.trim()
        : context.sessionId;
      const result = await walletFor(context, alipayBotService).proxyTradeRequest({
        protocol,
        url,
        sessionId,
        extractPath: typeof input.extractPath === "string" && input.extractPath.trim() ? input.extractPath.trim() : undefined,
        payloadType: input.payloadType === "link" || input.payloadType === "orderString" || input.payloadType === "auto"
          ? input.payloadType
          : undefined,
        method: typeof input.method === "string" && input.method.trim() ? input.method.trim() : undefined,
        query: typeof input.query === "string" ? input.query : undefined,
        body: typeof input.body === "string" ? input.body : undefined,
        headers: Array.isArray(input.headers)
          ? input.headers.filter((h): h is string => typeof h === "string")
          : undefined,
        mcpMethod: typeof input.mcpMethod === "string" && input.mcpMethod.trim() ? input.mcpMethod.trim() : undefined,
        params: typeof input.params === "string" ? input.params : undefined,
      });
      return {
        ok: result.ok,
        actorId,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      };
    },
  };

  return [check_wallet, apply_wallet, bind_wallet, submit_payment, query_payment, pay_402, proxy_trade];
}

/**
 * 注册支付宝支付内置 Skills 到 SkillManager。
 */
export function registerAlipayPaymentBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createAlipayPaymentBuiltinSkills(deps)) {
    register(s);
  }
}
