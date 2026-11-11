/**
 * 卡片身份（单一事实源，2026-11-12 双卡事故根修）。
 *
 * 事故复盘：buildCardMarker 等五个入口都用 `card_${Date.now()}_${random}` 盖
 * cardId，同一张卡两次构建（full 主链路 + done 阶段回执兜底重算）必然得到
 * 两个不同 id —— applyCards 的「cardType+业务标识」去重把同一张卡当成两张，
 * 提醒确认卡两端实测双卡。
 *
 * 根修原则：**身份从事实源来，不从渲染时刻来**。
 *   - cardId = payload 内容寻址（sha1 前 12 位）：同载荷恒同 id，跨渲染、
 *     跨阶段、跨重放都稳定；不同载荷（不同 taskId/poiId/行程）天然不同 id，
 *     同轮多卡能力不依赖任何场景自律。
 *   - 去重层（render/cards.ts cardIdentity）同步立规：易变 id（时间戳格式，
 *     历史遗留或其他代码再犯）绝不参与身份，只有稳定 id 才算业务标识。
 *
 * 消费方约定：cardId 对客户端是不透明字符串（chat.user_action 原样回传、
 * 外移卡去重键、闪卡 key），`card_` 前缀保持不变。
 */

import { createHash } from "node:crypto";

/**
 * 易变 cardId（旧格式 `card_<毫秒时间戳>_<随机>`）：每次渲染必变，
 * 不是稳定身份。去重身份计算必须跳过它。
 */
export const VOLATILE_CARD_ID_RE = /^card_\d+_[0-9a-z]+$/i;

/**
 * buildCardMarker 在场景 payload 之上追加的展示壳键：解析已附标记得到的
 * payload 比场景原 payload 多出这些键，身份计算必须剥掉，两侧才能对齐。
 */
export const MARKER_SHELL_KEYS = ["avatar", "avatarStyle", "speak", "cardId"] as const;

/** 键序无关的规范化：对象键递归排序后序列化，同一张卡两种来源字节恒等。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * 由内容确定地生成 cardId（键序无关规范化）。同一张卡从任何来源
 * （场景新建 payload / 已附标记反解析 / 序列化往返）算出的 id 恒一致。
 */
export function stableCardId(payload: unknown): string {
  const canonical = JSON.stringify(canonicalize(payload ?? null));
  const hash = createHash("sha1").update(canonical).digest("hex");
  return `card_${hash.slice(0, 12)}`;
}

/**
 * 去重身份内容：剥掉 marker 展示壳键后的规范化 hash 输入。
 * 场景 payload 与已附标记 payload 在同一张卡上经此归一后字节等价。
 */
export function cardIdentityContent(payload: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if ((MARKER_SHELL_KEYS as readonly string[]).includes(key)) continue;
    content[key] = value;
  }
  return content;
}
