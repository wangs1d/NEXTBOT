// HTTP 路由：统一主动性管道的诊断/结果回传 + 移动端推送通道注册（docs/proactivity-architecture.md §4）
//
// GET  /api/proactivity/diagnostics —— "为什么发/为什么没发"全程可解释：
//       待发提案、最近 30 条仲裁决策（verdict + reasonChain）、outcome、预算用量、在场。
// POST /api/proactivity/outcome —— 客户端回传触达结果（accepted/dismissed/...），
//       回灌自适应冷却：连续忽略的 kind 自动降频，高接受率自动回升。
// POST/DELETE /api/proactivity/push/register —— 客户端上报/注销推送 token（provider + token）。
// GET  /api/proactivity/push/status —— 已配置 provider 与各 actor 注册的 token 概览。
// POST /api/proactivity/push/test —— 给指定 actor 发一条测试推送（验证通道连通）。
import type { FastifyInstance } from "fastify";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveActorId } from "../../agent/actor-id.js";
import type { ProactivePipeline } from "../../proactivity/proactive-pipeline.js";
import type { MobilePushService } from "../../proactivity/mobile-push-service.js";
import type { ProactivitySuppressionStore } from "../../proactivity/suppression-store.js";
import type { ProactiveOutcome } from "../../proactivity/pipeline-types.js";

const ALLOWED_OUTCOMES = new Set<ProactiveOutcome>([
  "delivered",
  "viewed",
  "accepted",
  "dismissed",
  "snoozed",
  "ignored",
  "replied",
]);

const ALLOWED_PUSH_PROVIDERS = new Set(["huawei", "jpush", "bark", "webhook"]);

/** 用户语义化反馈动作（一键"太多了/别推这个"直通频控与静音表） */
const ALLOWED_FEEDBACK_ACTIONS = new Set(["too_many", "mute_topic", "resume_topic", "like"]);

/** 允许被反馈静音的触达类别：与抑制表路由白名单对齐 + 简报系 kind
 *  （greeting 仍被晨间简报 proposalKind 使用，不可删） */
const FEEDBACK_SUPPRESSIBLE_KINDS = new Set([
  "greeting",
  "interest_share",
  "interest_alert",
  "followup",
  "task_celebration",
  "overwork_care",
  "weather_alert",
  "life_reminder",
  "monthly_report",
  "digest",
  "morning_briefing",
]);

