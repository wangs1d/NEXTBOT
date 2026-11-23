// 统一投递出口：所有主动内容的唯一出站点。
// 投递模型（用户决策 2026-08-30）：仅向该 actor 的全部在线设备 fan-out（电脑端 + 手机端），
// 不落 MessageHub 离线信箱——两端都不在线时由管道挂起提案，任一设备重连即直推。
// 高重要度消息 payload 带 display:"popup"，客户端保证以弹窗形式展示（桌面原生弹窗 /
// 移动端应用内弹窗卡片）。每条投递带 deliveryId，客户端回传 outcome 反馈。
import type { ProactiveImportance, ProactiveProposal } from "./pipeline-types.js";
// 类型约束：投递正文必须是"已过开口闸"的 OpenedBody（见 DiscoveryLayer.openMouth）。
// 拿一句裸 string 调 deliver 会编译不过——主动内容无法绕开共享发现层说给用户。
import type { OpenedBody } from "./discovery-layer.js";
import type { ActionIntentService, ClientActionIntent } from "./action-intent-service.js";
import { registerIntentForProposal } from "./notification-actions.js";
import { getProactiveReplay } from "./proactive-replay-store.js";

export type DeliveryResult =
  | { ok: true; deliveryId: string }
  | { ok: false; reason: string };

export type DeliveryDeps = {
  trySend: (actorId: string, json: string) => boolean;
  /** 定向投递（targetDeviceClass 提案用）：仅向指定设备类别的在线端投递（2026-10-13） */
  trySendToDeviceClasses?: (actorId: string, json: string, deviceClasses: string[]) => boolean;
  /** 助手动态台账（右侧面板「助手动态」卡数据源）：kind 以 "action." 开头的代办提案
   * 投递成功后落一条记录（投递失败不记——提案会挂起重投，送达才算"办完了"）。 */
  ledger?: { record: (p: ProactiveProposal) => void };
  /**
   * 动作意图服务（2026-11-13「通知即界面」）：投递时为可决策提案签发带按钮的动作。
   * 未装配时投递行为与从前完全一致（只是通知里没有按钮）。
   */
  actionIntents?: ActionIntentService | null;
  /**
   * 横幅归属端（2026-11-23 §3.7「多端时取打断成本最低的那一端」）。
   * 返回非 null 时，只有该端弹系统通知，其余端只把消息落对话流——
   * 人在电脑前活跃时手机不再跟着弹一条，正是需求文档的验收项 3。
   * 未注入 / 返回 null = 各端按原逻辑自决（单端在线时本来就没得选）。
   */
  bannerSurface?: (actorId: string) => "mobile" | "desktop" | null;
};

export class ProactiveDeliveryService {
  private seq = 0;

  constructor(private readonly deps: DeliveryDeps) {}

  /**
   * 为这条提案签发「通知即界面」的动作视图（通知栏按钮）。
   * 聊天卡与通知栏用的是**同一个 intent**——两个渲染面，同一真相源。
   */
  private buildActionIntent(
    p: ProactiveProposal,
    deliveryId: string,
    title: string,
    text: string,
  ): ClientActionIntent | undefined {
    const svc = this.deps.actionIntents;
    if (!svc) return undefined;
    try {
      const intent = registerIntentForProposal(svc, p, {
        title,
        body: String(text),
        deliveryId,
      });
      return intent ? svc.renderForClient(intent) : undefined;
    } catch (err) {
      // 动作意图签发失败**不能**影响主投递：通知照发，只是没有按钮
      console.log(`[ProactiveDelivery] 动作意图签发失败（忽略，改为无按钮通知）kind=${p.kind}: ${err}`);
      return undefined;
    }
  }

