# Private-Agent 长期项目笔记

> 逐日明细见同目录 `YYYY-MM-DD.md`；本文件只留跨天仍有约束力的铁律与硬事实。
> 2026-10-11 二次压缩（原文件超长被注入截断）。条款未删，只压行文；新发现请追加到对应小节。

## 铁律一：确定性执行契约（realtime / media）
- 意图判出后：**查询词由纯代码构造**（`agent/realtime-search-query.ts` 的 composeRealtimeSearchQuery / composeMediaSearchQuery），**执行由 agent-core / 工具循环确定性发起**（realtime=前置证据检索；media=`deterministicToolCalls` 循环开场预执行，以 assistant(tool_calls)+tool 协议进上下文）。「要不要搜」永不交给模型现场决定，模型只当叙述者、可追加细化调用。
- 出口闸家族（never_attempted 续波）是决策权错配的事后补丁；遇「同类轮次时好时坏」先查该意图是否缺确定性半边，别再加闸。
- media 查询词：剥命令词/载体词/量词（搜索/几张/照片），余下主体即词；壁纸/头像/表情包是有效检索词**不剥**；剥光则退回 realtime 实体消解，恒非空。视频词命中走 search_videos。

## 铁律二：统一时间源注入
- 任何「当前时间」必须来自注入的时间源；服务内部**禁** `Date.now()`/无参 `new Date()`；跨服务调用**上层必须透传时钟**。写法 `constructor(..., private readonly now: () => Date = () => new Date())`（18+ 服务）。已补 ScheduleTaskService、FinanceDeepService。
- 时基跨边界贯通：`CommitmentBoard.setScheduleOutlet()` 把板钟经 `outlet.setNow?.()` 下发，保证出口「未来时间闸」与板扫描同基。
- 故障指纹：注入冻结时钟却「不物化 / spent=0 / 期望有数据实为 0」且真实日期已越过 fixture → 下游偷读墙钟（fire-and-forget 只留一行 console.error，易误判为功能缺失）。
- 测试隔离反模式：`delete process.env.X` 不够——`src/config/load-server-env.ts` 在 **import 期**跑 dotenv 会把本机 `.env` 灌回进程环境，须在请求前显式归位。

## 铁律三：用户事实单一权威源
- 权威源 = `structured_facts`（`agentic-memory/structured-fact-store.ts`，字段表 `PROFILE_FIELD_ALIASES`）：称呼/职业/居住地/技术栈/生日/公司/学历只允许它写。其余皆投影：`USER_PROFILE.md` 基本字段行由 `services/user-personalization/profile-fact-authority.ts` 重渲染；KV 槽位不留副本；KV `user_profile` 须与磁盘画像逐字一致。
- 纪律：发现某字段别处又写一份 → 接到权威源，**不是加同步**；新字段在 `PROFILE_FIELD_ALIASES` 登记。
- 存量收敛（幂等）：`cd server && D:\nodejs\node.exe --import tsx scripts/reconcile-profile-facts.ts [actorId...]`。运行期自动维持：写钩子(去抖 900ms)+夜间任务+启动后 25s 批量（`AGENT_PROFILE_FACT_AUTHORITY_RECONCILE=0` 关）。
- 坑：「常用语言」曾被当「技术栈」别名（投影会误替换）；`normalizeSubject` 需剥「」才能去近重复。

