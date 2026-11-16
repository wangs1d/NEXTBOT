// 统一投递出口：所有主动内容的唯一出站点。
// 投递模型（用户决策 2026-08-30）：仅向该 actor 的全部在线设备 fan-out（电脑端 + 手机端），
// 不落 MessageHub 离线信箱——两端都不在线时由管道挂起提案，任一设备重连即直推。
// 高重要度消息 payload 带 display:"popup"，客户端保证以弹窗形式展示（桌面原生弹窗 /
// 移动端应用内弹窗卡片）。每条投递带 deliveryId，客户端回传 outcome 反馈。
import type { ProactiveProposal } from "./pipeline-types.js";
// 类型约束：投递正文必须是"已过开口闸"的 OpenedBody（见 DiscoveryLayer.openMouth）。
// 拿一句裸 string 调 deliver 会编译不过——主动内容无法绕开共享发现层说给用户。
import type { OpenedBody } from "./discovery-layer.js";
import type { ActionIntentService, ClientActionIntent } from "./action-intent-service.js";
import { registerIntentForProposal } from "./notification-actions.js";

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
    const payload = {
      type: "agent.proactive_message",
      payload: {
        deliveryId,
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
    if (p.kind.startsWith("action.")) {
      try {
        this.deps.ledger?.record(p);
      } catch {
        /* 台账失败不影响投递主链路 */
      }
    }
    return { ok: true, deliveryId };
  }
}
