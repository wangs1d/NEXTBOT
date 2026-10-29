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
  attachSearchResultCardFromExecuted,
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

/** 按决策顺序把卡附到正文上，返回最终文本与结构化卡载荷。 */
export function applyCards(text: string, decision: RenderDecision): AppliedCards {
  let out = text;
  for (const spec of decision.cards) {
    if (spec.kind === "media") continue;
    if (spec.kind === "empty") {
      out = buildCardMarker(
        {
          title: spec.title,
          items: [{ type: "warn", text: spec.message }],
          cardType: "",
        },
        out,
      );
      continue;
    }

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
    if (spec.topic === "search_result") {
      out = attachSearchResultCardFromExecuted(
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
    if (spec.payload) {
      const cardType =
        typeof spec.payload.cardType === "string" ? spec.payload.cardType : "";
      const items = Array.isArray(spec.payload.items) ? spec.payload.items : [];
      if (cardType && items.length > 0) {
        out = buildCardMarker(spec.payload as unknown as ToolCardPayload, out);
      }
    }
  }

  return { text: out, cards: collectCardPayloads(out) };
}
