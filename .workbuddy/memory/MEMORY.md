# Private-Agent 长期项目笔记

> 逐日明细见同目录 `YYYY-MM-DD.md`；本文件只留跨天仍有约束力的铁律（≤3000 字，勿再膨胀）。

## 服务端铁律
0. **已流式即定稿（2026-10-13 根修定稿，最高优先）**：出口层（TurnFinalizer/tool-result-processor/chat-turn-runner）禁止对已流式正文做任何 prose 改稿——ReplyStyleGate 确定性删句、隔离重写臂（rewriteReplyBriefly）、AGENT_HUMAN_REWRITE 真人腔改写器（assistant-rewriter.ts）、processAssistantText 里的 humanize 已全部删除，勿复活。人化/人格约束归 prompt 层；认知快路径 agent-core.ts:1011 的流前 humanize 保留（流=落库一致）。保留下来的非文风出口：净化器（控制帧/meta句/时间戳帧/DSML）、说话算话裁决、utterance 塌缩、事实类闸（出口自检 TurnOutcomeGate、搜索宣称一致性重跑——会整轮换稿但属事实纠错，删=虚构搜索回归）、空回复重生。删句手术/词面违规检测（apology/hedge/offer 词表判人设）这类「措辞猜人格」的闸不许再加。
1. **确定性执行契约**：realtime/media 查询词纯代码构造（`agent/realtime-search-query.ts`），「要不要搜」永不交给模型现场决定；「时好时坏」先查意图缺确定性半边，别加出口闸。media 剥命令/载体/量词，壁纸/头像/表情包不剥；剥光退回实体消解。
2. **统一时间源**：服务内禁 `Date.now()`/无参 `new Date()`，用 `now: () => Date` 注入透传（`CommitmentBoard.setScheduleOutlet()` 下发板钟）。时间问句证据源=本地时钟（`isDirectCurrentTimeQuestion`→`buildClockEvidence`）。provider 陷阱：overrideSys ≠ 丢 memory，恒透传 promptMemory。诊断 `AGENT_PROMPT_TRACE=1` 或 `data/prompt-trace.flag`。
3. **用户事实权威源** = `structured_facts`（structured-fact-store.ts，`PROFILE_FIELD_ALIASES`）；新字段先登记别名表；`normalizeSubject` 剥「」。
4. **工具域归属**：`DOMAIN_REGISTRY`（tool-category.ts）唯一事实源，禁手工白名单；misc 溢出（上限 14）=能力不被用。语料必须含真实技能注册链。
5. **外部信源收编三件齐**：sensor + world-board ingestSignal case + mapping-rules；缺件=静默丢弃。验收 `test/sensor-to-proactive-e2e.test.ts`。ProactivePipeline 显式注 `lastConversationAt`。
6. **出口净化**：上游控制帧 `<system-reminder>` 须服务端（external-model/internal-frames.ts）+客户端（assistant_text_sanitizer.dart）同构剥离；元决策自述剥除在 `stripMetaSentences`（勿用 createStreamMetaSentenceFilter 打整串）；净化做在分段器之前。P1 通道分离：时间戳帧存 metadata `__ts`（chat-thread-ts-meta.ts），LLM 时间轴 buildTimestampFreeLlmView 先取 meta 再剥字段；旧帧读取端双形态兼容。占位帧摘录必须「无围栏、无括号、单行」。
7. **先一句话后结果闸门（2026-10-11 定调）**：调工具前说一句确认语（流式透出永不回收）→ 只流式最终结果，思考不透出、说出口不覆盖。实现：`onToolCallDeltaSeen` 闸门 + tool-loop `waveGateClosed` + WS 分歧裁决对话面 discard + 兜底走 `firstAckSentence`。「先流思考后被覆盖」→ 查关闸与裁决是否退回 replace。**答案留存（2026-10-13 根修定稿：打字机只在闲聊轮）**：「调过工具的轮次，答案不进流式通道」——tool-loop `options.holdAnswer`（after_tool_use/always）在**三个出口**关闸：主 consumer 波内直推、最终波整推、**runSchemaLessSummary 流式（工具全成功波的答案走这条，绕过主 consumer，漏闸=整段漏答案）**；agent-core 对话面置位（语音豁免）+ `reply.answerStreamHeld` → WS 裁决最优先整段替换（跳过说话算话）。意图前置闸/回执反应式扣流/stream_reset 卡片撤回均已退役，勿复活。
8. **工具超时以技能声明为准**：单一事实源 `declaredSkillTimeoutFromManager(manager)`；新档位放 `resolveToolExecutionTimeoutMs` 的 classTimeouts **之前**（末尾 Math.min 会钳回 30s）。契约测试 `test/skill-timeout-budget-contract.test.ts`（55 技能、10 个 >30s）。超时 `ToolExecutionTimeoutError` 无 errorCode，classifyToolFailure 按文本兜底。确定性预执行失败必须 `buildToolFailureReminder`。排查行程卡禁用 task-lane-travel-e2e.mjs（认错通道），用捕获任意 assistant_done 的探针。改 `packages/*` 必须重建；`server/src/**` 走 tsx watch。
9. **主动性护栏**：SuppressionStore → temporal-admission（带 originAt 才从严）→ FrequencyGovernor。recap 日粒度守 prefix cache。recall_history：裸 actorId=排除活跃线程，`master:{actorId}`=不排除。

