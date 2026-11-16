/**
 * 动作意图服务（ActionIntentService）——「通知即界面」的签发 / 验签 / 幂等执行。
 *
 * 核心职责：
 *   1. 签发：一条动作意图 → N 个按钮，每个按钮带一个**一次性 HMAC token**。
 *   2. 验签：客户端在通知栏点按钮后，把 token 原样回传服务端；服务端校验签名 +
 *      过期 + 归属，任何一项不过就拒绝执行（不猜、不放行）。
 *   3. 幂等：同一个 action 连点两次只执行一次（用户在通知栏猛点两下的现实）。
 *   4. 审计：每次执行都留下结果（lastResult），可回查「到底执行了什么」。
 *
 * 为什么 token 必须签名而不是直接传 intentId：
 *   intentId 是可猜的（`ai_<时间戳36>_<序号36>`）。只凭 intentId 就能执行动作，
 *   等于把「点通知栏按钮」变成「任何人 POST 一个 id 就能替你取消续费」。
 *   所以客户端拿到的是**带签名的短期凭据**，服务端只认签名。
 *
 * 签名算法：HMAC-SHA256(secret, base64url(JSON{i,a,e})) → base64url
 *   token = "ai1." + body + "." + sig
 *   e = 过期时间戳（ms），与 intent.expiresAt 同步
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ActionIntentStore,
  RISK_TTL_MS,
  type ActionIntent,
  type ActionIntentAction,
  type ActionRisk,
} from "./action-intent-store.js";

export type ActionExecutionResult = {
  ok: boolean;
  /** 回执文案：用户能看懂的一句话（"已取消自动续费"），不是错误码 */
  message: string;
  detail?: Record<string, unknown>;
};

export type ActionExecutorContext = {
  intent: ActionIntent;
  action: ActionIntentAction;
  actorId: string;
  /** kind=input 的动作，用户在通知栏内联输入的文字 */
  input?: string;
};

export type ActionExecutor = (
  ctx: ActionExecutorContext,
) => ActionExecutionResult | Promise<ActionExecutionResult>;

export type ActionIntentRegisterInput = {
  actorId: string;
  kind: string;
  title: string;
  body: string;
  summary?: string;
  risk?: ActionRisk;
  actions: ActionIntentAction[];
  /** 覆盖默认有效期（ms） */
  ttlMs?: number;
  deliveryId?: string;
};

export type ExecuteOutcome =
  | { ok: true; intent: ActionIntent; action: ActionIntentAction; result: ActionExecutionResult; alreadyExecuted: boolean }
  | { ok: false; error: string; code: string; intent?: ActionIntent };

/** 客户端可见的动作视图（含一次性 token） */
export type ClientAction = {
  actionId: string;
  label: string;
  kind: ActionIntentAction["kind"];
  token: string;
  inputLabel?: string;
  allowFreeFormInput?: boolean;
  inputChoices?: string[];
};

export type ClientActionIntent = {
  intentId: string;
  title: string;
  body: string;
  summary?: string;
  risk: ActionRisk;
  expiresAt: number;
  actions: ClientAction[];
};

/**
 * 读取/创建动作意图签名密钥。
 * 优先环境变量 ACTION_INTENT_SECRET；否则在 data 目录下生成一次性随机密钥落盘
 * （跨重启稳定——通知可能几小时后被点开，服务重启不该让按钮失效）。
 */
export function loadActionIntentSecret(keyPath: string): string {
  const fromEnv = process.env.ACTION_INTENT_SECRET?.trim();
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, "utf8").trim();
      if (existing.length >= 16) return existing;
    }
    const generated = randomBytes(32).toString("base64url");
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, generated, { mode: 0o600 });
    return generated;
  } catch {
    // 磁盘不可写：退化为进程内密钥（重启后旧 token 失效，可接受但不静默）
    console.warn("[ActionIntent] 无法持久化签名密钥，重启后已签发的通知按钮将失效");
    return randomBytes(32).toString("base64url");
  }
}

export class ActionIntentService {
  private readonly executors = new Map<string, ActionExecutor>();
  private readonly nowFn: () => number;

  constructor(
    private readonly deps: {
      store: ActionIntentStore;
      secret: string;
      nowFn?: () => number;
    },
  ) {
    this.nowFn = deps.nowFn ?? (() => Date.now());
  }

  /** 注册动作执行器（按 actionId 精确匹配） */
  registerExecutor(actionId: string, executor: ActionExecutor): void {
    this.executors.set(actionId, executor);
  }

  /**
   * 登记一条动作意图，并为每个动作签发一次性 token。
   * 返回给调用方的 intent 里**不含 token**（token 只在渲染视图里出现）。
   */
  register(input: ActionIntentRegisterInput): ActionIntent {
    const risk = input.risk ?? "L0";
    const createdAt = this.nowFn();
    const ttl = input.ttlMs ?? RISK_TTL_MS[risk];
    return this.deps.store.register({
      actorId: input.actorId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      ...(input.summary ? { summary: input.summary } : {}),
      risk,
      actions: input.actions,
      createdAt,
      expiresAt: createdAt + ttl,
      state: "pending",
      executedActions: [],
      ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    });
  }

