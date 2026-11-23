// 移动端推送通道（MobilePushService）—— 管道的离线必达升级通道。
//
// 投递模型：WS 在线直推（电脑端+手机端 fan-out）优先；两端都不在线（或投递竞态失败）时，
// 必达层/critical 提案自动升级到手机系统级推送——App 被杀也能收到系统通知（通知即弹窗）。
//
// Provider 可插拔（env 门控，未配置自动禁用）：
//   jpush   : 极光推送 REST API v3（JPUSH_APP_KEY + JPUSH_MASTER_SECRET；国内首选，
//             聚合华为/小米/OPPO/vivo/FCM 厂商通道），设备以 registration_id 定位
//   bark    : iOS Bark（BARK_URL，个人设备秒接入，无需客户端改造）
//   webhook : 通用 HTTP 出站（MOBILE_PUSH_WEBHOOK_URL，可接 ntfy/Server酱/WxPusher/自建网关）
//
// 设备 token 注册表：data/proactivity/push-tokens.json（客户端启动时经
// POST /api/proactivity/push/register 上报 actorId + provider + token）。
import { readJson, writeJson } from "./persist-file.js";
import { notificationIdFor } from "./notification-id.js";
import type { ClientActionIntent } from "./action-intent-service.js";

export type PushInput = {
  actorId: string;
  title: string;
  body: string;
  importance: string;
  kind: string;
  deliveryId: string;
  /**
   * 动作意图 id（2026-11-13「通知即界面」）：厂商推送落地的是系统模板通知，
   * **带不了按钮**——但带 intentId 后，点开通知能进 App 处理这个决策。
   * 通知 id 的口径统一走 notificationIdFor(intentId ?? deliveryId)。
   */
  intentId?: string;
  /** 动作视图（带按钮的决策）：厂商通道只能降级成「点开处理」，不能渲染按钮 */
  actionIntent?: ClientActionIntent | null;
};

/** 通知 id 的唯一口径：有 intent 用 intent，没有就用 delivery（两端必须一致） */
export function pushNotificationKey(input: PushInput): string {
  return input.intentId?.trim() || input.deliveryId;
}

export type PushAttemptResult = { ok: boolean; provider: string; reason?: string };

export type PushTarget = { provider: string; token?: string };

export interface PushProvider {
  readonly name: string;
  isConfigured(): boolean;
  push(target: PushTarget, input: PushInput): Promise<{ ok: boolean; reason?: string }>;
}

/** 管道消费的结构化通道接口（MobilePushService 满足；测试可注入桩） */
export type MobilePushChannel = {
  hasChannel(actorId: string): boolean;
  push(input: PushInput): Promise<PushAttemptResult>;
};

/** 注册表条目：actorId → 设备推送凭据（provider + token） */
export type PushTokenEntry = { provider: string; token?: string; deviceId?: string; updatedAt: number };

const FETCH_TIMEOUT_MS = 10_000;
const MAX_ENTRIES_PER_ACTOR = 10;

/**
 * 华为自分类权益 kind → category 映射（2026-11-23 AGC 审批通过 4 个云端类型：
 * 出行 TRAVEL / 工作事项提醒 WORK / 音视频通话 VOIP / 即时聊天 IM）。
 *
 * 规则（华为《消息分类标准》，违者会被暂停/取消权益）：
 *  - category 必须大写、且必须是**已审批通过**的类型，逐字一致；
 *  - 「闹钟/计时器」只有本地通知类型（CATEGORY_ALARM），云端推送没有它；
 *  - 未审批的内容类型（如财经动态、内容推荐）按规范属于资讯营销 → 传
 *    "MARKETING"（静默通知、仅通知栏展示），而不是硬塞进服务类；
 *  - 不认识的 kind 一律回落 MARKETING，宁可少弹不可错标。
 */
