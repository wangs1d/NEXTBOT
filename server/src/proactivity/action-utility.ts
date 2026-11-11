/**
 * 方案 A：Action Utility 评估器（主动性三分支核心）。
 *
 * 一次主动行为在执行前先过确定性效用评估（零 LLM、可单测）：
 *   - 风险维度：可逆性 / 金融影响 / 数据敏感性 / 第三方影响
 *   - 授权维度：显式（用户点名要求）/ 隐式（长期偏好或既有授权）/ 无
 *   - 价值维度：期望价值 / 打扰成本
 *
 * 输出三分支（方案 C 执行语义）：
 *   execute_silently —— 直接执行不通知（可逆 + 已授权 + 高净效用）
 *   ask_first        —— 暂停生成确认请求，等用户回复
 *   silence          —— 什么都不做，但留痕（方案 B silence-log，支持"上周为什么没提醒我"）
 *
 * 决策规则（顺序固定，先命中先出）：
 *   1. netUtility < 0                        → silence（不值得做，也不值得问）
 *   2. 不可逆 或 高金融影响                  → ask_first（高风险动作永不静默执行）
 *   3. 无授权 且 影响第三方                  → ask_first（不能替用户对别人做事）
 *   4. 可逆 + 有授权 + netUtility > 阈值     → execute_silently
 *   5. 其余（低效用但非负、或未授权但仅自身）→ ask_first（保守默认）
 */

import type { ProactiveImportance } from "./pipeline-types.js";
import { classifyToolRisk } from "../services/tool-risk.js";

// ============================================================
// 输入类型
// ============================================================

export type FinancialImpact = "none" | "low" | "high";
export type DataSensitivity = "none" | "personal" | "sensitive";
export type AuthorizationLevel = "explicit" | "implicit" | "none";

/** 风险维度：由触发源声明或从行动步骤推导（deriveRiskFromSteps） */
export type RiskDimensions = {
  /** 动作可否撤销（删除/发送/支付类默认不可逆） */
  reversible: boolean;
  financialImpact: FinancialImpact;
  dataSensitivity: DataSensitivity;
  /** 是否影响第三方（发消息给别人 / 代下单 / 代催促） */
  thirdPartyImpact: boolean;
};

/** 价值维度：期望价值与打扰成本均为 0-1 归一化分值 */
export type ValueDimensions = {
  /** 期望价值：做成这件事对用户的价值（0=无意义，1=刚需） */
  expectedValue: number;
  /** 打扰成本：一次触达/执行对用户注意力的占用（0=无感，1=严重打扰） */
  interruptionCost: number;
};

export type ActionUtilityInput = {
  /** 评估对象标识（kind/title，仅用于结果 reason 留痕） */
  kind: string;
  title?: string;
  risk: RiskDimensions;
  authorization: AuthorizationLevel;
  value: ValueDimensions;
};

export type ActionUtilityBranch = "execute_silently" | "ask_first" | "silence";

export type ActionUtilityResult = {
  branch: ActionUtilityBranch;
  /** 0-1 风险分（加权合成） */
  riskScore: number;
  /** 0-1 价值分（期望价值原样透出） */
  valueScore: number;
  /** 净效用 = 期望价值 - 打扰成本 - 风险拖累 */
  netUtility: number;
  /** 命中规则的人类可读解释（silence-log 与诊断接口展示） */
  reason: string;
};

// ============================================================
// 权重与阈值（集中定义，测试与调参唯一事实源）
// ============================================================

/** 风险加权：不可逆 0.4 / 高金融 0.3 / 敏感数据 0.2 / 第三方 0.1（合成封顶 1） */
export const RISK_WEIGHTS = {
  irreversible: 0.4,
  financialHigh: 0.3,
  dataSensitive: 0.2,
  thirdParty: 0.1,
} as const;

/** 低档风险折算系数（low 金融 / personal 数据各计 40% 权重） */
const RISK_LOW_TIER_RATIO = 0.4;

/** 风险对净效用的拖累系数：riskScore=1 时净效用扣 0.5 */
export const RISK_UTILITY_DRAG = 0.5;

/** 静默执行净效用阈值：可逆 + 已授权也要求净效用明显为正才免打扰直执行 */
export const EXECUTE_SILENTLY_THRESHOLD = 0.15;

/**
 * 规则 5 的「值得问」底线：期望价值低于此值时，问本身比做更打扰——
 * 直接 silence（不做也不问）。ask_first 只留给价值有意义但条件不满足的场景。
 */
export const ASK_WORTHINESS_MIN_VALUE = 0.3;

