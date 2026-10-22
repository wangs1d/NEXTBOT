# Private-Agent 长期项目笔记

> 只放跨天仍有效的**判定**（禁止什么／必须用什么／开关在哪）；逐日明细见 `YYYY-MM-DD.md`。

## 服务端铁律
0. **已流式即定稿**：禁改已流出正文（ReplyStyleGate／rewriteReplyBriefly／humanize 已删勿复活），人格归 prompt。仅存出口：净化器、说话算话裁决、utterance 塌缩、事实闸（TurnOutcomeGate、搜索宣称一致性重跑）、空回复重生。**「措辞猜人格」类闸不许再加。**
1. **工具编排（2026-10-22 v3 重设计）**：`docs/design/agent-tool-orchestration/2026-10-22-tool-orchestration-redesign.md`
   - `required` **彻底删除**，不许出现任何非 `auto` 的 `tool_choice`（含具名）。强制调用无 thinking 块、推理挤进参数；新模型对 `any`/`tool` 返 400。
   - **唯一事实源 = 工具 schema**：description 四段式（做什么／何时用／何时不用／与谁分工）+ `properties[*].description` **一律保留**。**禁为省 token 裁字段级描述**（BFCL：参数类失败 62%，选错工具 18%）。
   - **prompt 禁写工具名与场景映射**：现存 32 处待清，含 5 个幽灵名（`weather_query`/`clock_now`/`calendar_query`/`fetch_page`/`desktop_open`）。过载根因是**描述重叠**不是数量。
   - **完成语义走 `ToolMetadata.resultContract`**：`content`｜`ack`｜`queued`。**queued 不算完成（派发≠完成）**；出口闸只读此字段不读措辞；「完成」=返回了内容。
   - **常驻准入四条**：决策必需 + 高频 + **与其他常驻语义互斥** + 非代理。万能代理工具不得常驻。
   - 续波 = `auto` + system 点名**具体工具** + 一次重试（`resolveGateToolHint` 走延迟目录检索，**禁造词表**）。
   - **每闸记触发率**：持续高触发 ⇒ 改描述／改准入，**不许再加闸**。「时好时坏」先查工具调没调。
   - **红线 7（2026-10-22 实施发现）**：任何绕过主循环提前收尾的快捷路径（如 `runSchemaLessSummary` 汇总捷径）必须过完成度闸——捷径曾把纯派发轮收尾成「已经让后台去查了」绕过全部闸。新增早退路径必须同步检查。
   - **红线 8（同日）**：媒体轮工具藏匿只在 `isMediaOnlyRequest` 真媒体轮生效（loop `mediaHidden`）——原实现把 `filterTextSearchTools` 无条件套每轮，曾把 `search_web`/`fetch_web`/`internet.*` 在**所有轮**藏出可见集（search_movies 三样本全挂的真根因）。**任何按意图收窄可见集的过滤都必须带意图守卫**。诊断 `PA_TOOL_DEBUG=1` 转储实发工具名；看板 `GET /metrics/exit-gate`。
   - **常驻复审（同日晚，用户拍板）**：`surface.show` **整链已删**（悬浮卡召唤不由 LLM 工具实现，`surface.dismiss` 保留；Flutter `_handleSurfaceShow` 死代码待清）；`perception.overview` 移出常驻（主动感知本就推送，回查走延迟目录 BM25）；`agent.query_capabilities` 保留（"嘴硬没权限"自救，真机实证）。**去路由化（10-21）后普通轮统一 chat 车道无前置意图分类**，task 车道只剩计划续跑 + task.dispatch 两入口——勿再按"每轮 chat/task 二选一"理解。