  /** 签发 token：ai1.<body>.<sig> */
  issueToken(intent: ActionIntent, action: ActionIntentAction): string {
    const body = Buffer.from(
      JSON.stringify({ i: intent.intentId, a: action.actionId, e: intent.expiresAt }),
      "utf8",
    ).toString("base64url");
    const sig = createHmac("sha256", this.deps.secret).update(body).digest("base64url");
    return `ai1.${body}.${sig}`;
  }

  /**
   * 渲染给客户端的视图：每个动作带上它自己的一次性 token。
   * 聊天卡与通知栏用的是**同一份**这个视图——两个渲染面，同一真相源。
   */
  renderForClient(intent: ActionIntent): ClientActionIntent {
    return {
      intentId: intent.intentId,
      title: intent.title,
      body: intent.body,
      ...(intent.summary ? { summary: intent.summary } : {}),
      risk: intent.risk,
      expiresAt: intent.expiresAt,
      actions: intent.actions.map((a) => ({
        actionId: a.actionId,
        label: a.label,
        kind: a.kind,
        token: this.issueToken(intent, a),
        ...(a.inputLabel ? { inputLabel: a.inputLabel } : {}),
        ...(a.allowFreeFormInput !== undefined ? { allowFreeFormInput: a.allowFreeFormInput } : {}),
        ...(a.inputChoices?.length ? { inputChoices: a.inputChoices } : {}),
      })),
    };
  }

  /** 验签：返回 intent + action，或失败原因 */
  verify(
    token: string,
  ): { intent: ActionIntent; action: ActionIntentAction } | { error: string; code: string; intent?: ActionIntent } {
    const raw = String(token ?? "").trim();
    if (!raw) return { error: "缺少 token", code: "missing_token" };
    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== "ai1") {
      return { error: "token 格式不对", code: "bad_token" };
    }
    const [, body, sig] = parts;
    const expected = createHmac("sha256", this.deps.secret).update(body).digest("base64url");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { error: "token 签名不匹配", code: "bad_signature" };
    }
    let parsed: { i?: string; a?: string; e?: number };
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        i?: string;
        a?: string;
        e?: number;
      };
    } catch {
      return { error: "token 内容解析失败", code: "bad_token" };
    }
    if (!parsed.i || !parsed.a) return { error: "token 缺少字段", code: "bad_token" };
    const intent = this.deps.store.get(parsed.i);
    if (!intent) return { error: "意图不存在或已清理", code: "intent_not_found" };
    if (intent.expiresAt <= this.nowFn()) {
      return { error: "这条通知已经过期了", code: "expired", intent };
    }
    if (intent.state === "cancelled") {
      return { error: "这件事已经不需要处理了", code: "cancelled", intent };
    }
    const action = intent.actions.find((x) => x.actionId === parsed.a);
    if (!action) return { error: "动作不存在", code: "action_not_found", intent };
    return { intent, action };
  }

  /**
   * 执行一个动作（通知栏按钮 → 这里）。
   * 顺序：验签 → 过期 → 幂等 → 执行器 → 落审计。
   * 幂等命中时返回 ok=true + alreadyExecuted=true（不是错误——用户点两次不算失败）。
   */
  async execute(
    token: string,
    opts: { input?: string; actorId?: string } = {},
  ): Promise<ExecuteOutcome> {
    const verified = this.verify(token);
    if ("error" in verified) {
      return { ok: false, error: verified.error, code: verified.code, ...(verified.intent ? { intent: verified.intent } : {}) };
    }
    const { intent, action } = verified;

    // 归属校验：带 actorId 时必须与意图归属一致（防止把 A 的 token 用在 B 的请求里）
    const actorId = opts.actorId?.trim();
    if (actorId && actorId !== intent.actorId) {
      return { ok: false, error: "这个动作不属于当前账号", code: "actor_mismatch", intent };
    }

    // 幂等：这条决策已经拍过板 → 不再执行第二个动作
    // （同一批按钮是互斥决策：拍完"好就这么办"就不能再"稍后再说"）
    if (intent.state === "executed" || intent.executedActions.includes(action.actionId)) {
      const last = intent.lastResult;
      if (last && last.ok === false) {
        // 上次执行失败过：如实回报失败，不谎报成功（但也不算重复执行）
        return {
          ok: false,
          error: last.message,
          code: "action_failed",
          intent,
        };
      }
      return {
        ok: true,
        intent,
        action,
        alreadyExecuted: true,
        result: {
          ok: true,
          message: last?.message ?? "这件事你已经拍过板了",
        },
      };
    }

    const executor = this.executors.get(action.actionId);
    if (!executor) {
      return {
        ok: false,
        error: `这个动作暂时没有可执行的通道：${action.actionId}`,
        code: "no_executor",
        intent,
      };
    }

    let result: ActionExecutionResult;
    try {
      result = await executor({
        intent,
        action,
        actorId: intent.actorId,
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { ok: false, message: `执行失败：${message}` };
    }

    this.deps.store.markExecuted(intent.intentId, action.actionId, {
      ok: result.ok,
      message: result.message,
    });
    const updated = this.deps.store.get(intent.intentId) ?? intent;
    if (!result.ok) {
      // 执行器明确失败：如实回报（客户端会把这句话显示给用户，不假装成功）
      return { ok: false, error: result.message, code: "action_failed", intent: updated };
    }
    return { ok: true, intent: updated, action, result, alreadyExecuted: false };
  }

  get(intentId: string): ActionIntent | undefined {
    return this.deps.store.get(intentId);
  }
}