  /**
   * 唯一投递出口。`text` 是 branded 的 OpenedBody——只能由 DiscoveryLayer.openMouth
   * 产出，因此「绕过开口闸直接投递」在这里是编译错误，而不是靠人记约定。
   */
  deliver(p: ProactiveProposal, text: OpenedBody, title: string): DeliveryResult {
    const deliveryId = `d_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const popup = p.importance === "high" || p.importance === "critical";
    // 「通知即界面」：签发带按钮的动作视图（同一 intent 也用于离线推送的降级路径）
    const actionIntent = this.buildActionIntent(p, deliveryId, title, String(text));
    // 定向投递（targetDeviceClass）本来就只到一个端，那个端就是归属端，不再指定；
    // 全端 fan-out 时才需要「弹在哪一端」这个额外信息。
    const notifyOn = p.targetDeviceClass ? null : (this.deps.bannerSurface?.(p.actorId) ?? null);
    const payload = {
      type: "agent.proactive_message",
      payload: {
        deliveryId,
        // 稳定消息 id（2026-11-23「落流补发」）：客户端按 (sessionId, messageId)
        // upsert 本地历史——重连补投同一条消息不会产生重复气泡。
        messageId: `proactive-${deliveryId}`,
        title,
        text,
        importance: p.importance,
        kind: p.kind,
        proposalId: p.proposalId,
        source: p.source,
        // 离线补推的到点提醒带原定触发时刻：客户端气泡按原时间落屏（2026-11-12）
        ...(typeof p.firedAt === "number" ? { firedAt: p.firedAt } : {}),
        ...(popup ? { display: "popup" } : {}),
        // 带按钮的动作视图（2026-11-13）：通知栏与聊天卡共用同一个 intent
        ...(actionIntent ? { actionIntent } : {}),
        // 多端归属（2026-11-23 §3.7）：只有这一端弹系统横幅，其余端静默落流
        ...(notifyOn ? { notifyOn } : {}),
        // 「为什么现在告诉我」（§3.10）：长按详情用，缺省不下发
        ...(p.why ? { why: p.why } : {}),
      },
    };
    if (p.targetDeviceClass && this.deps.trySendToDeviceClasses) {
      // 定向投递：只面向声明设备类别的在线端；不在线返回失败由管道挂起重投/推送兜底
      if (!this.deps.trySendToDeviceClasses(p.actorId, JSON.stringify(payload), [p.targetDeviceClass])) {
        return { ok: false, reason: `no_online_${p.targetDeviceClass}` };
      }
    } else if (!this.deps.trySend(p.actorId, JSON.stringify(payload))) {
      return { ok: false, reason: "no_online_device" };
    }
    // 落流补发登记（2026-11-23）：WS 直投只到达了「当时在线」的设备——其他
    // 设备重连时由 ProactiveReplayStore 按稳定 messageId 幂等补投。
    getProactiveReplay().record(p.actorId, payload.payload as Record<string, unknown>);
    if (p.kind.startsWith("action.")) {
      try {
        this.deps.ledger?.record(p);
      } catch {
        /* 台账失败不影响投递主链路 */
      }
    }
    return { ok: true, deliveryId };
  }

  /**
   * 「回复」闭环的第二跳（2026-11-29 §4.3 步骤 4）：把 agent 对通知栏内联回复的
   * 应答送回用户界面。
   *
   * 复用 [deliver] 的同一套出站三件套（WS 直投 + 落流补发登记 + 横幅归属端），
   * 事件类型也仍是 `agent.proactive_message`——客户端已有的三段判定（前台落对话流 /
   * 后台用同 id 原地更新通知 / 非归属端不弹横幅）因此一行不改就接得住这条回复。
   * 与 deliver 的唯一区别：动作视图由 `chat.reply` 执行器预先签好（回复线程的
   * 下一轮意图，displayIntentId 钉在根意图上），这里不再走 registerIntentForProposal。
   *
   * 不走管道仲裁：这是对用户已经开口的一句话的应答，不是系统主动找话说，
   * 拿它去挤频控预算会把你自己的回信拦在门外。
   */
  deliverNotificationReply(input: {
    actorId: string;
    title: string;
    text: string;
    /** 根意图 id：客户端按它算通知 id → agent 的回复落在原来那条通知上 */
    rootIntentId: string;
    /** 这是这条线程的第几轮（诊断与埋点用） */
    round: number;
    /** 用户那句原话：随载荷带回，客户端据此落唯一一条用户气泡（缺省靠历史 reconcile 补） */
    userText?: string;
    kind?: string;
    actionIntent?: ClientActionIntent;
    /**
     * 横幅归属端。通知栏输入框只可能出现在手机上，所以默认把横幅钉给 mobile：
     * 手机在后台 → 同 id 更新那条通知；电脑在线也只落流不再弹一条。
     * 传 null = 各端按原逻辑自决。
     */
    notifyOn?: "mobile" | "desktop" | null;
  }): DeliveryResult {
    const deliveryId = `d_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const payload = {
      type: "agent.proactive_message",
      payload: {
        deliveryId,
        // 稳定消息 id：与 deliver 同口径，重连补投按 (sessionId, messageId) 幂等
        messageId: `proactive-${deliveryId}`,
        title: input.title,
        text: input.text,
        importance: "medium" as ProactiveImportance,
        kind: input.kind ?? "notification_reply",
        // 这条消息的来源：通知栏里回的那一句话所触发的应答（客户端落流详情用）
        source: "notification_reply",
        reply: { rootIntentId: input.rootIntentId, round: input.round },
        ...(input.userText ? { userText: input.userText } : {}),
        ...(input.actionIntent ? { actionIntent: input.actionIntent } : {}),
        ...(input.notifyOn === null ? {} : { notifyOn: input.notifyOn ?? "mobile" }),
      },
    };
    // 全端 fan-out：回复要落到会话流（电脑/手机都该看见），只是横幅归一台
    if (!this.deps.trySend(input.actorId, JSON.stringify(payload))) {
      return { ok: false, reason: "no_online_device" };
    }
    // 落流补发：此刻不在线的那一端重连后照样补到这轮应答（replay 标记只落流不弹横幅）
    getProactiveReplay().record(input.actorId, payload.payload as Record<string, unknown>);
    return { ok: true, deliveryId };
  }
}