## 铁律四：工具域归属自动派生
- `DOMAIN_REGISTRY`（`tools/tool-search/tool-category.ts`）是域归属唯一事实源；消费点：路由束投影、域卡（模型每轮的「我有什么」）、按域 `tool_discover`、L1 预载多数票。
- **禁止手工白名单**：`domainsForTool` 显式前缀未命中且注册名含 `.` 时取首段作派生域（`habit.create-rule`→`habit`）。教训：travel/alipay/habit/booking/picture/finance/virtual-phone/agentworld 都因漏登记落进 `misc`。
- 故障指纹：某能力「模型不用、自己答」且族名不在域卡 → 先看 `misc` 规模；**超 `CARD_TOOLS_PER_DOMAIN=14` 的溢出成员会从域卡消失**（picture 全族曾对模型不可见），此时 `tool_discover({domain:"<族名>"})` 报「未知能力域」。修后 misc 应恒为个位数。
- 技能族 BM25 词面分天生低（英文点号名 vs 中文口语）：域派生只解决可见性+按域可达；L1 预载还需 ① 派生域族信号通道（BM25 top-8 内同派生域 ≥2 工具，补充式，仅在显式域未占满 2 名额时生效）② `intent-metadata.ts` 给入口工具补 aliases/examples。缺一则 L1 漏召。
- 语料铁律：域归属/域卡/召回断言必须用**含技能注册链的真实语料**（builtin 113 不含技能工具）。探针 `server/scripts/probe-deferred-domain-coverage.ts`。

## 铁律五：外部信源收编「三件齐」
- 新增外部信源（邮件/日历/账本/购物…）必须：① 适配器 `proactivity/sensors/<x>-sensor.ts`（只做读端口→Signal 形状转换）② `world-board.ts` 的 `ingestSignal` switch case ③ `mapping-rules.ts` 一条规则。缺 ②=信号进库却驱动不了规则；缺 ③=进板没人看。**「静默丢弃」是标准指纹**（mail/finance 落 lastEnv 尾迹；ICS 的 startMs/summary 与 schedule 分支要求的 nextRunAt/nextTitle 不匹配被丢）。
- ICS 适配器 `signal.at` 是**事件开始时刻**，判「是否未来事件」必须对板钟 `nowFn()`，不能用 `at`。
- 验收：`server/test/sensor-to-proactive-e2e.test.ts`（真实组件全链，仅 IMAP/HTTP 是桩）；写新信源必须加一条三段断言（进库→驱动规则→投递）。
- 跨源实体召回：`source-store.tokenize` = 整段词元 + 2 字滑窗（CJK）；原 `{2,4}` 贪婪会让「三亚合同」吃掉「三亚」。改动必跑 `sensor-fabric-external.test.ts`。
- 管道测试：`ProactivePipeline` 必须显式注入 `lastConversationAt`，否则退回 `presence.lastActivityAt` → social 提案被 in_conversation_defer_90s 延迟。

## 铁律六：出口文本净化（元叙述 / 上游控制帧）
- **元叙述**：`ltm-write-gate.ts`（写侧）+ `reply-style-guard.ts`（出口侧）都含 `meta_narration`（括号段扫描器，整段剥离，先于句级手术）。
- **上游 harness 控制帧**：模型会把 provider 塞进上下文的控制帧原样复读成正文。已知两形态：`<system-reminder>`（2026-10-08）、`<system>`（2026-10-11，帧体 `[trajectory-slicing]`，**不闭合**且说明行带中文）。两者必须**服务端+客户端同构**剥离（`external-model/internal-frames.ts` ↔ `core/utils/assistant_text_sanitizer.dart`），改一边就漏一边。`<system>` 判据：opener 后首个非空行是方括号纯拉丁控制标签 → 吞到空行/EOF；客户端流式须「未终结即扣住整条流」，逐 chunk 净化认不出帧体后半段。
- **元决策自述**（2026-10-11，`stream-chat-helpers.ts` 的 `isMetaDecisionSentence` / `stripMetaSentences`，`createStreamMetaSentenceFilter` 共用同一套判据）：模型把「该不该调工具」的内心权衡写进 **content**（reasoning 通道只累积不推流、客户端不渲染），随**工具波前导话**透出 → 分泡器切条。硬判据单命中即删（根据规范/强制规则/必须调用/系统已注入/调用 clock…），软判据只吃光秃秃动作宣告（`直接调用。`）；代码语境词/超长句豁免；整句删除后须吞掉**孤立闭括号**。整串路径用 `stripMetaSentences`（无残句），**不要**用 `createStreamMetaSentenceFilter` 打整串——它按 chunk 语义会把末尾无句末标点的句子吞掉。
- **两条通用铁律**：① 这类自述的**触发源往往在 prompt 自相矛盾**（「要不要调工具」有互斥硬规则时模型必然先自述再执行）——先修口径，闸只是保险；② **净化必须做在分段器之前**（onDelta 咽喉）：ws 收口只在 `residual` 非空时才补推/替换裁决（`chat-user-message.ts:1429-1462`），**纯删除型净化 residual 为空 → 整块跳过 → 不打 `finalTextReplacesStream`，已展示气泡永久保留**（分泡轮 `resolveDivergence` 还会把 ≥40% 的重写版 "discard"）。出口闸修好了用户也照样看得见。
- 症状学：「该调的工具没调 + 出来是搜索结果卡 + 附一段 agent 独白」三连 → 先查 turnIntent 是否落对话面（chat/knowledge_qa），再查语料装配。