const KIND_CATEGORY: Record<string, string> = {
  // 闹钟/计时器：**云端通知没有这个类型**（官方分类标准标注「不涉及」，
  // 只有本地通知才有 CATEGORY_ALARM）→ 云端兜底推送归 WORK（日程安排）。
  // DEVICE_REMINDER 是 IoT 设备提醒，我们不是 IoT 应用，传了会被判无效打回
  // 营销类（2026-11-23 实测 result=256）。
  alarm: "WORK",
  alarm_fallback: "WORK",
  timer: "WORK",
  wake: "WORK",
  // 出行 → TRAVEL（打车/机票/酒店/旅游行程/位置到达离开）
  travel: "TRAVEL",
  trip: "TRAVEL",
  flight: "TRAVEL",
  hotel: "TRAVEL",
  ride: "TRAVEL",
  location_arrival: "TRAVEL",
  location_enter: "TRAVEL",
  place_home_arrival: "TRAVEL",
  place_home_departure: "TRAVEL",
  place_work_arrival: "TRAVEL",
  place_new_city: "TRAVEL",
  // 工作事项提醒 → WORK（日程/待办/会议/DDL/各类简报）
  reminder: "WORK",
  schedule_reminder: "WORK",
  intelligent_reminder: "WORK",
  life_reminder: "WORK",
  meeting_soon: "WORK",
  meeting_soon_early: "WORK",
  deadline: "WORK",
  task: "WORK",
  task_followup: "WORK",
  task_progress: "WORK",
  task_approval: "WORK",
  task_celebration: "WORK",
  watch_task_hit: "WORK",
  goal_progress: "WORK",
  goal_ready: "WORK",
  goal_blocked: "WORK",
  goal_confirm: "WORK",
  morning_brief: "WORK",
  weather_brief: "WORK",
  daily: "WORK",
  weekly: "WORK",
  digest: "WORK",
  monthly_report: "WORK",
  mute_suggest: "WORK",
  sleep_boundary: "WORK",
  message_watch: "WORK",
  push_test: "WORK",
  // 音频、视频通话 → VOIP（来电/通话邀请）
  voip: "VOIP",
  phone_call: "VOIP",
  call_invite: "VOIP",
  // 即时聊天 → IM（Agent 主动发起的聊天内容：关怀、分享、追问等）
  greeting: "IM",
  followup: "IM",
  interest_share: "IM",
  interest_alert: "IM",
  message: "IM",
  chat: "IM",
  im: "IM",
  agent_pulse: "IM",
  agent_task: "IM",
  mood: "IM",
  emotion_pause: "IM",
  topic: "IM",
  topic_switch: "IM",
  dialogue: "IM",
  first_meeting_intro: "IM",
};

/** 未登记的 kind 一律按资讯营销类（静默通知）——合规优先，不冒用服务类权益。 */
function categoryForKind(kind?: string): string {
  const key = String(kind ?? "").toLowerCase();
  return KIND_CATEGORY[key] ?? "MARKETING";
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { ok: response.ok, status: response.status, text: (await response.text().catch(() => "")).slice(0, 200) };
}

/** 极光推送（REST API v3）：国内聚合厂商通道的首选 */
export class JPushProvider implements PushProvider {
  readonly name = "jpush";
  constructor(private readonly appKey: string, private readonly masterSecret: string, private readonly apnsProduction = false) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): JPushProvider | null {
    const appKey = env.JPUSH_APP_KEY?.trim() ?? "";
    const secret = env.JPUSH_MASTER_SECRET?.trim() ?? "";
    return appKey && secret ? new JPushProvider(appKey, secret, env.JPUSH_APNS_PRODUCTION === "1") : null;
  }

  isConfigured(): boolean {
    return true;
  }

  async push(target: PushTarget, input: PushInput): Promise<{ ok: boolean; reason?: string }> {
    if (!target.token) return { ok: false, reason: "jpush 需要 registration_id token" };
    try {
      const auth = Buffer.from(`${this.appKey}:${this.masterSecret}`).toString("base64");
      const result = await postJson(
        "https://api.jpush.cn/v3/push",
        { Authorization: `Basic ${auth}` },
        {
          platform: "all",
          audience: { registration_id: [target.token] },
          notification: {
            alert: `${input.title}：${input.body}`,
            android: {
              alert: `${input.title}：${input.body}`,
              title: input.title,
              // 顶部横幅弹窗（heads-up）：channel_id 指向客户端 init 时创建的
              // HIGH 重要性渠道（LocalNotificationService），priority=2 为
              // Android 8.0 以下的遗留横幅优先级
              channel_id: "proactive",
              priority: 2,
              category: "reminder",
            },
            ios: { alert: `${input.title}：${input.body}`, sound: "default", badge: 1 },
          },
          options: { apns_production: this.apnsProduction, time_to_live: 86400 },
        },
      );
      return result.ok ? { ok: true } : { ok: false, reason: `jpush HTTP ${result.status}: ${result.text}` };
    } catch (err) {
      return { ok: false, reason: `jpush 请求失败: ${err}` };
    }
  }
}