2. **统一时间源**：禁 `Date.now()`／无参 `new Date()`，用注入 `now: () => Date`；overrideSys 恒透传 promptMemory。诊断 `AGENT_PROMPT_TRACE=1`。
3. **用户事实权威源**=`structured_facts`（新字段先登记 `PROFILE_FIELD_ALIASES`）；`valid_from/valid_to`+`event_time` vs `observed_at`；**计划到期≠事情发生**（转正只走 `confirmPlan`）；`getFactsAsOf` vs `getKnownFactsAsOf` 别混；勿退回 latest-wins。
4. **工具域归属**：`DOMAIN_REGISTRY` 唯一事实源，禁手工白名单；misc 溢出=能力不被用。
5. **外部信源收编三件齐**：sensor + world-board ingestSignal + mapping-rules，缺件=静默丢弃。
6. **出口净化**：控制帧两端同构剥离；元决策自述进 `stripMetaSentences`；净化在分段器之前；时间戳存 metadata `__ts`。
7. **先一句话后结果**：`holdAnswer` 须在三个出口关闸（主 consumer／最终波／runSchemaLessSummary）。**对偶铁律**：不进流式 ≠ 不落线程——每条收尾路径终态必须含 assistant(content)（兜底 `streamedVisible || full`），否则线程停在 tool 链，下轮必重复调工具。
8. **工具超时以技能声明为准**：`declaredSkillTimeoutFromManager`；新档位放 classTimeouts 之前（末尾 Math.min 钳回 30s）。改 `packages/*` 必重建。
9. **主动性护栏**：SuppressionStore → temporal-admission → FrequencyGovernor；recap 日粒度守 prefix cache。
10. **拆解按需**：闲聊/单点绝不拆；**用户否决「意图标签做前置闸门」**。方向=plan 作 in-loop 工具 + 压力软提示（≥3 次工具／跨 2 域／有重试无 plan）。
11. **goal 三层**：轮次／TaskPlan(`data/session-plans/`)／Goal(`goals.json`)，TaskPlan 绝不进 goals.json；不全量注入；**只填字段不渲染=每轮白查**（两侧同 PR + 契约测试）；保留「沉默≠同意」；不做 DAG。
12. **感知必须是真的**：凡"坐了多久／在不在电脑前"禁用应用运行时长冒充。判据只有 `GetLastInputInfo`（空闲毫秒，不读按键）。≤3min 在座／≥5min 离座／中间不动；久坐=连续在座（离座清零），喝水护眼=在座累计（离座暂停）；**离座不判定不打扰**。
13. **DDL 分级不新建投递通道**：只做聚合+分档，交晨报（L3 今天／L1 2~3 天）与睡前备忘（L2 明天）；**按日历日切不按小时**；**过期不许消失**（归 L3 标 overdue）。

## 旅行数据链路
- 权威源 `travel-poi.db`（五表 payload_json），判重键 `url`+`originUrl`；数据在 `server/data/`（根 data/ 是聊天图片）；照片走 `data/travel-media/assets/poi-<sha1>/`。
- 瓦片：只取一 host；`{z}/{x}/{y}` 先实例化；Carto 最高 z14。无经纬度不上图；MapLibre 无 line-dashoffset；marker element 禁设 position；`(0,0)` 是未知中心哨兵必须过滤。
- **维护任务全局互斥**：`/travel/data/refresh` 走 `runExclusive`，并发返 `ALREADY_RUNNING`。
- **体积治理**：写侧 `normalizeDownloadedImage`（1280 宽 jpeg q76）；压缩治不了体积，回收才是（`purge-orphan-travel-assets.mjs`→`.quarantine/`）。引用源穷举 5 处：media payload.url、covers、**coverDirs 目录级路由**、data/ 文本引用、remote-cache；media 行 `item_id` 是原 URL，只有 `payload.url` 随瘦身改名。
- **改数据前 `VACUUM INTO` 备份**（cp 漏 WAL）；断链 `repair-broken-travel-media.mjs`，自检 `verify-travel-media.mjs`。

## 桌面端 / 行程三端（Flutter·Windows）
- **退出必须先销毁窗口、后 CoUninitialize**：`window_manager.destroy()` 只 PostQuitMessage → 引擎在 COM 卸载后析构必 AV。main.cpp 消息循环后 `window.Destroy()`；Dart 走 `windowManager.close()`。**新退出路径不许只 PostQuitMessage。**
- **窗口必须实色背景**：禁 `Colors.transparent`（DWM 填白），用 `AppPalette.mainPanel`。白屏判据=平均亮度（深色≈19~26，白屏≈220）。
- `flutter test` 不可用 → 编译门只有 `dart analyze`；改 native 须全量 build；停应用用 `/IM` 禁 `taskkill /T`；**「改了代码界面没变」先查包**（windows_dist 镜像被运行实例锁住报 `MSB3073`，真错因被 MSBuild 吞；僵尸进程锁 exe）。
- **加直接依赖走「显式声明传递依赖」**，但 `pub get` 会改写 lock 里 150 条镜像 URL 并升 permission_handler_apple → **跑完必须还原 lock**。
- 行程：桌面=行程卡→独立窗口（desktop.html?host=1）；手机=`travel_plan_mobile_page.dart`，**视觉定稿在 `docs/design/mobile-travel-agent/`，禁自拟版式**；`server/web/` 被 gitignore，新页面 `git add -f`。WebView 桥：ready 只发一次，未 attach 出站入队（症状=永远「装载中」）。
- MapLibre：line-cap/join 属 layout，写 paint 静默丢弃；生效只看 `map.getLayer`。
- 安装包：捆绑 node.exe 须与原生模块 ABI 一致（真 open `:memory:` 自检）；PS 5.1 Start-Process 遇代理重复键抛错 → 用 .NET ProcessStartInfo。

