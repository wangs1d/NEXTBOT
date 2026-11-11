/**
 * 复合工具层：把同一后端链路上的细分动作收进一个 schema，用 action 分流。
 *
 * 设计约束：
 * - 模型只看见本文件的 11 个复合工具；被收编的细分工具仍保留执行器，
 *   由复合 handler 内部转发（registry.execute），不再出现在工具面上。
 * - 复合 schema 的字段沿用旧工具字段名，handler 原样透传（只剔除 action），
 *   避免在映射层再造一套参数语义。
 * - action 的 description 必须写清「什么时候用这个分支」，它是模型分化的唯一依据；
 *   keywords 同时承担两件事：写进 description 供模型判断，以及模型漏填 action 时
 *   按参数/词面做确定性兜底（resolveCompositeAction）。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { ToolHandler, ToolRegistry } from "../tools/tool-registry.js";

interface ActionSpec {
  /** 被收编的执行器名 */
  tool: string;
  /** 给模型看的分支说明 */
  desc: string;
  /** 该分支的用户口语触发词（写进 schema，也用于兜底路由） */
  keywords: string[];
  /** 该分支独有、可用于兜底判定的参数名 */
  params?: string[];
}

interface CompositeSpec {
  name: string;
  description: string;
  actions: Record<string, ActionSpec>;
  /** 兜底分支：无 action、无参数、无触发词时使用；必须是只读分支 */
  defaultAction: string;
  /** 合并后的参数表（沿用旧工具字段名） */
  properties: Record<string, unknown>;
}

function buildSchema(spec: CompositeSpec): ChatCompletionTool {
  const branches = Object.entries(spec.actions)
    .map(([action, s]) => {
      const trigger = s.keywords.length > 0 ? `；触发语：${s.keywords.join("、")}` : "";
      // 原名要留在描述里：检索（BM25/embedding）以 schema 文本为索引，
      // 少一个原名就等于少一个入口，不能再靠代码里的别名表补。
      return `${action}（${s.desc}；原工具 ${s.tool}${trigger}）`;
    })
    .join("；");
  return {
    type: "function",
    function: {
      name: spec.name,
      description: `${spec.description}\n【action 选择】${branches}`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: Object.keys(spec.actions),
            description: "要执行的动作分支，按【action 选择】里的分支说明挑一个",
          },
          ...spec.properties,
        },
        required: ["action"],
        additionalProperties: true,
      },
    },
  };
}