/**
 * 三分支语义总开关（env：PROACTIVITY_UTILITY_EVAL，默认开）。
 * 关闭时回退升级前行为：arbiter 跳过效用评估；hub act 直接执行并 speak 告知。
 * 每次调用读取（测试可动态切换）。
 */
export function isUtilityEvalEnabled(): boolean {
  const raw = process.env.PROACTIVITY_UTILITY_EVAL;
  if (raw === undefined || raw === "") return true;
  return !(raw === "0" || raw.toLowerCase() === "false");
}

// ============================================================
// 评估器（纯函数，零 LLM，确定性可测）
// ============================================================

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function computeRiskScore(risk: RiskDimensions): number {
  let score = 0;
  if (!risk.reversible) score += RISK_WEIGHTS.irreversible;
  score +=
    risk.financialImpact === "high"
      ? RISK_WEIGHTS.financialHigh
      : risk.financialImpact === "low"
        ? RISK_WEIGHTS.financialHigh * RISK_LOW_TIER_RATIO
        : 0;
  score +=
    risk.dataSensitivity === "sensitive"
      ? RISK_WEIGHTS.dataSensitive
      : risk.dataSensitivity === "personal"
        ? RISK_WEIGHTS.dataSensitive * RISK_LOW_TIER_RATIO
        : 0;
  if (risk.thirdPartyImpact) score += RISK_WEIGHTS.thirdParty;
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

export function evaluateActionUtility(input: ActionUtilityInput): ActionUtilityResult {
  const riskScore = computeRiskScore(input.risk);
  const valueScore = clamp01(input.value.expectedValue);
  const interruptionCost = clamp01(input.value.interruptionCost);
  const netUtility =
    Math.round((valueScore - interruptionCost - RISK_UTILITY_DRAG * riskScore) * 1000) / 1000;

  const authorized = input.authorization === "explicit" || input.authorization === "implicit";

  // 规则 1：净效用为负 → 沉默（既不做也不问，留痕供反问）
  if (netUtility < 0) {
    return {
      branch: "silence",
      riskScore,
      valueScore,
      netUtility,
      reason: `net_utility_negative(value=${valueScore}, interruption=${interruptionCost}, riskDrag=${Math.round(RISK_UTILITY_DRAG * riskScore * 1000) / 1000})`,
    };
  }
  // 规则 2：不可逆或高金融影响 → 先问（高风险动作的收益再大也不静默执行）
  if (!input.risk.reversible || input.risk.financialImpact === "high") {
    return {
      branch: "ask_first",
      riskScore,
      valueScore,
      netUtility,
      reason: !input.risk.reversible
        ? `irreversible_action(riskScore=${riskScore})`
        : `high_financial_impact(riskScore=${riskScore})`,
    };
  }
  // 规则 3：无授权且影响第三方 → 先问（不能替用户对别人做事）
  if (!authorized && input.risk.thirdPartyImpact) {
    return {
      branch: "ask_first",
      riskScore,
      valueScore,
      netUtility,
      reason: `unauthorized_third_party(authorization=${input.authorization})`,
    };
  }
  // 规则 4：可逆 + 有授权 + 净效用超阈 → 静默执行（免打扰直做）
  if (input.risk.reversible && authorized && netUtility > EXECUTE_SILENTLY_THRESHOLD) {
    return {
      branch: "execute_silently",
      riskScore,
      valueScore,
      netUtility,
      reason: `reversible_authorized_high_utility(netUtility=${netUtility} > ${EXECUTE_SILENTLY_THRESHOLD}, authorization=${input.authorization})`,
    };
  }
  // 规则 5a：价值太低不值得问（问本身比做更打扰）→ silence（不做也不问）
  if (valueScore < ASK_WORTHINESS_MIN_VALUE) {
    return {
      branch: "silence",
      riskScore,
      valueScore,
      netUtility,
      reason: `low_value_not_worth_asking(value=${valueScore} < ${ASK_WORTHINESS_MIN_VALUE})`,
    };
  }
  // 规则 5b：保守默认 → 先问
  return {
    branch: "ask_first",
    riskScore,
    valueScore,
    netUtility,
    reason: `conservative_default(netUtility=${netUtility}, authorization=${input.authorization}, reversible=${input.risk.reversible})`,
  };
}

// ============================================================
// 维度推导辅助（触发源不显式声明时的确定性回退）
// ============================================================

/** 金融敏感工具名（命中即高档金融影响） */
const FINANCIAL_TOOL_RE = /pay|wallet|transfer|refund|purchase|order|subscribe|renew|budget/i;
/** 数据敏感工具名（读取隐私数据并外发场景由调用方声明，这里只标数据档位） */
const SENSITIVE_DATA_TOOL_RE = /health|medical|credential|password|location|contact/i;
/** 第三方影响工具名（动作效果落到别人身上） */
const THIRD_PARTY_TOOL_RE = /send|message|sms|email|mail|nudge|reply|invite|notify_(?!self)/i;
/** 与 hub 黑名单（ACT_TOOL_DENY_RE）口径对齐的不可逆工具名（外发/删除/支付/发布类）。
 * post(?!pone) 排除 postpone（推迟日程可逆）；\bkill 排除 skill；run_shell/run_automation
 * 虽会被安全门拦截，也必须先按不可逆走 ask_first（否则静默执行被拦后无声无息）。 */
const IRREVERSIBLE_TOOL_RE =
  /delete|remove|drop|format|wipe|uninstall|shutdown|reboot|restart|run_shell|run_automation|\bkill|send|reply|invite|nudge|message|sms|mail|pay|transfer|purchase|order|publish|post(?!pone)/i;

/** 金融金额字段名（args 命中且为正数 → 高档金融影响） */
const AMOUNT_ARG_RE = /amount|price|cost|fee|total/i;

/**
 * 从行动计划（hub act 步骤 / 提案附带动作）确定性推导风险维度。
 * 工具名与参数模式匹配，零 LLM：删除与外发类不可逆、涉钱高档、
 * 通信类影响第三方、隐私类数据敏感。
 */
export function deriveRiskFromSteps(
  steps: Array<{ tool: string; args?: Record<string, unknown> }>,
): RiskDimensions {
  let reversible = true;
  let financialImpact: FinancialImpact = "none";
  let dataSensitivity: DataSensitivity = "none";
  let thirdPartyImpact = false;

  for (const step of steps) {
    const tool = step.tool ?? "";
    // 权威分级优先（tool-risk.ts 单一口径）：money→金融高档、irreversible→不可逆；
    // 正则族保留作兜底（覆盖未入表的新工具名模式）
    const riskClass = classifyToolRisk(tool, step.args as Record<string, unknown> | undefined);
    if (riskClass === "irreversible" || IRREVERSIBLE_TOOL_RE.test(tool)) reversible = false;
    if (riskClass === "money" || FINANCIAL_TOOL_RE.test(tool)) financialImpact = "high";
    if (SENSITIVE_DATA_TOOL_RE.test(tool) && dataSensitivity === "none") dataSensitivity = "personal";
    if (THIRD_PARTY_TOOL_RE.test(tool)) thirdPartyImpact = true;
    if (financialImpact !== "high") {
      for (const [key, val] of Object.entries(step.args ?? {})) {
        if (!AMOUNT_ARG_RE.test(key)) continue;
        const num = typeof val === "number" ? val : Number.parseFloat(String(val));
        // 显著金额（>0.01 元级）视为涉钱；小额标 low 供风险分加权
        if (Number.isFinite(num) && num > 0) {
          financialImpact = num >= 0.01 ? "high" : "low";
        }
      }
    }
  }
  return { reversible, financialImpact, dataSensitivity, thirdPartyImpact };
}

/** 提案重要度 → 期望价值（通知类提案未显式声明价值维度时的回退） */
const IMPORTANCE_VALUE: Record<ProactiveImportance, number> = {
  critical: 0.95,
  high: 0.7,
  medium: 0.45,
  low: 0.2,
};

/** 通知类提案的默认打扰成本：一次推送 ≈ 扫一眼（0.3），与重要度无关 */
export const NOTIFY_INTERRUPTION_COST = 0.3;

/**
 * 通知类提案的默认价值维度：期望价值按重要度映射，
 * 打扰成本取固定基线（一次推送的注意力占用）。
 * 临界语义：medium 及以上净效用非负可投递；low 净效用为负 → silenced。
 */
export function deriveNotifyValue(importance: ProactiveImportance): ValueDimensions {
  return { expectedValue: IMPORTANCE_VALUE[importance], interruptionCost: NOTIFY_INTERRUPTION_COST };
}

/** 后台行动的默认打扰成本：静默执行不触达用户（0.1 = 系统资源/副作用底噪） */
export const ACT_INTERRUPTION_COST = 0.1;

/** 行动计划的默认价值维度（hub act 模式）：期望价值按意图重要度映射 */
export function deriveActValue(importance: ProactiveImportance): ValueDimensions {
  return { expectedValue: IMPORTANCE_VALUE[importance], interruptionCost: ACT_INTERRUPTION_COST };
}