## 数据入口（统一上传）
- **按信息形态写抽取器，不按来源写 fromXxx**：ics(确定性)/表格(列映射)/图(VLM)/文本(LLM) 四种覆盖全来源；`ddl-radar` 只加一次 `fromIngested`。**接应用是死路**（教务无 API、日历 API 要资质）→ 课表=**截图**，上班族=**ics 订阅链接**。
- **两段式**：抽取只出草稿（带证据+置信度，<0.6 默认不勾），用户 commit 才落库。**重传=更新**：键=kind+归一化标题+周几节次，**时间不进键**。
- **入口=聊天框，禁再造上传 UI/抽屉**：发图直接进模型（`build-user-message-content` 塞 image_url）、发文件走 `file.parse_office/parse_pdf`；扫描=`SensorKernel` 7 sensor、聚合=`WorldBoard` 四层 + `mapping-rules` 10 条、投递=晨报/晚间备忘。**再造入口=重犯造轮子。**
- **课表已收编为 `weekly` 日程（不自建 weeklySlot 台账）**：`ingest-schedule-bridge.ts` 把 `kind=class` 物化成 `recurrence=weekly` 日程 → 课前提醒/今日安排/schedule-sensor→世界板/晨报全自动；**不需要校历**（weekly 只要"下一个周几"）。硬点：`kind=reminder` **必须给 reminderMessage**；`sourceRefId=ingest:<key>` 做幂等（换教室=更新同一条）；**改节次会新增一条**（key 含 slot，一门课一周两次必须分开）；删台账要同步 `deleteTask`。钟点用默认作息（1 节 08:00，45min/节，5min 课间）写进 description 提示可改，单双周 weekly 表达不了。`fromIngested` 只收有 dueAt 的 deadline。
- **`ScheduleTaskService` 的 `SCHEDULE_TASKS_FILE` 改构造时快照**（`persistPath`）：原来每次 persist 读 env，测试连续建实例各换目录时残留实例写到**下一个测试**的文件上 → Windows `EPERM` 随机红灯。（Node 22 跑 `better-sqlite3` 报 MODULE_VERSION 137vs127，相关测试须 Node 24。）
- **`xlsx@0.18.5` 顶层没有 `sheet_to_json`**（类型声明有 → 过 tsc、运行时 "is not a function"），必须 `XLSX.utils.sheet_to_json`。合并单元格必须展开，再按 title+weekday 合并连堂。

## 部署拓扑
- 后端：`159.75.52.2:3000`（腾讯云生产，King.pem，systemd pai-server）／`192.168.10.2:3000`（局域网）。`login.nextbot.top` 只是控制面；客户端控制面 URL 必须烤 `https://`（80 已 301）。
- **零配置启动门禁**：byok 首启无 `%APPDATA%\PrivateAgent\config.env`，**装配路径上因缺 key throw = abort 134、3000 永不监听**。启动期依赖必须零配置通过（调用期校验+降级 warn）。**测试三重假象**：本机有 key + shell 有 OPENAI_API_KEY + 冒烟注入 → 必须显式清环境 key 才验得出。
- 桌面 exe：Release 非捆绑漏烤 HTTP_BASE 会在 api_config.dart fail-fast。
- 拉起后端唯一判据 `LocalRuntimeManager.isBundled`（exe **同级**须有 `runtime\node.exe`+`runtime\dist\index.js`）；不满足时 `ensureRunning()` **静默 return true 且不写日志**。排查 `scripts/release/diagnose-runtime.ps1`。

