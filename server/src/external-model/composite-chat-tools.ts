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

import { BILL_PARCEL_CHAT_TOOLS } from "../tools/bill-parcel-tools.js";
import { FINANCE_DEEP_CHAT_TOOLS } from "../tools/capability-modules/finance-deep/chat-tools.js";
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
  /** 底层执行器自身也有 action 字段时，用本分支值覆盖（复合 action 会被剔除） */
  forwardAction?: string;
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

function collectToolProperties(tools: ChatCompletionTool[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const tool of tools) {
    if (tool.type !== "function") continue;
    const params = tool.function.parameters as
      | { properties?: Record<string, unknown> }
      | undefined;
    for (const [key, value] of Object.entries(params?.properties ?? {})) {
      if (key === "action" || key in out) continue;
      out[key] = value;
    }
  }
  return out;
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
      "联网检索的统一入口：网页搜索、深读检索、图片/视频、热搜榜、天气、行情。凡是「查一下/搜一下/网上看看」都走这里。\n【强制调用规则】涉及时事、新闻、股价、排片、票价、公告等时效信息，或任何人物的近况、最新消息、行程、所在城市、公开活动时，必须先调用本工具再作答，禁止仅凭训练数据作答——本轮 prompt 里没有【实时检索结果】块时也不例外。时效话题的 query 请带上当前年月或「最新」。只有寒暄、情绪、观点，以及不随时间变化的常识，才可以直接回答。",
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
        params: ["limit"],
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
        desc: "查天气，city 缺省按用户所在地；问多日（未来一周/后天/周末）时传 days",
        keywords: ["天气", "气温", "下雨", "温度", "降温", "多少度", "空气质量"],
        params: ["city", "days"],
      },
      quote: {
        tool: "market.quote",
        desc: "查股票/指数/汇率行情（暂不支持加密货币币价）",
        keywords: ["股价", "汇率", "行情", "涨跌", "基金", "指数", "多少美元"],
        params: ["symbols"],
      },
    },
    properties: {
      query: { type: "string", description: "检索词或问题" },
      queries: { type: "array", items: { type: "string" }, description: "images_batch 的多组检索词" },
      url: { type: "string", description: "parse_video 的视频页地址" },
      // 2026-11-14 接线修复：字段名必须与底层执行器一致（weather.get_local 只认
      // city/days）。此前这里声明的是 location，透传后被执行器静默丢弃——
      // 「北海一周天气」实际查成了用户 GPS 所在地（兴义）。days 同理此前未声明，
      // 「未来一周」的天数传不进回执。
      city: {
        type: "string",
        description:
          "weather 分支的城市名：用户明确说了城市时才传（如「北海一周天气」→ city:'北海', days:7）；没说城市就不要传，缺省按用户真实所在地",
      },
      days: {
        type: "integer",
        description: "weather 分支的预报天数 1-16（未来一周 → 7，后天 → 3），缺省今天+明天",
      },
      symbols: { type: "string", description: "quote 的标的代码或名称，支持逗号分隔多个（如 BTC,ETH）" },
      limit: {
        type: "integer",
        description: "web 返回条数（默认 5）；images 分支为返回张数（默认 4，上限 8）",
      },
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
        params: ["method", "headers", "body", "timeoutMs"],
      },
    },
    properties: {
      url: { type: "string", description: "目标网址" },
      question: { type: "string", description: "inspect 时要从页面回答的问题" },
      goal: { type: "string", description: "navigate 时要在站内完成的目标" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "raw 的请求方法" },
      headers: { type: "object", description: "raw 的请求头" },
      body: { type: "object", description: "raw 的请求体" },
      timeoutMs: { type: "integer", description: "raw 的超时毫秒数" },
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
  {
    name: "finance",
    description:
      "账本与账单的统一入口：导入交易、消费分析、预算、对账、分类、报表、订阅、账单、邮件/短信账单快递台账。凡是「这个月花了多少」「设个预算」「退订阅」「有哪些账单/快递」都走这里。",
    defaultAction: "analyze",
    actions: {
      import: {
        tool: "finance.import_transactions",
        desc: "导入支付宝/微信/银行交易记录",
        keywords: ["导入", "账单导入", "银行流水", "交易记录", "记账"],
        params: ["data"],
      },
      analyze: {
        tool: "finance.analyze_spending",
        desc: "按类别/月份分析支出与收入",
        keywords: ["花了多少", "消费分析", "支出", "开销", "消费趋势", "哪个类别"],
        params: ["from", "to"],
      },
      set_budget: {
        tool: "finance.set_budget",
        desc: "设置月度/类别预算",
        keywords: ["预算", "设预算", "每月不超过", "限额"],
        params: ["category", "amount"],
      },
      budget_status: {
        tool: "finance.get_budget_status",
        desc: "查看预算执行进度",
        keywords: ["预算还剩", "预算进度", "超支了吗", "预算情况"],
        params: ["month"],
      },
      budget_estimate: {
        tool: "budget.calculate",
        desc: "按收入与固定支出做一次性粗略测算",
        keywords: ["粗略算", "收支测算", "还能剩多少", "收入支出"],
        params: ["income"],
      },
      reconcile: {
        tool: "finance.reconcile",
        desc: "账单与账本对账，找差异",
        keywords: ["对账", "核对", "差异", "对不上"],
      },
      categorize: {
        tool: "finance.categorize",
        desc: "给一笔交易自动分类",
        keywords: ["分类", "归到哪类", "这笔算什么"],
        params: ["description", "amount"],
      },
      export_report: {
        tool: "finance.export_report",
        desc: "导出财务报告（markdown/csv/json）",
        keywords: ["导出", "报表", "财务报告", "月度报告"],
        params: ["format"],
      },
      list_subscriptions: {
        tool: "finance.list_subscriptions",
        desc: "盘点自动续费订阅",
        keywords: ["订阅", "自动续费", "会员", "包月"],
      },
      confirm_subscription: {
        tool: "finance.confirm_subscription",
        desc: "确认或登记一个订阅",
        keywords: ["登记订阅", "确认订阅", "这个订阅"],
        params: ["merchant", "amount"],
      },
      update_subscription: {
        tool: "finance.update_subscription",
        desc: "更新订阅状态或下次续费日",
        keywords: ["改订阅", "订阅状态", "下次续费"],
        params: ["subscriptionId"],
      },
      cancel_subscription: {
        tool: "finance.cancel_subscription",
        desc: "识别低使用订阅并退订",
        keywords: ["退订", "取消订阅", "不续费", "退掉会员"],
        params: ["subscriptionId", "merchant"],
      },
      savings_summary: {
        tool: "finance.savings_summary",
        desc: "统计退订省下的钱",
        keywords: ["省了多少钱", "退订省钱", "省钱统计"],
      },
      add_bill: {
        tool: "finance.add_bill",
        desc: "登记一笔定期账单",
        keywords: ["记一笔账单", "每月房租", "定期账单", "账单提醒"],
        params: ["name", "amount"],
      },
      list_bills: {
        tool: "finance.list_bills",
        desc: "查看账单到期与状态",
        keywords: ["账单", "要交的账单", "到期", "固定支出"],
      },
      update_bill: {
        tool: "finance.update_bill",
        desc: "修改账单信息",
        keywords: ["改账单", "账单调整", "改金额"],
        params: ["billId"],
      },
      pay_bill: {
        tool: "finance.pay_bill",
        desc: "登记账单已缴并入账",
        keywords: ["交了", "缴费", "已付账单", "还了"],
        params: ["billId"],
      },
      sync_bills: {
        tool: "finance.bills.sync_now",
        desc: "立即用支付宝登录态拉取账单并入账",
        keywords: ["同步账单", "拉支付宝流水", "更新账单"],
      },
      auto_fetch_on: {
        tool: "finance.bills.auto_fetch",
        desc: "开启后台自动同步支付宝账单",
        keywords: ["自动同步账单", "以后自动拉账单", "开启账单同步"],
        params: ["intervalMin", "hour"],
        forwardAction: "on",
      },
      auto_fetch_off: {
        tool: "finance.bills.auto_fetch",
        desc: "关闭后台自动同步",
        keywords: ["别自动拉账单", "关闭账单同步", "停止同步账单"],
        forwardAction: "off",
      },
      auto_fetch_status: {
        tool: "finance.bills.auto_fetch",
        desc: "查看账单自动同步开关与最近结果",
        keywords: ["账单自动同步开着吗", "同步状态"],
        forwardAction: "status",
      },
      bill_parcel_list: {
        tool: "bill_parcel.list",
        desc: "查邮件/短信识别出的账单与快递条目",
        keywords: ["快递", "取件码", "物流", "账单明细"],
        params: ["category", "days"],
      },
      bill_parcel_summary: {
        tool: "bill_parcel.summary",
        desc: "汇总账单金额与快递件数",
        keywords: ["话费扣了多少", "快递几件", "账单汇总"],
        params: ["days"],
      },
    },
    properties: {
      ...collectToolProperties(FINANCE_DEEP_CHAT_TOOLS),
      ...collectToolProperties(BILL_PARCEL_CHAT_TOOLS),
      income: { type: "number", description: "budget_estimate 的月收入" },
      rent: { type: "number", description: "budget_estimate 的房租" },
      food: { type: "number", description: "budget_estimate 的餐饮支出" },
      transport: { type: "number", description: "budget_estimate 的交通支出" },
    },
  },
  {
    name: "payment",
    description:
      "支付与钱包统一入口：授权状态、发起支付、确认超限支付、查支付结果、退款、支付记录、授权开关，以及历史商户收款码通道。Agent 不代持资金；未授权先给授权链接，超免密额度必须用户明确确认。",
    defaultAction: "authorization_status",
    actions: {
      pay: {
        tool: "payment.pay",
        desc: "发起一笔支付（自动走授权→额度→确认→渠道下单）",
        keywords: ["支付", "付款", "买单", "结账", "代付", "扫码付"],
        params: ["amount", "subject"],
      },
      confirm: {
        tool: "payment.pay_confirm",
        desc: "用户明确同意后确认超限支付",
        keywords: ["确认支付", "同意付款", "就付这个", "确认扣款"],
        params: ["confirmToken"],
      },
      resume: {
        tool: "payment.pay_resume",
        desc: "恢复一笔待继续的支付",
        keywords: ["继续支付", "接着付", "恢复支付"],
        params: ["intentId"],
      },
      status: {
        tool: "payment.pay_status",
        desc: "向渠道核对支付结果",
        keywords: ["付了吗", "到账没有", "支付状态", "订单状态"],
        params: ["intentId"],
      },
      refund: {
        tool: "payment.refund",
        desc: "原路退款",
        keywords: ["退款", "退钱", "退回", "退掉这笔"],
        params: ["intentId"],
      },
      receipt: {
        tool: "payment.receipt",
        desc: "查看支付记录与合计",
        keywords: ["支付记录", "消费记录", "花了多少", "账单"],
        params: ["limit"],
      },
      authorization_status: {
        tool: "payment.authorization_status",
        desc: "查看支付授权、额度与渠道可用性",
        keywords: ["授权状态", "额度", "免密", "能不能代付"],
      },
      revoke_authorization: {
        tool: "payment.revoke_authorization",
        desc: "撤销一条支付授权",
        keywords: ["撤销授权", "取消额度", "别再代付"],
        params: ["authorizationId"],
      },
      authorization_link: {
        tool: "payment.authorization_link",
        desc: "生成支付授权页链接",
        keywords: ["授权链接", "开通额度", "去授权"],
        params: ["channel", "amount"],
      },
      merchant_create: {
        tool: "payment.create_order",
        desc: "历史商户收款码通道：按商户号创建订单并出二维码",
        keywords: ["收款码", "商户下单", "二维码支付", "微信支付", "支付宝支付"],
        params: ["amount", "description"],
      },
      merchant_query: {
        tool: "payment.query_order",
        desc: "历史商户订单查询",
        keywords: ["商户订单", "订单号查询", "查这笔订单"],
        params: ["outTradeNo", "provider"],
      },
      methods: {
        tool: "payment.list_methods",
        desc: "查看可用支付方式与护栏",
        keywords: ["支付方式", "支持哪些支付", "能用什么付"],
      },
    },
    properties: {
      amount: { type: "number", description: "金额（元）" },
      subject: { type: "string", description: "付款事由（如「打车费」）" },
      category: { type: "string", description: "类别，用于授权与护栏判定" },
      bizDomain: {
        type: "string",
        enum: ["travel", "ride", "delivery", "dining", "express", "utility", "shopping", "recharge", "service", "other"],
        description: "业务域",
      },
      bizRefId: { type: "string", description: "业务单据号（幂等/对账用）" },
      merchant: { type: "string", description: "收款方名称" },
      channel: { type: "string", description: "支付渠道；不传为 auto" },
      cashierUrl: { type: "string", description: "已有收银台链接" },
      idempotencyKey: { type: "string", description: "幂等键" },
      intentId: { type: "string", description: "支付意图 id" },
      confirmToken: { type: "string", description: "确认令牌" },
      sync: { type: "boolean", description: "status 时是否向渠道实时同步，默认 true" },
      reason: { type: "string", description: "退款原因" },
      limit: { type: "integer", description: "receipt 返回条数，默认 20" },
      authorizationId: { type: "string", description: "授权 id" },
      provider: { type: "string", enum: ["wechat", "alipay"], description: "历史商户通道的支付提供商" },
      method: { type: "string", enum: ["native", "h5"], description: "历史商户通道的支付方式" },
      description: { type: "string", description: "历史商户通道的商品描述" },
      outTradeNo: { type: "string", description: "历史商户通道的订单号" },
      metadata: { type: "object", description: "历史商户通道的附加元数据" },
    },
  },
  {
    name: "ride_hailing",
    description:
      "打车统一入口：报价、下单、查订单、取消。用户说「叫个车/打车去某地」时先走 quote 报价。\n" +
      "调用时机铁律：用户表达打车意图且给出目的地后**立即 quote**，目的地抄用户原话；" +
      "起点未指定时系统自动推送「选上车点」卡让用户点选，**禁止用文字追问起点/你在哪**。\n" +
      "book 为两阶段确认：先 confirm=false 拿订单摘要+token 并复述给用户，用户明确同意后再 confirm=true+token 真实下单。" +
      "BOOKING_MODE=mock（默认）结果为模拟（simulated=true），必须如实告知用户不是真实订单；Agent 不代付。",
    defaultAction: "quote",
    actions: {
      quote: {
        tool: "ride_hailing.quote",
        desc: "叫车报价：车型（经济/舒适/商务）+ 预估价，下单前必先报价",
        keywords: ["打车", "叫车", "网约车", "车费", "报价", "去机场", "送我去"],
        params: ["dropoff", "scheduleAt"],
      },
      book: {
        tool: "ride_hailing.book",
        desc: "下单叫车（两阶段确认；optionId 来自 quote 返回）",
        keywords: ["下单", "叫车出发", "订车", "确认叫车"],
        params: ["optionId", "confirm", "confirmationToken", "passengerPhone"],
      },
      status: {
        tool: "ride_hailing.status",
        desc: "查行程进度/司机与车牌；不传 orderId 返回最近订单",
        keywords: ["司机到哪", "车牌", "订单状态", "行程进度", "接到我了吗"],
        params: ["orderId"],
      },
      cancel: {
        tool: "ride_hailing.cancel",
        desc: "取消订单（两阶段确认）",
        keywords: ["取消订单", "不坐了", "取消叫车"],
        params: ["reason"],
      },
    },
    properties: {
      pickup: { type: "string", description: "上车点；仅用户明说了具体地点才传，缺省系统推送「选上车点」卡" },
      dropoff: { type: "string", description: "目的地地址，抄用户原话" },
      city: { type: "string", description: "城市（可选，提高地理编码准确度）" },
      scheduleAt: { type: "string", description: "用车时间（ISO 时间）；缺省立即" },
      provider: { type: "string", description: "provider key（可选，缺省自动选择）" },
      optionId: { type: "string", description: "报价返回的车型选项 id（如 eco/comfort/business）" },
      passengerPhone: { type: "string", description: "乘客电话（live 模式需要；须用户明确提供）" },
      confirm: { type: "boolean", description: "true=阶段二执行；缺省/false=阶段一返回摘要+token" },
      confirmationToken: { type: "string", description: "阶段一返回的确认 token（confirm=true 时必填）" },
      orderId: { type: "string", description: "本地订单号（bkg_ 开头）" },
      reason: { type: "string", description: "取消原因（可选）" },
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
 * 填进参数的意图（url→parse_video、question→web_fetch.inspect）。
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

/**
 * 复合参数 → 执行器参数适配（2026-11-14 接线审计）。
 *
 * 复合层声明的字段名必须与底层执行器一致，透传才不丢参。本函数归一两类残留：
 * 1) 模型按历史习惯传的旧字段名（location/symbol/count/timeout_ms）；
 * 2) 复合层语义名与执行器实现名不同源的（navigate 的 url/goal → startUrl/goalKeywords）。
 * 丢参后果分级：weather 查错城市、quote 直接报错、images/timeout 静默降级——
 * 全部在此收口，不再各自为战。
 */
function adaptForwardInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const pickRename = (from: string, to: string): Record<string, unknown> | null => {
    if (hasValue(input[to]) || !hasValue(input[from])) return null;
    const { [from]: legacy, ...rest } = input;
    return { ...rest, [to]: legacy };
  };
  switch (tool) {
    case "weather.get_local":
      return pickRename("location", "city") ?? input;
    case "market.quote":
      return pickRename("symbol", "symbols") ?? input;
    case "search_images":
      return pickRename("count", "limit") ?? input;
    case "http.request":
      return pickRename("timeout_ms", "timeoutMs") ?? input;
    case "info.navigate_site": {
      const adapted = { ...input };
      if (!hasValue(adapted.startUrl) && hasValue(adapted.url)) adapted.startUrl = adapted.url;
      if (!hasValue(adapted.goalKeywords) && hasValue(adapted.goal)) {
        adapted.goalKeywords = String(adapted.goal)
          .split(/[,，、\s]+/)
          .filter(Boolean);
      }
      delete adapted.url;
      delete adapted.goal;
      return adapted;
    }
    default:
      return input;
  }
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
      const actionSpec = spec.actions[action]!;
      const targetTool = actionSpec.tool;
      const rawForwardInput = withoutAction(input);
      if (actionSpec.forwardAction) rawForwardInput.action = actionSpec.forwardAction;
      const forwardInput = adaptForwardInput(targetTool, rawForwardInput);
      const result = await registry.execute(targetTool, forwardInput, context);
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
