/**
 * Agent 自主任务的安全层:高危操作判定 + 权限白名单。
 *
 * 判定优先级:DENIED(绝对拒绝) > HIGH_RISK(需人工审批) > 默认 allow。
 * 所有规则用「工具名 + 参数匹配函数」表达,可扩展。
 */

import type { SafetyCheckResult } from "./agent-task-types.js";
import { AuditService } from "./audit-service.js";
import { classifyFeatureByName } from "../catalog/class-map.js";
import { resolveEffectiveToolName } from "../external-model/composite-chat-tools.js";

// --------------------------------------------------------------------------- //
// 正则规则集合
// --------------------------------------------------------------------------- //

/** 输入文本敏感金融信息(禁止直接输入) */
const INPUT_DENY_REGEX = /转账|汇款|支付|密码|验证码/;

/** 输入文本敏感个人信息(需审批) */
const INPUT_HIGH_RISK_REGEX = /账号|账户|金额|身份证|银行卡/;

/** 通用危险操作关键词(适用于任何工具的参数与任务目标) */
const GENERIC_HIGH_RISK_REGEX = /删除|清空|格式化|卸载|关闭.*服务|停止.*进程/;

// --------------------------------------------------------------------------- //
// 规则类型定义
// --------------------------------------------------------------------------- //

/** 绝对禁止规则:命中即 deny(即使人工审批也拒绝) */
interface DenyRule {
  /** 工具名,"*" 表示匹配任意工具 */
  tool: string;
  /** 参数匹配函数,返回 true 表示命中；toolName 仅在 tool==="*" 时传入,供工具名级规则使用 */
  match: (args: Record<string, unknown>, toolName: string) => boolean;
  /** 命中原因 */
  reason: string;
}

/** 高危规则:命中需人工审批 */
interface HighRiskRule {
  tool: string;
  match: (args: Record<string, unknown>, toolName: string) => boolean;
  reason: string;
}

// --------------------------------------------------------------------------- //
// 规则表
// --------------------------------------------------------------------------- //

/**
 * 绝对禁止的工具+参数组合(即使审批也拒)。
 * 顺序敏感:前面的先判定。
 */
const DENIED_ACTIONS: DenyRule[] = [];

/**
 * 高危工具闸的统一文案：AgentTaskSafety 规则表与 RuntimeKernel 兼容入口共用，
 * 保证两条入口对模型/用户说的是同一句话。
 */
export const HIGH_RISK_TOOL_REASON =
  "资金支付或对外发送类动作需要用户确认后才能执行。";

/**
 * 高危工具名集合(这些工具的某些操作需要人工审批)。
 * 顺序敏感:前面的先判定。
 */
const HIGH_RISK_TOOL_PATTERNS: HighRiskRule[] = [
  {
    // 高风险金融/购物类工具:下单/支付/转账/外发一律需人工审批
    // 迁移自原 RuntimeKernel.checkToolAction（工具名硬匹配规则）
    tool: "*",
    match: (args, toolName) => isHighRiskFinancialTool(toolName),
    reason: HIGH_RISK_TOOL_REASON,
  },
  {
    // 通配规则:对任意工具,只要参数值中包含高危关键词即触发
    tool: "*",
    match: (args) => {
      const joined = safeStringify(args);
      return GENERIC_HIGH_RISK_REGEX.test(joined);
    },
    reason: "操作描述包含高危关键词(删除/清空/格式化/卸载/关闭服务/停止进程)",
  },
];

/**
 * 判断工具名是否属于高风险金融/购物类（下单/支付/转账/钱包）。
 * 迁移自原 RuntimeKernel.checkToolAction，集中到 AgentTaskSafety 统一管理。
 *
 * 2026-09 分类层纳管：静态名单之外的工具由 FeatureCatalog 分类补充判定 ——
 * risk=spend（支付/下单/转账）或 risk=outbound（短信/邮件/社交外发/代打电话）
 * 的工具在自主任务通道一律要求人工审批。新工具落地只要分类正确即自动纳管，
 * 不再依赖逐个补本名单。
 *
 * 2026-09-28 去掉 includes("payment"/"transfer"/"wallet") 子串规则：子串命中
 * 不看 risk 轴，把 payment.query_order 等纯只读工具也拦成
 * 高危（trajectories 实证：social.get_feed 被拦 6 次、wallet 查询 4 次）。
 * 资金/外发治理以 FeatureCatalog 分类为唯一口径；静态名单只保留需两阶段确认的
 * 四件套作兜底（与 TWO_PHASE_CONFIRM_TOOLS 同集）。
 */
