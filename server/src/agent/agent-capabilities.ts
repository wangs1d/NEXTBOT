import type { SkillManager } from "../skills/index.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";

import { getAgentRuntimeConfig } from "./agent-runtime-config.js";


export const CAPABILITY_DOMAINS = [
  "wallet",
  "agent_link",
  "calendar",
  "weather",
  "sub_agent",
  "aip",
  "vision",
  "desktop",
  "web",
  "life_assistant",
  "voice",
  "phone",
  "entertainment",
  "social_feed",
  "self_programming",
  "agent_account",
  "world",
  "embodiment",
  "smart_home",
  "notes",
  "image_gen",
  "file_doc",
  "email_sms",
  "media_music",
  "health_fitness",
  "finance_deep",
  "social_outreach",
  "code_sandbox",
  "shopping_order",
  "shopping_compare",
  "agent_browser",
  "shared_browser",
  "ride_hailing",
  "home_services",
  "restaurant_booking",
  "travel_booking",
  "period_care",
  "safety_guard",
] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number] | "all";

export const DOMAIN_LABELS: Record<CapabilityDomain, string> = {
  wallet: "钱包（余额/交易/转账/充值/购买）",
  agent_link: "Agent Link 好友（列表/请求/中继消息）",
  calendar: "日程与提醒（创建/查询）",
  weather: "天气查询",
  sub_agent: "任务执行（后台 plan-and-execute 统一执行）",
  aip: "AIP协议（dispatch/状态/提案）",
  vision: "视觉能力（HTTP抓帧/定时巡检）",
  desktop: "桌面自动化（VLM视觉操控电脑）",
  web: "Web浏览（搜索/抓取网页）",
  life_assistant: "生活助手（预算计算/购物建议）",
  voice: "语音能力（TTS播报/ASR识别，Agent底层语音能力，可自调度）",
  phone: "语音触达（语音提醒/闹钟式TTS播报 + 电话通话/TTS-only来电，未来ASR+LLM+TTS全双工）",
  entertainment: "娱乐互动",
  social_feed: "社交推文站（发帖/评论/点赞/浏览动态）",
  self_programming: "自我编程（创建/更新/删除/生成Skill）",
  agent_account: "Agent账号注册",
  world: "Agent World（世界状态/社交/市场）",
  embodiment: "具身身体（球形本体：漫游/移动/表情）",
  smart_home: "智能家居（HomeAssistant：设备列表/开关/调温/灯控/场景）",
  notes: "学习笔记（学习/会议/视频/读书/灵感沉淀、摘要、抽问、复习）",
  image_gen: "图像生成（text-to-image，OpenAI 兼容图像模型）",
  file_doc: "文件/文档处理（read/write/parse_pdf/parse_office/export_format）",
  email_sms: "邮件/短信主动发送（SMTP + 阿里云短信）",
  media_music: "媒体音乐播放控制（搜索/播放/暂停/继续/停止/now playing）",
  health_fitness: "健康/运动数据接入（指标记录/查询/汇总/目标/导入）",
  finance_deep: "财务深度能力（交易导入/支出分析/预算/对账/分类/导出报告/订阅取消/账单管理）",
  social_outreach: "社交主动出击（Twitter/微博/小红书/朋友圈，发帖/评论/转发/点赞）",
  code_sandbox: "代码执行沙盒（python/node 子进程，工作目录隔离）",
  shopping_order: "购物/下单（后台无头浏览器代用户下单）",
  shopping_compare: "购物比价（跨平台同款比价 + 降价监控 + 保险/服务调研对比）",
  agent_browser: "Agent 虚拟浏览器（通用网页多步操作：open/click/type/scroll/screenshot/extract_text/wait_for/close）",
  shared_browser: "共用浏览器（用户与 Agent 共用客户端浏览器：navigate/click/type/scroll/read_page，用户可见可接管）",
  ride_hailing: "打车/网约车（报价/两阶段确认下单/订单追踪/取消）",
  home_services: "家政/本地生活预订（保洁/维修/搬家/美容/宠物，搜索/下单/改期/取消）",
  restaurant_booking: "餐厅预订（附近搜索/订座/状态/取消）",
  travel_booking: "机票/火车票/酒店预订（多源报价比价/下单/支付/出票/取消）",
  period_care: "生理周期关怀（经期记录/预测/临近提醒/状态打卡，数据本地加密）",
  safety_guard: "安全守护（紧急联系人/一键SOS/借口来电，定位仅按需获取一次）",
  all: "全部领域",
};

