/**
 * 能力就绪注册表（渐进式解锁的数据源）。
 *
 * 设计约束（内测期 → 平台供 key 的演进预留）：
 * - 每个能力域只声明「依赖哪些配置」，不声明「配置由谁提供」。
 *   配置来源由 CAPABILITY_CONFIG_MODE 决定：byok（内测默认，用户自备 key）/
 *   platform（统一服务付费，平台代供）。客户端卡片据此切换文案与动作，
 *   未来切到 platform 时不需要改任何能力定义。
 * - 就绪检查只读 process.env / 既有 config getter，不做网络探测（接口要轻）。
 * - 检查不齐全 ≠ 不可用：部分能力有 mock/模拟回退（如支付），用 note 说明。
 */

export type CapabilityConfigSource = "byok" | "platform";

export type CapabilityReadinessState = "ready" | "needs_config" | "disabled";

export interface CapabilityReadinessResult {
  state: CapabilityReadinessState;
  /** 缺失的 env 变量名（needs_config 时非空） */
  missingEnv: string[];
  /** 面向用户的补充说明（如"未配置商户凭证时为模拟支付"） */
  note?: string;
}

interface CapabilityEnvGroup {
  /** 组内任一变量有值即该组通过（多 provider 互备） */
  anyOf?: string[];
  /** 组内全部变量有值才通过（同一服务的配套凭证） */
  allOf?: string[];
  /** 该组未配置时的用户提示 */
  hint: string;
  /** false = 增强项：不配置也 ready，仅降级/受限 */
  required?: boolean;
}

interface CapabilityEntry {
  id: string;
  label: string;
  description: string;
  /** 实验能力：卡片打"实验"徽标，提示稳定性预期 */
  experimental?: boolean;
  groups: CapabilityEnvGroup[];
  /** 自定义检查（优先于 groups） */
  check?: () => CapabilityReadinessResult;
}

