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
  // 同类型卡只留一张：processAssistantText 可能已经出过卡，done 阶段再从回执
  // 兜底补一遍就会重复（客户端会渲染两张一模一样的比价卡）。
  const presentTypes = new Set(
    collectCardPayloads(out)
      .map((c) => (typeof c.cardType === "string" ? c.cardType : ""))
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
    const cardType = payload.cardType as string;
    if (!presentTypes.has(cardType)) {
      out = buildCardMarker(payload as unknown as ToolCardPayload, out);
      presentTypes.add(cardType);
    }
  }

  return { text: out, cards: collectCardPayloads(out) };
}