/** Bark（iOS 个人推送）：BARK_URL 即设备端点，零客户端改造 */
export class BarkProvider implements PushProvider {
  readonly name = "bark";
  constructor(private readonly url: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): BarkProvider | null {
    const url = env.BARK_URL?.trim() ?? "";
    return url ? new BarkProvider(url) : null;
  }

  isConfigured(): boolean {
    return true;
  }

  async push(_target: PushTarget, input: PushInput): Promise<{ ok: boolean; reason?: string }> {
    try {
      // Bark 是纯文本推送：带按钮时在正文末尾标一句「可回复/可处理」，
      // 让用户知道点进去能拍板，而不是以为只是一条提醒。
      const actions = input.actionIntent?.actions ?? [];
      const body =
        actions.length > 0
          ? `${input.body}\n— 可在 App 里直接处理：${actions.map((a) => a.label).join(" / ")}`
          : input.body;
      const result = await postJson(
        this.url,
        {},
        { title: input.title, body, group: "nextbot", level: input.importance === "critical" ? "timeSensitive" : "active" },
      );
      return result.ok ? { ok: true } : { ok: false, reason: `bark HTTP ${result.status}: ${result.text}` };
    } catch (err) {
      return { ok: false, reason: `bark 请求失败: ${err}` };
    }
  }
}

/** 通用 HTTP 出站：可接 ntfy / Server酱 / WxPusher / 自建推送网关 */
export class WebhookPushProvider implements PushProvider {
  readonly name = "webhook";
  constructor(private readonly url: string, private readonly bearer?: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): WebhookPushProvider | null {
    const url = env.MOBILE_PUSH_WEBHOOK_URL?.trim() ?? "";
    return url ? new WebhookPushProvider(url, env.MOBILE_PUSH_WEBHOOK_TOKEN?.trim() || undefined) : null;
  }

  isConfigured(): boolean {
    return true;
  }

  async push(_target: PushTarget, input: PushInput): Promise<{ ok: boolean; reason?: string }> {
    try {
      const result = await postJson(
        this.url,
        this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {},
        {
          actorId: input.actorId,
          title: input.title,
          body: input.body,
          importance: input.importance,
          kind: input.kind,
          deliveryId: input.deliveryId,
          // 「通知即界面」：动作视图随推送下发，网关侧若能渲染按钮就能直接决策
          intentId: input.intentId ?? "",
          notificationId: notificationIdFor(pushNotificationKey(input)),
          actionIntent: input.actionIntent ?? null,
        },
      );
      return result.ok ? { ok: true } : { ok: false, reason: `webhook HTTP ${result.status}: ${result.text}` };
    } catch (err) {
      return { ok: false, reason: `webhook 请求失败: ${err}` };
    }
  }
}

/** 华为 Push Kit 直连（2026-10-13 用户定调：移除极光，高可控直连）：
 *  OAuth client_credentials 换 access token（内存缓存）→ push-api messages:send。
 *  凭据来源 AGC「OAuth 2.0 客户端 ID」：HUAWEI_PUSH_APP_ID + HUAWEI_PUSH_CLIENT_SECRET。 */
export class HuaweiPushProvider implements PushProvider {
  readonly name = "huawei";
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly appId: string, private readonly clientSecret: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HuaweiPushProvider | null {
    const appId = env.HUAWEI_PUSH_APP_ID?.trim() ?? "";
    const secret = env.HUAWEI_PUSH_CLIENT_SECRET?.trim() ?? "";
    return appId && secret ? new HuaweiPushProvider(appId, secret) : null;
  }

