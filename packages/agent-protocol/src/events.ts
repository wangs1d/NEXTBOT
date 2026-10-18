export type EventEnvelope = {
  type: string;
  payload: Record<string, unknown>;
};

export type WalletAction = "freeze" | "debit" | "refund" | "purchase";

export const ClientEventType = {
  SessionInit: "session.init",
  ChatUserMessage: "chat.user_message",
  /**
   * 用户在「选择型卡片」底部按钮上点击某个 action 的事件。
   * 与 chat.user_message 语义等价(都是用户输入),但携带 action 元数据
   * (actionId/cardId/variant/payload),便于后端做埋点/统计/路由分流。
   * 服务端将其转写为 chat.user_message 走原有 chat 流程。
   */
  ChatUserAction: "chat.user_action",
  /**
   * 用户取消一个后台任务（任务面 TaskHub 记录，payload 带 taskId）。
   * 与「打断前台回复」（发送新消息触发）语义分离：本事件只作用于
   * 后台任务——任务标记 cancelled 后不再向对话推送结果。
   */
  ChatTaskCancel: "chat.task_cancel",
  /** 客户端「Agent 处理中」UI 显隐；false 时服务端锁定本轮，不再合并后续消息 */
  ChatAgentProcessingUi: "chat.agent_processing_ui",
  /** 客户端请求清除聊天历史（服务端同步清除 ChatThreadStore + 持久化） */
  ChatClearHistory: "chat.clear_history",
  WalletSimulateRequest: "wallet.simulate.request",
  /** AIP v0.1：结构化跨 Agent 消息（与工具 aip.dispatch 等价）。 */
  AipDispatch: "aip.dispatch",
  /** 电脑端桥接：若服务端配置了 DESKTOP_BRIDGE_TOKEN 则须提交；无 token 模式无需发送本事件 */
  DesktopBridgeRegister: "desktop.bridge.register",
  /** 电脑端桥接：执行完成后回传结果（与 desktop.bridge.invoke 的 jobId 对应）。 */
  DesktopBridgeResult: "desktop.bridge.result",
  /** 电脑端桥接：Python 主动推送事件（如窗口焦点变化），单向推送，不阻塞 invoke 通道。 */
  DesktopEvent: "desktop.event",
  /** 手机桥接注册：携带 PHONE_BRIDGE_TOKEN 验证 */
  PhoneBridgeRegister: "phone.bridge.register",
  /** 手机桥接：执行完成后回传结果（与 phone.bridge.invoke 的 jobId 对应）。 */
  PhoneBridgeResult: "phone.bridge.result",
  /**
   * 共用浏览器桥：客户端（聊天主通道 session.init 带 browserBridge:true 绑定）
   * 执行完 shared.browser.invoke 下发的动作后回传结果（jobId 对应）。
   */
  BrowserBridgeResult: "browser.bridge.result",
  /**
   * 共用浏览器桥：客户端上报 CDP 调试端点（payload.endpoint，http://127.0.0.1:<port>）。
   * 仅在用户显式开启 remote-debugging-port 时发送；服务端 trusted 工具
   * （Playwright CDP 直连，isTrusted=true 可信输入）据此连接。空 endpoint = 清除。
   */
  BrowserBridgeInfo: "browser.bridge.info",
  /**
   * 手机桥接：消息捕捉批量上报（通知监听/短信等 → 服务端消息聚合中心）。
   * payload.messages 为消息数组，每条带 externalMessageId 供服务端去重；
   * 服务端落库后回 phone.msg.report_ack（按 batchId），手机端凭 ack 出队。
   */
  PhoneMsgReport: "phone.msg.report",
  /**
   * 手机桥接：定位低频回传（前台服务定时上报；与 phone.locate 按需定位分离）。
   * 服务端落入 location-history（location.db）。
   */
  PhoneLocReport: "phone.loc.report",
  /** 用户发起虚拟电话呼叫Agent */
  VirtualPhoneUserCall: "phone.user_call_agent",
  /** 用户直接呼叫自己的Agent（无需输入ID，服务端从session推断） */
  VirtualPhoneCallMyAgent: "phone.call_my_agent",
  /** 用户对「其他 Agent 虚拟来电」的响应：接听 / 拒接 / 委托 Agent 代接 */
  VirtualPhoneIncomingResponse: "phone.incoming_response",
  /** 通话中用户回复：携带 callId + 文本（打字输入或客户端本地 ASR 转写），进通话回复总线 */
  VirtualPhoneCallReply: "phone.call_reply",
  /** 用户挂断当前通话：服务端推送 ended 状态并清理通话会话 */
  VirtualPhoneCallHangup: "phone.call_hangup",
  /** 球形 Agent 具身交互：唤醒、发消息、聚焦聊天等 */
  AgentEmbodimentInteract: "agent.embodiment.interact",
  /** 客户端回报球形窗口在屏幕上的位置（配合 embodiment.observe 闭环） */
  AgentEmbodimentState: "agent.embodiment.state",
  /** 用户对主动联系的反馈，写回用户理解与联系偏好 */
  CompanionContactFeedback: "companion.contact_feedback",

  // ============================================================
  // 终端互连平台 device.* 事件族（Phase 2+）
  // 与现有 phone.bridge.* / desktop.bridge.* 并存：
  //   - 旧事件按 userId 单连接语义（每用户一个桥接器）
  //   - device.* 按 deviceId 多连接语义（每用户可挂 N 台设备）
  // 适配器迁移完成后旧事件可逐步废弃。
  // ============================================================

  /** 设备上线注册：携带 deviceId / kind / capabilities / ownerUserId */
  DeviceRegister: "device.register",
  /** 设备主动下线 */
  DeviceUnregister: "device.unregister",
  /** 设备心跳：刷新 lastSeenAt（复用 ws.keepalive 亦可，本事件携带 deviceId 维度） */
  DeviceHeartbeat: "device.heartbeat",
  /** 设备回传 invoke 结果（与 device.invoke 的 jobId 对应） */
  DeviceInvokeResult: "device.invoke_result",
  /** 设备回传流数据块（与 device.stream_open 的 streamId 对应） */
  DeviceStreamData: "device.stream_data",
  /** 设备主动上报事件：电量变化 / 按键 / 移动侦测等 */
  DeviceEvent: "device.event",
  /** 设备能力变更：如摄像头切换分辨率、新增传感器 */
  DeviceCapabilitiesUpdate: "device.capabilities_update",
  /** 客户端回传实时位置（响应 agent.location_request，或天气面板主动上报） */
  LocationReport: "client.location_report",
  /**
   * 客户端上报语音模式切换（进入/退出纯语音模式）。
   * 服务端记录 per-actor 状态（proactivity/voice-mode-state），供诊断与
   * 后续主动消息投递通道矩阵（语音播报 vs 原生弹窗）消费。
   */
  ModeChanged: "mode.changed",
  /** 心跳检测 */
  Ping: "ping",
} as const;