function isHighRiskFinancialTool(toolName: string): boolean {
  if (
    toolName === "shopping.order.place" ||
    // 统一预订层（方案 A）：所有真实/模拟下单工具一律人工审批
    toolName === "ride_hailing.book" ||
    toolName === "home_service.book" ||
    toolName === "restaurant.book"
  ) {
    return true;
  }
  const cls = classifyFeatureByName(toolName);
  return cls.risk === "spend" || cls.risk === "outbound";
}

/**
 * 工具名级高危判定（2026-09-19 P1-1 危害把握：请求卡拦截用）。
 * 与 isHighRiskFinancialTool 同口径（静态名单 + FeatureCatalog risk 分类），
 * 导出供 tool-loop 在「请求卡转正加载」时做前置拦截——高危工具不因模型一句
 * <tool_request> 就自动进入 chat 车道可见集，资金/外发动作必须走 task.dispatch
 * 派发后台 + 人工审批，或既有两阶段确认。
 *
 * 传入 input 时按复合 action 解析成真实执行器名再判定（ride_hailing+book 与
 * ride_hailing.book 同判）；拿不到参数的名字级调用保持族名兜底。
 */
export function isHighRiskToolName(
  toolName: string,
  input?: Record<string, unknown>,
): boolean {
  return isHighRiskFinancialTool(input ? resolveEffectiveToolName(toolName, input) : toolName);
}

/**
 * 敏感输入文本判定（CDP 可信输入门用）。
 * 金融敏感词一律拒绝，个人信息词要求用户自行输入。
 */
export function isSensitiveTypedText(text: string): { sensitive: boolean; reason?: string } {
  if (INPUT_DENY_REGEX.test(text)) {
    return {
      sensitive: true,
      reason: "文本包含敏感金融信息（转账/汇款/支付/密码/验证码），禁止自动输入",
    };
  }
  if (INPUT_HIGH_RISK_REGEX.test(text)) {
    return {
      sensitive: true,
      reason: "文本包含敏感个人信息（账号/账户/金额/身份证/银行卡），请让用户自行输入",
    };
  }
  return { sensitive: false };
}

/**
 * 内置两阶段确认（ask_first）工具：阶段一 confirm=false 只生成摘要+确认 token、
 * 不执行任何不可逆动作；阶段二 confirm=true+token 的 token 即用户确认凭证。
 *
 * 聊天通道的 brain 安全门（limbic-cortex convertSafetyResult）据此放行：
 * 阶段一 = ask_first 的「问」，阶段二 = 用户已在会话内明确同意。
 * 自主任务通道不受影响（require_approval 照常挂起等 approveTask）。
 */
export const TWO_PHASE_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  "shopping.order.place",
  "ride_hailing.book",
  "home_service.book",
  "restaurant.book",
]);

// --------------------------------------------------------------------------- //
// 辅助函数
// --------------------------------------------------------------------------- //

/** 审计日志摘要最大字符数 */
const AUDIT_SUMMARY_MAX = 200;

/** 把任意值安全序列化为字符串(循环引用/异常时退化为 String()) */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 截断字符串到指定长度,超长追加 ...<truncated> */
function truncate(s: string, max: number = AUDIT_SUMMARY_MAX): string {
  return s.length > max ? s.slice(0, max) + "...<truncated>" : s;
}

// --------------------------------------------------------------------------- //
// 安全层主类
// --------------------------------------------------------------------------- //

export class AgentTaskSafety {
  constructor(private readonly auditService?: AuditService) {}

