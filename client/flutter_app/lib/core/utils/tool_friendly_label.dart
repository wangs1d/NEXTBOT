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
/// - 服务端新增工具若未入表，兜底返回通用文案「正在调用工具」，同样不裸露
///   原始名——宁可模糊，不可泄底。
library;

/// 前缀 → 文案。顺序即匹配优先级，改动时保持 specific-first。
const List<(String, String)> kToolFriendlyLabels = <(String, String)>[
  // ── 购物 / 钱包 / 财务 ──
  ("shopping.compare", "正在跨平台比价"),
  ("shopping.order.search", "正在搜索商品"),
  ("shopping.order.place", "正在创建订单"),
  ("shopping.order", "正在处理订单"),
  ("shopping.pay", "正在处理支付"),
  ("shopping.suggest", "正在挑选商品"),
  ("wallet.get_", "正在查询钱包"),
  ("wallet.", "正在处理钱包交易"),
  ("budget.calculate", "正在计算预算"),
  ("finance.analyze", "正在分析支出"),
  ("finance.", "正在整理账单"),
  // ── 日程 / 提醒 / 时间 ──
  ("calendar.", "正在整理日程"),
  ("calendar_query", "正在整理日程"),
  ("reminder.plan", "正在安排提醒"),
  ("care.", "正在安排关怀提醒"),
  ("period.", "正在更新生理期记录"),
  ("clock.", "正在核对时间"),
  ("clock_now", "正在核对时间"),
  // ── 任务 / 计划 / 委派 ──
  ("goal.plan.", "正在拆解任务"),
  ("plan.", "正在拆解任务"),
  ("task_plan", "正在拆解任务"),
  ("master.invoke_sub_agent", "正在委派子任务"),
  ("master_invoke_sub_agent", "正在委派子任务"),
  ("task.dispatch", "正在安排后台任务"),
  ("task.cancel", "正在取消后台任务"),
  ("task.status", "正在查看后台任务"),
  ("task.", "正在安排后台任务"),
  ("agent.tasks.list", "正在查看任务"),
  ("agent.query_capabilities", "正在盘点能力"),
  ("agent.update_", "正在更新资料"),
  ("agent.", "正在盘点能力"),
  ("watch.track", "正在追踪动态"),
  // ── 联网检索 / 内容 ──
  ("search_web", "正在联网检索"),
  ("deep_search", "正在深度检索"),
  ("internet.research", "正在深度检索"),
  ("internet.", "正在联网核实"),
  ("search_images", "正在搜图"),
  ("search_videos", "正在找视频"),
  ("video.grab", "正在下载视频"),
  ("video.", "正在找视频"),
  ("hot_rankings", "正在查看热搜"),
  ("http.request", "正在请求网络数据"),
  ("image.generate", "正在生成图片"),
  // ── 网页 / 浏览器 ──
  ("fetch_web", "正在读取网页"),
  ("fetch_page", "正在读取网页"),
  ("info.inspect_webpage", "正在查看网页"),
  ("info.navigate_site", "正在浏览网站"),
  ("info.search", "正在联网检索"),
  ("browser.fetch_page", "正在读取网页"),
  ("agent_browser", "正在操作浏览器"),
  ("shared_browser", "正在操作浏览器"),
  ("browser_navigate", "正在操作浏览器"),
  ("browser.", "正在操作浏览器"),
  // ── 桌面操作（点号与下划线两代命名并存）──
  ("desktop.visual.screenshot", "正在查看屏幕"),
  ("desktop.visual.run_task", "正在操作电脑"),
  ("desktop.uia_query", "正在查看屏幕"),
  ("desktop_uia_query", "正在查看屏幕"),
  ("desktop.web_search", "正在联网检索"),
  ("desktop.web_fetch", "正在读取网页"),
  ("desktop.http_get", "正在读取网页"),
  ("desktop.run_shell", "正在执行命令"),
  ("desktop_run_shell", "正在执行命令"),
  ("desktop.run_input", "正在操作电脑"),
  ("desktop_run_input", "正在操作电脑"),
  ("desktop.run_automation", "正在操作电脑"),
  ("desktop.run_preset", "正在操作电脑"),
  ("desktop.open", "正在打开应用"),
  ("desktop_open", "正在打开应用"),
  ("desktop.window", "正在调整窗口"),
  ("desktop.clipboard", "正在操作剪贴板"),
  ("desktop.", "正在操作电脑"),
  // ── 手机 / 通话 ──
  ("phone.call_user", "正在拨打电话"),
  ("phone.dial", "正在拨打电话"),
  ("phone.ring", "正在响铃找手机"),
  ("phone.camera_capture", "正在用手机拍照"),
  ("phone.screen_record", "正在录制手机屏幕"),
  ("phone.locate", "正在定位手机"),
  ("phone_call.prepare", "正在准备通话"),
  ("phone_call.start", "正在拨打电话"),
  ("phone_call.", "正在处理通话"),
  ("phone.", "正在操作手机"),
  // ── 消息 / 社交 ──
  ("messages.reply", "正在回复消息"),
  ("messages.suggest_reply", "正在起草回复"),
  ("messages.search", "正在搜索消息"),
  ("messages.", "正在查看消息"),
  ("email.send", "正在发送邮件"),
  ("sms.send", "正在发送短信"),
  ("world.gomoku.create_table", "正在创建棋局"),
  ("world.gomoku.join", "正在加入棋局"),
  ("world.link.send_friend_request", "正在添加好友"),
  ("world.link.send_message", "正在给好友发消息"),
  ("world.link.", "正在处理好友关系"),
  ("world.status", "正在确认在线状态"),
  ("social.post", "正在发布动态"),
  ("social.like", "正在点赞"),
  ("social.comment", "正在评论"),
  ("social.repost", "正在转发动态"),
  ("social.search_posts", "正在搜索帖子"),
  ("social.get_feed", "正在浏览动态"),
  // ── 语音 / 媒体 ──
  ("voice.speak", "正在合成语音"),
  ("voice.transcribe", "正在转写语音"),
  ("voice.send_message", "正在发送语音消息"),
  ("voice.", "正在处理语音"),
  ("media.search", "正在搜索媒体"),
  ("media.login_status", "正在确认登录状态"),
  ("media.", "正在控制播放"),
  // ── 记忆 / 感知 / 身体 ──
  ("memory.", "正在翻记忆"),
  ("obs_recall", "正在翻记忆"),
  ("brain.remember", "正在翻记忆"),
  ("brain.recall", "正在翻记忆"),
  ("brain.speak", "正在合成语音"),
  ("brain.look", "正在观察环境"),
  ("brain.listen", "正在聆听环境"),
  ("brain.observe_user", "正在观察用户"),
  ("brain.plan", "正在拆解任务"),
  ("brain.delegate", "正在委派子任务"),
  ("brain.", "正在思考"),
  ("perception.", "正在感知环境"),
  ("vision.", "正在调用摄像头"),
  ("embodiment.", "正在活动身体"),
  // ── 生活服务 ──
  ("health.get", "正在查看健康数据"),
  ("health.query", "正在查看健康数据"),
  ("health.", "正在记录健康数据"),
  ("body.", "正在查看身体状态"),
  ("home_service.search", "正在找家政服务"),
  ("home_service.", "正在处理家政预订"),
  ("restaurant.search", "正在找餐厅"),
  ("restaurant.book", "正在预订餐厅"),
  ("restaurant.", "正在处理餐厅预订"),
  ("ride_hailing.quote", "正在询问车费"),
  ("ride_hailing.", "正在叫车"),
  ("travel_booking.search", "正在查询行程"),
  ("travel_booking.", "正在处理行程预订"),
  ("travel.", "正在规划行程"),
  ("smart_home.", "正在控制智能家居"),
  ("device.", "正在连接设备"),
  ("life.manage", "正在打理生活事务"),
  ("interest.manage", "正在整理兴趣"),
  ("geofence.", "正在设置位置提醒"),
  // ── 安全 ──
  ("safety.sos", "正在发起紧急求助"),
  ("safety.fake_call", "正在模拟来电"),
  ("safety.", "正在设置紧急联系人"),
  // ── 文件 / 代码 ──
  ("file.parse", "正在解析文档"),
  ("file.", "正在处理文件"),
  ("code.run", "正在执行代码"),
  ("code.shell", "正在执行代码"),
  ("code.", "正在整理代码文件"),
  // ── 技能 / 自我扩展 ──
  ("self.generate", "正在生成技能"),
  ("self.create_skill", "正在生成技能"),
  ("self.update_skill", "正在生成技能"),
  ("self.", "正在盘点技能"),
  ("skill.manage", "正在管理技能"),
  ("skill.", "正在查看技能"),
  // ── 其他 ──
  ("activity.", "正在记录活动动态"),
  ("profile.query", "正在查看资料"),
  ("profile.", "正在更新资料"),
  ("proactivity.feedback", "正在记录反馈"),
  ("proactivity.", "正在记录反馈"),
  ("surface.dismiss", "正在收起浮层"),
  ("aip.dispatch", "正在调度智能体"),
  ("aip.", "正在查询智能体状态"),
  ("mcp.", "正在调用外部工具"),
  ("tool_search", "正在查找工具"),
  ("tool_discover", "正在查找工具"),
  ("tool_describe", "正在查找工具"),
  ("notes_create", "正在记笔记"),
  ("weather_query", "正在查看天气"),
  ("weather.", "正在查看天气"),
];

/// 未知工具的通用兜底文案：不携带任何原始工具名。
const String kToolFriendlyLabelFallback = "正在调用工具";

/// 把内部工具名翻译成用户能懂的进行时文案。
/// 未命中映射表时返回通用兜底，绝不返回原始工具名。
String friendlyToolLabel(String tool) {
  final String name = tool.trim();
  for (final (String prefix, String label) in kToolFriendlyLabels) {
    if (name.startsWith(prefix)) return label;
  }
  return kToolFriendlyLabelFallback;
}