function envHas(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function evalGroup(group: CapabilityEnvGroup): { ok: boolean; missing: string[] } {
  const names = group.anyOf ?? group.allOf ?? [];
  if (names.length === 0) return { ok: true, missing: [] };
  const missing = names.filter((n) => !envHas(n));
  if (group.anyOf) return { ok: missing.length < names.length, missing };
  return { ok: missing.length === 0, missing };
}

const CAPABILITY_ENTRIES: CapabilityEntry[] = [
  {
    id: "chat_core",
    label: "对话核心",
    description: "文字/语音对话主链路，多模型故障切换",
    groups: [
      {
        anyOf: ["MOONSHOT_API_KEY", "MINIMAX_API_KEY", "OPENAI_API_KEY"],
        required: true,
        hint: "至少配置一个对话模型 key（MOONSHOT_API_KEY / MINIMAX_API_KEY / OPENAI_API_KEY）",
      },
    ],
  },
  {
    id: "agentic_memory",
    label: "长期记忆",
    description: "记住你的偏好与事实，越用越懂你（内置本地向量引擎，零配置即用）",
    groups: [
      {
        anyOf: ["AGENT_EMBEDDING_API_KEY"],
        hint: "可选：配置远端 Embedding 端点可提升记忆检索质量（内置本地引擎默认可用）",
      },
    ],
  },
  {
    id: "proactive",
    label: "主动服务",
    description: "早报晚报、到点提醒、会前预警，打扰有分寸",
    groups: [],
  },
  {
    id: "travel_booking",
    label: "旅行订票",
    description: "机票/火车/酒店比价、预订、退改签、到站管家",
    groups: [
      // 主链路（本地库 + 飞猪 FlyAI + 浏览器比价）无需 key 即可用；各供应商 key 为增强项
      // （飞猪 FlyAI 无需 API key：安装 flyai CLI 即自动挂载，npm i -g @fly-ai/flyai-cli）
      {
        allOf: ["JUHE_TRAIN_KEY"],
        hint: "配置 JUHE_TRAIN_KEY 解锁火车票实时查询（聚合数据）",
      },
      {
        allOf: ["VARIFLIGHT_APP_ID", "VARIFLIGHT_APP_SECRET"],
        hint: "配置 VARIFLIGHT_APP_ID / VARIFLIGHT_APP_SECRET 解锁航班动态（航旅纵横）",
      },
      {
        anyOf: ["AMAP_WEB_KEY", "RIDE_AMAP_WEB_KEY"],
        hint: "配置 AMAP_WEB_KEY 解锁接站/接机与到站打车",
      },
    ],
  },
  {
    id: "ride_hailing",
    label: "打车出行",
    description: "网约车叫车与行程跟踪（滴滴 MCP / 高德打车）",
    groups: [
      {
        anyOf: ["DIDI_MCP_KEY", "AMAP_WEB_KEY", "RIDE_AMAP_WEB_KEY"],
        required: true,
        hint: "配置 DIDI_MCP_KEY（滴滴）或 AMAP_WEB_KEY（高德打车）",
      },
    ],
  },
  {
    id: "luckin_coffee",
    label: "瑞幸点单",
    description: "语音/对话点咖啡，到店自取",
    experimental: true,
    groups: [
      {
        allOf: ["LUCKIN_MCP_TOKEN"],
        required: true,
        hint: "配置 LUCKIN_MCP_TOKEN（瑞幸下单 MCP）",
      },
    ],
  },
  {
    id: "meituan_errand",
    label: "美团跑腿",
    description: "帮买帮送跑腿下单",
    experimental: true,
    groups: [
      {
        allOf: ["MEITUAN_AI_HUB_TOKEN", "MEITUAN_AI_HUB_SKILL_ID"],
        required: true,
        hint: "配置 MEITUAN_AI_HUB_TOKEN 与 MEITUAN_AI_HUB_SKILL_ID",
      },
    ],
  },
  {
    id: "package_track",
    label: "快递包裹",
    description: "在途包裹聚合与轨迹查询（通知流捕捉免密钥可用，补官方轨迹需顺丰丰桥）",
    groups: [
      {
        allOf: ["SF_QIAO_PARTNER_ID", "SF_QIAO_CHECK_WORD"],
        hint: "配置 SF_QIAO_PARTNER_ID / SF_QIAO_CHECK_WORD 补全官方轨迹（丰桥个人认证即可，接口免费）",
      },
    ],
  },
  {
    id: "shopping_payment",
    label: "购物与代付",
    description: "商品比价、代下单、扫码代付（带护栏限额）",
    groups: [
      {
        allOf: ["WECHAT_PAY_APP_ID", "WECHAT_PAY_MCH_ID", "WECHAT_PAY_API_KEY"],
        hint: "配置微信支付商户三元组解锁微信真实付款",
      },
      {
        allOf: ["ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY"],
        hint: "配置支付宝应用私钥解锁支付宝真实付款",
      },
    ],
  },
  {
    id: "home_assistant",
    label: "智能家居",
    description: "通过 Home Assistant 控制家中设备",
    groups: [
      {
        allOf: ["HA_BASE_URL", "HA_TOKEN"],
        required: true,
        hint: "配置 HA_BASE_URL 与 HA_TOKEN（Home Assistant 长期访问令牌）",
      },
    ],
  },
  {
    id: "voice_chat",
    label: "语音对话",
    description: "语音播报（TTS）与实时语音对话",
    groups: [
      {
        allOf: ["MINIMAX_API_KEY"],
        hint: "配置 MINIMAX_API_KEY 解锁语音播报与实时语音（MiniMax）",
      },
    ],
  },
  {
    id: "web_search",
    label: "联网搜索",
    description: "实时资讯、比价与资料检索",
    groups: [
      {
        anyOf: ["SEARCH_API_KEY", "BING_SEARCH_API_ENDPOINT", "JINA_API_KEY"],
        hint: "配置 SEARCH_API_KEY 等可增强搜索质量（默认必应中国源无需 key）",
      },
    ],
  },
  {
    id: "wechat_bridge",
    label: "微信接入",
    description: "把微信消息接入 Agent 代收代复",
    experimental: true,
    groups: [
      {
        allOf: ["WECHAT_CLAW_ACCOUNT_ID"],
        required: true,
        hint: "配置 WECHAT_CLAW_ACCOUNT_ID 并开启 WECHAT_CLAW_ENABLED",
      },
    ],
  },
];

export interface CapabilityStatus {
  id: string;
  label: string;
  description: string;
  experimental: boolean;
  state: CapabilityReadinessState;
  /** needs_config 时：缺失变量名 + 各组配置提示（客户端"去配置"引导用） */
  missingEnv: string[];
  hints: string[];
  note?: string;
}

/** 配置来源：byok = 用户自备 key（内测）；platform = 平台统一供 key（统一服务付费） */
export function getCapabilityConfigSource(): CapabilityConfigSource {
  return process.env.CAPABILITY_CONFIG_MODE?.trim().toLowerCase() === "platform"
    ? "platform"
    : "byok";
}

function evaluateEntry(entry: CapabilityEntry): CapabilityReadinessResult {
  if (entry.check) return entry.check();
  const missingEnv: string[] = [];
  let blocked = false;
  for (const group of entry.groups) {
    if (group.required === false) continue;
    const r = evalGroup(group);
    if (!r.ok) {
      blocked = true;
      missingEnv.push(...r.missing);
    }
  }
  return blocked
    ? { state: "needs_config", missingEnv, note: undefined }
    : { state: "ready", missingEnv: [], note: undefined };
}

/** 全量能力状态（HTTP /api/capabilities 的数据源，纯内存计算，无 IO） */
export function listCapabilityStatuses(): {
  configSource: CapabilityConfigSource;
  capabilities: CapabilityStatus[];
} {
  const configSource = getCapabilityConfigSource();
  const capabilities = CAPABILITY_ENTRIES.map((entry) => {
    const requiredGroups = entry.groups.filter((g) => g.required !== false);
    const optionalGroups = entry.groups.filter((g) => g.required === false);
    const hints = [
      ...requiredGroups.filter((g) => !evalGroup(g).ok).map((g) => g.hint),
      ...optionalGroups.filter((g) => !evalGroup(g).ok).map((g) => g.hint),
    ];

    if (configSource === "platform") {
      // 平台供 key 模式：能力统一就绪，用户无感
      return {
        id: entry.id,
        label: entry.label,
        description: entry.description,
        experimental: entry.experimental === true,
        state: "ready" as const,
        missingEnv: [],
        hints: [],
        note: "由平台统一提供",
      };
    }

    const result = evaluateEntry(entry);
    // 只配了增强项、必配组齐全时，若存在未配置的增强组则附说明
    const note =
      result.state === "ready" && hints.length > 0 ? "部分增强能力未配置，主功能可用" : result.note;
    return {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      experimental: entry.experimental === true,
      state: result.state,
      missingEnv: result.missingEnv,
      hints,
      note,
    };
  });
  return { configSource, capabilities };
}
