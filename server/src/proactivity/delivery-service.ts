// 统一投递出口：所有主动内容的唯一出站点。
// 投递模型（用户决策 2026-08-30）：仅向该 actor 的全部在线设备 fan-out（电脑端 + 手机端），
// 不落 MessageHub 离线信箱——两端都不在线时由管道挂起提案，任一设备重连即直推。
// 高重要度消息 payload 带 display:"popup"，客户端保证以弹窗形式展示（桌面原生弹窗 /
// 移动端应用内弹窗卡片）。每条投递带 deliveryId，客户端回传 outcome 反馈。
import type { ProactiveProposal } from "./pipeline-types.js";

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
};

export class ProactiveDeliveryService {
  private seq = 0;

  constructor(private readonly deps: DeliveryDeps) {}

  deliver(p: ProactiveProposal, text: string, title: string): DeliveryResult {
    const deliveryId = `d_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const popup = p.importance === "high" || p.importance === "critical";
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
        ...(popup ? { display: "popup" } : {}),
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