## 卡片渲染
- 枚举唯一源 `packages/agent-protocol/display-effects.ts`（新卡型必须登记）；三层：tool-card-registry → display-effect-router → `[RENDER_HINT]`；**Web 端不认卡片标记只渲染 markdown**（已拍板不做）。
- **睡前备忘卡**（`evening_digest_card.dart`）：**整卡恒展开、无折叠、无今日回顾段**；narrationText=卡顶文案；**服务端新增块必须在卡里同步解析**；`eveningDigest` 随消息持久化（isar 四处接线）。
- Flutter 坑：集合字面量不能声明局部变量（抽组件）；`as num?` 链式 `?.` 报 invalid_null_aware，用 `is num`。

## 桌宠 / 灵动岛 / 3D
- **面板必须长在桌宠窗口内**（`[attach-slot][pet-pane]` flex），`setAttachPanel(w)` 向左扩窗 → 桌宠绝对位置不变。**独立全屏透明层已否决并删除**。
- **灵动岛不新建**：复用 `core/presentation/dynamic_island.dart`；健康提醒 `health_reminder_feeds.dart`（久坐50/水45/眼20，仅 8–22 点，**无按钮**，8s 收回），判据 `input_activity_probe.dart`（铁律 12）。
- 台词零词库：`pet.reaction`→`ws/handlers/pet-reaction.ts`（ephemeral+disableThinking+64token，1.5s 节流+单飞，失败 ok:false 就不说话）。打卡数据必须读 `widgets/focus-store.ts`。
- 3D 桌宠：**曲屏上不画脸**；**DG2 开窗半角被 CAD 卡死 45°**（`FACE_RADIUS=0.34` 派生），别硬调 `model-proportions`。守「不漫游、不画脸、无状态气泡」；不做划词问答/日报海报/年度报告。设计稿 `docs/design/desktop-pet/desktop-pet-design.html`。
- **【病根】present_files 只发 HTML 本身，同目录资源 403** → 给用户看的页面必须**自包含单文件**（`build-*-single.mjs`；esbuild `write:false` 主产物路径是 `<stdout>`）。

## Provider 接入（一家登记 7 处，缺一处=半生效）
`providers/<x>-provider.ts`／`provider-profiles.ts`／`prefix-cache.ts`／`instantiate-provider.ts`／`resolve-provider.ts`／`agentic-memory/env.ts`（自有键位的 provider 独占 key/baseUrl/model，**绝不回落 OPENAI_***）／`openclaw-config-sync.ts`。auto 优先级只往末尾加。
- **关思考只有一种可靠写法**：DeepSeek `thinking:{type:"disabled"}`→reasoning_tokens=0；`reasoning_effort` 只是降档。
- **缓存策略跟 provider 机制走不跟槽位**：DeepSeek=隐式前缀（64 token 块，**不许发** prompt_cache_key/cache_control）；openai 槽=explicit-key；MiniMax=explicit-breakpoint；Kimi=implicit-prefix。命中真伪只看审计 `promptCacheHitTokens / apiPromptTokens`。

## 前缀缓存 append-only
- **请求必须是上一轮请求的字节前缀**；三处 append-only：`tools`、`system`、**`messages` 头部**。`stabilizeToolOrderForSession` 会话级首轮冻结（`AGENT_TOOL_FACE=union` 回滚），只锁前台对话车道。
- `PREFIX_WATCHDOG` 只看 tools+system，**看不见 messages 内部**——诊断 `PREFIX_DEBUG=1`（`data/prefix-dbg.log` 的 `diffAt`）。
- **回写边界按视图长度不按下标**（像素级剥 `__ts`/clientMessageId 并克隆本轮 user）。用 `llmViewAppendBoundary = llmView.length`。
- **轮内脚手架绝不入史**：域卡/时间轴/请求卡/闸转向指令用 WeakSet（`turn-scaffold.ts`）标记，写回跳过。
- **token 估算按字符**（中文 0.9／非中文 0.3）。**裁剪预算只算对话段不算 system**（`systemTokensInBudget()` 返 0，`AGENT_TRIM_INCLUDE_SYSTEM=1` 回滚）。
- **recap 只在折叠轮变**：`deferredRecapEnhance` 暂存 + 折叠点合入（`AGENT_RECAP_ENHANCE_DEFER=0` 回滚）。
- **动态块放尾部=永不命中**：只能进**会话冻结的 system 段**（`AGENT_DOMAIN_CARDS_IN_SYSTEM=0` 回滚）；进 system 的内容**必须与顺序无关**（域卡每域取前 14 个=位置截断，按工具名排序，否则命中 59%→26%）。
- 水位：`main_chat_tools` 62%→**86.8%**（DeepSeek 隐式，3 轮）。
