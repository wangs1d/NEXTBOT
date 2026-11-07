/**
 * 明日预览数据面桥（2026-11-05 接生产投递）。
 *
 * 背景：明日预览的确定性渲染器（render/scenes/tomorrow-preview.scene.ts）此前只在
 * 探针里可用——生产链路没有任何调用方注入 `payloads.eveningDigest`，所以场景永远
 * 不命中。本桥是「数据持有者」与「渲染出口」之间的唯一接口：
 *
 *   装配层 registerPreviewDigestSource(取数口)
 *        ↓
 *   聊天出口 resolvePreviewPayloads(sessionId, userText)
 *        ↓ 命中明日意图且拿到当日 digest
 *   tool-result-processor → decideRender({ payloads }) → tomorrow_preview 场景
 *
 * 设计约束：
 *   1. **绝不阻塞主对话**：取数超过 PREVIEW_PAYLOAD_TIMEOUT_MS 就放弃注入，
 *      回复走常规链路。宁可少一张预览，也不能让用户等天气接口。
 *   2. **不猜意图的地方不注入**：问天气/闲聊不塞预览（否则 90 优先级场景会把
 *      天气轮抢走）。
 *   3. 本模块不 import 任何服务实现，只有模块级回调——避免 chat handler 与
 *      evening-digest 服务互相反向依赖。
 */

/** 取数口：返回当日 EveningDigest（形状由场景定义，此处不耦合服务类型） */
export type PreviewDigestSource = (
  sessionId: string,
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

/** 取数上限：超过就放弃预览（主对话优先） */
export const PREVIEW_PAYLOAD_TIMEOUT_MS = 2500;

let digestSource: PreviewDigestSource | undefined;

export function registerPreviewDigestSource(source: PreviewDigestSource | undefined): void {
  digestSource = source;
}

/** 测试用：清空注册 */
export function resetPreviewDigestSource(): void {
  digestSource = undefined;
}

const TOMORROW_WORD = /明天|明日|明早|明晚|明儿/;
/** 强安排词：出现即认定为在问日程（即使同时提了天气） */
const SCHEDULE_WORD = /安排|行程|日程|计划|待办|预告|预览|要做|做什么|干啥|有事|忙什么/;
const WEATHER_WORD = /天气|气温|几度|下雨|降雨|雨|雪|冷|热|穿|带伞|风/;

/**
 * 这条消息是不是在问明日安排。
 *
 * 只看措辞，不做语义猜测：含「明天」是前提；提到安排/行程类强信号就认；
 * 只是问天气（「明天几点下雨」）则不认——天气轮有自己的卡与边界，
 * 被 90 优先级的预览场景抓走会同时丢卡和丢数据。
 */
export function wantsTomorrowPreview(userText: string): boolean {
  const text = (userText ?? "").trim();
  if (!text || !TOMORROW_WORD.test(text)) return false;
  // 天气词在场且没有强安排词 → 归天气轮
  if (WEATHER_WORD.test(text) && !SCHEDULE_WORD.test(text)) return false;
  return true;
}

/**
 * 解析本轮要注入渲染层的场景数据面。
 * 命中返回 `{ eveningDigest }`；不命中 / 取数失败 / 超时返回 undefined。
 */
export async function resolvePreviewPayloads(
  sessionId: string,
  userText: string,
): Promise<Record<string, unknown> | undefined> {
  if (!digestSource || !sessionId) return undefined;
  if (!wantsTomorrowPreview(userText)) return undefined;

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PREVIEW_PAYLOAD_TIMEOUT_MS);
    });
    const digest = await Promise.race([
      Promise.resolve(digestSource(sessionId)).catch(() => undefined),
      timeout,
    ]);
    if (!digest || typeof digest !== "object") return undefined;
    return { eveningDigest: digest };
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
