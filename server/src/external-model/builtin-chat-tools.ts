/**
 * 内置 Agent LLM 工具 schema 清单（ChatCompletionTool）——单一事实源。
 *
 * 2026-09-11 链路重构：此前这些 schema 手写内联在 openai-compatible-tool-loop.ts
 * 单体中段（该文件 3400+ 行，schema/编排/超时/压缩混杂）。抽出后与 ToolRegistry
 * 注册的执行器做 bootstrap 双向 diff（chat-tool-drift.ts），「有 schema 无执行器 /
 * 有执行器无 schema」的漂移在启动时直接暴露，而不是等模型调用时报「未知工具」。
 *
 * 新增工具的接线方式：在本文件（或领域工具文件）声明 schema + 在 tools/*.ts 注册
 * 执行器；启动时 drift 检查会校验两者对齐。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const INFO_WEB_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "联网搜索公开网页信息。query 由你按用户意图组织成完整、具体、语义清晰的搜索词（可含主体+特征+限定词），不要机械截成 2-6 字短词；时效话题请加当前年月或「最新」。\n如果有多个独立的查询维度（例如对比多个商品 / 多个主题），请在同一轮内并行发起多个 search_web 调用，每个 tool_call 用不同的 query，避免串行等待。\n【强制调用规则】涉及时事、新闻、股价、排片、票价、天气、价格、公告等时效信息，或任何人物的近况、行程、所在城市/地区、公开活动时，必须先调用本工具，禁止仅凭训练数据作答——本轮 prompt 里没有【实时检索结果】块时也不例外，没有块 ≠ 不用查，更要主动调用本工具自己查证；本地消费（电影票、外卖等）同样须先搜索再试。整合结果时优先引用发布时间最新的条目并注明日期。搜索条目常缺失发布日期且不保证按时间排序：行情/新闻等时效敏感问题不许把无日期条目直接当最新数据引用——换带具体日期的查询词再搜一次，或用 fetch_web 进原文核对日期；给出的数字必须说清是哪一天的（如收盘日/数据截止点），核不出日期就明说「数据截止到哪、哪一场还没出结果」，不许静默把旧数据当今天。动态/新闻/盘点/对比类问题要把多来源信息按主题整理充分（保留日期、数字、人名、作品名等细节），用 Markdown 小标题/加粗/表格组织成结构清晰的充分回答；只有真正的单一事实判断（是/否、单个数据点）才用「结论 + 1句依据」收尾。搜索回执只做素材：正文给整合后的答案，不要罗列来源、不要贴网址链接、不要逐条复述搜索条目。若摘要不足以覆盖用户要的细节（事件经过、正文内容），继续用 fetch_web / deep_search 深读相关链接后再回答。搜索结果与问题无关或为空时，如实说没查到，禁止编造。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "返回数量，1-20，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web",
      description: "读取指定网页正文并返回标题、摘要与纯文本内容。自动移除导航栏、页脚、广告等噪音，提取核心正文。\n如果已经从 search_web 拿到多个需要深读的独立 URL，请在同一轮内并行发起多个 fetch_web 调用，每个 tool_call 用不同的 url，避免串行等待。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要读取的网页 URL" },
          include_links: { type: "boolean", description: "是否同时返回页面中的链接列表（默认 false）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_images",
      description:
        "搜索公开图片结果，下载并转存为服务端本地 PNG，返回可在对话中直接预览的 mediaUrl/thumbnailUrl（形如 /agent/images/...png），以及可打开来源页的 pageUrl。\n" +
        "适用场景：用户**主动表达**想看/找图/照片/实拍图/长什么样/配图/壁纸/风景照/表情包/给我看看等视觉诉求时，并行调用本工具（可与 search_web 并行），直接出图，不要建议用户去其他平台。\n" +
        "不要误触发：仅当**当前轮**用户明确要图时才调用。若只是普通提及某事物（如聊天里带\"图\"字、或前面轮次搜过图），且本轮用户并未索图，不要调用本工具——宁缺勿滥，避免无关照片刷屏。\n" +
        "回答时优先展示 3-6 条最相关图片 PNG，附来源页链接；不要把图片搜索误用成 image.generate（生成图）。\n" +
        "降级策略（重要）：当用户要「某人+某场景/风格」的照片而组合搜索被拒/为空时，立刻只用该人名重新调用一次，交付人物的通用照片，并在回复里说明具体场景图暂时搜不到——宁可给通用真照片，也不要空手而归或编造说辞。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "图片搜索词，只允许两种形态：① 单一实体词——人名/地名/作品名/事物名（2-12 字，如「刘浩存」「灯塔」「科莫多岛」），人物照片必须只传人名本身；② 普通事物的「事物+场景」两词组合（如「灯塔 风景」「雪山 日落」）。禁止人名+修饰词组合（如「刘浩存 红毯」「卢昱晓 写真」）和中英混排——这类组合在图片搜索引擎只会返回随机无关填充。要同一人物的不同侧面就拆成多次并行调用，每次只传人名" },
          limit: { type: "integer", description: "返回数量，1-8，默认 4" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_images_batch",
      description:
        "多维对比出图：一次调用同时搜索多个维度、每个维度两侧的对比图，返回按维度分组的 mediaGroups（每个 group 含维度标题 + 左/右两侧图片列表），供前端「一段文字介绍后放一组对比照片」交错渲染。\n" +
        "适用场景：用户要求对比两类事物（如「A 与 B 的区别」「A vs B 哪个好」），或要求从多个方面/维度找图（如「颜色持久度、价格、色号对比」）时，**优先**用本工具代替普通 search_images，以实现多维度、两侧对比而非单批平铺。\n" +
        "用法：query 写「A 对比 B」（自动拆两侧）；可选 dimensions 数组指定要对比的维度（如 [\"持久度\",\"防水\",\"色号\"]），不传时自动按两侧共同点推断维度标题。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "对比关键词，含「A 对比 B / A vs B / A 和 B 区别」等对比语义" },
          dimensions: {
            type: "array",
            items: { type: "string" },
            description: "对比维度列表（可选），如 [\"持久度\",\"防水\",\"色号\"]；缺省时按两侧共同点自动推断",
          },
          limit_per_group: { type: "integer", description: "每组每侧返回张数，1-4，默认 3" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_videos",
      description:
        "搜索公开视频结果并返回标题、播放页 pageUrl、缩略图 thumbnailUrl 与来源（只是链接列表，不能内联播放）。\n" +
        "适用场景：用户明确要「视频链接」「视频资源列表」「自己去找视频」等只要链接/列表的诉求。注意：用户想直接看/播放视频内容时**不要用本工具**——用 video.find（返回可直接播放的视频流，点开即看）。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "视频搜索词，完整具体，按要找的视频内容描述" },
          limit: { type: "integer", description: "返回数量，1-12，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "video.grab",
      description:
        "解析用户消息里的短视频/视频链接，返回无水印视频流 videoUrl、封面 thumbnailUrl、标题与作者；前端会以内联播放器直接播放视频流。\n" +
        "适用场景：用户消息中带视频分享链接（v.douyin.com / douyin.com / 抖音短链、xiaohongshu.com / xhslink.com、b23.tv / bilibili.com、kuaishou.com、weibo.com 等），或明确要求「解析这个视频」「提取无水印」「保存/下载这个视频」时调用本工具。\n" +
        "不要误触发：找新视频内容用 search_videos（本工具只解析用户给定的链接）；普通网页文章链接用 fetch_web。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "用户消息中的视频分享链接或播放页链接，原样传入" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "video.find",
      description:
        "按内容找视频并直接解析出可内联播放的视频流（无需用户提供链接），返回 items（首条最优先，带 videoUrl/封面/标题）。前端渲染成播放卡，用户点开即在右侧面板全屏播放（画面不带任何文案）。\n" +
        "适用场景：用户想看/想播/想找视频内容时**必须优先用本工具**——「来个/找个/放个 xxx 的视频」「我想看 xxx」「搜个视频看看」「有没有 xxx 的视频」「xxx 的视频看看」等一切想直接观看的诉求都用本工具（search_videos 只回链接列表不能播放，别用错）。\n" +
        "不要误触发：用户已贴视频链接时用 video.grab；只要文字资讯用 search_web。\n" +
        "回复口径：本轮由前端确定性出播放卡，正文不要再复述标题/链接/作者等文案（会被整段丢弃），一句话带过即可。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要找的视频内容描述，具体完整（如「王者荣耀 李白 精彩操作」「苹果手机 隐藏功能 教学」）" },
          limit: { type: "integer", description: "返回可播放视频条数，1-3，默认 2" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.inspect_webpage",
      description: "巡检网页：返回标题、摘要、内容预览、主要链接和同域链接，便于继续导航。",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "info.navigate_site",
      description: "从起始 URL 自动多层跟进链接，直到命中目标关键词页面（如注册入口）。",
      parameters: {
        type: "object",
        properties: {
          startUrl: { type: "string" },
          goalKeywords: { type: "array", items: { type: "string" } },
          maxDepth: { type: "integer", description: "默认 2，最大 5" },
          maxPages: { type: "integer", description: "默认 20，最大 80" },
          sameHostOnly: { type: "boolean", description: "默认 true" },
        },
        required: ["startUrl"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_search",
      description:
        "深度搜索：一次调用完成「搜索 + 抓取 Top 网页正文」。先按 query 搜索，再并行读取前 N 条结果的完整正文（自动去导航栏/广告噪音），每条结果同时带 snippet 摘要与 content 全文。\n" +
        "适用场景：需要深入了解某个主题、扒取细节/数据/结论（如产品详情、事件经过、技术细节、行情解读）时，优先用本工具而不是 search_web + 逐个 fetch_web 来回多次。\n" +
        "若只需快速浏览话题就继续用 search_web。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词，完整具体，按要查的主题语义组织" },
          limit: { type: "integer", description: "搜索返回条数，1-20，默认 8" },
          fetch_pages: { type: "integer", description: "抓取完整正文的 Top 条数，1-10，默认 3" },
          content_limit: { type: "integer", description: "单条正文最大字符数，1000-8000，默认 3000" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hot_rankings",
      description:
        "实时热点榜单：聚合微博/百度/知乎/B站 当前热门话题，每条含平台、排名、话题与热度。\n" +
        "适用场景：用户问「今天有什么热点/大家都在看什么/热搜」「最近关注什么」等要掌握当下时事话题，或需要补充实时热点素材时调用；可指定 platforms（weibo/baidu/zhihu/bilibili）只看特定平台。\n" +
        "榜单是全平台通用结果，不是给这个人挑的：讲给他听之前，先按你已知的他的关注点挑重点；" +
        "他关心的方向榜上没有，就按那个方向补一次检索。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "返回条数，1-60，默认 20" },
          platforms: { type: "array", items: { type: "string" }, description: "可选平台：weibo/baidu/zhihu/bilibili，默认全部" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather.get_local",
      description:
        "获取当地天气与穿衣建议（Open-Meteo）。\n" +
        "⚠️ 不要猜测用户所在城市——如果用户未明确说城市名，不要传 city/latitude/longitude，工具会自动获取用户真实位置。\n" +
        "用户明确说了城市名时才传 city（如「上海天气」→ city:'上海'）。\n" +
        "timezone 一般不要传：缺省 auto 由用户坐标推导当地时区（服务器时区与出口 IP 都不参与）。\n" +
        "可选 days：预报天数 1-16。默认 2（今天+明天）；用户问后天/周末/未来一周等多日天气时传对应天数" +
        "（如「后天下雨吗」→ days:3，「周末天气」→ days:7），回执会带 dailyForecast 逐日数组（含 dayLabel 今天/明天/后天/周X）。\n" +
        "可选 focus：用户明确只问某一天时传，回执只含那天的数据（问明天就不掺今天的实况和气温）。" +
        "「明天天气怎么样」→ focus:'tomorrow'；「今天热不热」→ focus:'today'；" +
        "两天都提或泛泛问天气（「这两天冷吗」「天气如何」）不传，缺省回执含今天+明天。\n" +
        "⚠️ 回执含 todayRainPeriod / tomorrowRainPeriod（降水集中的钟点段，如「上午 9–12 点最明显」）时，" +
        "正文必须把这段说出来，不能只讲「今天降水 99%」——用户要知道的是几点出门。\n" +
        "⚠️ todayRainPeriod 写成「…已下过」时当天的雨已经过去，不要再催带伞。\n" +
        "⚠️ 回执里的当日天气数值（天气/气温/湿度/风速/降水概率）系统会自动渲染成结构化卡片，" +
        "你的文字回复里禁止再用 markdown 标题、表格或引用块复述这些数据（同屏会出现两份）；" +
        "⚠️ 例外：dailyForecast 逐日数据不在卡片里，用户问多日时正文直接口语化转述即可。" +
        "正文只写口语化的结论与建议（穿搭/出行提醒等）。\n" +
        "示例（卡片已展示数值时）：「明天上午 9–12 点有小雨，早晚偏凉，长袖加薄外套足够，出门顺手带把伞。」",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          city: { type: "string", description: "城市名（与坐标二选一）" },
          timezone: { type: "string" },
          locationLabel: { type: "string", description: "展示用地点名" },
          days: { type: "integer", description: "预报天数 1-16，默认 2（今天+明天）；问多日时传" },
          focus: {
            type: "string",
            enum: ["today", "tomorrow"],
            description: "用户明确只问某一天时传：today=只回今天（无明日段），tomorrow=只回明天（无当前实况/今日数据）；不传=今天+明天",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "market.quote",
      description:
        "查询股票/指数/ETF 的实时与最近成交报价（腾讯行情，A股/港股/美股）。\n" +
        "适用场景：用户问「现在/今天 XX 多少点、多少钱、涨跌多少」类行情事实时必须优先调用本工具；" +
        "新闻搜索（search_web）返回的报价是文章快照，无日期、新旧混杂，禁止当作最新行情引用——搜索只负责回答「为什么涨跌」。\n" +
        "参数 symbols 每项一个标的：支持常用别名（上证指数/大盘/创业板指/沪深300/恒生指数/道指/纳斯达克/标普500/罗素2000/特斯拉/英伟达/苹果/微软/亚马逊/谷歌/Meta）" +
        "或交易所代码（sh000001、sz399006、sh000300、hkHSI、hk00700、usDJI、usIXIC、usINX、usAAPL）；一次最多 8 个。\n" +
        "回执契约：quotes[] 含 name/market/price/prevClose/change/changePct/quoteTime（报价时间，北京时间）。" +
        "⚠️ 报价是交易所最近成交快照：回复中必须说明数据是 quoteTime 那一刻的；quoteTime 不是今天 = 最近收盘数据，照实说是哪天的收盘，禁止说成「现在/今天」。" +
        "missing 里列出的标的没查到，如实告知，禁止编造报价。",
      parameters: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "标的列表，别名或交易所代码，最多 8 个",
          },
        },
        required: ["symbols"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http.request",
      description:
        "发起任意 HTTP 请求（等价 curl），对接外部 API / Webhook / 自建服务。自动 SSRF 防护（拒绝内网地址），响应 body 默认截断 8KB。method 默认 GET；headers/body 可选；超时默认 15s 上限 60s。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整 http(s) URL（内网地址会被拒绝）" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
            description: "默认 GET",
          },
          headers: {
            type: "object",
            description: "请求头，如 {\"Authorization\":\"Bearer xxx\",\"Content-Type\":\"application/json\"}",
            additionalProperties: { type: "string" },
          },
          body: { type: "string", description: "请求体（POST/PUT/PATCH 时使用）。JSON 请序列化为字符串" },
          timeoutMs: { type: "integer", description: "超时毫秒，默认 15000，上限 60000" },
          maxBytes: { type: "integer", description: "响应 body 截断字节数，默认 8192，上限 65536" },
          followRedirects: { type: "boolean", description: "是否跟随重定向，默认 true（最多 5 次）" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

export const LIFE_ASSISTANT_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "budget.calculate",
      description: "根据收入与各项支出计算剩余预算并给出建议。",
      parameters: {
        type: "object",
        properties: {
          income: { type: "number", description: "月收入" },
          rent: { type: "number", description: "房租" },
          food: { type: "number", description: "餐饮" },
          transport: { type: "number", description: "交通" },
        },
        required: ["income"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shopping.suggest",
      description:
        "在自有商品库中检索并给出结构化购物建议（含商品图/试色图对比、参数对比表、" +
        "评测视频入口，前端会渲染二分化对比卡）。适用于用户表达选品/买决策诉求：" +
        "「A 和 B 怎么选」「预算 X 想买 Y」「有没有适合 Z 的推荐」等。" +
        "只读不购买；商品库未命中时如实说明并给泛选购建议。" +
        "item 支持多关键词（如「XM5 Bose」）以触发对比。",
      parameters: {
        type: "object",
        properties: {
          item: {
            type: "string",
            description: "商品名/品类，可含多个候选关键词触发对比（如「Chili Dior 720」）",
          },
          budget: { type: "number", description: "预算上限（元）" },
          userRequest: {
            type: "string",
            description:
              "用户本轮原话或意图摘要（尽量原文照录），供推荐话术结合用户画像做个性化组织",
          },
        },
        required: ["item"],
        additionalProperties: false,
      },
    },
  },
];

/** Agent Link：好友列表、好友请求、世界状态（Agent World 域能力 world.*；与 App 侧栏「Agent Link」/ MailboxPage 对齐）。 */
export const AGENT_LINK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.status",
      description:
        "查询 Agent World 状态：世界注册状态、世界点数余额、已解锁/已购技能、上架的社区技能，" +
        "及 world.* 工具族（注册/房间/技能商店/社交）说明。用户问「世界点数」「技能商店」「我的技能」" +
        "「Agent World 注册了吗」时调用。只读零副作用。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.link.list_friends",
      description: "列出当前用户的好友（Agent Link）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "world.link.list_friend_requests",
      description: "列出好友请求。scope: all（默认）| incoming | outgoing。",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "incoming", "outgoing"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.link.send_friend_request",
      description: "向另一用户发送好友请求（须用户明确要求）。",
      parameters: {
        type: "object",
        properties: {
          toActorId: { type: "string", description: "对方 userId/sessionId" },
          message: { type: "string", description: "可选附言" },
        },
        required: ["toActorId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "world.link.respond_friend_request",
      description: "接受或拒绝收到的好友请求。",
      parameters: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          accept: { type: "boolean" },
        },
        required: ["requestId", "accept"],
        additionalProperties: false,
      },
    },
  },
];

