# Private-Agent 长期项目笔记

> 逐日明细见 `YYYY-MM-DD.md`；本文件只留跨天仍有约束力的铁律。新增前先想：删掉这行还成立吗？

## 服务端铁律
0. **已流式即定稿**：出口层禁止对已流式正文做 prose 改稿（ReplyStyleGate 删句、rewriteReplyBriefly、assistant-rewriter、humanize 已全删，勿复活）。人格/人化归 prompt 层。保留的非文风出口：净化器、说话算话裁决、utterance 塌缩、事实类闸（TurnOutcomeGate、搜索宣称一致性重跑）、空回复重生。「措辞猜人格」类闸不许再加。
1. **确定性执行契约**：realtime/media 查询词纯代码构造（`agent/realtime-search-query.ts`），「要不要搜」永不交给模型；「时好时坏」先查意图缺的确定性半边，别加出口闸。
2. **统一时间源**：服务内禁 `Date.now()`/无参 `new Date()`，用注入的 `now: () => Date`。时间问句证据=本地时钟。provider overrideSys ≠ 丢 memory，恒透传 promptMemory。诊断 `AGENT_PROMPT_TRACE=1`。
3. **用户事实权威源**=`structured_facts`（新字段先登记 `PROFILE_FIELD_ALIASES`）。**时态模型**：`current|past|upcoming` + `valid_from/valid_to` + `event_time` vs `observed_at`。**未来态铁律**：计划到期≠事情发生，`sweepUpcomingPlans` 只降级 lapsed、不写 past；转正只走 `confirmPlan`（拒绝非实时陈旧定位）。查询双语义 `getFactsAsOf`(valid) vs `getKnownFactsAsOf`(knowledge)。勿退回 latest-wins。
3b. **三类时间不许混**：当前时间／对话发生时间／事情发生时间，各有独立来源与渲染位。
3c. **检索确定性信号**：`memory-temporal-intent.ts` 时间词→区间加权；召回行打 `[当前]/[已失效]/[勿主动提]`；`entityOverlapFactor` 用档案实体值加分；cross-encoder 精排默认关。`MemorySuppressionStore` **不删源**，与 forget 严格区分。面板 `/memory`（web/ 被 gitignore，须 `git add -f`）。
4. **工具域归属**：`DOMAIN_REGISTRY` 唯一事实源，禁手工白名单；misc 溢出=能力不被用。
5. **外部信源收编三件齐**：sensor + world-board ingestSignal + mapping-rules，缺件=静默丢弃。
6. **出口净化**：控制帧服务端+客户端同构剥离；元决策自述在 `stripMetaSentences`；净化在分段器之前。时间戳帧存 metadata `__ts`，LLM 视图先取 meta 再剥。
7. **先一句话后结果闸门**：工具前一句确认语（永不回收）→ 只流式最终结果。「调过工具的轮次答案不进流式通道」：`holdAnswer` 必须在**三个出口**关闸（主 consumer／最终波／runSchemaLessSummary 流式，漏最后一个=整段漏答案）。已退役的意图前置闸/回执扣流勿复活。
8. **工具超时以技能声明为准**：`declaredSkillTimeoutFromManager` 单一事实源；新档位放 classTimeouts 之前（末尾 Math.min 钳回 30s）。改 `packages/*` 必重建。
9. **主动性护栏**：SuppressionStore → temporal-admission → FrequencyGovernor；recap 日粒度守 prefix cache。
10. **拆解按需**：闲聊/单点查询绝不拆，也不为拆解多付规划请求；**用户明确否决「用意图标签做前置闸门」**。方向=plan 作 in-loop 工具 + 执行压力软提示（≥3 次工具调用／跨 2 域／有重试且无 plan）。plan-execute 默认关是双平面架构的主动决策，勿重开成「每轮都规划」。
11. **goal 主键架构**：不新建第六套台账。三层=轮次／TaskPlan(`data/session-plans/`)／Goal(`goals.json`)，TaskPlan 绝不进 goals.json。铁律：绝不全量注入；**只填字段不渲染=每轮白查**（两侧同 PR + 契约测试）；步骤级验收 0 token；执行类失败必须开口；外部动作卡口与「沉默≠同意」保留；不做 DAG。