## 旅行数据链路
- **权威源 = `travel-poi.db`（SQLite 五表）**，POI 完整对象存 payload_json；判重键同时含 `url`+`originUrl`。运维 `/travel/data`、`/travel/data/refresh`、`/travel-basemap/offline`。
- **新图片源必须先 curl 验连通性**（Wikimedia 不可达 http=000，cn.bing.com 200）。照片本地化=内容寻址 `data/travel-media/assets/poi-<sha1>/`，存量 materializeEntryImages 原地替换。
- 离线瓦片坑：tiles-a/b/c/d 同镜像只取一个 host；`{z}/{x}/{y}` 模板先实例化；Carto 免费最高 z14，z15+ 走 overzoom。旅行数据都在 `server/data/`（根 data/ 是聊天图片）。改持久化代码即时触发迁移，备份须在改码前。
- 真实地图（MapLibre+Carto dark 代理）：无经纬度的站不上图；MapLibre 无 line-dashoffset（逐帧截断 setData）；marker element 禁设 position；`.view-map.open` 须 z-index。底图优化 tuneBasemap：`place_*/watername_*/roadname_*` 三类字段 coalesce(name,name_zh,name_en)，别碰 housenumber/poi；(0,0) 是未知中心哨兵必须过滤。
- **维护任务全局互斥**：`/travel/data/refresh` 走 `runExclusive`，并发/重复触发返回 `ALREADY_RUNNING`（curl 一批目的地会全被挡）。批处理必须串行 + 轮询重试，脚本 `scripts/e2e/backfill-travel-media.mjs`。
- **视频/评论已整体下线（2026-10-12 用户决定）**：数据（video 719/review 321 已删）、服务端口、过滤/抓取函数、存储层字段方法、HTTP 路由与 zod schema、快照字段、桌面 `desktop.html` 渲染块与 CSS、dart `TravelEntryReview/TravelEntryVideo` 与 bridge 透传全清。**照片本地化保留**。
- **本地化体积治理三件套**：①写侧根治=下载出口统一 `normalizeDownloadedImage`（travel-media-store.downloadImage，rotate+1280 宽+jpeg q76）；②存量瘦身 `scripts/e2e/slim-travel-media-assets.mjs`（四阶段分离+幂等，判据「宽≤1280 且已是 jpeg」）；③打包防线=build-installer.ps1 断言 staging 不含 travel-media/tile-cache。**坑：media 行 `item_id` 是原 URL、只有 `payload.url` 会随瘦身改名**，回退/修复必须认这一点。
- **媒体库改数据前必须 `VACUUM INTO` 备份**（cp 会漏 WAL，4MB WAL 未合并）；断链修复用 `scripts/e2e/repair-broken-travel-media.mjs`（优先从 item_id 原图重压，找不到就删行），自检 `verify-travel-media.mjs`。
- **压缩治不了体积，回收才是**：`assets/remote-cache` + 改名后未回收的旧原图堆到 1759 份/684MB（压缩只解决「单张多大」）。清理 `purge-orphan-travel-assets.mjs` 移入 `.quarantine/<ts>/` 不直接删。**引用源必须穷举 5 处**，漏一个就误删：media 表 payload.url、destination-covers.json 的 covers、**同文件 coverDirs 是目录级路由（`resolveSuperseded` 会把该目录任意文件换发当前封面 → 整目录受保护）**、data/ 下文本字面引用、remote-cache。实测 873MB → 189MB。
- **视频/评论补全的查询词与过滤坑（历史，已下线）**：按 POI 类型加后缀 attraction→游玩/restaurant→探店/hotel→测评；`filterPoiVideos` 三层过滤（游戏/影视词、平台占位标题、缺地名）；游戏社区行话「探区/开区系列」不含「游戏」二字须显式列出；`limit=20` 覆盖不到后排餐厅，用 40。