export const AGENT_RELAY_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "world.link.send_message",
      description:
        "给站内好友发消息（内置好友系统，不是短信/QQ/微信；用户说「给好友发消息/回复好友」就是它）。targetSessionId 填 world.link.list_friends 里的 friendActorId 或对方身份短号 agentNumber，仅限好友、须先加为好友；对方在线即时送达，离线存收件箱。",
      parameters: {
        type: "object",
        properties: {
          targetSessionId: {
            type: "string",
            description: "对方身份：好友列表里的 friendActorId，或对方的身份短号（纯数字，来自 world.link.list_friends 的 agentNumber / 对方主页）",
          },
          body: { type: "string", description: "消息正文" },
          subject: { type: "string", description: "可选主题" },
          traceId: { type: "string", description: "可选追踪 id" },
        },
        required: ["targetSessionId", "body"],
        additionalProperties: false,
      },
    },
  },
];

/** 对话中自动创建/查询日程与提醒的内置工具组（写入定时任务，非独立日历应用）。 */
export const CALENDAR_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "calendar",
      // 2026-11-11 复合：6 个 calendar.* 合并为单入口 `calendar`，用 `action` 分流。
      // 可见工具面按函数名占槽位，6 个名字占 6 个槽位，收敛成 1 个只占 1 个；
      // 每个 action 的语义、参数与回执保持不变。
      description:
        "【内置 Calendar】日程/提醒/定时任务的统一入口（用 action 分流）。\n" +
        "action=create：创建提醒/日程/定时任务。优先把用户原句放进 text（含时间与事项，如「明天 9:00 提醒我开会」），服务端确定性解析时间与事项；只有时间/类型已结构化时才用下方字段。常见触发：「明天早上九点提醒我开会」「十分钟后提醒我」「到点叫我吃药」「定个明早七点的闹钟」（睡觉叫醒须传 alarmIntent=true）「提醒我交周报」（每天循环的喝水/睡觉/运动习惯走 care.rhythm_reminder）。带明确时间点时直接调用，不要追问；仅当返回 needsRecurrenceConfirm=true 时按 suggestedQuestion 追问一次后重调。kind=reminder 时返回 whenSpoken（口语时间，如「明天上午十一点」；**仅在时间不是用户说的、或与他说的不同时才用它交代一句，用户刚说过就别重复**，也别把钟点念成 11:00、别念 11/6 这种日期）；advanceReminderKinds 只说明提前提醒的性质（departure=出发前、evening_before=前一晚），是事实不是台词：要不要提起、怎么提起你自己判断，别提字段名、别说几级、别报时点；hasAdvanceReminder 为 true 时说明另有提前提醒，别让用户以为只响一次，但不要解释提醒是怎么排的，也不要罗列提醒时间点。提醒方式默认弹窗；仅用户明确要求电话/语音才升级。\n" +
        "action=batch_create：批量创建日程（一次最多 60 条）。用于用户一次性导入多件日程的场景（课表/排班表/会议日程/行程单），先从图/文提取每条的 description 与 runAt（ISO 时间），再一次创建；逐条转述结果，冲突/失败条目如实说明。单条日程不要用本 action。\n" +
        "action=list_tasks：查询当前用户已创建的定时日程/提醒（含下次执行时间）。仅当用户**明确**要查看/确认日程或定时任务时调用；禁止用于「你确定？」「真的吗？」等短句追问。\n" +
        "action=delete_task：删除用户已创建的定时日程/提醒。仅当用户明确要求删除/取消某个日程或提醒时调用；可先用 action=list_tasks 找到 taskId。\n" +
        "action=update_task：改期/编辑单个日程：改时间、改时长、改提前量、暂停或恢复。taskId 来自 list_tasks。\n" +
        "action=find_free_slots：查询未来空闲时段（自动扣除已有安排占用）。用于「什么时候有空」「帮我约时间」，或改期遇 conflict=true 后给用户改期建议。返回 slots[]（startLocal/endLocal 展示），由用户选定。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "batch_create", "list_tasks", "delete_task", "update_task", "find_free_slots"],
            description: "要执行的日历动作。",
          },
          // ── action=create ──
          text: { type: "string", description: "action=create：用户原句，须含时间与提醒事项；优先使用本字段" },
          kind: {
            type: "string",
            enum: ["reminder", "action", "weather_brief", "agent_task"],
            description: "action=create 无 text 时必填；缺省 reminder。weather_brief 需用户已保存定位；agent_task 到点让 Agent 执行 prompt",
          },
          description: { type: "string", description: "action=create 无 text 时必填：事项/日程内容" },
          runAt: { type: "string", description: "action=create 无 text 时必填：ISO-8601" },
          title: { type: "string", description: "完整标题（日程页用；reminder 可选，由 reminderMessage 兜底；非提醒类型必填）" },
          shortTitle: { type: "string", description: "简洁展示标题（「今日安排」紧凑列表用）：去掉指令词与时间词只留核心事项，如「明天9点提醒我吃药」→\"吃药\"；必须是干净事项词，禁止复述原句、禁止含时间词/「提醒我」/悬空的「的」开头；缺省时服务端自动生成。" },
          category: { type: "string", enum: ["itinerary", "trivia"], description: "trivia=喝水/睡觉/锻炼等生活琐事(照常提醒,不进「今日安排」)；行程正事填 itinerary；缺省 itinerary。" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "yearly"],
            description: "默认 none；仅用户明确要每天/每周/每年重复时才填",
          },
          timezone: { type: "string", description: "IANA 时区，默认 Asia/Shanghai" },
          durationMinutes: { type: "number", description: "事件时长（分钟）。会议/就诊/课程等有时长的安排必填；纯时间点提醒不填。" },
          location: { type: "string", description: "事件地点（可选）。说了具体地点就填：据此估算路程并安排提前提醒。" },
          remindBeforeMinutes: {
            type: "array",
            items: { type: "number" },
            description: "提前量提醒（分钟数组）。仅当用户明确说出提前量时填；没说就省略——提前量由服务端决定，不要向用户解释规则。",
          },
          reminderMessage: { type: "string", description: "仅 kind=reminder。到点展示文案，如「该睡觉啦！」；禁止复述原句、禁止带时间表述、不要写称呼。" },
          forceCreate: { type: "boolean", description: "用户明知时间冲突仍坚持创建时传 true（跳过冲突拦截）" },
          alarmIntent: {
            type: "boolean",
            description:
              "仅一种情形传 true：睡觉叫醒——用户要在睡觉后被叫醒（「明早七点叫我起床」「六点半叫醒我」「明早叫早」）。" +
              "其余一切（会议提醒、吃药、日程、批量导入课表，以及「定个闹钟」这类没有睡觉语境的表述）一律不传。" +
              "传 true 会创建手机本地闹钟（到点响铃 + 语音叫醒，杀进程也响），误传会把用户真的吵醒，宁缺勿滥。",
          },
          httpAction: {
            type: "object",
            description: "仅 kind=action",
            properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] } },
          },
          actionUrl: { type: "string", description: "与 httpAction.url 二选一" },
          agentTask: {
            type: "object",
            description: "仅 kind=agent_task",
            properties: { prompt: { type: "string" }, accessMode: { type: "string", enum: ["sandbox", "full"] } },
          },
          prompt: { type: "string", description: "agent_task 的快捷 prompt 字段" },
          // ── action=batch_create ──
          items: {
            type: "array",
            description: "action=batch_create：日程条目数组",
            items: {
              type: "object",
              properties: {
                description: { type: "string", description: "日程内容（必填），如「高数 课上」" },
                runAt: { type: "string", description: "开始时间（ISO-8601，必填）；周期项填首次时间" },
                title: { type: "string", description: "完整标题，可选" },
                shortTitle: { type: "string", description: "紧凑短标题（≤12字，今日安排展示用）" },
                category: { type: "string", enum: ["itinerary", "trivia"], description: "缺省 itinerary（正事）" },
                recurrence: { type: "string", enum: ["none", "daily", "weekly", "yearly"], description: "缺省 none" },
                durationMinutes: { type: "number", description: "时长（分钟），可选" },
                location: { type: "string", description: "地点（可选），说了具体地点就填" },
                remindBeforeMinutes: { type: "array", items: { type: "number" }, description: "提前量提醒（分钟）；仅用户明确说了提前量才填，缺省由系统按事项类型自动分级" },
                reminderMessage: { type: "string", description: "到点提醒文案，可选（缺省用 description）" },
              },
              required: ["description", "runAt"],
            },
          },
          // ── action=list_tasks ──
          from: { type: "string", description: "action=list_tasks/find_free_slots：范围起点 ISO，可选" },
          to: { type: "string", description: "action=list_tasks/find_free_slots：范围终点 ISO，可选" },
          // ── action=delete_task / update_task ──
          taskId: { type: "string", description: "action=delete_task/update_task：日程 taskId（list_tasks 返回）" },
          // ── action=update_task 补充 ──
          status: {
            type: "string",
            enum: ["active", "paused", "cancelled"],
            description: "action=update_task：paused=暂停提醒；cancelled=取消（软删）；active=恢复",
          },
          // ── action=find_free_slots 补充 ──
          dailyWindow: {
            type: "object",
            description: "action=find_free_slots：每日可用窗口（HH:MM），默认 09:00–21:00",
            properties: {
              start: { type: "string" },
              end: { type: "string" },
            },
          },
          excludeTaskId: { type: "string", description: "action=find_free_slots：排除自身任务" },
          limit: { type: "number", description: "action=find_free_slots：最多返回几个空闲槽" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export const PHONE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "phone.ensure_my_number",
      description:
        "仅当用户明确要求办理虚拟电话时调用：分配或查询用户与 Agent 共用的 6 位站内虚拟号码（登记在 Agent 名下，即用户的站内电话号）。禁止未要求时主动占号。申领后方可使用虚拟电话服务（呼出电话）。对用户可说「您的虚拟号码」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "phone.call_user",
      description:
        "Agent 呼叫当前用户：通过 WebSocket 向用户客户端推送语音来电（含 TTS），用户可接听并回复。主叫须已申领站内号码（未申领会被拒绝）；被叫用户不需要号码。spokenMessage 为播报正文。ringStyle：reminder=提醒；peer=联络（默认）。\n【绝对禁止】\n- 一轮只许调用一次，多次调用系统只认第一次。\n- 禁止回复「马上给你打过去」「好的我给您打个电话」「现在给你打确认」「再打一次」「马上去设」等任何提前告知或重复承诺——用户不需要知道你要打，直接打就是。\n- 别一上来就甩「我是 AI 打不了电话」「没法拨号」这种话。\n- 打电话是后台事儿，跟用户说话时别提倒计时、别说「到时候接一下」、别提「准时喊你」这种内部细节。",
      parameters: {
        type: "object",
        properties: {
          toUserId: { type: "string", description: "被叫用户 ID，通常省略则使用当前会话用户" },
          spokenMessage: { type: "string", description: "用户将听到的播报正文" },
          ringStyle: {
            type: "string",
            enum: ["peer", "reminder"],
            description: "peer=联络；reminder=提醒",
          },
        },
        required: ["spokenMessage"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Agent 底层语音能力 ChatCompletionTool schema（说）。
 *
 * 之前 voice.speak / voice.send_message 已在 ToolRegistry 注册 handler，
 * 但缺这份 schema，导致 LLM 看不到这两个工具——是个真正的盲点。
 * 本数组把它们正式暴露给 LLM。
 *
 * 与 phone.call_user 的区别：phone 走 `isExplicitPhoneCallRequest` 旁路注入，
 * voice 工具族走常规 tool-search 选择 + 关键词分类。
 */

export const VOICE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "voice.speak",
      description:
        "【语音播报·即时模式】合成语音并立即对用户播报（无来电 UI、无振铃，客户端后台一次性播放）。适用于：状态告知、提醒、即时反馈、不需要用户回应的简短播报。与 phone.call_user 区别：phone 是来电体验（振铃+接通+通话 UI），voice.speak 是轻量后台播报。用户问「能不能说话」「用语音告诉我」时调用本工具。\n【绝对禁止】调用后不要在文本回复里复述语音内容，工具会替你落地。禁止回复「马上给你播报」「好的我给您念」等提前告知。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要朗读的文字内容（建议 200 字以内，过长会被截断）" },
          mode: {
            type: "string",
            enum: ["instant", "reminder"],
            description: "instant=即时播报（默认），reminder=提醒式播报（带标题/优先级，客户端可显示卡片）",
          },
          title: { type: "string", description: "reminder 模式下的标题（仅 mode=reminder 生效）" },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "reminder 模式下的优先级（默认 medium）",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice.send_message",
      description:
        "【语音消息·微信式】合成语音并落地为可重播的语音消息（客户端渲染为微信式语音气泡，用户可多次点击重播）。适用于：用户明确要求「发语音」「发条语音消息」、长文本回复用语音更自然、朋友式聊天场景。与 voice.speak 区别：speak 是一次性即时播报无 UI，send_message 是落地可重播语音消息。短指令回复（如「好的」「知道了」）请用文本，不要滥用本工具。\n【绝对禁止】调用后不要在文本回复里复述语音内容，工具会替你落地。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "语音消息要朗读的内容" },
          replyToMessageId: {
            type: "string",
            description: "可选：要回复的历史消息 ID（用于上下文关联）",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
];

/** 时钟工具：识别用户当前位置与时区（时间/日期由每轮【当前时间】块提供）。 */
export const CLOCK_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "clock.get_user_location",
      description:
        "通过 IP 识别用户当前所在城市、省份/州、国家和时区。用户问「我在哪个城市」「我在哪」「当前位置」时必须调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

/**
 * Agent 宿主能力详细查询工具：用户问「你能做什么」时返回宿主侧各域能力清单。
 * 2026-10-22 复审：生活 12 域（Feature Catalog 分类面）与 Agent World 状态分支
 * 已移除——某域有哪些工具走 tool_discover({domain})，世界状态走 world.status；
 * 本工具只回答「宿主侧有什么能力域、各自干什么」。
 */
export const AGENT_CAPABILITY_QUERY_CHAT_TOOLS: ChatCompletionTool[] = [  {
    type: "function",
    function: {
      name: "agent.query_capabilities",
      description:
        "查询宿主侧各能力域的清单与说明。用户问「你能做什么/你有哪些功能」时调用，按域给出能力描述；" +
        "需要某域具体工具的参数 schema 时优先用 tool_discover；Agent World 的注册/点数/技能状态用 world.status。结果会保留在对话上下文供后续参考。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: ["wallet", "agent_link", "calendar", "weather", "sub_agent", "aip", "desktop", "web", "life_assistant", "phone", "entertainment", "social_feed", "agent_account", "notes", "system", "all"],
            description:
              "能力领域过滤。不传或传 'all' 返回全部宿主域；传具体域名仅返回该域。建议优先指定领域以减少 token 消耗：wallet=钱包, agent_link=好友, calendar=日程, weather=天气, sub_agent=子Agent委派, aip=AIP协议, desktop=桌面自动化, web=网页浏览, life_assistant=生活助手, phone=虚拟电话, entertainment=娱乐互动, agent_account=账号注册, notes=笔记, system=系统管理。",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/**
 * ObservationPack 读回工具（借鉴 NVlabs/SoL-Pi，MIT）：被压缩/折叠的大体积工具结果
 * 归档为稳定句柄（obs_N）后，模型用本工具读回原文，替代「重新执行原工具」。
 * WP1：支持 outline 看结构目录、query 关键词定向读取（借鉴 codebase-memory-mcp
 * 「先查结构再取片段」），替代盲翻页。
 * 执行在 openai-compatible-tool-loop 循环层（不进 ToolRegistry，chat-tool-drift 豁免）。
 */
export const OBS_RECALL_CHAT_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "obs_recall",
    description:
      "读回此前被压缩或折叠的工具结果原文。当早前结果摘要缺少你需要的细节（具体数字、URL、正文段落）时，" +
      "用结果提示中给出的 id（形如 obs_1）：先 mode=\"outline\" 看结构目录，或直接 query=\"关键词\" 定向读取相关段落" +
      "（推荐，一次命中，避免逐页翻找）；也可用 offset/limit 按 nextOffset 线性翻页。读完即作答。" +
      "query 结果带 lowConfidence=true 或没找到目标时，改用结果原文中的关键词重试一次，或按 alternatives 提示的节名换词再试。" +
      "不要用它读回近期完整可见的结果，也不要为了「确认」而重复读回同一段。outline 仅供导航，" +
      "引用具体细节前必须读取对应段落原文。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "待读回的结果句柄（见工具结果或折叠摘要中的 obs_recall 提示）" },
        mode: {
          type: "string",
          enum: ["text", "outline"],
          description: "text=读原文（默认）；outline=返回该结果的结构目录（标题/键/段落列表，不含正文），便于先定位再读",
        },
        query: {
          type: "string",
          description: "关键词（可中文短语）。给出时直接返回内容中最相关的段落窗口，替代盲翻页",
        },
        offset: { type: "integer", description: "起始字符偏移，默认 0（续页用上一页返回的 nextOffset；query 模式忽略此参数）" },
        limit: { type: "integer", description: "本次读回的字符数，默认 4000，上限 12000" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
};
