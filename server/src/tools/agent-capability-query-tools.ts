import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { ToolRegistry } from "./tool-registry.js";

import {
  buildCoreCapabilitySections,
  CAPABILITY_DOMAINS,
  DOMAIN_LABELS,
  type CapabilityDomain,
} from "../agent/agent-capabilities.js";
import {
  buildAgentAccessModePromptLine,
  parseAgentAccessMode,
} from "../agent/agent-access-mode.js";
import { resolveActorId } from "../agent/actor-id.js";

/**
 * 2026-10-22 复审（用户拍板）：
 * - 生活 12 域（Feature Catalog 分类面）分支删除——"某域有哪些工具"由延迟目录
 *   （环 2 域卡 + tool_discover）负责，query_capabilities 不再重复一份清单。
 * - Agent World 分支删除——世界状态归专属工具 world.status（域归属归位）。
 * 本工具回归单一职责：回答"宿主侧有什么能力域、各自干什么"（"你能做什么"）。
 */
const QUERY_DOMAINS = CAPABILITY_DOMAINS.filter((d) => d !== "world") as CapabilityDomain[];

const VALID_DOMAIN_VALUES = [...QUERY_DOMAINS, "all"] as const;
type ParsedDomain = (typeof VALID_DOMAIN_VALUES)[number];

const ALL_DOMAINS = [...QUERY_DOMAINS] as CapabilityDomain[];

function parseDomain(raw: unknown): ParsedDomain {
  if (typeof raw === "string") {
    const normalized = raw.toLowerCase().trim();
    if (VALID_DOMAIN_VALUES.includes(normalized as ParsedDomain)) {
      return normalized as ParsedDomain;
    }
  }
  return "all";
}

export function registerCapabilityQueryTools(
  toolRegistry: ToolRegistry,
  deps: {
    skillManager: SkillManager;
    virtualPhoneService?: VirtualPhoneService;
  },
): void {
  toolRegistry.register("agent.query_capabilities", async (input, context) => {
    const actorId = resolveActorId(context);
    const { skillManager, virtualPhoneService } = deps;
    const capDomain = parseDomain(input.domain);

    const sections = buildCoreCapabilitySections(skillManager, virtualPhoneService, actorId);

    const parts: string[] = [];

    const filtered = capDomain === "all"
      ? sections
      : sections.filter((s) => s.domain === capDomain);

    if (filtered.length > 0) {
      const header = capDomain === "all"
        ? "【宿主能力清单】"
        : `【宿主能力 · ${DOMAIN_LABELS[capDomain] || capDomain}】`;
      parts.push(header);

      for (const section of filtered) {
        parts.push(...section.lines);
      }

      parts.push(
        "",
        "能力边界：以上为宿主侧工具。Agent World 是独立模块——注册/点数/技能状态用 world.status 查询；某域具体工具的参数 schema 用 tool_discover 检索。",
      );
    }

    const accessLine = buildAgentAccessModePromptLine(parseAgentAccessMode(context.agentAccessMode), {
      desktopBridgeOnline: context.desktopBridgeOnline,
      phoneBridgeOnline: context.phoneBridgeOnline,
    });
    if (accessLine) {
      parts.push("", accessLine);
    }

    const resultText = parts.join("\n");

    return {
      ok: true,
      domain: capDomain,
      capabilities: resultText,
      availableDomains: ALL_DOMAINS,
      message: capDomain === "all"
        ? "已返回宿主侧完整能力清单（含本轮访问权限说明）。"
        : `已返回「${DOMAIN_LABELS[capDomain] || capDomain}」领域的能力描述。如需其他领域，可指定 domain 参数。`,
    };
  });
}
