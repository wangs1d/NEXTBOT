/**
 * 工具风险分级（ToolRiskClass）—— 自主执行安全口径的单一事实源。
 *
 * 背景：此前的安全门按"工具名正则"拦截（ACT_TOOL_DENY_RE），改名即可绕过，
 * 且金额类工具（wallet.transfer 等）不在名单内——"是否涉钱"由 LLM 自觉。
 * 本模块按风险等级给全量工具分级，供四处强制消费：
 *   1. hub act-loop：money/irreversible 一律不允许静默执行（转 ask_first/拒绝）
 *   2. action-utility.deriveRiskFromSteps：等级映射风险维度（金融高档/不可逆）
 *   3. 工具循环幂等闸：money/irreversible 重复调用短窗拦截（防重试双下单）
 *   4. 审计：money/irreversible 的每次调用落盘（args 脱敏）
 *
 * 分级原则（宁严勿松）：
 *   irreversible —— 不可逆/系统级：shell、删除/格式化/重启类
 *   money        —— 花钱：支付/转账/下单/充值（真实或模拟通道，口径一致）
 *   write        —— 有副作用但可逆：建日程/发消息/控设备/派任务
 *   read_only    —— 纯读：查询/列表/快照
 * 未识别工具默认 write（保守：按"有副作用"对待，不给静默执行开绿灯）。
 */

export type ToolRiskClass = "read_only" | "write" | "money" | "irreversible";

/** 不可逆/系统级（优先级最高；含 \bkill 防 skill 误伤的写法由消费方正则兜底） */
const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /(^|\.)(run_shell|run_automation)$/,
  /(^|\.)(shell|exec|format|wipe|shutdown|reboot|uninstall)$/i,
  /(^|\.|_)(delete|remove|drop|kill|destroy|purge)(\.|_|$)/i,
  /(^|\.)(reset|clear)_all/i,
];

/** 花钱（支付通道/钱包/下单；alipay.* 整族走真实 CLI，一律按 money） */
const MONEY_PATTERNS: RegExp[] = [
  /^alipay\./,
  /^payment\./,
  /^wallet\.(transfer|purchase|recharge|pay|withdraw)/,
  /^shopping\.(order\.place|pay\.submit)/,
  /^finance\.pay_bill/,
];

/** 明确只读的家族/模式（命中 → read_only；未命中且无副作用模式 → write） */
const READ_ONLY_PATTERNS: RegExp[] = [
  /(^|\.)(list|get|query|search|find|overview|status|state|stats|health|track|read|view|check|recall|where|preview|snapshot|screenshot|log|logs|notifications|sms_list|call_log|battery|observe|look|verify|analyze|suggest|capabilities|probe)(\.|_|$)/i,
  /^(brain\.recall|brain\.look|brain\.listen|perception\.|messages\.(overview|list|read)|phone\.(battery|call_log|notifications|sms_list|locate|screen_record)|device\.list|calendar\.(list|query|find)|reminder\.(query|schedule)$)/,
  /(_list$|_query$|_status$|_overview$)/,
];

/**
 * 复合工具（单入口 + `action` 分流）的 action 级风险覆盖。
 *
 * 2026-11-11 起 calendar / geofence / smart_home 合并为单函数名，按名匹配
 * （delete→irreversible、list→read_only）失效：必须看调用参数里的 action。
 * 未传 args 或 action 不在表内 → 落回按名分级（保守 write）。
 */
const COMPOSITE_ACTION_RISK: Record<string, Record<string, ToolRiskClass>> = {
  calendar: {
    list_tasks: "read_only",
    find_free_slots: "read_only",
    create: "write",
    batch_create: "write",
    update_task: "write",
    delete_task: "irreversible",
  },
  geofence: {
    list: "read_only",
    create: "write",
    delete: "irreversible",
  },
  smart_home: {
    list_devices: "read_only",
    control_device: "write",
    scene: "write",
  },
};

/**
 * 分级（优先级 irreversible > money > read_only > write）。
 * 未知工具按 write 对待——分级错误的代价不对称：把读误判为写只损失一点便利，
 * 把写误判为读可能变成静默执行的资金/数据事故。
 */
export function classifyToolRisk(
  toolName: string,
  args?: Record<string, unknown> | null,
): ToolRiskClass {
  const name = String(toolName ?? "").trim();
  if (!name) return "write";
  const composite = COMPOSITE_ACTION_RISK[name];
  if (composite) {
    const action = String(args?.action ?? "").trim();
    const mapped = composite[action];
    if (mapped) return mapped;
  }
  for (const re of IRREVERSIBLE_PATTERNS) if (re.test(name)) return "irreversible";
  for (const re of MONEY_PATTERNS) if (re.test(name)) return "money";
  for (const re of READ_ONLY_PATTERNS) if (re.test(name)) return "read_only";
  return "write";
}

/** 敏感工具（审计 + 幂等闸 + 自主执行强制的消费口径）：money 或 irreversible */
export function isSensitiveTool(
  toolName: string,
  args?: Record<string, unknown> | null,
): boolean {
  const risk = classifyToolRisk(toolName, args);
  return risk === "money" || risk === "irreversible";
}