export const ServerEventType = {
  /**
   * 协议级消息已收到确认：WS 收到用户消息后立即推送（< 1ms），
   * 让客户端知道服务端已收到并排队处理。与 chat.assistant_interim 不同，
   * 这是纯协议层 received-confirmation，不带任何内容。
   */
  ChatMessageReceived: "chat.message_received",
  /**
   * 任务面（TaskHub）生命周期变更广播：任务派发/进度/终态。
   * 前后台分工的客户端契约——前台模型把实事派给后台（task.dispatch）后，
   * 客户端凭此事件在对话流里落一张轻量「任务回执」（无缝对话形态：
   * 状态原地更新，不打断用户继续聊天；结果本身仍走 chat.assistant_done，
   * 以独立 assistant 消息落位、只含结果本体）。
   * 可用 AGENT_TASK_PLANE_WS_EVENTS_ENABLED=0 关闭（回退到旧行为：
   * 无回执，任务完成后结果消息直接落进对话流）。
   */
  ChatTaskUpdate: "chat.task_update",
  ChatAssistantChunk: "chat.assistant_chunk",
  ChatAssistantDone: "chat.assistant_done",
  /**
   * 会出卡片的轮次不流式（2026-10-08）：服务端在确认本轮将携带结构化卡片
   * （工具确定性附卡源 / 识图照片卡 / LLM 自产结构化标记）后推送此事件，
   * 客户端撤回该 trace 已流出的正文（清空流式气泡回到生成中状态），服务端
   * 随即转静默——最终内容由 chat.assistant_done 一次性结构化下发，根治
   * 「先流式打纯文本 → done 整条替换成卡片渲染」的跳变。
   */
  ChatStreamReset: "chat.stream_reset",
  /**
   * 「边说边出图」：媒体搜索工具（search_images / search_images_batch /
   * search_videos）执行成功的瞬间推送该批结构化媒体卡片，前端立即把它们
   * 插到当前流式回复正文下方（pendingMediaCards），无需等 LLM 打完字。
   * done 时再以 renderBlocks 的最终顺序校正/替换。
   */
  ChatMediaReady: "chat.media_ready",
  /**
   * 即时确认应答（已废弃，保留兼容）：被动聊天路径已改为通过
   * chat.assistant_chunk 携带 phase="interim" 字段推送首段文本，
   * 与主回复共用同一 messageId，避免渲染成两条独立消息。
   * 主动通知路径（proactive_text）仍使用此事件类型。
   */
  ChatAssistantInterim: "chat.assistant_interim",
  /**
   * 「分阶段异步对话交互 v2」阶段 0：客户端在用户发消息的同一帧就应展示
   * 顶栏「正在思考…」占位 + 计时器。服务端在路由/委派开始时立即推一条，
   * 用于打点 T0（首字延迟测量起点）。
   */
  ChatTurnStarted: "chat.turn_started",
  /**
   * 「分阶段异步对话交互 v2」阶段 1：路由结束、意图已识别。
   * 携带 mode + 可选的 plan（plan_execute 拆解出的步骤）和 subAgents
   * （master_delegate 要派出的子 Agent 列表），让 UI 立刻渲染结构化骨架。
   */
  ChatIntentDetected: "chat.intent_detected",
  /**
   * 「分阶段异步对话交互 v2」阶段 2：执行事件流（多次）。
   * 替换此前的 chat.agent_status 自由文本，把工具调用 / 子 Agent 启停 /
   * 模型内部 thought 都按 kind 结构化下发，UI 按 kind 决定卡片样式。
   */
  ChatExecutionEvent: "chat.execution_event",
  /** 模型生成的口语化进度/状态行（如委派子 Agent），供客户端替代「思考中」 */
  ChatAgentStatus: "chat.agent_status",
  /** 日程/提醒任务已创建或更新，客户端应刷新日程视图 */
  ScheduleTasksChanged: "schedule.tasks_changed",
  /** 定时提醒到点触发（服务端调度器执行后推送） */
  ScheduleReminderFired: "schedule.reminder_fired",
  /**
   * 生活消息入站（邮件 / 微信服务通知 / 通用消息桥等 MessageHub 汇入源）：
   * 客户端收到后经灵动岛 attention 即时告知（2026-10-05 定调：消息类统一上岛，
   * 岛=告知、弹窗=决策）。仅判重后的新消息推送（ingestInbound 命中去重不触发）。
   */
  HubMessageArrived: "hub.message_arrived",
  ToolCall: "tool.call",
  ToolResult: "tool.result",
  WalletSimulateResult: "wallet.simulate.result",
  AgentPeerMessage: "agent.peer_message",
  /**
   * 站内好友消息已读回执（2026-10-17）：A 标读好友会话后，服务端把读取进度
   * 翻译到对端 B 的会话空间（经 externalMessageId 映射两侧副本）推给 B。
   * payload: { readerActorId, lastReadSeq, readAt }——lastReadSeq 为 B 会话
   * 空间内的已读序号，B 客户端把自己的 seq ≤ lastReadSeq 的气泡标为已读。
   * 尽力而为语义：离线不补投，标读动作不重复补偿。
   */
  AgentPeerReadReceipt: "agent.peer_read_receipt",
  /** 每日天气简报（日程 weather_brief 触发，需已建立 WS session） */
  WeatherBrief: "weather.brief",
  /** Agent 自动化任务到点执行完成（需已建立 WS session 才能实时收到） */
  ScheduleAgentTaskFired: "schedule.agent_task_fired",
  /** Agent 虚拟电话来电（6 位号码线路；可含 TTS mp3 base64） */
  VirtualPhoneIncoming: "agent.phone.incoming",
  /** 虚拟电话通话状态变更（用户拨打Agent时的振铃/接通/挂断等） */
  VirtualPhoneCallStatus: "agent.phone.call_status",
  /**
   * 虚拟电话振铃开始事件 —— 前摇阶段首帧。
   * 客户端收到后应进入「振铃中」UI：播放振铃音、显示来电者信息、
   * 渐入动画、倒计时。此时不含 TTS 正文音频。
   * 随后服务端会推送 agent.phone.call_connecting 进入接通阶段。
   */
  VirtualPhoneRingingStart: "agent.phone.ringing_start",
  /**
   * 虚拟电话接通事件 —— 前摇结束，正式进入通话。
   * 包含 TTS 音频和正文 transcript。
   * 仅在 ringing_start 之后发送；若不需要前摇则直接发 incoming（向后兼容）。
   */
  VirtualPhoneCallConnecting: "agent.phone.call_connecting",
  /**
   * 通话中 Agent 语音回应 —— 用户在通话里回复（phone.call_reply）后，
   * Agent 的后续回应以此事件推回（含 TTS 音频 + transcript），客户端在通话 UI 内续播。
   * 与 call_connecting 的区别：call_connecting 只出现在接通瞬间，voice_reply 用于通话中的多轮交互。
   */
  VirtualPhoneVoiceReply: "agent.phone.voice_reply",
  /** 电脑端桥接绑定成功 */
  DesktopBridgeRegisterAck: "desktop.bridge.register_ack",
  /** 发往电脑端：执行一轮纯视觉桌面任务 */
  DesktopBridgeInvoke: "desktop.bridge.invoke",
  /** 手机端等与 userId 对齐的 WS：电脑桥接在线状态、最近桌面任务结果摘要 */
  DesktopBridgeSync: "desktop.bridge.sync",
  /** 手机桥接：绑定成功 */
  PhoneBridgeRegisterAck: "phone.bridge.register_ack",
  /** 发往手机端：执行远程控制命令 */
  PhoneBridgeInvoke: "phone.bridge.invoke",
  /** 手机桥接状态同步 */
  PhoneBridgeSync: "phone.bridge.sync",
  /** 发往客户端：让用户正在看的浏览器（WebView2）执行一个动作（导航/点击/输入/读页） */
  SharedBrowserInvoke: "shared.browser.invoke",
  /** 共用浏览器桥在线状态同步（随 session.init 绑定后下发） */
  SharedBrowserSync: "shared.browser.sync",
  /** 发往手机端：消息捕捉批量上报已落库（payload.batchId + accepted/duplicate 计数），手机端凭此出队 */
  PhoneMsgReportAck: "phone.msg.report_ack",
  /** 球形 Agent 权威视觉状态（mood/energy/caption/委派 phase） */
  AgentEmbodimentPatch: "agent.embodiment.patch",
  /** 主 Agent 具身控制：3D 漫游、移动、停驻等（球形机器人身体） */
  AgentEmbodimentCommand: "agent.embodiment.command",
  ErrorEvent: "error.event",
  /** 晨间简报：调度器到点触发后推送 */
  MorningBriefing: "morning.briefing",
  /** 晚间 digest（今日回顾+明日预告）：调度器到点触发后推送（Task 15 生活节律） */
  EveningDigest: "evening.digest",
  /**
   * 接驳提醒（travel-upgrade-plan P2）：行程交通大段（高铁/航班）到站/出发前
   * 动态触发，询问是否预约滴滴（确认后 Agent 走 ride_hailing 真实下单）。
   * payload: { sessionId, planId, destination, segment, minutesUntil, message, phase }
   * phase: pre_arrival（到达提醒）| pre_departure（返程出发提醒，卡面带「导航去车站」）
   *        | missing_time（无票面时刻，求补充）
   */
  AgentTransferReminder: "agent.transfer_reminder",
  /**
   * 生活节律画像更新（Task 20 生活节律引擎）：夜间分析完成后推送。
   * 客户端可用于展示"管家眼中的你"（睡眠窗口/高效时段/节律洞察），
   * 以及节律提醒时间被自适应调整后的说明。
   */
  RhythmProfileUpdated: "rhythm.profile_updated",
  /** Agent 推断的用户心情变化（实时通知） */
  MoodInferred: "mood.inferred",
  /** 心跳响应 */
  Pong: "pong",
  /**
   * Agent 语音播报（即时模式）—— `voice.speak` 工具触发的轻量播报。
   * 与 `agent.phone.*` 不同：无来电 UI、无振铃、无前摇，客户端后台播放即可。
   * payload.tts.format === null 时表示 TTS 未启用，客户端可用本地 TTS 兜底。
   */
  AgentVoiceSpeak: "agent.voice.speak",
  /**
   * Agent 语音提醒（闹钟模式）—— 带标题/优先级的语音播报。
   * 适用于提醒、定时播报、重要通知场景，客户端可显示卡片 + 播放音频。
   * 比 phone.call_user 轻：无来电界面，但有视觉提示。
   */
  AgentVoiceAlarm: "agent.voice.alarm",
  /**
   * 闹钟跨设备同步 —— 闹钟在某端创建/修改/取消后 fan-out 到该用户全部在线设备，
   * 各端写入本地闹钟库并重排本地调度（本地调度为主路，见 docs/mobile-agent-reminder-alarm-design.md）。
   * payload: { alarm, op: "upsert" | "delete" }
   */
  AlarmSync: "alarm.sync",
  /**
   * 闹钟到点兜底触发 —— 服务端调度器扫描到 nextFireAt 到点后推送。
   * 客户端本地调度是主路：若本地已触发（firedAtMs 相同分钟内），收到本事件应幂等忽略并回报回执。
   * payload: { alarmId, label, kind, firedAtMs, via, wakeMode?, tts? }
   */
  AlarmTrigger: "alarm.trigger",
  /**
   * 即时提醒投递 —— 服务端到点下发，客户端按 channelPlan 升级链展示
   * （notification → popup → …，escalateAfterSec 未确认则升级）。
   * payload: { reminderId, text, channelPlan, escalateAfterSec, requireAck }
   */
  ReminderDeliver: "reminder.deliver",
  /**
   * 用户语音消息的 ASR 转写结果回执：
   * 服务端在 `chat.user_message` 收到 `contentType=audio` 后跑 ASR，
   * 把识别到的 transcript 推回给客户端，让本地 user 消息气泡直接显示转写文本
   * （便于用户验证 ASR 准确率 + 留有可读副本）。
   * payload.messageId 与客户端发出的 user 消息 messageId 一一对应。
   */
  ChatAudioTranscript: "chat.audio_transcript",
  /**
   * Agent 语音消息（微信式可重播）—— `voice.send_message` 工具触发。
   * 与 `agent.voice.speak` 区别：speak 是即时播报（一次性、后台播放、无 UI），
   * message 是落地的可重播语音消息（带 mediaUrl / durationMs / waveform / transcript），
   * 客户端渲染为微信式语音气泡，可多次点击重播。
   */
  AgentVoiceMessage: "agent.voice.message",
  /**
   * 媒体音乐播放控制 —— `media.*` 工具族触发。
   * 客户端收到后执行实际播放 / 暂停 / 恢复 / 停止；服务端负责按 trackId 解析
   * 可播放 URL 并随 agent.media.play 下发（客户端不自行拉流地址）。
   * URL 解析失败（无版权/超时）时事件仍下发（payload 带 urlError），客户端应
   * 如实展示"无法播放"，不得假成功。
   */
  AgentMediaPlay: "agent.media.play",
  AgentMediaPause: "agent.media.pause",
  AgentMediaResume: "agent.media.resume",
  AgentMediaStop: "agent.media.stop",

  // ============================================================
  // 终端互连平台 device.* 服务端事件
  // ============================================================

  /** 设备注册确认（发往注册方设备） */
  DeviceRegisterAck: "device.register_ack",
  /** 设备上线广播（发往 owner 的其他客户端，让其刷新设备列表） */
  DeviceOnline: "device.online",
  /** 设备下线广播 */
  DeviceOffline: "device.offline",
  /** 下发给设备的 RPC 调用请求 */
  DeviceInvoke: "device.invoke",
  /** 下发给设备的开流请求 */
  DeviceStreamOpen: "device.stream_open",
  /** 下发给设备的关流指令 */
  DeviceStreamClose: "device.stream_close",
  /** 设备列表 / 能力 / 状态变更通知（发往 owner 客户端） */
  DeviceListChanged: "device.list_changed",
  /** 设备主动上报事件转发（发往订阅了该设备事件的客户端 / Agent） */
  DeviceEventRelay: "device.event_relay",
  /** device.list 查询应答（同步拉取当前设备清单） */
  DeviceListResult: "device.list_result",
  /** 进化审批请求：EvolutionCortex 检测到能力缺口 + 生成 Skill 后，请求用户批准装载 */
  EvolutionApprovalRequest: "evolution.approval_request",
  /** 进化审批结果：用户批准或拒绝后的状态通知 */
  EvolutionApprovalResult: "evolution.approval_result",
  /**
   * 服务端按需向客户端请求实时位置（如 weather.get_local 需要经纬度）。
   * 客户端收到后拉 GPS，通过 `client.location_report` 回传（携带相同 jobId）。
   */
  LocationRequest: "agent.location_request",
  /**
   * 持续定位配置（位置方案 A）：LOCATION_TRACKING_MODE=continuous 时随
   * session.init 绑定下发。客户端按 intervalSec 定时上报 `client.location_report`
   * （payload 带 source:"continuous"）；ondemand 模式不下发，客户端无定时器。
   * payload: { mode: "ondemand"|"continuous", intervalSec: number }
   */
  LocationTrackingConfig: "agent.location_tracking_config",
  /**
   * Surface-on-Demand：服务端（`surface.show` 工具）要求客户端展示一个
   * 按需召唤的信息面板（如"今日安排"悬浮窗）。客户端按 surface 名执行，
   * 不支持的面板静默忽略；ttlSeconds 后自动淡出。
   * payload: { surface: string, ttlSeconds?: number, jobId?: string }
   */
  SurfaceShow: "surface.show",
  /**
   * Surface-on-Demand：服务端（`surface.dismiss` 工具）要求客户端收起已
   * 展示的面板（如媒体中央展示页）。客户端按 surface 名执行，
   * 不支持的面板静默忽略；未展示时为 no-op。
   * payload: { surface?: string, jobId?: string }
   */
  SurfaceDismiss: "surface.dismiss",
  /**
   * 站内信：平台/运营侧经 POST /api/inbox/send 推送给用户的消息。
   * 必达语义：服务端先落盘（data/inbox/{actorId}.json，客户端随时经
   * GET /api/inbox/messages 拉取补齐），在线设备再收到本事件做即时提醒。
   * payload: { messageId, title, body, kind?, importance?, fromActorId?, createdAt }
   */
  InboxMessage: "inbox.message",

  // ============================================================
  // 电话代办（phone_call.* 工具族：真实 PSTN 外呼）事件族。
  // 与既有两族严格区分（命名即语义，详见 docs/phone-call-architecture.md §〇）：
  //   agent.phone.*  = 虚拟电话（站内应用内互拨，无 PSTN）
  //   phone.bridge.* = 设备桥 RPC（拨号/短信/定位…），非通话会话
  //   phone_call.*   = 本族：agent 代用户向第三方真人的真实外呼会话
  // ============================================================

  /**
   * 真实外呼会话状态变更（awaiting_confirm/confirmed/dialing/active/summarized/
   * cancelled/expired/failed）。客户端可据此展示轻量状态提示；P0 客户端未实现
   * 消费逻辑时安全忽略（不影响确认卡/结果卡等聊天内渲染通道）。
   */
  PhoneCallStatusUpdate: "phone_call.status_update",
  /**
   * 真实外呼确认卡请求：服务端在 phone_call.prepare 后推送（含脱敏号码、目标、
   * 话术要点）。聊天内的权威确认入口是回复文本中的确认卡（AgentActionChoiceCard，
   * 点击经 chat.user_action 回传）；本事件仅作辅助提示通道。
   */
  PhoneCallConfirmRequest: "phone_call.confirm_request",
} as const;