export type ProactivityFabricDeps = {
  /** 树枝配置面（2026-10-22 树状架构 Phase 3）：信息源树枝清单/启停/精简预算 */
  branches?: () => unknown;
  branchSetConfig?: (patch: { id: string; enabled?: boolean; condense?: boolean; dailyBudget?: number }) => unknown;
  /** 盯梢任务面板（Muse 对齐件）：列表/删除/启停（创建走对话 watch.manage 工具） */
  watchTasks?: (actorId?: string) => unknown;
  watchTaskRemove?: (actorId: string, id: string) => unknown;
  watchTaskSetActive?: (actorId: string, id: string, active: boolean) => unknown;
  /** 传感器健康快照（L1） */
  sensorHealth: () => unknown;
  /** 跨源统一采集库健康（2026-10-10）：窗口条数 / 各 stream 计数 / 实体索引规模 */
  sourceStats?: () => unknown;
  /** 跨源实体检索（"提到三亚的所有来源"）——Muse「汇聚」价值的查询面 */
  sourceFind?: (entity: string, opts?: { since?: number; streams?: string[]; limit?: number }) => unknown;
  /**
   * 票务邮件规则漏检埋点（2026-10-11）：预筛判定"像票务"但规则零产出 → 计数 + 最近样本。
   * 回答"规则漏了多少、漏的邮件长什么样"，是评估"要不要上 LLM 兜底"的数据面。
   */
  mailTicketMissStats?: () => unknown;
  /** 目标自驱循环状态（GoalRunner）：是否启用/扫描间隔/跟踪目标数 */
  goalRunnerStatus?: () => unknown;
  /** Goal 成本-产出报告（2026-10-19）：按 kind 的目标数/步骤数/达成率 + goal stage token 占比 */
  goalCost?: (actorId?: string) => unknown;
  /** Goal 夜间内省（确定性）：闲置/显著度/partial 验收 → 需要开口的 finding */
  goalIntrospect?: (actorId: string) => unknown;
  /** 在办事项统一视图（goal + 承诺只读合并）：前端「在办目标」面板的数据面 */
  goalView?: (actorId: string) => unknown;
  /** 节律采样链健康（睡眠/桌面/屏幕条件化传感器是否还在产出观察） */
  rhythmHealth?: () => unknown;
  /** 当前仲裁快照 + 预览裁决（L3） */
  arbiterPreview: () => unknown;
  /** 目标板统计（L4） */
  goalStats: () => unknown;
  /**
   * P3 自诊断（2026-10-01）：按 actor 输出「为什么没说话」分层计数——
   * 活跃判定/状态板/事件/提案/投递各层最新数据，主动性健康一查即知。
   */
  whySilent?: (actorId?: string) => Record<string, unknown>;
  /**
   * 邮件反应链测试注入（2026-10-01）：模拟邮件走真实 handleIncoming 链
   * （分级→主动提醒→票务日程桥→消息中心），只跳过 IMAP 拉取（需授权码）。
   */
  mailTestInject?: (mail: {
    actorId?: string;
    from: string;
    subject: string;
    text: string;
    uid?: number;
    source?: Buffer;
  }) => Promise<{ importance: string; reasons: string[] }>;
  /** 邮箱接入状态（设置页；诚实反映自动接入/授权码/轮询态） */
  mailWatchStatus?: () => unknown;
  /** 授权码提交（设置页）：即刻配置并尝试启动轮询，返回启动后状态 */
  mailWatchApplyPass?: (pass: string) => unknown;
  /** 成本校准快照（接受率 → alert 阈值） */
  calibration?: () => unknown;
  /** 评估器探针（L2：id/订阅流/状态键） */
  evaluatorProbes?: () => unknown;
  /** outcome 回灌桥（CostCalibrator.observe） */
  observeOutcome?: (outcome: string) => void;
  /** 主动话术生成器状态（内容型场景 LLM 用量） */
  phraseStats?: () => unknown;
  /** 主动呼叫器状态（通话轮次/冷却） */
  callStats?: () => unknown;
  /** 自检来电（?call=1 实拨一通测试电话验证呼叫闭环） */
  testCall?: (actorId: string) => Promise<unknown> | unknown;
  /** 设备信号上行（家居/手机/可穿戴 → 传感层 feeder） */
  emitDeviceSignal?: (input: {
    actorId: string;
    sensorId: string;
    kind: string;
    fingerprint?: string;
    salience?: "high" | "medium" | "low";
    payload?: Record<string, unknown>;
    at?: number;
  }) => { ok: boolean; deduped?: boolean; error?: string };
  /** 真实链路自检：fire=true 时实际投递一条测试消息 */
  selftest: (fire: boolean) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export function registerProactivityPipelineRoutes(
  app: FastifyInstance,
  deps: {
    pipeline: ProactivePipeline | null;
    pushService?: MobilePushService | null;
    fabric?: ProactivityFabricDeps | null;
    suppressionStore?: ProactivitySuppressionStore | null;
  },
): void {
  const pipeline = deps.pipeline;

  // ─── 树枝配置面（2026-10-22 树状架构 Phase 3）───
  // GET  /api/proactivity/branches —— 信息源树枝清单（manifest+用户配置）+ 精简器用量。
  // POST /api/proactivity/branches/config —— 动态启停 / 开关 L3 精简 / 调每日预算。
  //        写穿 data/proactivity/branches.json，即刻生效无需重启。
  app.get("/api/proactivity/branches", async () => {
    if (!deps.fabric?.branches) return { ok: false, error: "树枝配置面未装配" };
    return { ok: true, ...(deps.fabric.branches() as Record<string, unknown>) };
  });

  app.post("/api/proactivity/branches/config", async (request, reply) => {
    if (!deps.fabric?.branchSetConfig) return { ok: false, error: "树枝配置面未装配" };
    const body = (request.body ?? {}) as {
      id?: string;
      enabled?: boolean;
      condense?: boolean;
      dailyBudget?: number;
    };
    const id = String(body.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "id required" });
    if (
      body.enabled === undefined &&
      body.condense === undefined &&
      body.dailyBudget === undefined
    ) {
      return reply.code(400).send({ ok: false, error: "至少提供 enabled / condense / dailyBudget 之一" });
    }
    return deps.fabric.branchSetConfig({
      id,
      ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      ...(body.condense !== undefined ? { condense: body.condense === true } : {}),
      ...(body.dailyBudget !== undefined ? { dailyBudget: Number(body.dailyBudget) } : {}),
    }) as Record<string, unknown>;
  });

  // ─── 盯梢任务面板（2026-10-22 Muse 对齐件）───
  // GET  /api/proactivity/watch-tasks?actorId= —— 列表（创建走对话内 watch.manage 工具）
  // POST /api/proactivity/watch-tasks/config —— remove / pause / resume
  app.get("/api/proactivity/watch-tasks", async (request) => {
    if (!deps.fabric?.watchTasks) return { ok: false, error: "盯梢任务面未装配" };
    const q = request.query as { actorId?: string };
    return { ok: true, ...(deps.fabric.watchTasks(q.actorId?.trim() || undefined) as Record<string, unknown>) };
  });

  app.post("/api/proactivity/watch-tasks/config", async (request, reply) => {
    if (!deps.fabric?.watchTaskRemove || !deps.fabric.watchTaskSetActive) {
      return { ok: false, error: "盯梢任务面未装配" };
    }
    const body = (request.body ?? {}) as { id?: string; actorId?: string; action?: string };
    const id = String(body.id ?? "").trim();
    const actorId = String(body.actorId ?? "").trim();
    const action = String(body.action ?? "").trim();
    if (!id || !actorId) return reply.code(400).send({ ok: false, error: "id / actorId required" });
    if (action === "remove") return deps.fabric.watchTaskRemove(actorId, id);
    if (action === "pause") return deps.fabric.watchTaskSetActive(actorId, id, false);
    if (action === "resume") return deps.fabric.watchTaskSetActive(actorId, id, true);
    return reply.code(400).send({ ok: false, error: "action 可选：remove / pause / resume" });
  });

  // ─── Goal 成本-产出 / 夜间内省（2026-10-19）───
  // 放在 pipeline 守卫之前：成本面与内省是否可用，不该取决于主动性管道装没装。
  app.get("/api/proactivity/goals/cost", async (request) => {
    if (!deps.fabric?.goalCost) return { ok: false, error: "goal 成本面未装配" };
    const q = request.query as { actorId?: string };
    const actorId = q.actorId?.trim() || undefined;
    return { ok: true, report: deps.fabric.goalCost(actorId) };
  });

  app.get("/api/proactivity/goals/introspect", async (request, reply) => {
    const q = request.query as { actorId?: string };
    const actorId = q.actorId?.trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!deps.fabric?.goalIntrospect) return { ok: false, error: "goal 内省未装配" };
    return { ok: true, actorId, findings: deps.fabric.goalIntrospect(actorId) };
  });

  // 在办事项统一视图（2026-10-19）：goal（goals.json）+ 承诺（SQLite）只读合并，
  // 前端「在办目标」面板与干预入口共用一个口子。
  app.get("/api/proactivity/goals/view", async (request, reply) => {
    const q = request.query as { actorId?: string };
    const actorId = q.actorId?.trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!deps.fabric?.goalView) return { ok: false, error: "在办视图未装配" };
    return { ok: true, actorId, view: deps.fabric.goalView(actorId) };
  });

  if (!pipeline) return;

  // 诊断快照。可选查询参数（沉默决策反问）：
  //   ?silenceKeyword=体检&silenceDays=7 → 附加 silenceSearch（效用评估沉默留痕检索）
  app.get("/api/proactivity/diagnostics", async (request) => {
    const result: Record<string, unknown> = { ok: true, ...pipeline.diagnostics() };
    const q = request.query as { silenceKeyword?: string; silenceDays?: string };
    if (q.silenceKeyword?.trim() || q.silenceDays) {
      const days = Math.max(1, Math.min(90, Number(q.silenceDays) > 0 ? Number(q.silenceDays) : 7));
      result.silenceSearch = pipeline.searchSilences({
        keyword: q.silenceKeyword?.trim() || undefined,
        sinceMs: Date.now() - days * 24 * 60 * 60 * 1000,
        limit: 20,
      });
    }
    return result;
  });

  app.post("/api/proactivity/outcome", async (request, reply) => {
    const body = (request.body ?? {}) as { deliveryId?: string; outcome?: string };
    const deliveryId = String(body.deliveryId ?? "").trim();
    const outcome = String(body.outcome ?? "").trim() as ProactiveOutcome;
    if (!deliveryId) return reply.code(400).send({ ok: false, error: "deliveryId required" });
    if (!ALLOWED_OUTCOMES.has(outcome)) {
      return reply.code(400).send({
        ok: false,
        error: `未知 outcome「${outcome}」，可选：${[...ALLOWED_OUTCOMES].join(", ")}`,
      });
    }
  const applied = pipeline.recordOutcome(deliveryId, outcome);
  if (!applied) return reply.code(404).send({ ok: false, error: "deliveryId not found" });
  deps.fabric?.observeOutcome?.(outcome);
  return { ok: true, deliveryId, outcome };
});

  // 用户语义化反馈：一键"太多了 / 这个话题别再推 / 喜欢"→ 频控自适应 + 话题静音。
  //   deliveryId 优先（主动消息卡片自带）；简报等无 deliveryId 的投递物用 kind + actorId。
  //   too_many / like → 自适应冷却（负反馈冷却×1.5、正反馈回落）；
  //   mute_topic / resume_topic → 抑制表（仲裁器与 Hub 发送前都会检查）。
  app.post("/api/proactivity/feedback", async (request, reply) => {
    const body = (request.body ?? {}) as {
      deliveryId?: string;
      actorId?: string;
      kind?: string;
      action?: string;
      keywords?: unknown;
      note?: string;
      target?: string;
    };
    const action = String(body.action ?? "").trim();
    if (!ALLOWED_FEEDBACK_ACTIONS.has(action)) {
      return reply.code(400).send({
        ok: false,
        error: `未知 action「${action}」，可选：${[...ALLOWED_FEEDBACK_ACTIONS].join(", ")}`,
      });
    }
    const deliveryId = String(body.deliveryId ?? "").trim();
    let actorId = String(body.actorId ?? "").trim();
    let kind = String(body.kind ?? "").trim();
    if (deliveryId) {
      const record = pipeline.describeDelivery(deliveryId);
      if (!record) {
        return reply.code(404).send({ ok: false, error: "deliveryId not found" });
      }
      actorId = actorId || record.actorId;
      kind = kind || record.kind;
    }
    if (!kind) return reply.code(400).send({ ok: false, error: "kind required（或提供 deliveryId）" });

    const suppression = deps.suppressionStore ?? null;
    const suppressible = FEEDBACK_SUPPRESSIBLE_KINDS.has(kind);
    const applied: Record<string, unknown> = {};

    if (action === "too_many" || action === "like") {
      // 频控自适应：有投递记录走完整 outcome 状态机；否则直接回灌冷却
      const positive = action === "like";
      if (deliveryId) {
        applied.outcomeRecorded = pipeline.recordOutcome(
          deliveryId,
          positive ? "accepted" : "dismissed",
        );
      } else {
        pipeline.noteKindFeedback(kind, positive);
        applied.cooldownAdjusted = true;
      }
    }

    if (action === "mute_topic" || action === "resume_topic") {
      if (!actorId) {
        return reply.code(400).send({ ok: false, error: "actorId required for topic actions" });
      }
      if (!suppression) {
        return reply.code(503).send({ ok: false, error: "suppression store not wired" });
      }
      if (!suppressible) {
        return reply.code(400).send({
          ok: false,
          error: `类别「${kind}」暂不支持话题静音，可选：${[...FEEDBACK_SUPPRESSIBLE_KINDS].join(", ")}`,
        });
      }
      if (action === "mute_topic") {
        const keywords = Array.isArray(body.keywords)
          ? body.keywords.map((k) => String(k).trim()).filter(Boolean)
          : [];
        applied.suppressions = await suppression.add(actorId, kind, keywords, body.note);
        // 静音本身也是一次负反馈，同步回灌冷却
        if (deliveryId) pipeline.recordOutcome(deliveryId, "dismissed");
        else pipeline.noteKindFeedback(kind, false);
      } else {
        applied.suppressions = await suppression.remove(actorId, String(body.target ?? "").trim() || kind);
      }
    }

    return { ok: true, action, actorId: actorId || undefined, kind, ...applied };
  });

  // ─── 五层主动性架构观测端点 ───
  // GET /api/proactivity/sensors —— L1 传感层健康面板：谁活着、谁熔断、最近产出
  app.get("/api/proactivity/sensors", async () => {
    if (!deps.fabric) return { ok: false, error: "fabric not wired" };
    return {
      ok: true,
      sensors: deps.fabric.sensorHealth(),
      goals: deps.fabric.goalStats(),
      // 目标自驱循环（GoalRunner）：无人对话时 goal 是否在后台推进
      goalRunner: deps.fabric.goalRunnerStatus?.() ?? null,
      // 跨源统一采集库（"自己的数据库"）：外线信源收编后与内线同池
      sources: deps.fabric.sourceStats?.() ?? null,
      // 票务邮件规则漏检埋点：预筛命中却零产出的计数与样本（0 表示规则没漏）
      mailTicketMiss: deps.fabric.mailTicketMissStats?.() ?? null,
      // 节律采样链健康（rhythm 未启用时为 null）：per-sensor 计数 + stalled 红点
      rhythm: deps.fabric.rhythmHealth?.() ?? null,
    };
  });

  // GET /api/proactivity/sources/find?entity=三亚 —— 跨源实体检索：
  // 一次返回**所有来源**里提到该实体的条目（邮件航班+日历行程+账单酒店可拼图）。
  // 这是 Muse「跨源汇聚」价值的直接查询面，替代过去"逐个服务去问"。
  app.get("/api/proactivity/sources/find", async (request) => {
    if (!deps.fabric?.sourceFind) return { ok: false, error: "sourceFind not wired" };
    const q = request.query as { entity?: string; since?: string; streams?: string; limit?: string };
    const entity = q.entity?.trim();
    if (!entity) return { ok: false, error: "entity required" };
    const streamsArg = q.streams?.split(",").map((s) => s.trim()).filter(Boolean);
    return {
      ok: true,
      entity,
      hits: deps.fabric.sourceFind(entity, {
        ...(q.since ? { since: Number(q.since) } : {}),
        ...(streamsArg && streamsArg.length ? { streams: streamsArg } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    };
  });

  // P3 自诊断（2026-10-01）：「主动性到底干没干活 / 为什么没说话」——
  // 按 actor 输出活跃判定、状态板当下层、事件/提案/投递计数与最近痕迹。
  app.get("/api/proactivity/why-silent", async (request) => {
    if (!deps.fabric?.whySilent) return { ok: false, error: "whySilent not wired" };
    const q = request.query as { actorId?: string };
    return {
      ok: true,
      ...(deps.fabric.whySilent(q.actorId?.trim() || undefined) as Record<string, unknown>),
    };
  });

  // 邮件反应链测试注入口（2026-10-01）：一封模拟邮件走真实 handleIncoming 链
  // （重要性分级 → 主动提醒 → 票务日程桥 → 消息中心落库），与 IMAP 轮询取到
  // 真邮件后的路径完全一致——只跳过 IMAP 拉取本身（需授权码）。
  // 正文按 RFC822 组装成原始 MIME（utf-8 base64），票务桥吃的 source 与真邮件同构。
  // 诊断/验收用：POST /api/proactivity/mail/test {from, subject, text, actorId?}
  app.post("/api/proactivity/mail/test", async (request, reply) => {
    const inject = deps.fabric?.mailTestInject;
    if (!inject) return reply.code(503).send({ ok: false, error: "mailTestInject not wired" });
    const body = (request.body ?? {}) as {
      from?: string;
      subject?: string;
      text?: string;
      actorId?: string;
    };
    if (!body.from || !body.subject) {
      return reply.code(400).send({ ok: false, error: "from / subject required" });
    }
    const source = Buffer.from(
      [
        `From: ${body.from}`,
        `To: user@example.com`,
        `Subject: ${body.subject}`,
        `Date: ${new Date().toUTCString()}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
        Buffer.from(body.text ?? "", "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
      ].join("\r\n"),
      "utf8",
    );
    const classification = await inject({
      actorId: body.actorId?.trim() || undefined,
      from: body.from,
      subject: body.subject,
      text: body.text ?? "",
      uid: Date.now(),
      source,
    });
    return { ok: true, classification };
  });

  // 邮箱接入状态（设置页「邮箱盯梢」块数据源）：诚实反映自动接入/授权码/轮询态
  app.get("/api/mail-watch/status", async () => {
    const status = deps.fabric?.mailWatchStatus;
    if (!status) return { ok: false, error: "mailWatchStatus not wired" };
    return { ok: true, status: status() };
  });

  // 授权码提交（设置页填 IMAP 授权码）：写进 MailWatchService 即刻尝试启动轮询。
  // 注意：本进程内生效；持久化由客户端写 config.env（MAIL_WATCH_PASS），重启后
  // 由 runtime 环境注入回来——服务端不落盘明文授权码。
  app.post("/api/mail-watch/pass", async (request, reply) => {
    const applyPass = deps.fabric?.mailWatchApplyPass;
    if (!applyPass) return reply.code(503).send({ ok: false, error: "mailWatchApplyPass not wired" });
    const body = (request.body ?? {}) as { pass?: string };
    const pass = String(body.pass ?? "").trim();
    if (!pass) return reply.code(400).send({ ok: false, error: "pass required" });
    const result = applyPass(pass);
    return { ok: true, ...(result as Record<string, unknown>) };
  });

  // GET /api/proactivity/selftest —— 一键链路自检：上下文快照 + 打断成本 + 裁决预览。
  //   ?fire=1 实际投递一条测试消息（验证直达车道端到端可用）
  app.get("/api/proactivity/selftest", async (request) => {
    const q = request.query as { fire?: string; call?: string };
    const fire = q.fire === "1";
    if (!deps.fabric) return { ok: false, error: "fabric not wired" };
    const base = (await deps.fabric.selftest(fire)) as Record<string, unknown>;
    if (q.call === "1") {
      const actorId = String(base.actorId ?? "local_user");
      base.testCall = deps.fabric.testCall
        ? await deps.fabric.testCall(actorId)
        : { ok: false, error: "testCall not wired" };
    }
    return { ok: true, ...base };
  });

  // POST /api/proactivity/device-signal —— 物理设备信号统一上行入口
  // （Flutter 端 WS 复用同一 payload 结构；家居网关/脚本/第三方直接 POST）
  app.post("/api/proactivity/device-signal", async (request, reply) => {
    const emit = deps.fabric?.emitDeviceSignal;
    if (!emit) return reply.code(503).send({ ok: false, error: "fabric not wired" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const actorId = String(body.actorId ?? "").trim();
    const sensorId = String(body.sensorId ?? "").trim();
    const kind = String(body.kind ?? "").trim();
    if (!actorId || !sensorId || !kind) {
      return reply.code(400).send({ ok: false, error: "actorId / sensorId / kind required" });
    }
    const result = emit({
      actorId,
      sensorId,
      kind,
      ...(typeof body.fingerprint === "string" ? { fingerprint: body.fingerprint } : {}),
      ...(body.salience === "high" || body.salience === "medium" || body.salience === "low"
        ? { salience: body.salience }
        : {}),
      ...(body.payload && typeof body.payload === "object" ? { payload: body.payload as Record<string, unknown> } : {}),
      ...(typeof body.at === "number" ? { at: body.at } : {}),
    });
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  const pushService = deps.pushService ?? null;

  app.post("/api/proactivity/push/register", async (request, reply) => {
    if (!pushService) return reply.code(503).send({ ok: false, error: "push service not wired" });
    const body = (request.body ?? {}) as { actorId?: string; provider?: string; token?: string; deviceId?: string; err?: string };
    const actorId = String(body.actorId ?? "").trim();
    const provider = String(body.provider ?? "").trim();
    // 设备侧诊断（2026-10-14）：token 拿不到时客户端把 HMS 报错带上来落日志，
    // 便于远程定位（无 token 不进注册表；放在 actorId 校验之前——未登录时
    // actorId 可能为空，同样要留痕）
    if (!body.token?.trim()) {
      const errLine = `${new Date().toISOString()} actor=${actorId || "(empty)"} provider=${provider || "?"} err=${String(body.err ?? "token missing").slice(0, 300)}\n`;
      try {
        const diagDir = join(process.cwd(), "data", "debug");
        mkdirSync(diagDir, { recursive: true });
        appendFileSync(join(diagDir, "push-register-errors.log"), errLine);
      } catch {
        /* 落盘失败不影响响应 */
      }
      return { ok: false, logged: true, error: "token missing (diag logged)" };
    }
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!ALLOWED_PUSH_PROVIDERS.has(provider)) {
      return reply.code(400).send({
        ok: false,
        error: `未知 provider「${provider}」，可选：${[...ALLOWED_PUSH_PROVIDERS].join(", ")}`,
      });
    }
    const entries = pushService.register(actorId, { provider, token: body.token?.trim() || undefined, deviceId: body.deviceId?.trim() || undefined });
    return { ok: true, actorId, entries };
  });

  app.delete("/api/proactivity/push/register", async (request) => {
    if (!pushService) return { ok: false, error: "push service not wired" };
    const body = (request.body ?? {}) as { actorId?: string; provider?: string; token?: string };
    const actorId = String(body.actorId ?? "").trim();
    if (!actorId) return { ok: false, error: "actorId required" };
    const entries = pushService.unregister(actorId, String(body.provider ?? "").trim(), body.token?.trim() || undefined);
    return { ok: true, actorId, entries };
  });

  app.get("/api/proactivity/push/status", async () => {
    if (!pushService) return { ok: false, providers: [], error: "push service not wired" };
    return {
      ok: true,
      configuredProviders: pushService.configuredProviders(),
      tokens: pushService.listAll().map(([actorId, entries]) => ({ actorId, count: entries.length, providers: entries.map((e) => e.provider) })),
    };
  });

  app.post("/api/proactivity/push/test", async (request, reply) => {
    if (!pushService) return reply.code(503).send({ ok: false, error: "push service not wired" });
    const body = (request.body ?? {}) as { actorId?: string };
    const actorId = String(body.actorId ?? "").trim();
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    if (!pushService.hasChannel(actorId)) {
      return reply.code(409).send({
        ok: false,
        error: "该 actor 无可用推送通道：未注册 token 或 provider 未配置（检查 JPUSH_APP_KEY 等环境变量）",
      });
    }
    const result = await pushService.push({
      actorId,
      title: "推送通道测试",
      body: "这是一条测试推送：两端都不在线时，日程与重要提醒会通过这条通道送到你手机上。",
      importance: "high",
      kind: "push_test",
      deliveryId: `test_${Date.now().toString(36)}`,
    });
    return { ok: result.ok, provider: result.provider, reason: result.reason };
  });
}

/**
 * 自主性设置路由（GET/PUT /api/autonomy）：
 *   GET  ?userId=&sessionId=            → { level, dndUntil }
 *   PUT  { level?, dndUntil? }          → 更新并返回新设置
 * level: 0=只建议 1=标准 2=高效；dndUntil: epoch ms（0=关闭勿扰）。
 */
export function registerAutonomyRoutes(
  app: FastifyInstance,
  deps: {
    autonomySettings: { get: (actorId: string) => { level: number; dndUntil: number }; setLevel: (actorId: string, level: 0 | 1 | 2) => { level: number; dndUntil: number }; setDnd: (actorId: string, untilMs: number) => { level: number; dndUntil: number } } | null;
  },
): void {
  if (!deps.autonomySettings) return;

  app.get("/api/autonomy", async (request) => {
    const query = request.query as { userId?: string; sessionId?: string };
    const actorId = resolveActorId({ userId: query.userId, sessionId: query.sessionId ?? "" });
    const settings = deps.autonomySettings!.get(actorId);
    return { ok: true, actorId, ...settings };
  });

  app.put("/api/autonomy", async (request, reply) => {
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string; level?: number; dndUntil?: number };
    const actorId = resolveActorId({ userId: body.userId ?? "", sessionId: body.sessionId ?? "" });
    if (!actorId) return reply.code(400).send({ ok: false, error: "actorId required" });
    let settings: { level: number; dndUntil: number } = deps.autonomySettings!.get(actorId);
    if (body.level !== undefined) {
      const level = Number(body.level);
      if (![0, 1, 2].includes(level)) {
        return reply.code(400).send({ ok: false, error: "level 必须是 0（只建议）/ 1（标准）/ 2（高效）" });
      }
      settings = deps.autonomySettings!.setLevel(actorId, level as 0 | 1 | 2);
    }
    if (body.dndUntil !== undefined) {
      const until = Number(body.dndUntil);
      if (!Number.isFinite(until) || until < 0) {
        return reply.code(400).send({ ok: false, error: "dndUntil 必须是非负 epoch 毫秒（0=关闭勿扰）" });
      }
      settings = deps.autonomySettings!.setDnd(actorId, until);
    }
    return { ok: true, actorId, ...settings };
  });
}