## 工具可见集装配
- 已修：chat 分支 `chatToolsExtra` 曾覆盖 `sessionSkillTools`，致 8 族 51 个技能工具在对话面失踪。语料 = `dedupeToolsByName([builtin, promptContextBuilder.getChatSkillTools(actorId)])`。**技能工具只走 sessionSkillTools**（有装配通道不变量测试守住）。
- 教训（铁律级）：这类装配 bug 的回归测试必须从**真实装配产出**取语料（SkillManager 注册真实技能 → skillManifestToChatTool）；手搓 corpus 会绿测骗自己。

## 主动性与时间感知（别重复造）
- 三层护栏串行于 `ProactivityHub.route()`：抑制 `SuppressionStore`（用户明确拒绝）→ 时效准入 `proactivity/temporal-admission.ts`（话题时效）→ 频控 `FrequencyGovernor`（预算/冷却/静默时段）。
- 时效闸默认零行为变化：仅当意图显式带 `originAt` 且越过 kind 在途窗口才从严；未带 originAt 当新鲜放行。会「复活旧事」的新生产者必须回填 originAt。
- 时间信息三处丢失点：`chat-thread-store.buildTimestampFreeLlmView` 剥 `[ts:]`；`agent/time-context-gate.ts` 按需放行；recap 相对词跨天漂移。修复全在**视图层**（annotateRecapLinesWithAge / decayStaleOpenLoops / migrateRecapLineLabel），**不落盘** → 测试断言「存储对象字节未变」。
- 改 recap 视图必守 prefix cache：标注一律**日粒度**，禁「N 小时前」。回归 `test/temporal-anchor.test.ts`、`test/temporal-admission.test.ts`；端到端 `server/scripts/probe-temporal-guard.ts`。
- recall_history 跨会话检索 exclude 语义：裸 actorId=当前活跃线程（排除）、`master:{actorId}`=migrate 历史线程（**不排除**，正是回查目标）。主会话消息落盘无 `[ts:]`，回退线程 updatedAt 会渲染成精确时刻把旧消息显示成「刚刚」→ 必须加「约」前缀 + timeSource。探针 `server/scripts/probe-recall-history.ts`。

## 入口下线（右侧面板）
- `features/chat/right_side_panel.dart` 的 `_allToolSpecs()` 是工具全集（`_ToolSpec{id,icon,label,onTap,badgeCount,subLabelBuilder}`）；布局偏好存 `core/services/right_panel_tool_preference.dart`（order+hidden），`sortIds` 只保留仍在全集里的 id → **下线入口只需从 `_allToolSpecs()` 摘掉，用户历史偏好无需清理**。
- 已下线/已删：图库（注释保留）、手机（`_kPhoneToolEntryEnabled=false` → 后按要求**彻底删除**）。手机删除口径：`_allToolSpecs()` 摘 tile、`RightSidePanel.onPhone` 参数、`main.dart` 的 `onPhone:_openPhoneDevicesDialog` 与该法、`phone_devices_page.dart` 的 import，及面板内 `_phoneOnline/_phoneTotal/_phoneBridgeOnline/_devicePollTimer/_deviceApi/_phoneApi`、`_refreshDeviceStatus/_refreshDeviceList/_refreshPhoneBridgeStatus`、`_phoneSubLabel`、`device_api_client.dart`/`phone_remote_api.dart` 两个 import。**保留**：`features/phone_devices/`（我的手机页）与 `core/services/phone_remote_api.dart` 留仓无调用方；`features/devices/devices_page.dart` 仍由 `_openDevicesPage` 使用，别误删。教训：隐藏与删除是两回事——入口专用且无其他消费者的轮询/状态字段，删入口时必须同删。