/** phone_call.status_update 载荷：真实外呼会话状态快照 */
export type PhoneCallStatusUpdatePayload = {
  callId: string;
  state:
    | "awaiting_confirm"
    | "cancelled"
    | "expired"
    | "dialing"
    | "active"
    | "summarized"
    | "failed";
  /** 被叫号码（脱敏，如 138****5678） */
  numberMasked: string;
  contactName?: string;
  /** 一句话通话目标 */
  goal: string;
  outcome?: string;
  /** 拒绝/取消原因（确认超时/静默时段/频控/手机端取消…） */
  rejectReason?: string;
  /** 确认已记录（awaiting_confirm 阶段收到 confirmed=true 表示可拨打） */
  confirmed?: boolean;
  updatedAt: string;
};

/** phone_call.confirm_request 载荷：拨号确认请求（辅助提示通道） */
export type PhoneCallConfirmRequestPayload = {
  callId: string;
  numberMasked: string;
  contactName?: string;
  goal: string;
  /** 已知要素（人数/时间/订单号…） */
  facts?: Record<string, unknown>;
  /** 必须问清的事项 */
  mustAsk?: string[];
  /** 确认卡上的按钮约定：phone_call_confirm / phone_call_cancel（payload.callId 回传） */
  actionIds: string[];
  createdAt: string;
};

