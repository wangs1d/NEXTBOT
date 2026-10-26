/// 工具名 → 用户能懂的进行时文案。
///
/// 服务端 `tool.call` 下发的是内部工具名（如 `shopping.compare.prices`、
/// `desktop_uia_query`），直接亮给用户等于泄露工程实现。此表把每个工具族
/// 映射成一句进行时短语；**匹配必须走 `friendlyToolLabel`**，任何展示路径
/// 都不允许直接渲染原始工具名。
///
/// 维护约定：
/// - 表内前缀「specific 在前、family 在后」：同一族里更长的前缀必须排在
///   更短的前缀之前（如 `shopping.order.search` 先于 `shopping.order`）。
/// - 未入表的工具返回 `null`，调用方改用别的真实文案；**不设通用兜底**，
///   宁可不说，也不摆一句什么也没说的空话。新增工具请补表。
library;

/// 前缀 → 文案。顺序即匹配优先级，改动时保持 specific-first。
const List<(String, String)> kToolFriendlyLabels = <(String, String)>[
  // ── 购物 / 钱包 / 财务 ──
  ("shopping.compare", "我去比比哪儿便宜"),
  ("shopping.order.search", "我找找这件东西"),
  ("shopping.order.place", "我把单准备好"),
  ("shopping.order", "我处理下订单"),
  ("shopping.pay", "正在走支付这一步"),
  ("shopping.suggest", "我挑几个给你看"),
  ("wallet.get_", "我看下钱包余额"),
  ("wallet.", "正在处理钱包的事"),
  ("budget.calculate", "我算算这笔"),
  ("finance.analyze", "我看看钱都花哪儿了"),
  ("finance.", "我把账单理一下"),
  // ── 日程 / 提醒 / 时间 ──
  ("calendar.", "我看下你怎么排的"),
  ("calendar_query", "我查下你的日程"),
  ("reminder.plan", "我想想什么时候叫你"),
  ("care.", "我琢磨下怎么提醒你"),
  ("period.", "正在更新生理期记录"),
  ("clock.", "我看下现在几点"),
  ("clock_now", "我看下现在几点"),
  // ── 任务 / 计划 / 委派 ──
  ("goal.plan.", "这事得分几步，我捋一下"),
  ("plan.", "我捋一下怎么做"),
  ("task_plan", "我捋一下怎么做"),
  ("master.invoke_sub_agent", "我叫个帮手一起弄"),
  ("master_invoke_sub_agent", "我叫个帮手一起弄"),
  ("task.dispatch", "我先放着办，好了跟你说"),
  ("task.cancel", "我把那个活儿停一下"),
  ("task.status", "我去看看那件事办到哪了"),
  ("task.", "我先放着办"),
  ("agent.tasks.list", "我看看手上都有什么活儿"),
  ("agent.query_capabilities", "我想想这事我能不能办"),
  ("agent.update_", "我把资料改一下"),
  ("agent.", "我想想能怎么办"),
  ("watch.track", "我盯着这个"),
  // ── 联网检索 / 内容 ──
  ("search_web", "我上网查查"),
  ("deep_search", "我往深了查一下"),
  ("internet.research", "我往深了查一下"),
  ("internet.", "我上网核实一下"),
  ("search_images", "我找几张图"),
  ("search_videos", "我找个视频"),
  ("video.grab", "我把这个视频存下来"),
  ("video.", "我找个视频"),
  ("hot_rankings", "我看看现在都在聊什么"),
  ("http.request", "我去取一下数据"),
  ("image.generate", "我画一张"),
  // ── 网页 / 浏览器 ──
  ("fetch_web", "我把这页读完"),
  ("fetch_page", "我把这页读完"),
  ("info.inspect_webpage", "我看看这页写了什么"),
  ("info.navigate_site", "我去这个站里转转"),
  ("info.search", "我上网查查"),
  ("browser.fetch_page", "我把这页读完"),
  ("agent_browser", "我用浏览器打开看看"),
  ("shared_browser", "我用浏览器打开看看"),
  ("browser_navigate", "我在网页里翻一下"),
  ("browser.", "我在网页里翻一下"),
  // ── 桌面操作（点号与下划线两代命名并存）──
  ("desktop.visual.screenshot", "我截一下你的屏幕看看"),
  ("desktop.visual.run_task", "我动一下你的电脑"),
  ("desktop.uia_query", "我看下你屏上有什么"),
  ("desktop_uia_query", "我看下你屏上有什么"),
  ("desktop.web_search", "我上网查查"),
  ("desktop.web_fetch", "我把这页读完"),
  ("desktop.http_get", "我把这页读完"),
  ("desktop.run_shell", "我跑一下这个命令"),
  ("desktop_run_shell", "我跑一下这个命令"),
  ("desktop.run_input", "我替你敲两下"),
  ("desktop_run_input", "我替你敲两下"),
  ("desktop.run_automation", "我按预设走一遍"),
  ("desktop.run_preset", "我按预设走一遍"),
  ("desktop.open", "我把那个应用打开"),
  ("desktop_open", "我把那个应用打开"),
  ("desktop.window", "我挪一下窗口"),
  ("desktop.clipboard", "我看下你剪贴板里的东西"),
  ("desktop.", "我动一下你的电脑"),
  // ── 手机 / 通话 ──
  ("phone.call_user", "我打过去"),
  ("phone.dial", "我拨号"),
  ("phone.ring", "我让手机响一下"),
  ("phone.camera_capture", "我用手机拍一张"),
  ("phone.screen_record", "我开始录手机屏幕了"),
  ("phone.locate", "我定位一下手机"),
  ("phone_call.prepare", "我把电话准备好"),
  ("phone_call.start", "我打过去"),
  ("phone_call.", "我处理下这通电话"),
  ("phone.", "我操作下手机"),
  // ── 消息 / 社交 ──
  ("messages.reply", "我回他一句"),
  ("messages.suggest_reply", "我先把话拟好"),
  ("messages.search", "我翻翻聊天记录"),
  ("messages.", "我看看消息"),
  ("email.send", "我把邮件发出去"),
  ("sms.send", "我发条短信"),
  ("world.gomoku.create_table", "我开个棋局"),
  ("world.gomoku.join", "我进这局棋"),
  ("world.link.send_friend_request", "我加个好友"),
  ("world.link.send_message", "我给好友发一句"),
  ("world.link.", "我处理下好友的事"),
  ("world.status", "我看看谁在线"),
  ("social.post", "我发一条"),
  ("social.like", "我点个赞"),
  ("social.comment", "我留句评论"),
  ("social.repost", "我转发一下"),
  ("social.search_posts", "我搜搜帖子"),
  ("social.get_feed", "我刷刷动态"),
  // ── 语音 / 媒体 ──
  ("voice.speak", "我说出来"),
  ("voice.transcribe", "我把这段听成字"),
  ("voice.send_message", "我发条语音"),
  ("voice.", "我处理下语音"),
  ("media.search", "我找找有什么能听的"),
  ("media.login_status", "我看下登录了没"),
  ("media.", "我放一下"),
  // ── 记忆 / 感知 / 身体 ──
  ("memory.", "我翻翻咱聊过的"),
  ("obs_recall", "我翻翻咱聊过的"),
  ("brain.remember", "我记下来"),
  ("brain.recall", "我回想一下"),
  ("brain.speak", "我说出来"),
  ("brain.look", "我看一眼周围"),
  ("brain.listen", "我听一下周围"),
  ("brain.observe_user", "我看下你现在的样子"),
  ("brain.plan", "我捋一下怎么做"),
  ("brain.delegate", "我叫个帮手一起弄"),
  ("brain.", "我琢磨一下"),
  ("perception.", "我感受下周围"),
  ("vision.", "我开一下摄像头"),
  ("embodiment.", "我动一下"),
  // ── 生活服务 ──
  ("health.get", "我看下你的身体数据"),
  ("health.query", "我看下你的身体数据"),
  ("health.", "我记一笔身体数据"),
  ("body.", "我看下你的状态"),
  ("home_service.search", "我找下家政"),
  ("home_service.", "我处理下家政这单"),
  ("restaurant.search", "我找家餐厅"),
  ("restaurant.book", "我把位子订上"),
  ("restaurant.", "我处理下订座的事"),
  ("ride_hailing.quote", "我看下车费多少"),
  ("ride_hailing.", "我叫辆车"),
  ("travel_booking.search", "我查下有哪些行程"),
  ("travel_booking.", "我处理下这单预订"),
  ("travel.", "我排一下这趟怎么走"),
  ("smart_home.", "我弄一下家里设备"),
  ("device.", "我连一下设备"),
  ("life.manage", "我打理一下这些事"),
  ("interest.manage", "我记一下你的喜好"),
  ("geofence.", "我设个到地方的提醒"),
  // ── 安全 ──
  ("safety.sos", "正在发起紧急求助"),
  ("safety.fake_call", "正在模拟来电"),
  ("safety.", "正在设置紧急联系人"),
  // ── 文件 / 代码 ──
  ("file.parse", "我把这份文档读进来"),
  ("file.", "我处理下这个文件"),
  ("code.run", "我跑一下这段代码"),
  ("code.shell", "我跑一下这段命令"),
  ("code.", "我改下这些文件"),
  // ── 技能 / 自我扩展 ──
  ("self.generate", "我学一下这个"),
  ("self.create_skill", "我学一下这个"),
  ("self.update_skill", "我学一下这个"),
  ("self.", "我想想我会不会这个"),
  ("skill.manage", "我调整下我会的东西"),
  ("skill.", "我看看我会什么"),
  // ── 其他 ──
  ("activity.", "我记一笔"),
  ("profile.query", "我看下资料"),
  ("profile.", "我把资料改一下"),
  ("proactivity.feedback", "我记下你这个反馈"),
  ("proactivity.", "我记下你这个反馈"),
  ("surface.dismiss", "我把那张卡片收起来"),
  ("aip.dispatch", "我叫另一个我去办"),
  ("aip.", "我去看看那边办得怎么样"),
  ("mcp.", "我找个工具搭把手"),
  ("tool_search", "我找找有没有趁手的工具"),
  ("tool_discover", "我找找有没有趁手的工具"),
  ("tool_describe", "我找找有没有趁手的工具"),
  ("notes_create", "我记个笔记"),
  ("weather_query", "我看下外头天气"),
  ("weather.", "我看下外头天气"),
];

/// 把内部工具名翻译成用户能懂的进行时文案。
/// 未命中映射表返回 `null`（绝不返回原始工具名），由调用方决定改说什么。
String? friendlyToolLabel(String tool) {
  final String name = tool.trim();
  for (final (String prefix, String label) in kToolFriendlyLabels) {
    if (name.startsWith(prefix)) return label;
  }
  return null;
}