## 桌面端（Flutter/Windows）铁律
- **桌面 exe 必须路由到真的桌面代码（2026-10-13 用户明令）**：main.dart `_buildApp()` 在桌面平台必须走桌面链路（注册门禁→首启向导→AppSidebar 桌面主壳），`_isMobile` 只按平台判定（Android/iOS），任何调试/排查都不许伪造它或把桌面 exe 路由进手机壳（MobileLoginPage/MobileHomePage）。调手机 UI 唯一通道 = `main_mobile.dart`（-t lib/main_mobile.dart）。提醒注释在 main.dart `_isMobile` getter + `_buildApp` 分支 + main_mobile.dart 头。
- **行程页入口同理钉死**：/travel-map/desktop 恒为 desktop.html，桌面 UA 分流不许换 mobile.html；调试手机版用 /travel-map/mobile 或 ?mobile=1。契约锁 test/travel-map-routes.test.ts（断言「行迹 · 桌面端」标识）。
- `flutter test` 不可用 → 编译门只有 `dart analyze`；管道耗尽（ERROR_PIPE_BUSY）重启可恢复，期间 Node spawnSync 也废 → 脚本异步 spawn。
- 开发：`npm run dev:desktop`；行程独立窗口是子进程不吃热重载（app.dill 同步两份 kernel_blob.bin，先备份）；改 native 须全量 build。停应用用 `/IM private_ai_agent.exe`，禁 `taskkill /T`。
- 测试：`cd server && node --import tsx --test`；better-sqlite3 按 Node 24 编译须 `D:\nodejs\node.exe`。worktree 清理先 `cmd //c rmdir node_modules` 摘 junction。