export type CapabilitySection = {
  domain: CapabilityDomain;
  lines: string[];
};


function buildStaticSections(): CapabilitySection[] {
  return [
    {
      domain: "wallet",
      lines: [
        "1️⃣ 钱包（用户真实资金CNY，非Agent私有）：wallet.get_balance / wallet.get_transactions / wallet.transfer（须用户同意，仅限好友）/ wallet.purchase（须授权，覆盖全消费场景）/ wallet.recharge",
      ],
    },
    {
      domain: "agent_link",
      lines: [
        "2️⃣ Agent Link 好友（Agent World 域）：world.link.list_friends / list_friend_requests / send_friend_request / respond_friend_request / world.link.send_message（仅限好友）/ aip.dispatch",
      ],
    },
    {
      domain: "calendar",
      lines: [
        "3️⃣ 日程：calendar.create_from_text / create_task / list_tasks / reminder.plan",
      ],
    },
    {
      domain: "weather",
      lines: [
        "4️⃣ 天气：weather.get_local",
      ],
    },
    {
      domain: "sub_agent",
      lines: [
        "5️⃣ 任务执行：复杂任务由后台 plan-and-execute 流程统一执行（全量工具 + 多步收敛），无需委派子 Agent。",
      ],
    },
    {
      domain: "aip",
      lines: [
        "6️⃣ AIP协议：aip.dispatch / aip.list_my_state / aip.get_proposal",
      ],
    },
    {
      domain: "vision",
      lines: [
        "7️⃣ 视觉：vision.http_pull / vision.periodic_start / periodic_stop / periodic_list（须「完全访问」）",
      ],
    },
    {
      domain: "desktop",
      lines: [
        "8️⃣ 电商读价：browser.session.list / browser.fetch_page（用户导入 Cookie 并按站点授权 agentAllowed +「完全访问」）",
        "8️⃣b 桌面自动化：desktop.visual.screenshot / desktop.visual.run_task（须「完全访问」+ 服务端/桥接已配置）",
      ],
    },
    {
      domain: "web",
      lines: [
        "9️⃣ Web浏览：search_web / search_images（搜索并转存本地 PNG）/ search_videos / fetch_web",
        "9️⃣b 图片意图：**当前轮**用户明确表达了想看/找图/照片/实拍图/长什么样/配图/壁纸/风景照等视觉诉求时，**并行**调用 search_images（不再只调 search_web）直接出图，不要建议用户去其他平台；同时可调 search_web 获取来源信息。若本轮用户并未索图（只是普通提及、或不含图片诉求），**不要**调用 search_images，避免无关照片刷屏——宁缺勿滥。",
        "9️⃣c search_images 数量与排版：单次默认 4 张、上限 8 张。**不要追求数量**，宁可少而精。多个地点/多个主题请**按主题各发一次 query 并行搜**（每个 query 用完整具体的描述，如「平潭岛蓝眼泪荧光海 夜景实拍」「黄山云海日出 云海翻涌」，不要把单个主题截成碎片短词）；不要一次性塞 20+ 张图，也不要把多个不同主题的图全堆在一张图墙里。每张照片会由视觉模型自动附带真实画面描述，正文不要逐张描述照片或用「第几张图」指代；只搜到图（没有文字检索结果）时，正文一两句话引入即可，**不要**分节盘点或写「已确认的/能说的/没查到的」式小节。",
      ],
    },
    {
      domain: "embodiment",
      lines: [
        "🤖 具身身体（球形即你的物理身体，用来表达状态与移动）：",
        "   embodiment.roam — 3D 场景内随机漫游",
        "   embodiment.move — 移动到场景坐标 (x,y,z)",
        "   embodiment.stop — 停止漫游",
        "   embodiment.set_state — 设置 mood/energy/玻璃屏 caption",
        "   embodiment.observe — 观察身体在屏幕何处（坐标 + 可选截图）",
        "   embodiment.window_place — 按归一化坐标 screenX/screenY 移动（0～1）",
        "   embodiment.window_roam — 随机换屏幕位置（无明确目标时用）",
      ],
    },
    {
      domain: "smart_home",
      lines: [
        "🏠 智能家居（HomeAssistant，需用户已部署 HA 并配置 HA_BASE_URL / HA_TOKEN）：",
        "   smart_home.list_devices — 列出所有智能设备及状态（灯/开关/空调/窗帘/传感器）",
        "   smart_home.control_device — 控制设备：开灯/关灯、调亮度/色温、开关插座、设空调温度/模式、开关窗帘",
        "   smart_home.scene — HA 场景：列出+激活（回家/离家/晚安等）",
        "   用户说「开灯」「关空调」「窗帘打开」「灯调暗」「温度调到26」时自动调用对应操作。",
        "   操作前先 list_devices 了解有哪些设备；勿猜 entity_id。",
      ],
    },
    {
      domain: "life_assistant",
      lines: [
        "🔟 生活助手：budget.calculate / shopping.suggest",
      ],
    },
    {
      domain: "voice",
      lines: [
        "🔊 语音能力（Agent 底层语音能力，可自调度）：",
        "   - voice.speak（即时播报）：合成语音并直接播报给用户，无需走电话流程",
        "     · mode=\"instant\"（默认）：轻量即时播报，客户端后台播放，无 UI 强制",
        "     · mode=\"reminder\"：提醒式播报，带标题/优先级，客户端可显示卡片",
        "   - voice.send_message（语音消息）：发送微信式可重播语音消息",
        "     · 把文本合成为 mp3 落地，客户端渲染为微信式语音气泡（带时长 / 声波 / 可重播）",
        "     · 与 voice.speak 区别：speak 是一次性即时播报无 UI；send_message 是落地可重播语音消息",
        "     · 适用场景：用户说「发语音」「发条语音消息」「用语音回复」，或长回复用语音更自然",
        "   - 与 phone.call_user 区别：voice.* 是底层语音能力（无来电 UI/振铃），phone.call_user 是完整电话触达体验",
        "   - TTS 提供商：优先 MiniMax（中文），回退 OpenAI；均未配置时客户端用本地 TTS 兜底",
        "   - 未来扩展：ASR 识别（voice.transcribe）+ 全双工对话（voice.dialogue）将在此领域扩展",
      ],
    },
    {
      domain: "social_feed",
      lines: [
        "1️⃣4️⃣ 社交推文站（Agent与人类共享的社交平台）：",
        "   - 平台特性：这是一个Agent和人类用户都能发帖、互动的社交网页平台",
        "   - social.post（发帖）：可代表用户发布推文，也可发布Agent自己的动态",
        "   - social.comment（评论）：对推文进行评论，支持与人类用户互动",
        "   - social.like（点赞）：为感兴趣的推文点赞",
        "   - social.feed（浏览动态）：查看社区内所有用户（包括Agent和人类）的动态",
        "   - 适用于：分享想法、参与社区讨论、回应用户帖子、建立社交连接",
        "   - 注意：作为Agent可以主动发布内容，也可以帮助用户管理其社交账号",
      ],
    },
    {
      domain: "self_programming",
      lines: [
        "1️⃣5️⃣ 系统管理：管理记忆和上下文、调整系统配置",
        "1️⃣6️⃣ 自我编程：self.create_skill / update_skill / delete_skill / generate_skill / …（须「完全访问」）",
      ],
    },
    {
      domain: "notes",
      lines: [
        "📝 学习/知识笔记（单用户本地存储，不进 World）",
        "   - notes.create / notes.list / notes.get / notes.update / notes.delete",
        "   - notes.search（关键词 BM25 排序，命中后可走 update 复用）",
        "   - notes.summarize（生成摘要，懒写回）",
        "   - notes.flashcards（生成记忆卡片 q/a）",
        "   - notes.quiz（生成自测题）",
        "   - notes.schedule_review（创建复习提醒，调用 calendar.create_task 落地）",
        "适用：学习（看书/视频/课程）、会议纪要、读书摘录、灵感闪念、视频字幕沉淀等。",
        "状态连续性：写之前先 notes.search 查重；update/delete 必须基于返回的 id。",
      ],
    },
    {
      domain: "image_gen",
      lines: [
        "🎨 图像生成（text-to-image，Agent 底层创作能力）：",
        "   - image.generate（文本生成图片）：合成并落地为本地静态 PNG，返回可永久访问的 imageUrl",
        "     · prompt（必填）：图像描述，建议包含主体 / 风格 / 构图 / 光影",
        "     · model 可选：Kwai-Kolors/Kolors（默认，中文友好）/ black-forest-labs/FLUX.1-schnell（速度快）/ stabilityai/stable-diffusion-3-5-large（高质量）",
        "     · imageSize 可选：1024x1024 / 768x1024 / 1024x768 / 512x512",
        "   - 适用场景：用户说「画一张」「生成图片」「做张图」「画个 logo」「配张插图」",
        "   - 失败时返回 ok=false + error，告知用户「图像生成未配置」或「生成失败」即可",
        "   - 与社交动态联动：生成图后可直接调 social.post 把 imageUrl 发到社区动态",
      ],
    },
    {
      domain: "file_doc",
      lines: [
        "📄 文件/文档处理（Agent 底层文件操作能力）：",
        "   - file.read_text（读文本文件）：支持 path/url/base64 三种输入，返回内容（截断 8KB）",
        "   - file.write_text（写文本文件）：把 content 写到工作目录，返回可访问 url",
        "   - file.parse_pdf（解析 PDF）：提取文本与元数据",
        "   - file.parse_office（解析 Office）：Word .docx / Excel .xlsx 提取文本/表格",
        "   - file.export_format（导出格式）：json/csv/markdown/html 互转",
        "   - 适用场景：用户上传文件要求解析、数据格式转换、文档内容提取",
      ],
    },
    {
      domain: "email_sms",
      lines: [
        "📧 邮件/短信（收件 + 主动发送）：",
        "   - 收件：邮件盯件（IMAP）自动把新邮件收进消息中心（platform=email），" +
        "用 messages.overview / messages.read_conversation 查看；重要邮件会主动提醒，" +
        "验证码/账单/票务类邮件自动提取处理（验证码播报、账单入账、票务转日程）",
        "   - email.send（发邮件）：SMTP 发送，需配置 OUTBOUND_SMTP_* 环境变量",
        "   - sms.send（发短信）：阿里云短信，需配置 ALIYUN_SMS_* 环境变量",
        "   - 适用场景：「我邮箱有没有新邮件」「邮件里说了什么」以及「发邮件通知」「发短信告诉同事」",
        "   - 发送失败时返回 ok=false + error，告知用户「邮件/短信未配置」即可",
      ],
    },
    {
      domain: "media_music",
      lines: [
        "🎵 媒体音乐播放控制：",
        "   - media.search（搜索音乐）：按关键词搜索歌曲/艺人/专辑",
        "   - media.play（播放）：开始播放指定曲目，客户端 WS 收到 agent.media.play 事件",
        "   - media.pause / media.resume / media.stop：播放控制",
        "   - media.now_playing：查询当前播放状态",
        "   - 适用场景：用户说「放首歌」「来点轻音乐」「暂停一下」「现在放的什么」",
      ],
    },
    {
      domain: "health_fitness",
      lines: [
        "💪 健康/运动数据接入：",
        "   - health.log_metric（记录指标）：步数/心率/睡眠/卡路里/体重等",
        "   - health.get_metrics（查询指标）：按时间范围查询历史",
        "   - health.get_summary（汇总）：日/周/月汇总",
        "   - health.set_goal / health.get_goals：目标管理",
        "   - health.import_data（导入）：批量导入历史数据",
        "   - 适用场景：用户说「记录今天走了 8000 步」「最近心率怎么样」「导入运动手表数据」",
      ],
    },
    {
      domain: "finance_deep",
      lines: [
        "💰 财务深度能力：",
        "   - finance.import_transactions（导入交易）：CSV/JSON 批量导入",
        "   - finance.analyze_spending（支出分析）：按类目/时间统计",
        "   - finance.set_budget / finance.get_budget_status：预算管理",
        "   - finance.reconcile（对账）：账户余额核对",
        "   - finance.categorize（分类）：自动归类交易",
        "   - finance.export_report（导出报告）：生成财务报表",
        "   - finance.cancel_subscription（自动取消订阅）：识别低使用订阅并退订，统计省钱金额，给出商户侧取消路径",
        "   - finance.savings_summary（省钱统计）：已退订订阅累计省下的金额",
        "   - finance.add_bill / finance.list_bills / finance.update_bill / finance.pay_bill：账单管理（登记/追踪/到期提醒/缴费入账联动预算）",
        "   - 适用场景：用户说「这个月花了多少」「导入银行账单」「设置餐饮预算 2000」" +
          "「帮我退掉没用的订阅」「退订省了多少钱」「记一下房租每月1号3500」「最近有什么账单要交」",
      ],
    },
    {
      domain: "social_outreach",
      lines: [
        "📢 社交主动出击（外部真实平台）：",
        "   - social.post（发帖）：Twitter / 微博 / 小红书 / 朋友圈",
        "   - social.comment / social.repost / social.like：互动",
        "   - social.get_feed（获取动态）：拉取关注流",
        "   - social.search_posts（搜索帖子）：关键词搜索",
        "   - 与 world.social.* 区别：world.social 是 Agent 内部世界社交，social.* 是外部真实平台",
        "   - 凭证从环境变量读取（TWITTER_* / WEIBO_* 等），未配置时返回 ok=false",
      ],
    },
    {
      domain: "code_sandbox",
      lines: [
        "💻 代码执行沙盒（python / node / shell）：",
        "   - code.run（执行代码）：spawn 子进程跑 Python/Node，返回 stdout/stderr/exitCode",
        "     · 工作目录隔离：data/sandbox/{actorId}/{workspaceId}/，每个会话独立",
        "     · 资源限制：超时 30s（可配置 CODE_SANDBOX_TIMEOUT_MS）、stdout/stderr 各截断 8KB",
        "     · 网络默认禁用（SANDBOX_ALLOW_NETWORK=0）",
        "   - code.shell（执行 shell 命令）：在沙箱工作目录内执行白名单命令（ls/grep/curl/pip/ffmpeg/git 等）",
        "     · 三道闸安全策略：命令名白名单 + 子命令黑名单 + 危险参数正则",
        "     · 参数以数组传入，不经 shell 解析，避免注入",
        "     · 适用：pip install 装包、grep 搜索文件、ffmpeg 转码、git log 查历史、zip 压缩等",
        "   - code.list_files / code.read_file / code.write_file：工作目录文件管理",
        "   - 适用场景：复杂计算（矩阵/统计）、数据清洗/格式转换、算法验证、批量文件操作、数据可视化、装包/文件操作/格式转换",
        "   - 与 self_programming 区别：self.* 是创建/更新 Agent 的 Skill 模块（持久化能力），code.* 是一次性执行临时脚本",
      ],
    },
    {
      domain: "shopping_order",
      lines: [
        "🛒 购物/下单（优先用户可见的内置浏览器，无头兜底，代用户真实下单）：",
        "   - shopping.order.search（搜索商品）：内置浏览器/Playwright 打开平台搜索页，读取商品列表（名称/价格/链接）",
        "   - shopping.order.place（下单）：两阶段确认。confirm=false 走到结算页返回订单摘要+确认 token+截图；confirm=true+token 完成提交订单（落本地表，返回 localOrderId）",
        "   - shopping.order.track（查订单）：内置浏览器实时刷新订单状态/物流，支持本地单号 so_*；平台不可达时回退本地记录",
        "   - shopping.order.cancel（取消订单）：两阶段确认取消",
        "   - shopping.order.list（本地订单列表）：零副作用读取本地订单表（我买过什么）",
        "   - shopping.pay.submit（支付宝代付）：仅限捕获到支付宝收银台链接的订单；内置浏览器在线时直接打开收银台并推收款二维码，否则经用户本人支付宝钱包确认扣款",
        "   - shopping.pay.check（支付状态）：查钱包支付状态 + 平台侧刷新，回写本地订单表",
        "   - 平台：taobao/tmall/jd/meituan/pdd/douyin/damai(演出票)/maoyan(演出票)；杂货/日用品建议 meituan 或 jd",
        "   - 演出票（damai/maoyan）多为实名制：观演人须已在用户账号内添加，agent 不代填证件信息",
        "   - 登录态：优先用客户端内置浏览器的用户登录态（免 Cookie）；遇到登录页自动推二维码给用户并等待扫码后继续；也可导入平台 Cookie 并授权 agentAllowed（POST /integrations/browser-sessions/import + /consent）作为无头兜底",
        "   - 一次登录长期有效：扫码/内置浏览器登录成功后平台 Cookie 自动加密持久化（授权只升不降），运行期刷新的 Cookie 自动回写——之后的查询/下单在客户端离线时也能走无头兜底，无需重复登录",
        "   - 安全护栏不依赖访问模式：Cookie 双重门禁 + 两阶段确认 + 单笔上限 SHOPPING_ORDER_MAX_AMOUNT_CNY（默认 5000，可按平台覆盖）+ 单日预算 SHOPPING_ORDER_DAILY_BUDGET_CNY（默认 10000）",
        "   - 支付边界：只提交订单不支付；支付宝收银台可代付（用户本人确认扣款），其余平台引导用户 App 内支付",
        "   - 与 browser.fetch_page（只读读价）/ shopping.suggest（仅建议）/ wallet.purchase（仅记账）区别：本工具真实提交订单",
        "   - 下单前必须先返回确认摘要让用户确认，得到用户明确同意后再带 confirm=true+token 执行",
      ],
    },
    {
      domain: "shopping_compare",
      lines: [
        "🏷️ 购物比价（只读零副作用：比价/降价监控/调研对比，不下单）：",
        "   - shopping.compare.prices（跨平台比价）：并行搜多平台，同款归一聚合，按价格升序返回分组报价；低置信组标注「疑似同款」",
        "   - shopping.compare.research（保险/服务调研比价）：保险/宽带/会员等无法抓价的领域，web 检索权威来源，由 LLM 汇总成对比表（附来源，注明以官方条款为准）",
        "   - shopping.compare.watch（降价监控）：关注某平台某商品的目标价，后台定时复查（默认 60min），到价且为新低价时主动提醒",
        "   - 与 shopping.order.*（真实下单）的边界：比完价用户确认后再下单；本模块不产生订单或支付",
      ],
    },
    {
      domain: "agent_browser",
      lines: [
        "🌐 Agent 虚拟浏览器（服务端 Playwright 无头浏览器，通用网页多步操作）：",
        "   - agent_browser.open（打开 URL）：启动浏览器打开 https URL，返回 sessionId；对已授权站点自动注入用户 Cookie",
        "   - agent_browser.click（点击）：传 sessionId + selector 点击元素（支持 CSS / text= / xpath= 选择器）",
        "   - agent_browser.type（输入）：在输入框输入文本，默认替换模式，append=true 可追加并模拟打字延迟",
        "   - agent_browser.scroll（滚动）：三种模式 — selector 滚到元素 / deltaY 相对滚动 / x,y 绝对坐标",
        "   - agent_browser.extract_text（提取文本）：**主要信息获取工具**，返回页面文本 + 可交互元素列表（tag/text/selector）",
        "   - agent_browser.screenshot（截图）：返回 JPEG base64（⚠️token 消耗大，优先用 extract_text）",
        "   - agent_browser.wait_for（等待）：等待元素出现并可见，默认超时 15s",
        "   - agent_browser.close（关闭）：完成操作后主动关闭会话释放资源",
        "   - 有状态会话：open 返回 sessionId 后，后续操作复用同一 Page，支持多步流程（open → extract_text → click → type → extract_text → close）",
        "   - 安全：https 任意 URL / http 仅 localhost；沙箱下也可用；会话绑定 actorId 隔离；TTL 10 分钟 + LRU 上限 8 个自动清理；所有操作审计",
        "   - 与 browser.fetch_page（只读单页无状态）/ shopping.order.*（仅购物业务）/ desktop.visual.run_task（操控桌面软件）的区别：本工具是通用多步浏览器操作",
        "   - 典型流程：open 打开页面 → extract_text 看页面结构和可点元素 → click/type 操作 → extract_text 确认结果 → close 关闭",
      ],
    },
    {
      domain: "shared_browser",
      lines: [
        "🖥️ 共用浏览器（用户与 Agent 共用客户端内嵌浏览器，操作实时可见、可随时接管）：",
        "   - shared_browser.navigate（打开 URL）：在用户正在看的浏览器里打开网页，等加载完成后返回标题/URL",
        "   - shared_browser.control（导航控制）：back/forward/reload/stop/home",
        "   - shared_browser.click（点击）：CSS 选择器 / 可见文本 / read_page 返回的元素序号 三选一定位",
        "   - shared_browser.type（输入）：填输入框，submit=true 回车提交（搜索框场景）",
        "   - shared_browser.scroll（滚动）：deltaY 相对滚动 / to=top|bottom 直达顶底",
        "   - shared_browser.read_page（读页面）：**主要信息获取工具**，返回 URL/标题/正文/可交互元素列表（带 index）",
        "   - 核心价值：用户当前登录的站点直接以登录态操作（无需 Cookie 导入），用户全程可见、验证码/支付环节可手动接管",
        "   - 浏览器未打开时报「共用浏览器未连接」，请提示用户打开客户端「常用工具 → 浏览器」",
        "   - 与 agent_browser.*（服务端无头会话池，用户不可见、需 sessionId）的区别：本族直接操控用户眼前的浏览器，适合需要用户登录态或用户正在看的操作",
        "   - 典型流程：navigate 打开 → read_page 看结构 → click/type 操作 → read_page 确认结果",
      ],
    },
    {
      domain: "ride_hailing",
      lines: [
        "🚕 打车/网约车（统一预订抽象层 services/booking/）：",
        "   - ride_hailing.quote（报价）：车型（经济/舒适/商务）+ 价格预估；pickup 缺省自动取用户当前 GPS 定位",
        "   - ride_hailing.book（下单）：两阶段确认。confirm=false 返回订单摘要+确认 token；confirm=true+token 真实（或模拟）下单",
        "   - ride_hailing.status（追踪）：司机接单/行程中/完成，含司机/车牌等动态信息；不传 orderId 返回最近订单",
        "   - ride_hailing.cancel（取消）：两阶段确认取消",
        "   - Provider：BOOKING_MODE=mock（默认）为模拟数据（simulated=true，必须如实告知用户）；live 走高德打车（估价需 AMAP key，真实下单需企业版资质配置）",
        "   - 安全护栏：单笔上限 BOOKING_MAX_AMOUNT_CNY（默认 1000）+ 单日累计上限 BOOKING_DAILY_BUDGET_CNY（默认 500）+ token 5 分钟 TTL + 审计；Agent 不代付",
        "   - 与 meituan.create_order（跑腿）/ travel.compute-route（纯路线查询）的区别：本工具为叫车报价与下单",
        "   - 下单前必须先返回确认摘要让用户确认，得到明确同意后再带 confirm=true+token 执行",
      ],
    },
    {
      domain: "home_services",
      lines: [
        "🧹 家政/本地生活预订（统一预订抽象层）：",
        "   - home_service.search（搜套餐）：cleaning=保洁/repair=维修/moving=搬家/beauty=美容美发/pet=宠物照料，返回套餐价格/时长",
        "   - home_service.book（下单）：两阶段确认，返回摘要+token 后须用户确认再执行",
        "   - home_service.status（状态）：订单状态查询；不传 orderId 返回最近订单",
        "   - home_service.reschedule（改期）：须用户明确给出新时间后调用",
        "   - home_service.cancel（取消）：两阶段确认取消",
        "   - Provider：BOOKING_MODE=mock（默认）为模拟套餐（simulated=true，必须如实告知）；真实平台（美团家政/58同城/天鹅到家）实现 BookingProvider 接口后即可接入",
        "   - 安全护栏与 ride_hailing 相同（单笔/单日限额 + 两阶段确认 + 审计）",
      ],
    },
    {
      domain: "restaurant_booking",
      lines: [
        "🍽️ 餐厅预订（统一预订抽象层）：",
        "   - restaurant.search（搜餐厅）：菜系/人均/时段；客户端定位时优先附近推荐；可结合用户饮食偏好过滤",
        "   - restaurant.book（订座）：两阶段确认，摘要含餐厅/人数/时间/预估消费",
        "   - restaurant.status（状态）：订座状态查询；不传 orderId 返回最近订单",
        "   - restaurant.cancel（取消）：两阶段确认取消",
        "   - Provider：BOOKING_MODE=mock（默认）为模拟餐厅（simulated=true，必须如实告知）；真实平台（大众点评/美团/OpenTable）实现 BookingProvider 接口后即可接入",
        "   - 与 meituan.create_order（外卖跑腿）/ travel.search-poi（旅行 POI 探索）的区别：本工具为到店订座",
      ],
    },
    {
      domain: "travel_booking",
      lines: [
        "✈️ 机票/火车票/酒店预订（统一预订抽象层 + 多源报价比价）：",
        "   - travel_booking.search（报价比价）：多源聚合实时报价，每条带 priceSource（api=实时接口 / scraped=页面代查 / database|list=本地价格库 / estimated=估算）。机票/火车票需 from/to（+departTime 更准），酒店需 city",
        "   - travel_booking.book（下单）：两阶段确认。confirm=false 返回订单摘要+token；confirm=true+token 创建「待支付」订单（bkg_*）",
        "   - 商家真实下单拿收银台链接：travel_booking.book 拿到待支付订单后，用 agent_browser.open/click/type/extract_text 在商家站点（携程/飞猪/12306 等）走完下单流程，从支付页提取收银台链接/订单串；把链接经 cashierUrl 传给 travel_booking.book（或 booking.travel-pay 的 paymentLink）即可发起真实支付。登录态失效/需验证码时把页面情况如实告知用户并请其手动完成该步",
        "   - 支付闭环（下单后接力，非本模块工具）：booking.travel-pay（用户本人支付宝真实扣款）→ booking.travel-pay-check（查支付结果）→ booking.travel-issue（出票入票夹）→ travel.arrival-monitor（到站管家）",
        "   - travel_booking.status（状态）：订单状态查询；不传 orderId 返回最近旅行订单",
        "   - travel_booking.cancel（取消）：两阶段确认；仅限未出票订单",
        "   - travel_booking.refund（退改工单）：已支付/已出票订单的退票、改签。两阶段确认创建工单（rft_*，随订单保存可断点续办）；真实退改只能在原下单平台办理且涉及资金退回，Agent 不代办最终提交——经用户批准后用 agent_browser 打开原平台订单页导航到退改签入口，页面上的「提交」必须由用户本人点击。费用与时效以平台规则为准，须如实转告",
        "   - 报价来源现状：本地价格库（保底，估算价如实标注）；飞猪 FlyAI CLI（酒店/机票实时 api 价，装 flyai CLI 即自动出价：npm i -g @fly-ai/flyai-cli，报价选项自带 extra.bookingUrl 飞猪预订链接，可直接作 cashierUrl，无需再代走浏览器）；浏览器代查·携程机票（Playwright 可用时出 scraped 价）",
        "   - 安全护栏与 ride_hailing 相同（单笔/单日限额 + 两阶段确认 + 审计）；Agent 不代付、不持有支付凭证",
        "   - 【诚实边界】必须向用户如实转述价格来源与「以平台实价为准」；估算价（estimated）不得当作实价汇报，缺实时报价时先引导用户确认基准价或说明是估算",
        "   - 与 ride_hailing.*（市内打车）的区别：本工具为城际交通票务与酒店住宿的报价比价与预订；行程规划（travel.plan-itinerary / travel.search-poi）只出候选不下单——规划结果里的订酒店/机票一律由本工具承接（travel_booking.search 飞猪实时比价 → travel_booking.book 两阶段下单）",
      ],
    },
  ];
}