/** inbox.message 载荷：站内信（平台→用户收件箱） */
export type InboxMessagePayload = {
  messageId: string;
  title: string;
  body: string;
  /** system / announcement / friend / ... */
  kind?: string;
  importance?: "low" | "normal" | "high" | "critical";
  fromActorId?: string;
  /** ISO 时间戳 */
  createdAt: string;
};

/**
 * agent.media.play 载荷：媒体音乐播放指令。
 *
 * 服务端已按 trackId 解析好可播放 URL（网易云 song/enhance/player/url），
 * 客户端拿到 `url` 直接播放即可，无需自行拉流地址。
 * `url === null` 表示服务端解析失败（无版权/仅 VIP/上游超时），此时
 * `urlError` 说明原因——客户端应如实提示"无法播放"，不得假装在放。
 */
export type AgentMediaPlayPayload = {
  actorId: string;
  trackId: string;
  /** 曲目名（搜索元数据缺失时为 null，客户端可显示 trackId 兜底） */
  title: string | null;
  artist: string | null;
  album?: string | null;
  /** 可播放音频 URL；解析失败为 null（原因见 urlError） */
  url: string | null;
  /** 曲目时长（毫秒）；未知为 null */
  durationMs: number | null;
  /** URL 解析失败原因（无版权/接口超时等）；仅 url 为 null 时存在 */
  urlError?: string;
  /** ISO 时间戳 */
  timestamp: string;
};