function withoutAction(input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = input;
  return rest;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

const COMPOSITE_SPECS: CompositeSpec[] = [
  {
    name: "web_search",
    description:
      "联网检索的统一入口：网页搜索、深读检索、图片/视频、热搜榜、天气、行情。凡是「查一下/搜一下/网上看看」都走这里。",
    defaultAction: "web",
    actions: {
      web: {
        tool: "search_web",
        desc: "普通网页搜索，返回标题+摘要+链接",
        keywords: ["搜一下", "搜索", "查一下", "查查", "新闻", "最新消息", "资料", "网上"],
        params: ["limit"],
      },
      deep: {
        tool: "deep_search",
        desc: "需要读完正文再回答的深度检索，比 web 慢但信息完整",
        keywords: ["深度", "深读", "详细", "调研", "多来源", "全面", "深入", "核实"],
      },
      images: {
        tool: "search_images",
        desc: "找图片",
        keywords: ["图片", "照片", "壁纸", "表情包", "头像", "找图", "配图", "插画"],
        params: ["count"],
      },
      images_batch: {
        tool: "search_images_batch",
        desc: "一次找多组图",
        keywords: ["多组图", "批量找图", "几组图片"],
        params: ["queries"],
      },
      videos: {
        tool: "search_videos",
        desc: "找视频",
        keywords: ["视频", "影片", "短视频", "录像", "影视"],
      },
      find_video: {
        tool: "video.find",
        desc: "在已搜到的视频结果里按关键词定位",
        keywords: ["视频里", "视频结果", "第几个视频", "定位视频", "哪个视频"],
      },
      parse_video: {
        tool: "video.grab",
        desc: "解析/下载指定视频页",
        keywords: ["下载视频", "解析视频", "保存视频", "存下来", "视频链接"],
        params: ["url"],
      },
      hot: {
        tool: "hot_rankings",
        desc: "看当前热搜/热点榜",
        keywords: ["热搜", "热点", "热榜", "榜单", "趋势", "trending", "大家在聊"],
      },
      weather: {
        tool: "weather.get_local",
        desc: "查天气，location 缺省按用户所在地",
        keywords: ["天气", "气温", "下雨", "温度", "降温", "多少度", "空气质量"],
        params: ["location"],
      },
      quote: {
        tool: "market.quote",
        desc: "查股票/基金/汇率行情",
        keywords: ["股价", "汇率", "比特币", "行情", "涨跌", "基金", "指数", "币价"],
        params: ["symbol"],
      },
    },
    properties: {
      query: { type: "string", description: "检索词或问题" },
      queries: { type: "array", items: { type: "string" }, description: "images_batch 的多组检索词" },
      url: { type: "string", description: "parse_video 的视频页地址" },
      location: { type: "string", description: "weather 的城市名，可省略" },
      symbol: { type: "string", description: "quote 的标的代码或名称" },
      limit: { type: "integer", description: "web 返回条数，默认 5" },
      count: { type: "integer", description: "images 返回张数，默认 6" },
    },
  },
  {
    name: "web_fetch",
    description:
      "打开指定网址取内容：读正文、按问题抽取、站内导航、发原始 HTTP 请求。搜索之后要看某一页时用它。",
    defaultAction: "read",
    actions: {
      read: {
        tool: "fetch_web",
        desc: "抓网页正文并转成可读文本",
        keywords: ["读一下", "看看内容", "抓正文", "正文", "打开这个网页"],
      },
      inspect: {
        tool: "info.inspect_webpage",
        desc: "打开网页并回答某个具体问题",
        keywords: ["说了什么", "讲了什么", "写的什么", "主要内容", "讲了啥", "重点", "什么意思", "是不是真的"],
        params: ["question"],
      },
      navigate: {
        tool: "info.navigate_site",
        desc: "在目标站内按任务继续点选浏览",
        keywords: ["站内", "网站里", "这个站", "导航", "点开", "找一下", "翻一下", "浏览"],
        params: ["goal"],
      },
      raw: {
        tool: "http.request",
        desc: "调用任意 HTTP 接口",
        keywords: ["接口", "api", "请求", "curl", "post", "header"],
        params: ["method", "headers", "body", "timeout_ms"],
      },
    },
    properties: {
      url: { type: "string", description: "目标网址" },
      question: { type: "string", description: "inspect 时要从页面回答的问题" },
      goal: { type: "string", description: "navigate 时要在站内完成的目标" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "raw 的请求方法" },
      headers: { type: "object", description: "raw 的请求头" },
      body: { type: "object", description: "raw 的请求体" },
      timeout_ms: { type: "integer", description: "raw 的超时毫秒数" },
    },
  },
  {
    name: "world.link",
    description:
      "站内好友链路：看好友/待处理申请、加好友、处理申请、给好友发消息。这是 Agent 世界里的通信方式。",
    defaultAction: "list_friends",
    actions: {
      list_friends: {
        tool: "world.link.list_friends",
        desc: "看我的好友列表",
        keywords: ["好友列表", "有哪些好友", "谁是我的好友", "我的好友"],
      },
      list_requests: {
        tool: "world.link.list_friend_requests",
        desc: "看待处理的好友申请",
        keywords: ["好友申请", "加我好友", "谁加我", "待处理申请"],
      },
      send_request: {
        tool: "world.link.send_friend_request",
        desc: "加某人为好友",
        keywords: ["加好友", "添加好友", "加个好友", "交个朋友"],
        params: ["targetName", "message"],
      },
      respond_request: {
        tool: "world.link.respond_friend_request",
        desc: "同意/拒绝申请",
        keywords: ["同意申请", "拒绝申请", "通过申请", "接受申请"],
        params: ["requestId"],
      },
      send_message: {
        tool: "world.link.send_message",
        desc: "给好友发一条消息",
        keywords: ["发消息", "回复", "告诉", "给好友", "发一句", "私信", "联系他"],
        params: ["content"],
      },
    },
    properties: {
      targetId: { type: "string", description: "对方 id" },
      targetName: { type: "string", description: "对方昵称（没有 id 时用）" },
      requestId: { type: "string", description: "好友申请 id" },
      accept: { type: "boolean", description: "true 同意，false 拒绝" },
      message: { type: "string", description: "加好友时的附言" },
      content: { type: "string", description: "要发送的消息正文" },
    },
  },
  {
    name: "voice",
    description:
      "语音输出：把一段文字说出来，或直接以语音消息发给对方。用户要求「说给我听/发条语音」时用。",
    defaultAction: "speak",
    actions: {
      speak: {
        tool: "voice.speak",
        desc: "在当前会话里朗读一段文字",
        keywords: ["朗读", "念给我听", "读给我听", "读一下", "说出来", "播报", "说给我听"],
        params: ["text"],
      },
      message: {
        tool: "voice.send_message",
        desc: "生成语音消息并发送",
        keywords: ["语音消息", "发语音", "语音回复", "用语音发", "语音条"],
      },
    },
    properties: {
      text: { type: "string", description: "要转成语音的文字" },
      targetId: { type: "string", description: "发送对象 id，缺省为当前会话" },
    },
  },
  {
    name: "phone",
    description: "手机通话链路：取我的虚拟号码、代我拨打电话。",
    defaultAction: "number",
    actions: {
      number: {
        tool: "phone.ensure_my_number",
        desc: "获取/开通我的专属虚拟号码",
        keywords: ["我的号码", "虚拟号码", "联络号", "申领号码", "开通号码", "号码是多少"],
      },
      call: {
        tool: "phone.call_user",
        desc: "代我发起一通电话",
        keywords: ["打电话", "拨号", "拨个电话", "给我打", "外呼", "呼叫", "电话联系"],
        params: ["reason", "phoneNumber"],
      },
    },
    properties: {
      reason: { type: "string", description: "打电话的目的，用于开场说明" },
      phoneNumber: { type: "string", description: "被叫号码，省略时默认打给用户" },
    },
  },
  {
    name: "agent",
    description:
      "Agent 自身与用户档案：查能力边界、看任务进度、改名字签名、改主页、查用户画像。",
    defaultAction: "capabilities",
    actions: {
      capabilities: {
        tool: "agent.query_capabilities",
        desc: "不确定自己能不能办某件事时先查",
        keywords: ["能不能", "会不会", "你会什么", "能力", "能做什么", "支持什么", "办得到吗"],
        params: ["domain"],
      },
      tasks: {
        tool: "agent.tasks.list",
        desc: "看已派出去的任务办到哪了",
        keywords: ["待办", "任务", "办到哪", "进度", "跑完了吗", "执行情况"],
        params: ["status"],
      },
      update_identity: {
        tool: "agent.update_identity",
        desc: "改我的名字/签名",
        keywords: ["改名字", "改名", "签名", "叫你", "自称", "换个名字"],
        params: ["name", "signature"],
      },
      update_homepage: {
        tool: "agent.update_homepage",
        desc: "改我的主页介绍",
        keywords: ["主页", "简介", "自我介绍", "个人介绍", "首页"],
        params: ["title", "bio"],
      },
      profile: {
        tool: "profile.query",
        desc: "查用户档案字段",
        keywords: ["档案", "画像", "用户资料", "我的资料", "我的信息", "我喜欢什么", "你了解我"],
        params: ["keys"],
      },
    },
    properties: {
      domain: { type: "string", description: "capabilities 的能力域，可省略" },
      status: { type: "string", description: "tasks 的状态过滤，如 pending/running/done" },
      name: { type: "string", description: "新名字" },
      signature: { type: "string", description: "新签名" },
      title: { type: "string", description: "主页标题" },
      bio: { type: "string", description: "主页介绍" },
      keys: { type: "array", items: { type: "string" }, description: "profile 要查的字段" },
    },
  },
  {
    name: "proactivity",
    description:
      "主动性的对话侧闭环：确认后台等你拍板的动作、对打扰做反馈、问清我为什么没说话。后台负责发起，这里负责接用户的话。",
    defaultAction: "why_silent",
    actions: {
      confirm: {
        tool: "proactivity.confirmAction",
        desc: "用户对后台提议明确同意/拒绝时",
        keywords: ["就这么办", "可以办", "别办", "批准", "同意这个", "拒绝这个"],
        params: ["proposalId", "decision"],
      },
      feedback: {
        tool: "proactivity.feedback",
        desc: "用户嫌吵/说别发时记下",
        keywords: ["太吵", "别提醒", "别发了", "烦", "打扰", "少提醒"],
        params: ["signal"],
      },
      why_silent: {
        tool: "proactivity.whySilent",
        desc: "用户问「你怎么没提醒我」时查沉默原因",
        keywords: ["怎么没提醒", "为什么没说", "怎么没动静", "没告诉我", "沉默", "为什么不提醒", "怎么不说话了"],
        params: ["topic"],
      },
    },
    properties: {
      proposalId: { type: "string", description: "待确认提议 id" },
      decision: { type: "string", enum: ["accept", "reject"], description: "接受或拒绝" },
      signal: { type: "string", description: "反馈信号，如 too_frequent/not_useful" },
      reason: { type: "string", description: "反馈原因" },
      topic: { type: "string", description: "why_silent 关注的主题" },
    },
  },
  {
    name: "care",
    description: "重要日期管理：记生日/纪念日、查看、删除。日常节律提醒由后台调度，不在这里建。",
    defaultAction: "list",
    actions: {
      add: {
        tool: "care.set_important_date",
        desc: "记一个重要的日子",
        keywords: ["记住", "记一下", "记下", "帮我记", "添加"],
        params: ["date"],
      },
      list: {
        tool: "care.get_important_dates",
        desc: "查看已记的重要日期",
        keywords: ["重要日期", "重要日子", "记了哪些", "有哪些纪念日"],
      },
      delete: {
        tool: "care.delete_important_date",
        desc: "删掉某条",
        keywords: ["删掉", "删除", "取消", "不用记", "去掉"],
        params: ["id"],
      },
    },
    properties: {
      name: { type: "string", description: "日期名称，如「妈妈生日」" },
      date: { type: "string", description: "日期，YYYY-MM-DD 或 MM-DD" },
      relation: { type: "string", description: "与用户的关系" },
      id: { type: "string", description: "要删除的记录 id" },
    },
  },
  {
    name: "device",
    description: "已绑定设备：列设备、下发指令、取实时画面流。",
    defaultAction: "list",
    actions: {
      list: {
        tool: "device.list",
        desc: "看有哪些已绑定设备",
        keywords: ["设备列表", "有哪些设备", "绑定了什么", "哪些设备"],
      },
      use: {
        tool: "device.use",
        desc: "对某台设备执行动作",
        keywords: ["打开", "关闭", "设置", "调节", "执行", "控制"],
        params: ["command"],
      },
      stream: {
        tool: "device.stream",
        desc: "取某台设备的实时视频流地址",
        keywords: ["画面", "实时", "直播", "监控", "摄像头", "看家里"],
        params: ["deviceId"],
      },
    },
    properties: {
      deviceId: { type: "string", description: "设备 id" },
      command: { type: "string", description: "要下发的指令或动作" },
      args: { type: "object", description: "指令参数" },
    },
  },
  {
    name: "aip",
    description: "Agent 间协作协议（AIP）：向配对 Agent 发结构化请求、看我的协作状态、取对方提议。",
    defaultAction: "state",
    actions: {
      dispatch: {
        tool: "aip.dispatch",
        desc: "向配对 Agent 发一条结构化请求",
        keywords: ["派给", "协作请求", "委托", "转给", "发给另一个"],
        params: ["content", "targetId", "type"],
      },
      state: {
        tool: "aip.list_my_state",
        desc: "看我的协作关系与状态",
        keywords: ["协作状态", "我的协作", "配对", "联盟", "关系"],
      },
      proposal: {
        tool: "aip.get_proposal",
        desc: "取某条提议详情",
        keywords: ["提案", "提议", "方案详情"],
        params: ["proposalId"],
      },
    },
    properties: {
      targetId: { type: "string", description: "配对 Agent id" },
      content: { type: "string", description: "请求内容" },
      type: { type: "string", description: "请求类型" },
      proposalId: { type: "string", description: "提议 id" },
    },
  },
  {
    name: "world",
    description: "Agent 世界接入：看在线状态、开房间、完成开放注册挑战。日常通信走 world.link。",
    defaultAction: "status",
    actions: {
      status: {
        tool: "world.status",
        desc: "看我在世界里的在线状态",
        keywords: ["世界状态", "在线", "我的世界", "接入状态"],
      },
      room_create: {
        tool: "world.room.create",
        desc: "开一个房间",
        keywords: ["开房间", "建房间", "创建房间", "开个房"],
        params: ["name"],
      },
      registry_challenge: {
        tool: "world.open_registry.get_challenge",
        desc: "取开放注册挑战题",
        keywords: ["挑战", "注册题", "开放注册", "认证"],
      },
      registry_submit: {
        tool: "world.open_registry.submit",
        desc: "提交挑战答案",
        keywords: ["提交答案", "提交挑战", "答案是"],
        params: ["answer"],
      },
    },
    properties: {
      name: { type: "string", description: "房间名称" },
      answer: { type: "string", description: "挑战答案" },
    },
  },
];

/**
 * 旧工具名 → 复合 action 的兼容别名表（自动从 COMPOSITE_SPECS 派生）。
 *
 * 只做「名字归一」，不做语义打分：模型按旧提示词/历史习惯把 `action` 填成
 * `search_images` 这类原工具名时，直接映射到对应分支，而不是被当成非法值
 * 静默降级到 defaultAction（曾导致「找图」实际执行 search_web 只回文本）。
 */
const COMPOSITE_ACTION_ALIASES: Record<string, Record<string, string>> = (() => {
  const out: Record<string, Record<string, string>> = {};
  for (const spec of COMPOSITE_SPECS) {
    const map: Record<string, string> = {};
    for (const [action, actionSpec] of Object.entries(spec.actions)) {
      map[action] = action;
      map[actionSpec.tool] = action;
      map[actionSpec.tool.replace(/\./g, "_")] = action;
    }
    out[spec.name] = map;
  }
  return out;
})();

/** action 归一：合法 action 或旧工具名别名 → 标准 action；未知返回 null。 */
export function normalizeCompositeAction(
  toolName: string,
  rawAction: unknown,
): string | null {
  const map = COMPOSITE_ACTION_ALIASES[toolName];
  if (!map) return null;
  const key = typeof rawAction === "string" ? rawAction.trim() : "";
  if (!key) return null;
  return map[key] ?? null;
}

/**
 * 复合调用 → 真实执行器名（下游语义判断的唯一依据）。
 *
 * 媒体卡、搜索卡、状态行、预算/超时、缓存族等消费方都按**真实执行器名**
 * 匹配；复合工具名只出现在模型接口层。非复合工具原样返回。
 */
export function resolveEffectiveToolName(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  const spec = COMPOSITE_SPECS.find((s) => s.name === toolName);
  if (!spec) return toolName;
  const action = resolveCompositeAction(toolName, input ?? {});
  const target = action ? spec.actions[action]?.tool : undefined;
  return target ?? toolName;
}

export const COMPOSITE_CHAT_TOOLS: ChatCompletionTool[] = COMPOSITE_SPECS.map(buildSchema);

/** 供测试/巡检读取的复合工具与 action 声明。 */
export const COMPOSITE_ACTION_SPECS: ReadonlyArray<{
  name: string;
  defaultAction: string;
  actions: ReadonlyArray<{ action: string; tool: string }>;
}> = COMPOSITE_SPECS.map((spec) => ({
  name: spec.name,
  defaultAction: spec.defaultAction,
  actions: Object.entries(spec.actions).map(([action, s]) => ({ action, tool: s.tool })),
}));

/** 被复合收编、不再对模型暴露的细分工具体名。 */
export const COMPOSITE_ABSORBED_TOOL_NAMES: ReadonlySet<string> = new Set(
  COMPOSITE_SPECS.flatMap((spec) => Object.values(spec.actions).map((a) => a.tool)),
);

/**
 * 解析 action：显式合法值 > 参数签名 > 只读兜底分支。
 *
 * 语义判断交给模型：分支适用场景写在 schema 描述里，模型按描述选择。
 * 这里只保留两类确定性证据——模型显式给出的 action，以及模型已经结构化
 * 填进参数的意图（date→care.add、question→web_fetch.inspect）。
 * 不再按自然语言关键词打分：措辞歧义应由模型重选，服务端猜只会掩盖问题。
 */
export function resolveCompositeAction(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const spec = COMPOSITE_SPECS.find((s) => s.name === toolName);
  if (!spec) return null;
  const explicit = typeof input.action === "string" ? input.action.trim() : "";
  if (explicit) {
    // 显式给了 action 就只认它：合法值或旧工具名别名；无法识别时返回 null，
    // 由 handler 明确报错——绝不静默降级到 defaultAction（会掩盖模型选错分支）。
    return normalizeCompositeAction(toolName, explicit);
  }

  let best: string | null = null;
  let bestScore = 0;
  for (const [action, actionSpec] of Object.entries(spec.actions)) {
    let score = 0;
    for (const param of actionSpec.params ?? []) {
      if (hasValue(input[param])) score += 3;
    }
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  }
  return best ?? spec.defaultAction;
}

/** 注册复合执行器到 ToolRegistry（在旧执行器注册完成后调用）。 */
export function registerCompositeTools(registry: ToolRegistry): void {
  for (const spec of COMPOSITE_SPECS) {
    const handler: ToolHandler = async (input, context) => {
      const action = resolveCompositeAction(spec.name, input);
      if (!action) {
        // 业务失败标记（ok:false）必须回流：执行层只认抛异常，下游按
        // isBusinessFailurePayload 判 error，否则失败会被包装成「成功但没数据」。
        return {
          ok: false,
          error: `未知 action: ${String(input.action ?? "(空)")}，可用: ${Object.keys(spec.actions).join(" / ")}`,
        };
      }
      const result = await registry.execute(spec.actions[action]!.tool, withoutAction(input), context);
      // 透传底层 ok：被收编执行器失败时，复合层不能伪装成功（否则不重试、不报错）。
      // 仅显式 ok:false 视为失败，兼容旧 handler 返回裸结果的形态。
      if (result.ok !== false) return result.result;
      const payload =
        result.result && typeof result.result === "object" && !Array.isArray(result.result)
          ? (result.result as Record<string, unknown>)
          : { error: String(result.result ?? "工具执行失败") };
      return { ...payload, ok: false };
    };
    registry.register(spec.name, handler);
  }
}
