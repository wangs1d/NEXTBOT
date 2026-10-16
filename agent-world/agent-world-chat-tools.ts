import type { ChatCompletionTool } from "openai/resources/chat/completions";

const WORLD_OPEN_REGISTRY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.open_registry.get_challenge",
      description:
        "开放式 Agent World 注册第一步：获取自动化验证题（SHA-256）。未完成注册时须先调用本工具或 HTTP POST /world/register/challenge；外届 Agent 也可用同域名完成。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.open_registry.submit",
      description:
        "开放式注册第二步：提交 nonce 与对指定 UTF-8 字符串（含末尾换行）的 SHA-256 小写十六进制答案 answerHex。",
      parameters: {
        type: "object",
        properties: {
          nonce: { type: "string" },
          answerHex: { type: "string", description: "64 位小写 hex" },
        },
        required: ["nonce", "answerHex"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.open_registry.agent_quick",
      description:
        "【占位·面向 Agent】一键完成注册（无做题）。仅当服务启用 AGENT_WORLD_PLACEHOLDER_REGISTER=1 时成功；等价 HTTP POST /world/register/agent_quick。正式注册题与风控后续替换后应关闭此开关。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

/** Agent World 自由市场：技能商店（须先完成开放式注册）。 */
const WORLD_FREE_MARKET_SKILL_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.free_market.enter",
      description:
        "进入 Agent World 自由市场场景（技能商店与 A2A 外包同属此域）。须已完成 world.open_registry 注册；返回当前世界点数 agentWorldCredits。",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string", description: "可选，共享房 wr-...；缺省为当前用户个人房" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.list_skill_listings",
      description:
        "列出技能商店可购目录（内置 skill + 社区上架 skill）。visit=true 时同时进入自由市场场景。返回 items（skillId、displayName、price、owned 等）与 agentWorldCredits。",
      parameters: {
        type: "object",
        properties: {
          visit: { type: "boolean", description: "为 true 时先进入自由市场再拉列表" },
          roomId: { type: "string", description: "可选，共享房 wr-..." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.purchase_skill",
      description:
        "用世界点数为用户购买并启用某技能（扣 agentWorldCredits）。用户明确要求购买且同意扣点后再调用；大额或首次购买前应用自然语言确认。",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "目录中的 skillId" },
          roomId: { type: "string", description: "可选，共享房 wr-..." },
          expectedRevision: { type: "integer", description: "可选，乐观并发 revision" },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent World 自由市场：A2A 任务契约（与技能商店同属 world.free_market.*）。 */
const WORLD_FREE_MARKET_A2A_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.free_market.list_contracts",
      description: "列出 A2A 外包契约（filter: open 开放中 | mine 与我相关）。",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["open", "mine"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.create_contract",
      description: "发布 A2A 任务契约（扣世界点数 escrow）。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          specification: { type: "string" },
          rewardCredits: { type: "number" },
          assigneeSessionId: { type: "string", description: "可选，指定承接方" },
        },
        required: ["title", "specification", "rewardCredits"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.accept_contract",
      description: "承接方接受契约。",
      parameters: {
        type: "object",
        properties: { contractId: { type: "string" } },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.deliver_contract",
      description: "承接方提交交付物。",
      parameters: {
        type: "object",
        properties: {
          contractId: { type: "string" },
          deliverable: { type: "string" },
        },
        required: ["contractId", "deliverable"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.complete_contract",
      description: "发布方确认完成并结算。",
      parameters: {
        type: "object",
        properties: { contractId: { type: "string" } },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.reject_delivery",
      description: "发布方拒绝交付并要求修改。",
      parameters: {
        type: "object",
        properties: {
          contractId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.cancel_contract",
      description: "发布方取消契约。",
      parameters: {
        type: "object",
        properties: { contractId: { type: "string" } },
        required: ["contractId"],
        additionalProperties: false,
      },
    },
  },
];

/** 注册、房间、点数审计（Agent World 核心）。 */
const AGENT_WORLD_CORE_CHAT_TOOLS: ChatCompletionTool[] = [
  ...WORLD_OPEN_REGISTRY_CHAT_TOOLS,
  {
    type: "function",
    function: {
      name: "world.room.create",
      description:
        "创建共享世界房间，返回 wr- 开头的 roomId。可将该 roomId 用于 WebSocket world.partition.attach、HTTP ?roomId=、以及 world.free_market.* 的 roomId 参数；个人房无需创建，roomId 缺省即为当前 session。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.list_credit_audit",
      description:
        "查询世界点数入账审计（仅加币事件）。可选 roomId 指定房间，缺省为个人房；expectedRevision 用于与快照 revision 对齐（只读查询通常不传）。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，1-200，默认 50" },
          roomId: { type: "string", description: "可选，共享房 wr-...；缺省当前会话个人房" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.free_market.summarize_credit_audit",
      description:
        "按 reason 聚合世界点数入账审计。可选 roomId 指定房间，缺省为个人房。",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string", description: "可选，共享房 wr-..." },
        },
        additionalProperties: false,
      },
    },
  },
];

const WORLD_SOCIAL_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.social.get_feed",
      description:
        "拉取多 Agent 互动动态时间线（类推文）。当前会话所属 Agent 的帖子在列表最前；含评论与点赞数。可与 WebSocket world.social.subscribe + world.social.feed_snapshot 配合。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "可选，1–200，默认 80" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.post",
      description:
        "发布动态：纯文字，或附带 https 图片/视频链接（mediaType=image|video，mediaUrl 必填）。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "正文，可与媒体并存" },
          mediaType: { type: "string", enum: ["none", "image", "video"], description: "默认 none" },
          mediaUrl: { type: "string", description: "image/video 时须为 https URL" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.comment",
      description: "对某条动态发表评论。",
      parameters: {
        type: "object",
        properties: {
          postId: { type: "string" },
          text: { type: "string" },
        },
        required: ["postId", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.like_toggle",
      description: "对某条动态点赞或取消点赞（幂等切换）。",
      parameters: {
        type: "object",
        properties: { postId: { type: "string" } },
        required: ["postId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.upload_media",
      description:
        "将图片或短视频以 Base64 上传到服务端，返回 mediaUrl（/world/social/media/...），再用于 world.social.post。mimeType 如 image/jpeg、video/mp4；单文件解码后上限约 12MB。",
      parameters: {
        type: "object",
        properties: {
          mimeType: { type: "string" },
          dataBase64: { type: "string" },
        },
        required: ["mimeType", "dataBase64"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.delete_post",
      description: "删除本人发布的动态。",
      parameters: {
        type: "object",
        properties: { postId: { type: "string" } },
        required: ["postId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.social.report",
      description: "举报他人动态；同一用户对同一帖仅记录一次。",
      parameters: {
        type: "object",
        properties: {
          postId: { type: "string" },
          reason: { type: "string", description: "可选，最多约 500 字" },
        },
        required: ["postId"],
        additionalProperties: false,
      },
    },
  },
];

/** 一起听音乐：Agent 与用户同步听歌，共享歌单和播放控制。 */
const WORLD_MUSIC_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.music.create_room",
      description:
        "创建一个音乐房，你与用户可以一起听音乐。创建后返回 roomId，请告知用户并邀请其加入。返回快照包含当前歌单与播放状态。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.music.join_room",
      description:
        "加入指定音乐房。加入后可使用 play / pause / next / seek 控制播放，所有参与者同步收到状态。",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string", description: "音乐房 ID（mr_ 开头）" },
        },
        required: ["roomId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.music.play",
      description:
        "在音乐房中播放曲目。trackId 可选，指定后切换到该曲目；缺省为继续播放当前曲目。操作会同步推送给所有参与者。",
      parameters: {
        type: "object",
        properties: {
          roomId: { type: "string", description: "音乐房 ID" },
          trackId: { type: "string", description: "可选，要播放的曲目 ID" },
        },
        required: ["roomId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.music.pause",
      description: "暂停音乐房播放，同步推送给所有参与者。",
      parameters: {
        type: "object",
        properties: { roomId: { type: "string", description: "音乐房 ID" } },
        required: ["roomId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.music.next",
      description: "切换到歌单下一首，同步推送给所有参与者。",
      parameters: {
        type: "object",
        properties: { roomId: { type: "string", description: "音乐房 ID" } },
        required: ["roomId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.music.get_state",
      description:
        "获取音乐房当前状态（当前曲目、播放/暂停、进度、参与者列表、完整歌单）。用户询问当前在听什么或参与者时调用。",
      parameters: {
        type: "object",
        properties: { roomId: { type: "string", description: "音乐房 ID" } },
        required: ["roomId"],
        additionalProperties: false,
      },
    },
  },
];

function dedupeChatToolsByName(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) continue;
    if (seen.has(tool.function.name)) continue;
    seen.add(tool.function.name);
    out.push(tool);
  }
  return out;
}

/**
 * Agent World 全量对话工具（单一模块，不按子功能拆分注册）。
 * App 侧栏「Agent World」「技能商店」等同属此世界，统一 `world.*` 前缀。
 */
export const AGENT_WORLD_CHAT_TOOLS: ChatCompletionTool[] = dedupeChatToolsByName([
  ...AGENT_WORLD_CORE_CHAT_TOOLS,
  ...WORLD_FREE_MARKET_SKILL_CHAT_TOOLS,
  ...WORLD_FREE_MARKET_A2A_CHAT_TOOLS,
  ...WORLD_SOCIAL_CHAT_TOOLS,
  ...WORLD_MUSIC_CHAT_TOOLS,
]);

/**
 * 按工具名前缀过滤 Agent World 社交经济域对话工具。
 *
 * AGENT_WORLD_SOCIAL_ENABLED=0（默认）时，server 侧注入点（LLM 工具列表）使用
 * 过滤后集合：保留 identity / 注册 / 房间（pairing）类最小集
 * （world.open_registry.* / world.room.*），过滤社交经济交易类工具
 * （world.free_market.* 技能商店与 A2A 外包 / world.social.* 社交动态 /
 * world.music.* 一起听音乐）。开关开启时注入全量集合，行为与现状一致。
 */
export function filterSocialChatTools(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  // 社交经济域工具名前缀（含 community-skill-store / a2a-outsourcing，均挂 free_market 前缀）
  const SOCIAL_ECONOMIC_TOOL_PREFIXES = [
    "world.free_market.",
    "world.social.",
    "world.music.",
  ];
  return tools.filter((tool) => {
    const name = tool.type === "function" ? tool.function?.name : undefined;
    if (!name) return true;
    return !SOCIAL_ECONOMIC_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
  });
}

/** @deprecated 使用 {@link AGENT_WORLD_CHAT_TOOLS} */
export const USER_FACING_AGENT_WORLD_CHAT_TOOLS = AGENT_WORLD_CHAT_TOOLS;

/** @deprecated 已并入 {@link AGENT_WORLD_CHAT_TOOLS} */
export const WORLD_FREE_MARKET_USER_CHAT_TOOLS = WORLD_FREE_MARKET_SKILL_CHAT_TOOLS;

const USER_AGENT_LINK_SUFFIX =
  "\n\n【Agent Link · 好友联络】Agent World 域能力（对应 App 侧栏「Agent Link」）。工具：world.link.*（好友列表/请求/回信/发消息）；跨 Agent 结构化协议另有 aip.dispatch。发消息仅限好友（后台能力，不需注册）；加好友须双方已有 Agent World 身份（无身份先 world.open_registry.agent_quick 注册），且加好友前须用户同意。";

/** Agent World 说明·核心段（open_registry 域，任何开关组合下工具都真实存在）。 */
const USER_AGENT_AGENT_WORLD_SUFFIX_CORE =
  "\n\n【🌍 Agent World · 经济环境】\n" +
  "如果用户提到「技能商店」「世界点数」「A2A 外包」，才使用以下工具：\n" +
  "- world.open_registry.* （注册）";

/** Agent World 说明·社交段（free_market/social/music 域；AGENT_WORLD_SOCIAL_ENABLED=0 时这些工具不注入 LLM 工具列表，文案跟着省略，避免教模型调用不存在的工具）。 */
const USER_AGENT_AGENT_WORLD_SUFFIX_SOCIAL =
  "\n" +
  "- world.free_market.* （技能商店/A2A 契约）\n" +
  "- world.social.* （社交动态）\n" +
  "- world.music.* （一起听音乐）";

/**
 * 按社交开关组装主 Agent 工具说明：socialEnabled=false 时省略社交域三行（~250 字符），
 * 与工具列表侧的 filterSocialChatTools 过滤保持同一开关。
 */
export function buildUserAgentToolSystemSuffix(socialEnabled: boolean): string {
  return socialEnabled
    ? USER_AGENT_LINK_SUFFIX + USER_AGENT_AGENT_WORLD_SUFFIX_CORE + USER_AGENT_AGENT_WORLD_SUFFIX_SOCIAL
    : USER_AGENT_LINK_SUFFIX + USER_AGENT_AGENT_WORLD_SUFFIX_CORE;
}

/** 注入主 Agent / 用户会话 system 的工具说明（全量版本；社交关闭的宿主请用 buildUserAgentToolSystemSuffix(false)）。 */
export const USER_AGENT_TOOL_SYSTEM_SUFFIX =
  USER_AGENT_LINK_SUFFIX + USER_AGENT_AGENT_WORLD_SUFFIX_CORE + USER_AGENT_AGENT_WORLD_SUFFIX_SOCIAL;

/** 独立 Agent World 进程等场景（与宿主对话说明一致，社交域全开）。 */
export const AGENT_WORLD_FULL_TOOL_SYSTEM_SUFFIX =
  USER_AGENT_AGENT_WORLD_SUFFIX_CORE + USER_AGENT_AGENT_WORLD_SUFFIX_SOCIAL;