// ============================================================
// 「分阶段异步对话交互 v2」事件载荷类型
// ============================================================

/** agent.location_tracking_config 载荷（位置方案 A：持续定位配置） */
export type LocationTrackingConfigPayload = {
  mode: "ondemand" | "continuous";
  /** 上报间隔（秒），服务端已夹紧到 30..3600 */
  intervalSec: number;
};

/** rhythm.profile_updated 载荷：节律画像摘要（Task 20 生活节律引擎） */
export type RhythmProfileUpdatedPayload = {
  actorId: string;
  /** 本轮有变化的节律维度 */
  changedDimensions: string[];
  /** 被自适应重排的节律提醒任务（出口 A） */
  adjustedReminderTaskIds: string[];
  /** 统计洞察（入睡趋势/加班日/高效时段等，纯统计生成） */
  insights: Array<{
    id: string;
    dimension: string;
    kind: string;
    text: string;
    confidence: number;
    generatedAt: string;
  }>;
  updatedAt: string;
};

/**
 * 阶段 0 载荷：路由开始打点。
 * - t0: 服务端接收 chat.user_message 的 epoch ms（用于客户端对齐首字延迟）
 */
export type ChatTurnStartedPayload = {
  sessionId: string;
  traceId: string;
  t0: number;
};

/**
 * 路由模式枚举（与服务端执行车道同步）：
 *   chat     对话面：直答 / 前台工具直办，秒回
 *   task     任务面：后台执行，完成后结果以独立消息回灌
 */