## 本机环境硬约束（别踩）
- **`flutter` 工具本机跑不起来**：Dart VM 起子进程报 `CreateFile failed 231 (ERROR_PIPE_BUSY)`（系统命名管道耗尽），重启可恢复；期间 `flutter run/build/doctor` 全废（`flutter build` 要 spawn cmake/ninja/gen_snapshot）。
  **但 `D:/Flutter/bin/dart analyze lib` 可用**（2026-10-11 实测）——它就是本机的「编译门」：**改完 Dart 先 analyze，有 error 就别指望热重载/重建**。纯 Dart 工具函数还能直接 `dart run` 跑校验脚本。
- 命名管道耗尽还会让 Node `spawnSync` `EBUSY`（tasklist/netstat/taskkill 同步调用全废）→ 脚本一律异步 `spawn`。
- 停桌面应用**不要** `taskkill /T`：应用名下挂着本地 runtime(127.0.0.1:3000) 与灵动岛/简报子进程；子进程即同名 exe，`/IM private_ai_agent.exe` 已全覆盖。
- 调试版 exe `windows_dist\Debug\private_ai_agent.exe`，kernel 在 `windows_dist\Debug\data\flutter_assets\kernel_blob.bin`。debug 启动时 VM Service 地址打到 stdout（stderr 被重定向到 pai_app_stderr.log 且独占），端口/鉴权码随机。
- 后端本地跑 **tsx watch 源码**：`scripts/autostart/autostart-server.mjs` → `dev-all.mjs` → `dev-server-watch.mjs` → `tsx watch src/index.ts`。**改 `server/src/**` 无需构建**；`server/dist/**` 是 2026-10-04 旧快照，只有 `npm start` 用，别拿它判断代码是否生效。
- 类型检查：`cd server && node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（2026-10-09 起 0 错误）。
- 单测：`cd server && node --import tsx --test test/<file>.test.ts`（tsx/typescript 装在**根** node_modules）。
- **better-sqlite3 按 Node 24 编译**：直接开 sqlite 的脚本必须 `D:\nodejs\node.exe`（托管 Node 22 → ERR_DLOPEN_FAILED）。
- 全量测试：`cd server && "D:/nodejs/node.exe" --import tsx --test --test-timeout=30000 "test/**/*.test.ts"`（**必须带 --test-timeout**）。2026-10-09 基线：2598 例 / 2584 过 / 12 败 / 1 取消（92s）。托管 Node 22 跑会凭空多 137 条 NODE_MODULE_VERSION 伪失败。
- 判「失败是否本次引入」：`git worktree add ../pa-head HEAD --detach` + `cmd //c mklink //J ../pa-head/node_modules <主仓>/node_modules` 比对；清理**必须先 `cmd //c rmdir <worktree>\node_modules` 摘 junction 再 `git worktree remove --force`**（Windows 上 rm -rf 会跟随 junction 删掉主仓 node_modules）。

## 桌面端开发循环
- 改 Flutter Dart 用 `npm run dev:desktop`（`scripts/desktop-hot-reload.mjs`）：真热重载 ~3-4s 生效；回车=重载，r=重启，q=退出，`--once` 跑一轮。`dev-client-watch.mjs` + `rebuild-desktop-debug.ps1` 是兜底。
- **顺序**：① `dart analyze lib` 必须 0 error（有 error 时热重载只会打印「增量编译失败」，很容易被当成「改漏了」——2026-10-11 用户报「还是原先的效果」，真因就是工作区里 `client_update_checker.dart` 少了 `FileMode` 的 import，编译全挂、应用一直跑 10-10 的旧 kernel）；② `npm run dev:desktop -- --once`；③ **行程独立窗口是子进程，不吃热重载** → 把 `build/hot-reload/app.dill` 同步进两个 `data/flutter_assets/kernel_blob.bin`（先备份 `.pre-日期`），否则窗口仍跑旧 Dart。校验：`grep -c "<新加的字面量>" <kernel>`。
- 改 native（`client/flutter_app/windows/**`、插件原生、pubspec 依赖）必须全量 `flutter build windows --debug`。