  isConfigured(): boolean {
    return true;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.appId,
      client_secret: this.clientSecret,
    });
    const resp = await fetch("https://oauth-login.cloud.huawei.com/oauth2/v3/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = (await resp.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!resp.ok || !data.access_token) {
      throw new Error(`huawei OAuth HTTP ${resp.status}`);
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return data.access_token;
  }

  async push(target: PushTarget, input: PushInput): Promise<{ ok: boolean; reason?: string }> {
    if (!target.token) return { ok: false, reason: "huawei 需要 HMS push token" };
    try {
      const accessToken = await this.getAccessToken();
      // 自分类权益（2026-11-23 AGC 审批通过：出行 TRAVEL / 工作事项提醒 WORK /
      // 音视频通话 VOIP / 即时聊天 IM）：不带 category 的通知消息默认按资讯营销
      // 类计频（每设备每天个位数），超限后华为仍返回 80000000 但**静默丢弃**——
      // 回执 result=256（2026-11-23 实测 11 连丢）。取值必须与 AGC 已审批类型
      // 逐字一致（大写）；无效值会被打回营销类。
      // 归类：Agent 主动消息/发现推送 = 即时聊天 IM；日程/提醒/简报等 = 工作事项提醒 WORK。
      const category = categoryForKind(input.kind);
      const payload = {
        validate_only: false,
        message: {
          android: {
            collapse_key: -1,
            urgency: "HIGH",
            category,
            notification: {
              title: input.title,
              body: input.body,
              // 顶部横幅弹窗（heads-up）：channel_id 指向客户端 init 时创建的
              // HIGH 重要性渠道（LocalNotificationService："proactive"）
              channel_id: "proactive",
              click_action: { type: 3 },
              // 通知 id 统一口径（2026-11-13）：与 App 自建通知、华为推送、Webhook
              // 三处同源——此前这里用 title+body 哈希、App 侧用 deliveryId.hashCode，
              // 后果是同一条决策跨层投递变成两条通知（其中一条的按钮是死的）。
              notify_id: notificationIdFor(pushNotificationKey(input)),
              // data 随点击回传：App 被杀时点开这条通知，能知道要处理哪个决策
              data: {
                deliveryId: input.deliveryId,
                intentId: input.intentId ?? "",
                hasActions: input.actionIntent ? "1" : "0",
              },
            },
          },
          token: [target.token],
        },
      };
      // 华为 messages:send 的业务错误（如 80300002 token 无效/指纹不匹配）也走
      // HTTP 200 + body.code —— 只看 HTTP 状态会把被拒的推送误记成「已送达」。
      // 必须解析 body：code 缺失或 80000000 才算成功（实测 2026-10-14）。
      const response = await fetch(
        `https://push-api.cloud.huawei.com/v1/${this.appId}/messages:send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      const text = (await response.text().catch(() => "")).slice(0, 500);
      let bodyCode = "";
      try {
        bodyCode = (JSON.parse(text) as { code?: string }).code ?? "";
      } catch {
        /* 非 JSON 响应按 HTTP 状态判定 */
      }
      if (!response.ok) return { ok: false, reason: `huawei HTTP ${response.status}: ${text}` };
      if (bodyCode && bodyCode !== "80000000") {
        return { ok: false, reason: `huawei code=${bodyCode}: ${text}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `huawei 请求失败: ${err}` };
    }
  }
}

type PersistedTokens = Record<string, PushTokenEntry[]>;

export type MobilePushDeps = { registryPath: string; env?: NodeJS.ProcessEnv; providers?: PushProvider[] };

export class MobilePushService {
  private readonly providers: PushProvider[];
  private readonly tokens: Map<string, PushTokenEntry[]> = new Map();
  private dirty = false;

  constructor(private readonly deps: MobilePushDeps) {
    // 极光 2026-10-15 短暂重接后再次移除（用户定调）：小米厂商通道需应用上架 +
    // 企业开发者账号，当前不具备。JPushProvider 类保留仅供参考，不再进激活列表。
    const envProviders = [HuaweiPushProvider.fromEnv(deps.env), BarkProvider.fromEnv(deps.env), WebhookPushProvider.fromEnv(deps.env)].filter(
      (p) => p !== null,
    );
    this.providers = deps.providers ?? envProviders;
    const raw = readJson<PersistedTokens>(deps.registryPath, {});
    for (const [actorId, entries] of Object.entries(raw)) this.tokens.set(actorId, entries);
  }