export type ChatIntentMode =
  | "chat"
  | "task";

/** plan_execute 拆解出的单个步骤。 */
export type ChatPlanStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "ok" | "err";
};

/** master_delegate 要派出的子 Agent 规划。 */
export type ChatSubAgentPlan = {
  id: string;
  role: string;
  task: string;
};

/**
 * 阶段 1 载荷：意图已识别。
 * - reasons: 路由命中的判定原因（调试用）
 * - plan: 仅 plan_execute 模式携带
 * - subAgents: 仅 master_delegate 模式携带
 */
export type ChatIntentDetectedPayload = {
  sessionId: string;
  traceId: string;
  mode: ChatIntentMode;
  reasons: string[];
  plan?: ChatPlanStep[];
  subAgents?: ChatSubAgentPlan[];
};

/** 执行事件类型（结构化区分 UI 渲染）。 */
export type ChatExecutionKind =
  | "thought" // 模型内部 monologue
  | "tool_call" // 工具开始调用
  | "tool_result" // 工具调用结果
  | "agent_start" // 子 Agent 开始
  | "agent_done" // 子 Agent 完成
  | "plan_step" // plan_execute 拆解出的步骤状态更新
  | "task_progress" // 状态机编排的桌面自动化任务进度(state_machine 模式)
  | "log"; // 兜底：自由文本日志（v1 过渡期兼容）