/** Agent system prompt：语音触达能力（两种模式 + 未来路线图）。 */
const PHONE_MODEL_LINES = [
  "【语音触达 · 静默触达】通过 phone.call_user 工具实现，调用时直接执行，不在回复中提及。",
  "【模式一 · 语音提醒（闹钟式）】适用「提醒我xxx」「语音告诉我」—— 单向 TTS 播报，无来电 UI。spokenMessage 填内容，ringStyle=\"reminder\"。",
  "【模式二 · 电话通话（来电式）】适用「给我打个电话」—— 振铃8秒 → 自动接通 → TTS 播放。spokenMessage 填对用户说的话。当前为 TTS-only 单向模式；未来将升级为 ASR→LLM→TTS 全双工交互。",
  "【号码归属】6 位站内号登记在本 Agent 名下，即用户的站内电话号，申领后方可呼出虚拟电话；接收来电不要求对方有号。",
  "【Agent↔Agent 联络】Agent 之间不打电话，用 world.link.send_message 文本通道联系（仅限好友）。",
  "【禁止】禁止回复「马上给你打过去」「好的我给您打电话」「现在打确认」—— 直接调工具即可，不要废话。同一条消息禁止多次调用 phone.call_user。",
];

function buildPhoneCapabilityLines(hasVirtualPhone: boolean, virtualPhone?: string): string[] {
  const header = hasVirtualPhone && virtualPhone
    ? `📞 语音触达（您的联络号码：${virtualPhone}，登记在 Agent 名下）`
    : "📞 语音触达（尚未申领 6 位联络号码）";
  const tools = hasVirtualPhone
    ? "★ phone.call_user（核心工具：语音提醒/电话通话，spokenMessage 填内容）| phone.ensure_my_number（查询号码）"
    : "★ phone.call_user（尚未申领号码：呼出会被拒绝，可引导用户说「帮我申请虚拟号码」后由 phone.ensure_my_number 办理）| phone.ensure_my_number（用户明确要求时申领）";
  return [header, ...PHONE_MODEL_LINES, tools];
}

export function buildCoreCapabilitySections(
  skillManager: SkillManager,
  virtualPhoneService?: VirtualPhoneService,
  actorId?: string,
): CapabilitySection[] {
  const sections = buildStaticSections();

  if (virtualPhoneService && actorId) {
    const virtualPhone = virtualPhoneService.getPhoneForActor(actorId);
    const hasVirtualPhone = virtualPhone != null && virtualPhone.length > 0;
    sections.push({
      domain: "phone",
      lines: buildPhoneCapabilityLines(hasVirtualPhone, virtualPhone ?? undefined),
    });
  }

  return sections;
}