## 行程三端布局
- 桌面：行程卡→独立窗口（desktop.html?host=1，Dart 桥 `window.__travelPanel.loadPlan`）；工具「行程」→应用内归档页 travel_plan_archive.dart。**UI 定稿偏好（2026-10-12）：侧栏类组件走双面板并排，不做顶层悬浮覆盖；天气长句压短胶囊全文走 title；站点照片进页面即预热（preloadDayAssets，并发 4）。**
- 手机=原生页 travel_plan_mobile_page.dart；**视觉定稿在 `docs/design/mobile-travel-agent/`，动行程 UI 前先查，禁自拟版式**。
- 沉淀权威源 travelPlanStore（data/travel-plans/*.json ≤50）；`server/web/` 被 .gitignore 覆盖，新页面要 `git add -f`；路由分流契约锁在 test/travel-map-routes.test.ts（Vary: User-Agent）。
- WebView 桥时序：页面 ready 只发一次，attach 路径不得重置就绪态；未 attach 出站调用入队（违反症状：行程页永远「装载中」）。就绪态重置只在导航前 `resetPageState()`。
- 行程 Agent：anchor/progress（store.updateProgress 不走 save 防并发 409）、实时信号 signal 接口、晨报第六源、travel_ask_launcher。测试 test/travel-plan-agent-loop.test.ts。窗口即设计稿：setAsFrameless 1140×740 页面自绘标题栏。

## MapLibre / 崩溃 / 前缀缓存
- line-cap/join 属 layout，写 paint 静默丢弃；图层生效只看 map.getLayer。
- stderr 崩溃：freopen 失败置流关闭 → fwprintf 触发断言 abort(0xC0000409)；写点须 `_fileno(stderr)>=0` 防御；main.cpp 兜底链 env→exe→%TEMP%→nul；dumps 在 logs/crashdumps/。
- 前缀缓存：MiniMax 缓存好，命中率低=tools 数组逐轮分叉；`stabilizeToolOrderForSession` 会话级单调并集，必须在注册表名层做；新加「逐轮筛工具」前先想这条。Anthropic 端点 api.minimaxi.com/anthropic 可用，被动缓存已够不必切端点。
- 右侧面板入口下线：从 `_allToolSpecs()` 摘掉即可，历史偏好无需清理；隐藏≠删除，入口专属轮询字段同删。

## APK 烤入/部署拓扑约定（2026-10-14 用户定调）
- 手机 APK 后端地址两档：`159.75.52.2:3000`＝腾讯云生产后端（SSH 用桌面 King.pem，root@，/opt/pai，systemd pai-server 跑 dist）；`192.168.10.2:3000`＝本机局域网自用版。build_apk.ps1 -HttpBase 二选一；`login.nextbot.top`（阿里云 47.98.122.29）只是控制面/登录页，不是后端。桌面 exe 同规则：build_windows.ps1 -HttpBase，2026-10-16 起 Windows+Release+非捆绑（exe 旁无 runtime\node.exe）漏烤 HTTP_BASE 在 api_config.dart 直接 fail-fast（Debug/byok 捆绑仍回落 127.0.0.1）。
- **HTTPS（2026-10-16 已上线）**：`login.nextbot.top`（阿里云控制面）HTTPS 全通——LE 证书（certbot webroot 自动续期，dry-run 已验证），443=HSTS+反代 3000，80=ACME+301；服务器 conf 与仓库 `scripts/release/nginx-nextbot.conf` 一致。159.75.52.2 自用后端保持明文 3000 不签证书（80 挂了 nginx 反代备用，conf=`scripts/release/nginx-api.nextbot.conf`）。SSH：阿里云 root 用本机 id_ed25519，腾讯云 root 用桌面 King.pem。客户端控制面 URL 必须烤 `https://login.nextbot.top`（80 已 301，POST 跨协议重定向不可靠）。
- 云机华为 Push 凭据 = AGC「OAuth 2.0 客户端 ID」面板值（119333351 + 6750e54b…），**不是** agconnect-services.json 里的 client_secret（那个实测 1101 invalid）。

## 媒体兜底抓取（2026-10-14 用户提出，工具 `scripts/scrape-article-media.mjs`）
- 「搜索引擎只返回文章链接」时：拉文章页 → 抠 `<img>` 真图 → `curl -e <referer>` 下载；信息也一并抽成 md。三模式：`--urls` 抓文章 / `--images` 直链下载 / `--prune` 清残留。
- 铁律：**抽取端放宽，content-type + 真实分辨率才是闸门**（网易/腾讯图链无 `.jpg` 后缀）；**先切正文容器再抽图**（否则推荐流混入，163 实测 29→13）；**新浪是 GBK 必须解码**；JS 壳站点（头条）用 agent-browser 只取 `article img`。
- **信息侧同思路**（2026-10-14）：正文清洗（模板噪声词表 + 附件清单行过滤 + 句级去重）→ `info/*.json` 结构化 → `--digest --topic` 聚合出时间线/要点/多源同事件。三个坑：标题必须防模板污染（论坛 og:title 是门户口号，要降级 `<h1>`）；**中文改写稿字面相似度极低（≤0.06），同事件归组要用共享实体（《书名号》）而非 n-gram**；要点必须过**主题相关性闸门**，否则多人红毯稿会把无关明星带进来。