## 旅行数据链路
- 权威源 `travel-poi.db`（SQLite 五表，payload_json），判重键含 `url`+`originUrl`。数据在 `server/data/`（根 data/ 是聊天图片）。改持久化代码即时触发迁移，备份在改码前。
- 新图片源先 curl 验连通（Wikimedia 不可达）。照片本地化走内容寻址 `data/travel-media/assets/poi-<sha1>/`。
- 离线瓦片：tiles-a/b/c/d 同镜像只取一个 host；`{z}/{x}/{y}` 先实例化；Carto 免费最高 z14，z15+ 走 overzoom。
- 真实地图：无经纬度不上图；MapLibre 无 line-dashoffset；marker element 禁设 position；`.view-map.open` 须 z-index；(0,0) 是未知中心哨兵必须过滤。
- **维护任务全局互斥**：`/travel/data/refresh` 走 `runExclusive`，并发返回 `ALREADY_RUNNING`；批处理串行+轮询。
- 视频/评论已整体下线（2026-10-12），照片本地化保留。
- **体积治理**：写侧统一 `normalizeDownloadedImage`（1280 宽 jpeg q76）；存量 `slim-travel-media-assets.mjs`；打包断言不含 travel-media/tile-cache。坑：media 行 `item_id` 是原 URL，只有 `payload.url` 会随瘦身改名。
- **改数据前 `VACUUM INTO` 备份**（cp 漏 WAL）。断链修复 `repair-broken-travel-media.mjs`，自检 `verify-travel-media.mjs`。
- **压缩治不了体积，回收才是**：`purge-orphan-travel-assets.mjs` 移入 `.quarantine/`。**引用源必须穷举 5 处**：media payload.url、covers、**coverDirs 目录级路由（整目录受保护）**、data/ 文本引用、remote-cache。

## 桌面端（Flutter/Windows）铁律
- **退出必须「先销毁窗口、后 CoUninitialize」（2026-10-20 根修，实测 19.5s→76ms）**：`window_manager.destroy()` 原生只 `PostQuitMessage(0)`，**不销毁窗口**；消息循环退出后引擎要到 main 返回析构才释放，而那时 `CoUninitialize()` 已跑过 → 引擎/WebView2 在 COM 卸载后析构必然 AV（`flutter_windows.dll+0x1d7b0`，0xc0000005→0xc000041d），WER 挂起全线程收 dump（WS 220MB→690MB），进程 13~19s 才消失。修法：main.cpp 消息循环后 `window.Destroy()` 再 CoUninitialize；Dart 退出走 `windowManager.close()`（WM_CLOSE→DestroyWindow）而非 destroy()。**任何新退出路径都不许只 PostQuitMessage。**
- **窗口必须给实色背景（2026-10-20 白屏根修）**：`WindowOptions(backgroundColor:)` 不许用 `Colors.transparent` —— 窗口在 `runApp` 之前就 `show()`，首帧未渲染时 Windows 不支持逐像素透明，transparent 会被 DWM 填成**白色客户区**（Debug 版 JIT 慢，实测纯白 1.4s；Release 快所以看不出来）。用 `AppPalette.mainPanel`（颜色常量在 `AppPalette`，不在 `AppTheme`）。判断白屏用平均亮度：深色 UI ≈19~26，白屏 ≈220；`PrintWindow` 读 DWM 缓存不可靠，`CopyFromScreen` 会被遮挡误导。
- 桌面 exe 必须走桌面链路（`_buildApp()`），`_isMobile` 只按平台判定、不许伪造；调手机 UI 只用 `main_mobile.dart`。
- 行程页入口钉死：`/travel-map/desktop` 恒为 desktop.html。
- `flutter test` 不可用 → 编译门只有 `dart analyze`；管道耗尽重启可恢复。
- 开发 `npm run dev:desktop`；行程独立窗口不吃热重载；改 native 须全量 build。停应用用 `/IM`，禁 `taskkill /T`。
- **「改了代码界面没变」先查包**：windows_dist 镜像由 cmake_install 做，被运行实例锁住报 `MSB3073`（真错因被 MSBuild 吞）。只回填需要的文件，别整树复制。
- **僵尸进程会锁 exe**：崩溃退出会留下 Threads=0 的进程对象，占着 exe 映像导致覆盖报 busy（**Git Bash 的 cp 报 Device busy，PowerShell `Copy-Item -Force` 可成功**）。
- 测试 `cd server && node --import tsx --test`；better-sqlite3 按 Node 24 编须 `D:\nodejs\node.exe`。
- 安装包两坑：捆绑 node.exe 必须与原生模块 ABI 一致（真 open 一个 `:memory:` 库自检）；PS 5.1 Start-Process 遇代理重复键抛错 → 用 .NET ProcessStartInfo。

## 行程三端布局
- 桌面：行程卡→独立窗口（desktop.html?host=1）；工具「行程」→ travel_plan_archive.dart。UI 定稿偏好：侧栏双面板并排、不做顶层悬浮；天气胶囊全文走 title；照片进页即预热（并发 4）。
- 手机=`travel_plan_mobile_page.dart`；**视觉定稿在 `docs/design/mobile-travel-agent/`，禁自拟版式**。
- 沉淀源 travelPlanStore（≤50）；`server/web/` 被 gitignore，新页面 `git add -f`。
- WebView 桥：ready 只发一次，attach 不得重置就绪态，未 attach 出站调用入队（症状=永远「装载中」）。
- 行程 Agent：progress 不走 save（防 409）；窗口即设计稿 1140×740。

