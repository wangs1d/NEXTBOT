/**
 * 包裹感知接入（写入的一半；查询的一半在 tools/package-tools.ts）。
 * 挂在 MessageHubService.onInbound 上：通知/短信/微信服务通知/发货邮件都汇这同一个口，
 * 平台差异被"通知里有没有运单号"一件事吸收掉了，不需要逐平台写适配器。
 *
 *  - 同步入口、异步落库、异常静默：提取失败不能阻断消息落库主链路；
 *  - 只在 created / transition / 补到取件码时发信号，noop 不发——否则同一件被三条来源各播报一次；
 *  - 状态是通知文本的规则判定，delta 里不谎称"官方轨迹"。
 */
import type { Signal } from "../../proactivity/sensors/types.js";
import { resolveBaseActorId } from "../../agent/master-chat-session.js";
import { extractPackageClue, PACKAGE_STATUS_LABELS, type PackageStatus } from "./express-extract.js";
import type { PackageIngestResult, PackageStore } from "./package-store.js";

export type PackageIntakeInput = {
  actorId: string;
  platform: string;
  title?: string;
  text: string;
};

export type PackageIntakeDeps = {
  store: PackageStore;
  /** registerFeeder 返回的 emit（stream 由内核补） */
  emit: (partial: Omit<Signal, "stream">) => void;
  now?: () => number;
};

/** 到件待取是"用户需要行动"的状态，值得高优先；签收只是收尾 */
function salienceFor(status: PackageStatus, kind: PackageIngestResult["kind"]): Signal["salience"] {
  if (status === "awaiting_pickup") return "high";
  if (kind === "created") return "low";
  if (status === "signed" || status === "exception") return "medium";
  return "medium";
}

export function createPackageIntake(deps: PackageIntakeDeps) {
  const now = deps.now ?? Date.now;

  return function handleInbound(input: PackageIntakeInput): void {
    let clue: ReturnType<typeof extractPackageClue>;
    try {
      clue = extractPackageClue({ platform: input.platform, title: input.title, text: input.text });
    } catch {
      return;
    }
    if (!clue) return;

    const actorId = resolveBaseActorId(input.actorId) || input.actorId;
    const at = now();
    deps
      .store.ingestPackageClue(actorId, clue, at)
      .then((result) => {
        if (result.kind === "noop") return;
        const p = result.package;
        const who = p.courierName ?? "快递";
        const label = PACKAGE_STATUS_LABELS[p.status];
        const head = p.trackingNo ? `${who} ${p.trackingNo}` : `${who} 到件（未抓到运单号）`;
        deps.emit({
          actorId,
          at,
          // 10 分钟同状态窗口去重：驿站短信与菜鸟推送同一状态的重复播报合并成一条
          fingerprint: `pkg:${p.packageId}:${p.status}:${Math.floor(at / 600_000)}`,
          salience: salienceFor(p.status, result.kind),
          delta: `${head} ${label}${p.pickupCode ? `，取件码 ${p.pickupCode}` : ""}（来自${clue.sourcePlatform}通知）`,
          payload: {
            packageId: p.packageId,
            trackingNo: p.trackingNo,
            courierCode: p.courierCode,
            status: p.status,
            statusWord: p.statusWord,
            pickupCode: p.pickupCode,
            fromStatus: result.kind === "transition" ? result.from : undefined,
            intakeKind: result.kind,
            sourcePlatforms: p.sourcePlatforms,
          },
        });
      })
      .catch((err) => {
        console.warn("[PackageIntake] 包裹登记失败（忽略，不影响消息落库）:", err);
      });
  };
}