  flush(): void {
    if (!this.dirty) return;
    const out: PersistedTokens = {};
    for (const [actorId, entries] of this.tokens) out[actorId] = entries;
    writeJson(this.deps.registryPath, out);
    this.dirty = false;
  }

  register(actorId: string, entry: Omit<PushTokenEntry, "updatedAt"> & { updatedAt?: number }): PushTokenEntry[] {
    let list = this.tokens.get(actorId) ?? [];
    // 同设备动态跟随（2026-11-23）：带 deviceId 的注册按 (provider, deviceId) 做
    // upsert——重装/清数据后 HMS 会签发新 token，旧 token 立即被替换，不再残留
    // 失效条目（残留导致每次推送都先白发一条，回执 result=5：Token 不匹配）。
    // deviceId 用安装标识（Android 上由 ANDROID_ID 派生，同签名卸载重装不变）。
    const deviceId = entry.deviceId?.trim();
    if (deviceId) {
      list = list.filter((e) => !(e.provider === entry.provider && e.deviceId === deviceId));
    }
    // 同 token 去重：无论 deviceId 是否一致，同一个 token 不允许占两个坑
    list = list.filter((e) => !(e.provider === entry.provider && e.token === entry.token));
    list.push({ ...entry, updatedAt: Date.now() });
    while (list.length > MAX_ENTRIES_PER_ACTOR) list.shift();
    this.tokens.set(actorId, list);
    this.dirty = true;
    // 写穿：注册即落盘。此前只在内存置 dirty、flush 无调用方，重启丢 token
    // → 离线必达升级推送静默失效
    this.flush();
    return list;
  }

  /** 按 token 值清理失效条目（华为回执 result=1/2/5 = token 失效/被卸载/不匹配） */
  pruneToken(token: string): number {
    let removed = 0;
    for (const [actorId, list] of this.tokens) {
      const next = list.filter((e) => e.token !== token);
      if (next.length !== list.length) {
        removed += list.length - next.length;
        if (next.length === 0) this.tokens.delete(actorId);
        else this.tokens.set(actorId, next);
      }
    }
    if (removed > 0) {
      this.dirty = true;
      this.flush();
    }
    return removed;
  }

  unregister(actorId: string, provider: string, token?: string): PushTokenEntry[] {
    const list = (this.tokens.get(actorId) ?? []).filter((e) => e.provider !== provider || (token !== undefined && e.token !== token));
    if (list.length === 0) this.tokens.delete(actorId);
    else this.tokens.set(actorId, list);
    this.dirty = true;
    this.flush();
    return list;
  }

  listByActor(actorId: string): PushTokenEntry[] {
    return this.tokens.get(actorId) ?? [];
  }

  /** 全部注册概览（诊断/状态接口用） */
  listAll(): Array<[string, PushTokenEntry[]]> {
    return [...this.tokens.entries()];
  }

  /** 该 actor 是否有可用推送通道（存在注册条目 且 对应 provider 已配置） */
  hasChannel(actorId: string): boolean {
    return this.listByActor(actorId).some((e) => this.providers.some((p) => p.name === e.provider && p.isConfigured()));
  }

  configuredProviders(): string[] {
    return this.providers.filter((p) => p.isConfigured()).map((p) => p.name);
  }

  /** 推送到该 actor 的全部设备：按注册条目逐个尝试，任一成功即止 */
  async push(input: PushInput): Promise<PushAttemptResult> {
    const entries = this.listByActor(input.actorId).filter((e) => this.providers.some((p) => p.name === e.provider && p.isConfigured()));
    if (entries.length === 0) return { ok: false, provider: "none", reason: "no_registered_token" };
    let lastReason = "all_failed";
    for (const entry of entries.slice(0, 3)) {
      const provider = this.providers.find((p) => p.name === entry.provider)!;
      try {
        const result = await provider.push({ provider: entry.provider, token: entry.token }, input);
        if (result.ok) return { ok: true, provider: provider.name };
        lastReason = result.reason ?? "provider_failed";
      } catch (err) {
        lastReason = `${provider.name} 异常: ${err}`;
      }
    }
    return { ok: false, provider: "none", reason: lastReason };
  }
}