## MapLibre / 崩溃 / 前缀缓存
- line-cap/join 属 layout，写 paint 静默丢弃；生效只看 `map.getLayer`。
- stderr 崩溃：freopen 失败置流关闭，fwprintf 触发断言 abort；写点须 `_fileno(stderr)>=0`；兜底链 env→exe→%TEMP%→nul。
- 前缀缓存：MiniMax 命中率低=tools 数组逐轮分叉；`stabilizeToolOrderForSession` 会话级单调并集，必须在注册表名层做。
- 右侧面板入口下线=从 `_allToolSpecs()` 摘掉即可；隐藏≠删除。

## 部署拓扑
- 后端两档：`159.75.52.2:3000`（腾讯云生产，King.pem，systemd pai-server）／`192.168.10.2:3000`（局域网）。`login.nextbot.top`（阿里云）只是控制面，HTTPS 全通（LE 自动续期）。客户端控制面 URL 必须烤 `https://`（80 已 301，POST 跨协议重定向不可靠）。
- **零配置启动门禁（2026-10-21 血案）**：byok 捆绑包在新用户机器上，模型 key 的唯一来源是客户端注入的 `%APPDATA%\PrivateAgent\config.env`，**首启时该文件不存在**。因此**任何在 bootstrap 同步装配路径上因缺 key/缺配置而 throw 的代码，都会让整个服务 abort（退出码 134）、3000 永不监听**，用户表现为「界面能开但连不上」。新增启动期依赖必须允许零配置通过（改为调用期校验 + 降级 warn）。**测试三重假象**：本机 config.env 有 key + WorkBuddy shell 环境自带 `OPENAI_API_KEY` + 打包冒烟注入 `sk-smoke-...` → 零配置失败在本机永远复现不出来；验证必须显式清掉环境 key。
- 桌面 exe：Windows+Release+非捆绑漏烤 HTTP_BASE 会在 api_config.dart fail-fast。华为 Push 凭据=AGC OAuth 2.0 Client ID，不是 client_secret。
- 客户端拉起后端的唯一判据是 `LocalRuntimeManager.isBundled`（exe **同级**须有 `runtime\node.exe` + `runtime\dist\index.js`）；不满足时 `ensureRunning()` **静默 return true 且不写任何日志**。压 staging（`app\`+`runtime\` 并列）或从 zip 内直接双击运行都会踩中。排查入口：`scripts/release/diagnose-runtime.ps1`（放 exe 同级双击，七项检查 + 冷启动实测）。
- `D:\nodejs` **已不存在**（旧记录作废）；Node 24 在 `C:\Program Files\nodejs\node.exe`。

## 媒体兜底抓取（`scripts/scrape-article-media.mjs`）
- 拉文章页抠 `<img>` 真图 + `curl -e <referer>` 下载。铁律：**content-type + 真实分辨率才是闸门**；先切正文容器再抽图；新浪 GBK 必须解码；JS 壳站只取 `article img`。
- 信息侧：先切正文 → 结构化成 json → 按共享实体（《书名号》）归组同事件（中文改写稿字面相似度≤0.06，n-gram 不可用）；要点须过主题相关性闸门。

## 3D 桌宠 agent-sphere-avatar
- **曲屏上不画脸**：SVG 表情系统已整体删除；若重做先对齐方向。
- 屏幕质感层在 `src/screen/screen-panel.ts`，组件 `OledScreen.tsx`。**DG2 玻璃开窗半角被 CAD 卡死 45°**（`FACE_RADIUS=0.34` 派生），别硬调 `model-proportions`。
- `boundaryBump` 衰减责任在 `OledScreen`；`userTouch/userSpin` 在 `useSphereUserDrag`。
- **桌宠不要自己动、不要状态气泡**（`InnerThought` 已删；`roamArmedRef` 默认关，只保留呼吸+命令驱动）。`.overlay-pet-pane` 的 padding-bottom/canvas height/message-list bottom 是联动数（88px），别单独改。
- overlay 模式 `verticalStable=true` 会连呼吸一起关掉（球体完全静止）。
- **【病根】present_files 静态代理只发 HTML 本身，同目录资源一律 403** → 给用户看的页面必须**自包含单文件 HTML**。脚本：`build-face-preview-single.mjs`／`build-screen-preview-single.mjs`。模型内联：入口劫持 `window.fetch` 命中 `/models/*.obj` 回内联文本，模型经 esbuild define 注入。esbuild `write:false` 时主产物路径是 `<stdout>`。