## 行程「进入界面」三端布局（2026-10-11 桌面端收敛后为准）
- 桌面 = **独立系统窗口 + `server/web/travel-map/desktop.html`（行迹桌面版，用户设计稿 1:1）**：`GET /travel-map/desktop` → 窗口宿主 `TravelWebPanelHost` 以 `?host=1` 加载 → Dart 桥 `window.__travelPanel.loadPlan(payload)` 注入真实行程。页面自带演示数据兜底（浏览器直开可看），但 `?host=1` 下载荷未到只显示装载态。
- **桌面端不再用系统浏览器打开行程**（`main.dart:_openTravelPlanWindow` 只走 `TravelPlanWindowLauncher`）；`TravelPlanBrowserLauncher` 降级为**手机端专用**。「同一张卡先弹独立窗口、又开浏览器」= 曾把浏览器当首选路径的后果，别再改回去。
- 手机 = `mobile.html`（一屏一站 + 详情 + 按需全屏地图 + 抽屉，SPA）+ 应用内浏览器。旧的桌面双栏页 `panel.html`（+ `.bak`）已于 2026-10-11 **删除**；`GET /travel-map` 的桌面分支随之改指 `desktop.html`。页面文件在 `server/web/`（被 .gitignore 的 Build outputs 段覆盖）→ 新增页面要 `git add -f`，本次已 force-add `desktop.html`/`mobile.html`/`vendor/**`。
- 三页同域同桥：都暴露 `window.__travelPanel`（loadPlan/applySignal/showDay/openStop…）；`GET /travel-map` 按 `MOBILE_UA_RE` 分流（`?mobile=1`/`?desktop=1` 覆盖），另有 `/travel-map/mobile`、`/travel-map/desktop`；分流响应须 `Vary: User-Agent` + `private`。契约由 `server/test/travel-map-routes.test.ts` 锁定。
- **窗口即设计稿**：行程独立窗口 `setAsFrameless()` + 1140×740（不默认最大化）；页面自绘标题栏（三色按钮/拖拽区）经 `notifyHost({event:'windowDrag'|'minimize'|'maximize'|'close'})` → `TravelWebPanelController.onWindowAction` → `windowManager`。改窗口形态必须同步两端。
- 载荷适配在页面里：`entries[].time`→绝对分钟；duration/leg 缺省按相邻站与坐标保守估算（leg 上限 180 分）；**anchor / optional / day.alts 语义只有 Agent 侧能定，前端不臆造**。设计稿 1:1 的有意差异与字段清单见 `docs/design/desktop-travel-agent/README.md`。
- 地图坑（两页都踩过）：`viewBox + preserveAspectRatio="slice"` 在**宽容器**下会切掉上下，按固定 viewBox 投影的站点会跑出屏外 → 必须按「当前实际可见窗口」投影（`desktop.html` 的 `projectDay`/`visibleViewBox`）。

## MapLibre 纪律
- **`line-cap`/`line-join` 属 layout，写进 paint 会被样式校验静默丢弃**（addLayer 不抛错、图层无声消失）；判断图层是否真加上只看 `map.getLayer(id)`。
- 路线用单一 GeoJSON source + setData（按 done 用 filter 分实线/虚线两条 layer），别反复 add/remove。
- `getStyle().layers` 含运行时添加的图层。底图统一 `/travel-basemap/style/dark`（Carto dark 矢量，URL 已改写到本地瓦片缓存）；其 sprite 经代理 404，只影响厂商 POI 图标。
