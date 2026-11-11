/**
 * 结构化卡落地（唯一出口）。
 *
 * 按 `decideRender` 给出的卡顺序执行，不再各自「先到先得 / 让位」：
 * 决定层已经保证了同一轮只有一组主结构化面，这里只负责建块。
 *
 * `cards` 返回值从最终文本的卡块解析而来——文本与结构化通道永远同一份，
 * 不会出现两条通道各说各话。
 */

import {
  attachWeatherResultCardFromExecuted,
  buildCardMarker,
} from "../services/tool-card-registry.js";
import type { ToolCardPayload } from "../services/tool-card-registry.js";
import {
  attachTravelItineraryCard,
  attachVideoMediaMarker,
} from "../services/tool-result-processor.js";
import { extractContentSummaryCard } from "../services/content-summary-service.js";
import { stableCardId, cardIdentityContent } from "../services/card-identity.js";
import type { CardSpec, RenderDecision } from "./types.js";

export interface AppliedCards {
  text: string;
  cards: Array<Record<string, unknown>>;
}

interface ExecutionRef {
  tool: string;
  result: Record<string, unknown>;
}

function readExecutions(spec: CardSpec): ExecutionRef[] {
  const raw = spec.kind === "card" ? spec.payload?.executions : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is ExecutionRef =>
      !!x && typeof x === "object" && typeof (x as ExecutionRef).tool === "string",
  );
}

/** 解析文本里全部卡片块（与客户端解析同一份载荷，绝无第二条数据源） */
export function collectCardPayloads(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /\[AGENT_RESULT_CARD_START\]\s*([\s\S]*?)\s*\[AGENT_RESULT_CARD_END\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // 坏块不收集；出口清洗会整块剥掉
    }
  }
  return out;
}

/**
 * 结构化面在场时，正文不允许还是折叠卡：把摘要块拆回长文排版。
 * 这是出口不变量（一张卡 + 一张折叠卡会互相盖住），不是「让位」。
 */
export function unfoldIfCardsPresent(text: string): string {
  if (!text.includes("[CONTENT_SUMMARY_V2_START]")) return text;
  const extracted = extractContentSummaryCard(text);
  const detail =
    extracted.card && typeof extracted.card.detailContent === "string"
      ? extracted.card.detailContent.trim()
      : "";
  if (!detail) return extracted.text;
  return `[RENDER_AS:structured]\n${detail}`;
}

/**
 * 注册业务卡的 payload 形状诊断（2026-11-07）。
 *
 * 此前 applyCards 隐式要求 payload 自带 `cardType` + 非空 `items`，不满足就
 * 无 else、无日志直接跳过。新场景最容易踩的就是这一脚：代码写了卡、用户
 * 什么也没看到。抽成纯函数，供场景作者自检与单测复用。
 */
export function diagnoseRegisteredCardPayload(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!payload || typeof payload !== "object") return "payload 缺失";
  const cardType = payload.cardType;
  if (typeof cardType !== "string" || !cardType.trim()) return "cardType 缺失或非字符串";
  if (!Array.isArray(payload.items) || payload.items.length === 0) return "items 缺失或为空";
  return null;
}

/** 按决策顺序把卡附到正文上，返回最终文本与结构化卡载荷。 */
export function applyCards(text: string, decision: RenderDecision): AppliedCards {
  let out = text;
  // 去重口径：同一张卡不重复附，但同轮允许多张同类卡。
  //
  // 旧口径按 cardType 去重（"同类型只留一张"），动机是 processAssistantText
  // 已出过卡、done 阶段回执兜底再补一遍会产生两张一模一样的比价卡。
  // 但按类型去重把业务需求一起误杀了：同轮两张不同的景点选择卡、两张不同的
  // 酒店卡只会剩一张，用户看不到完整选项。
  //
  // 身份铁律（2026-11-12 双卡事故根修，与 services/card-identity.ts 同规）：
  // 身份 = **规范化内容寻址**，不从任何"渲染时刻生成的 id"来。
  //   - 决策层拿到的是场景 payload，去重层扫已附文本解析出的是 marker payload
  //     （多 avatar/avatarStyle/speak/cardId 壳键、键序不同）——两侧经
  //     cardIdentityContent 剥壳 + canonicalize 排序后，同一张卡字节等价、
  //     hash 恒等；不同卡内容不同、hash 必异。
  //   - 因此跨阶段重算（full 主链路 → done 兜底）天然幂等，无需任何场景
  //     自律；时间戳随机 id（VOLATILE_CARD_ID_RE）即便再被某处引入也进不了
  //     身份——cardId 键本身就在剥壳清单里。
  const cardIdentity = (payload: Record<string, unknown>): string => {
    const type = typeof payload.cardType === "string" ? payload.cardType : "";
    if (!type) return "";
    return `${type}#${stableCardId(cardIdentityContent(payload))}`;
  };
  const presentTypes = new Set(
    collectCardPayloads(out)
      .map((c) => cardIdentity(c as unknown as Record<string, unknown>))
      .filter(Boolean),
  );
  for (const spec of decision.cards) {
    if (spec.kind === "media") continue;

    if (spec.topic === "travel_itinerary") {
      out = attachTravelItineraryCard(out, "travel.plan-itinerary", spec.payload);
      continue;
    }
    if (spec.topic === "travel_brief") {
      // 简报卡依赖行程冷层存档，由调用方在行程卡之后补附
      continue;
    }
    if (spec.topic === "weather") {
      out = attachWeatherResultCardFromExecuted(
        out,
        readExecutions(spec).map((e) => ({ toolName: e.tool, result: e.result })),
      );
      continue;
    }
    if (spec.topic === "video") {
      const execution = readExecutions(spec)[0];
      if (execution) out = attachVideoMediaMarker(out, execution.tool, execution.result);
      continue;
    }

    // 注册业务卡：payload 已由决定层建好，直接追加（支持同轮多卡）
    const issue = diagnoseRegisteredCardPayload(spec.payload);
    if (issue) {
      // 静默丢卡是「新增渲染不返回」的头号隐形故障：至少留下可检索的信号。
      console.warn(`[render-cards] 丢弃卡 topic=${spec.topic} kind=${spec.kind} 原因=${issue}`);
      continue;
    }
    const payload = spec.payload as Record<string, unknown>;
    const identity = cardIdentity(payload);
    if (!presentTypes.has(identity)) {
      out = buildCardMarker(payload as unknown as ToolCardPayload, out);
      presentTypes.add(identity);
    }
  }

  return { text: out, cards: collectCardPayloads(out) };
}