/** 阶段 2 载荷：执行事件流。 */
export type ChatExecutionEventPayload = {
  sessionId: string;
  traceId: string;
  /** 事件唯一 id（同 traceId 内单调递增，便于客户端去重 / 排序） */
  eventId: string;
  kind: ChatExecutionKind;
  /** 该事件发生时间 epoch ms */
  at: number;
  // ---- 按 kind 选填 ----
  thought?: string;
  toolCall?: {
    id: string;
    name: string;
    /** 摘要化的入参（避免把大对象塞进 WS） */
    argsPreview?: string;
  };
  toolResult?: {
    id: string;
    name: string;
    /** 摘要化的结果预览 */
    preview?: string;
    ok: boolean;
    elapsedMs: number;
  };
  agentStart?: {
    id: string;
    role: string;
    task?: string;
  };
  agentDone?: {
    id: string;
    role: string;
    ok: boolean;
    elapsedMs: number;
  };
  /** plan_execute 步骤状态更新（kind=plan_step 时携带） */
  planStep?: {
    id: string;
    title: string;
    status: "pending" | "running" | "ok" | "err";
  };
  /** 状态机任务进度（kind=task_progress 时携带，由 AgentTaskOrchestrator 推送） */
  taskProgress?: {
    taskId: string;
    actorId: string;
    type:
      | "task_created"
      | "state_transition"
      | "subtask_started"
      | "subtask_completed"
      | "subtask_failed"
      | "round_started"
      | "round_completed"
      | "tool_call"
      | "tool_result"
      | "approval_required"
      | "approval_granted"
      | "approval_denied"
      | "task_completed"
      | "task_failed"
      | "log";
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
  };
  /** 兜底：v1 过渡期自由文本 */
  log?: string;
};

// ============================================================
// 任务面（TaskHub）↔ 客户端 事件载荷（2026-09-08 前后台分工对话改造）
// ============================================================

/** chat.task_update 载荷：TaskHub 记录的一次生命周期变更（幂等全量快照）。 */
export type ChatTaskUpdatePayload = {
  sessionId: string;
  taskId: string;
  /** TaskHub 生命周期态：submit=running；结果/取消/异常=done|failed|cancelled */
  state: "running" | "awaiting_input" | "done" | "failed" | "cancelled";
  /** 任务目标（一句话自包含），客户端回执的主文案 */
  goal: string;
  /** 最近一条进度（工具调用名/排队提示），可缺省 */
  progressLine?: string;
  /** 结果归属的用户消息 id（发起该任务的消息），可缺省 */
  replyAnchorId?: string;
  /** 任务提交时间 epoch ms */
  startedAt: number;
  /** 事件发出时已运行时长 epoch ms 差值 */
  elapsedMs: number;
};

/** chat.task_cancel 载荷：用户请求取消一个后台任务。 */
export type ChatTaskCancelPayload = {
  sessionId: string;
  taskId: string;
};