  /**
   * 检查单次工具调用是否安全。
   *
   * 判定顺序:
   *   1. DENIED_ACTIONS 命中 → deny(绝对拒绝)
   *   2. HIGH_RISK_TOOL_PATTERNS 命中 → require_approval(需人工审批)
   *   3. 其他 → allow(默认放行;工具暴露范围由 provider 基于 streamOpts 控制)
   */
  checkToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): SafetyCheckResult {
    // 复合工具按 action 解析成真实执行器名再判定：ride_hailing+book 必须与
    // ride_hailing.book 同档（两阶段/审批），而 quote/status 等只读分支不被族名连坐。
    const effectiveName = resolveEffectiveToolName(toolName, args);

    // 1. 绝对禁止规则优先(即使审批也拒)
    for (const rule of DENIED_ACTIONS) {
      if (rule.tool !== "*" && rule.tool !== effectiveName) continue;
      try {
        if (rule.match(args, effectiveName)) {
          return {
            isHighRisk: true,
            action: "deny",
            reason: rule.reason,
            matchedRule: `DENIED:${rule.tool}`,
          };
        }
      } catch {
        // match 函数异常时保守跳过该规则,继续判定下一条
      }
    }

    // 2. 高危规则(需人工审批)
    for (const rule of HIGH_RISK_TOOL_PATTERNS) {
      if (rule.tool !== "*" && rule.tool !== effectiveName) continue;
      try {
        if (rule.match(args, effectiveName)) {
          return {
            isHighRisk: true,
            action: "require_approval",
            reason: rule.reason,
            matchedRule: `HIGH_RISK:${rule.tool}`,
          };
        }
      } catch {
        // match 异常,跳过该规则
      }
    }

    // 3. 默认放行(工具暴露范围已由 provider 基于 streamOpts 控制)
    return {
      isHighRisk: false,
      action: "allow",
      matchedRule: `DEFAULT_ALLOW:${toolName}`,
    };
  }

  /**
   * 检查任务目标是否高危(创建任务时调用)。
   *
   * 目标文本命中通用危险关键词或金融敏感词时,标记为 require_approval。
   * 不会返回 deny(deny 仅用于具体工具调用)。
   */
  checkGoal(goal: string): SafetyCheckResult {
    if (!goal || typeof goal !== "string") {
      return { isHighRisk: false, action: "allow" };
    }

    // 命中通用危险关键词(删除/清空/格式化/卸载等)
    if (GENERIC_HIGH_RISK_REGEX.test(goal)) {
      return {
        isHighRisk: true,
        action: "require_approval",
        reason: "任务目标包含高危关键词(删除/清空/格式化/卸载/关闭服务/停止进程)",
        matchedRule: "GOAL:generic_high_risk",
      };
    }

    // 命中金融敏感词(转账/支付/密码等)
    if (INPUT_DENY_REGEX.test(goal)) {
      return {
        isHighRisk: true,
        action: "require_approval",
        reason: "任务目标涉及敏感金融操作(转账/汇款/支付/密码/验证码)",
        matchedRule: "GOAL:finance_sensitive",
      };
    }

    return { isHighRisk: false, action: "allow" };
  }

  /**
   * 记录审计日志。
   *
   * 若构造时传入了 AuditService,则将 taskId / toolName / args 摘要 /
   * result 摘要 / timestamp 写入审计日志文件。
   * 未传入 AuditService 时为 no-op。
   */
  async audit(
    taskId: string,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
  ): Promise<void> {
    if (!this.auditService) return;

    const argsSummary = truncate(safeStringify(args));
    const resultSummary = truncate(safeStringify(result));

    try {
      await this.auditService.record({
        taskId,
        toolName,
        argsSummary,
        resultSummary,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // 审计日志写入失败不应影响主流程,静默吞掉
    }
  }
}

// --------------------------------------------------------------------------- //
// 单例
// --------------------------------------------------------------------------- //

let instance: AgentTaskSafety | null = null;

/** 获取 AgentTaskSafety 单例(未初始化时以无 AuditService 模式创建) */
export function getAgentTaskSafety(): AgentTaskSafety {
  if (!instance) {
    instance = new AgentTaskSafety();
  }
  return instance;
}

/** 注入 AuditService 初始化单例(应用启动时调用一次) */
export function initAgentTaskSafety(auditService?: AuditService): AgentTaskSafety {
  instance = new AgentTaskSafety(auditService);
  return instance;
}
