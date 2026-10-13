# Agent 响应延迟优化方案（2026-10-12）

> 触发：用户反馈「无论是调用工具还是普通对话回复都稍微有一点慢了」。
> 本文只做定位与方案，不改行为；每条都附 文件:行号，可按优先级单独落地。

## 现状与结论摘要

一轮对话的耗时由三段构成：**前置流水线（pre-LLM）+ 主模型 TTFT + 流式/工具波**。
按现有代码走查，**前置流水线里存在几个「每轮必付」的固定成本**，这正是"稍微有点慢"
且「对话和工具都慢」的典型指纹——它与单条消息无关，而是每轮都加一截。

已确认的高价值耗时点（按嫌疑排序）：

| 级别 | 问题 | 位置 | 性质 |
|---|---|---|---|
| P0 | L1 路由是一次**额外、阻塞、非流式**的完整 LLM 往返 | `agent-core.ts:836` + `structured-call.ts:85` | 每轮固定成本 |
| P0 | ~~**每轮逆地理编码无缓存**，串行打 amap + open-meteo（各 8s 超时）~~ **已修复 2026-10-12** | `user-location-service.ts:75` → `reverse-geocode-service.ts:157` | 每轮固定成本 |
| P0(工具) | 任务面 PRO 档**显式开思考链**，MiniMax-M3 思考很贵 | `agent-core.ts:2610` | 每波首 token 前多秒 |
| P1 | cognize 大并行 3.5s 护栏，任一成员抖动即白等满 | `agent-core.ts:879` | 长尾 |
| P1 | 同步 prompt 装配（含 better-sqlite3 同步读）阻塞事件循环 | `prompt-context-builder.ts:617` | 并发放大 |
| P1 | 每个全成功工具波多一次**无 schema 汇总探针** LLM 调用 | `openai-compatible-tool-loop.ts:3434` | 多 1 跳 |
| P1 | replan 折叠改写历史中段 → 破坏前缀缓存，重新 prefill | `openai-compatible-tool-loop.ts:2176` | 每波 miss |
| P2 | 「投机搜索」对话面白跑（结果不被消费） | `agent-core.ts:784` | 无用网络 |
| P2 | 每请求重复的审计 JSON.stringify + 指纹 sha256 | `openai-compatible-tool-loop.ts:2236` / `:2192` | 纯 CPU |
| P2 | `prompt_cache_key` 用未稳定化的 visibleTools，与实际发送的 tools 不一致 | `openai-official-provider.ts:201` / `minimax-provider.ts:109` | 缓存稀释 |

---

## 真机前后对比（2026-10-12，已落地）

> 同一台机器、同一个 provider（minimax / MiniMax-M3）、同一条链路。
> 「修复前」取自真机日常流量（`logs/autostart/server-2026-10-11.log`，n=144 轮）；
> 「修复后」取隔离探针账号的实跑轮次（`scripts/probe-daily-chat-leak.mjs`，3 轮）。

| 指标 | 修复前 p50（n=144） | 修复后（3 轮抽样） | 变化 |
|---|---|---|---|
| `ctxMs`（上下文装配） | **1854 ms** | **6 / 73 / 16 ms** | ↓ ~97–99% |
| ├ `userLocation`（逆地理） | **2052 ms**（n=74） | 未再触达 100ms 日志阈值（≈0） | ↓ ~100% |
| └ `userProfileChat` | 375 ms | 178 ms | ↓（同批阻塞减轻） |
| `routeMs`（路由 LLM） | 1926 ms | 1275 / 2345 / 2422 ms | 未动（见下） |
| `cognizeExtraMs` | 58 ms | 69 / 78 / 94 ms | — |
| **`preMainMs`（首字前总耗时）** | **3999 ms** | **1426 / 2430 / 2523 ms** | ↓ ~40% |

**组件级直证（活体服务端 `/geo/reverse`，与 ctx 内是同一条 `reverseGeocodeCoordinates`）**：

```
第1次(冷): http=200 time=1.163s      # 走外网
第2次(热): http=200 time=0.0037s     # 命中进程缓存 → 快 ~320×
第3次(热): http=200 time=0.0038s
```

**可复现基准**：`node --import tsx scripts/bench-location-latency.ts [--stub=800]`
（`--stub` 注入固定网络延迟，不依赖外网抖动）：

```
A 优化前：每轮冷查（2 次外网）     p50=1976ms  外网调用/轮≈2
B 优化后：复用前端已解析字段       p50=0ms     外网调用=0
C 优化后：纯坐标 首次冷查          1979ms
C 优化后：纯坐标 同坐标再查(缓存)  p50=0ms
每轮节省：≈ 2284ms，外网调用 2 → 0 次/轮
```

**结论**：首字前那根 4 秒的固定长杆里，**最大的一段（≈2s，占 ~50%）是纯浪费**——
服务端把前端已经解析好的位置又拿去反查了一遍，还没有缓存。这段已归零。

**修复后剩下的第一长杆是「路由 LLM」**（`routeMs` 1275–2422ms，非 LLM 生成窗口内
还有 ~1.05s 差额，见 §1.1/§3）。它是一次**独立的、阻塞首字的 LLM 往返**：
- 其中 ~0.83s 是路由模型自身耗时（p50）；
- 另 ~1.05s（p50）**不在 provider 自计窗口内**，与「主线程被并行 cognize 的同步
  DB 读阻塞」一致——即 §1.4 的同步装配问题在路由等待窗口里也在放大墙钟时间。
- 未动它的原因：换更快模型/去掉这次调用都会影响意图判定质量，与「不影响对话」
  的前提冲突，需单独立项评估。**它是现在唯一剩下的结构性固定成本。**

---

## 0. 先测量（已有现成埋点，零改造）

**不要先改代码，先读这三条日志定位**（都恒开）：

1. `[turn-timing] session=… routeMs=… cognizeExtraMs=… ctxMs=… preMainMs=…`
   —— `agent-core.ts:1153-1159`。这一条直接告诉你**前置流水线**各段耗时。
   - `routeMs` = 路由 LLM 耗时（`turnRouteDone - turnT0`）
   - `cognizeExtraMs` = cognize 超出路由的部分
   - `ctxMs` = 上下文装配（含逆地理、同步 store 读）
   - `preMainMs` = 到主调用派发的总前置耗时
2. `[llm-timing] tool-wave model=… wave=… firstRaw=…ms firstDelta=…ms total=…ms`
   —— `openai-compatible-tool-loop.ts:2378-2383`；纯文本轮见
   `abstract-chat-provider.ts:589-594`。看 **firstRaw**（请求→首字节，含 provider 排队/思考）。
3. `[turn-trace] … durationMs=… toolCalls=[{name,ok,ms}]`
   —— `turn-trace.ts:76`，看单工具长尾。

**判读**：若 `preMainMs` 占 `durationMs` 的比例高 → 问题在本文 §1；
若 `firstRaw` 大而 `preMainMs` 小 → 问题在 provider/TTFT（模型排队或思考链），走 §2、§3。

现成脚本：`npm run bench:ttft`（`server/scripts/bench-ttft.ts`，`-- --live` 打真实 TTFT）。
prompt 转储：`AGENT_PROMPT_TRACE=1` 或建 `data/prompt-trace.flag`（免重启）。

---

## 1. 每轮固定成本（普通对话慢的主因）

### 1.1 P0 — 路由 LLM 是每轮一次的阻塞式额外往返

**事实**：`routeTurnByLlm` 在 WS 层先行发起（`chat-user-message.ts:791`），主链路在
`agent-core.ts:836` `await routePromise` 才继续。它与 `cognize` 并行（已优化成
`max(route, cognize)`，见 `:794-795` 注释），**但路由本身仍是一次独立的、等待全量
输出的 LLM 调用**：`structured-call.ts:85` 把 `provider.streamCompletion` 的 onDelta
设为空回调并 `await` 完整结果（非流式）。当前主脑 `minimax`（MiniMax-M3）的档案是
`routeMaxOutputTokens=1024 / routeTimeoutMs=5000 / maxAttempts=2`
（`provider-profiles.ts:58,77`）→ **最坏 10s，典型 0.5–2s**。

**优化选项（由保守到激进）**：
1. 路由改用**快档非思考模型**：`.env.local` 已有 deepseek-flash 槽位与 key
   （`OPENAI_MODEL`，档案 `FAST_ROUTE = 192 tok / 3000ms`，`provider-profiles.ts:52`），
   路由走该 provider 可显著压低单次耗时。
2. `maxAttempts` 路由档降为 1（`structured-call.ts:77` 默认 2）——超时直接保守降级，
   已有降级路径，不必再等第二次。
3. 极短/寒暄消息（如 <6 字、纯问候）走确定性短路，跳过路由 LLM。
   ⚠️ 历史教训：纯词法路由已因「信号盲区」退役（`agent-core.ts:788-791`），
   此短路只应覆盖**高置信的极短寒暄**，且必须叠加"失败即回落 LLM 路由"。

### 1.2 P0 — 每轮逆地理编码无缓存（纯浪费的网络往返）

**事实**：上下文装配里 `resolveUserLocationForPrompt`（`agent-core.ts:1090-1139` 内，
`:1111/:1136`）在客户端带 GPS 时，直接走 `resolveUserGeo → geoFromClientLocation →
reverseGeocodeCoordinates`（`user-location-service.ts:29-63`）。而
`reverseGeocodeCoordinates`（`reverse-geocode-service.ts:157-167`）**没有任何缓存**：
每次先打 amap（`regeo`），再打 open-meteo 取时区（`:106/:144`），各自 8s 超时。
位置是**几乎不变**的 prompt 背景，却每轮重新反查一次。

> 注：同函数里"向客户端按需拉 GPS"那一路已在 2026-09-28 改成后台不等待
> （`:1671-1682`），但**已知位置的逆地理**这一路仍是串行 await。

> **2026-10-12 复查修正**：这不是「服务端主动去要位置」，而是**同一条消息前后端各逆
> 地理一遍**。完整链路：
> 1. 前端 `client_location_service.dart::getCurrentLocationForChat()` 每条消息都拉一次
>    新 GPS，再调服务端 `GET /geo/reverse`（`routes/http/geo.ts:12-25`）把坐标解析成
>    省市区；
> 2. 前端把**已解析好的** `city/district/region/country/timezone/label` 随消息回传
>    （`chat-user-message.ts:527`）；
> 3. 服务端 `geoFromClientLocation`（`user-location-service.ts:29`）**无视这些字段**，
>    又拿经纬度调一次 `reverseGeocodeCoordinates`。
>
> 二者都无缓存；且 `AMAP_WEB_KEY` 未配 → `reverseFromAmap` 直接 return null，实际每次
> 是 BigDataCloud + open-meteo（时区）两个外网请求。所以「每轮 2 次外网请求 × 每条消息」。
> （注：另一条「socket 按需拉 GPS」路径已于 2026-09-28 后台化，`agent-core.ts:1671`——
> 那是另一条路，与本节无关。）

**已实施（2026-10-12）**：
1. `geoFromClientLocation` 优先复用 payload 里已有的结构化字段（`city/district/region/
   country`），仅当**完全没有**结构化字段（纯坐标上报/逆地理失败兜底）时才回退服务端反查
   ——直接消掉每条消息的冗余那次反查。
2. `reverseGeocodeCoordinates` 加进程内缓存：键 = 经纬度取整 3 位小数（≈110m），
   TTL 30min、LRU 512 条封顶、只缓存成功结果、并发同键 in-flight 去重。这条同时加速
   前端 `/geo/reverse`、`weather-tools`、`clock-tools`、`internet-intelligence` 等全部调用方。
3. 测试：`server/test/user-location-geo.test.ts`（2 例）锁定「结构化字段零网络」「同坐标
   二次命中缓存」；定向 41 例全绿，`tsc` 0 error。
4. **实测验证（2026-10-12）**：`ctxMs` p50 1854ms → 6/73/16ms；活体 `/geo/reverse`
   冷 1.163s → 热 3.7ms；基准见 `scripts/bench-location-latency.ts`。详见「真机前后对比」节。

### 1.3 P1 — cognize 3.5s 护栏会「白等满」

`agent-core.ts:879-890` 用 `Promise.race([cognizePromise, 3500ms])`。若 cognize 的
某个非关键成员（情绪推断 LLM 2500ms、anticipation、contextCortex、embedding）抖动，
整轮就锁到 3500ms 才放行。**优化**：把"锦上添花"的成员（情绪/anticipation/contextCortex）
移出关键 race，真正后台化；关键子集（记忆召回）单独设更短超时。

### 1.4 P1 — 同步 prompt 装配阻塞事件循环

`prompt-context-builder.ts:617 build()` 整段同步（`:647-866`），内部多路
`memoryManager.get*ForPrompt`、`shortTermMemoryGateway.buildPromptContext`、
`buildSchedulePromptSnapshot` 等，**且底层大量 better-sqlite3 同步读**
（`agentic-memory/sqlite-store.ts:19` 等）。单用户感知为"卡一下"，并发时放大成全局排队。
**优化**：装配结果按 `(actorId, 内容签名)` 做进程内缓存；把可在后台预热的 store 读
提前到上一轮空闲期。

### 1.6 P2 — 投机搜索在多数轮次白跑（2 个真实搜索请求/轮）

`agent-core.ts:784`：对 ≥6 字消息无条件发起 `runFreshEvidenceSearch`——**内部是 2 个并行
`search_web` 执行**（原词 + 「最新」变体，各 9s 超时，`:2995-3002`）。

**消费条件极窄**（`:2368-2378`，三级 if 互斥）：
1. `directClockQuestion` → 走本地时钟证据，不搜索；
2. `routeSearchQuery` 存在（realtime 轮路由给了查询词）→ 用 route 查询词重搜，
   **投机的被丢弃**；
3. 仅当 `specEvidence && !isChatLane(mode)` → 才 `await` 投机结果。

即**只有「任务面且路由未产出查询词」（路由保守降级/超时轮）才真正消费**。其余
（全部 chat 轮 + 全部 realtime 轮）发起的投机搜索都是纯浪费——不阻塞首字（fire-and-forget），
但消耗搜索 API 配额、外网连接与事件循环。

**优化（建议，需评估时序）**：把发起点从 `:784` 移到 `await routePromise` 之后，用
`fastRoute.plane !== "chat" && !fastRoute.searchQuery?.trim()` 精确门控（与消费条件同构）。
⚠️ 权衡：这只在「路由降级」这一本来要用的场景里，把投机搜索的启动推迟约 `routeMs`
（超时轮≈5s）——而该场景下它恰是被 await 的，可能来不及完成。改前需先量降级轮占比；
若占比不为零且在意，则正解是给 `toolRegistry.execute` 加 `AbortSignal`（现签名无 signal，
需贯穿搜索链），chat/已有查询词时主动 abort，时序不变、零浪费。

---

## 2. 工具调用开销（调用工具慢的主因）

### 2.1 P0 — 任务面 PRO 档显式开思考链

`agent-core.ts:2493-2494`：`mode!=="chat"` 即 `TaskTier.PRO`；`:2610`
`...(resolvedTier === TaskTier.PRO ? { disableThinking: false } : {})`。
MiniMax provider 默认关思考（`minimax-provider.ts:82-84`），PRO 档把它**显式打开** →
每个工具波在首 token 前多出整段思考链。**这是"工具明显比对话慢"的结构性原因**。
**优化**：测量 PRO 轮 `[llm-timing] firstRaw` 后决定——工具调用（填参/选工具）
通常不需要长思考，可让 PRO 也关思考，仅保留"复杂规划"轮开启（用 turnPlan 信号门控）。

### 2.2 P1 — 无 schema 汇总探针 = 每波多一次 LLM 调用

`openai-compatible-tool-loop.ts:3430-3434`：每个"全成功且非元工具"的波都额外发一次
`runSchemaLessSummary(true)`，把整段历史再发一遍。若本波 assistant 已带有可交付文本，
这次探针纯属多余。**优化**：检测本波已有终稿文本 → 直接返回，跳过探针。

### 2.3 P2 — router-first 的 discover 往返

task 车道 router-first 下，波 0 先 `tool_discover` → 强制 replan → 波 1 才 `tool_call`
→ 汇总，比直调多 1–2 跳（`:3427-3464`）。**优化**：适当提高域预载 cap
（`lane-tool-sets.ts:252 DOMAIN_PRELOAD_CAP=12`）或扩大轻量常驻，让常见动作一轮直达。

### 2.4 P1 — replan 折叠破坏前缀缓存

`:2176 foldOldWaveToolChains` 每波把旧工具链替换成 160 字摘要，改写历史**中段** →
provider 端前缀缓存必 miss，从折叠点重新 prefill。**优化**：只折叠一次并持久化，
或仅在历史超阈值时折叠（仓库已有 `bench-fold-prefix.ts` 佐证这是已知关注点）。

### 2.5 P2 — 每请求重复的审计序列化与指纹

`:2236` 为审计做 `JSON.stringify(requestMessages) + JSON.stringify(stableApiTools)`；
`:2192` `fingerprintRequestHead` 对 tools/history/tail 各做 stringify+sha256，**每次请求
（含重试）都跑**。**优化**：审计改用估算长度；`PREFIX_WATCHDOG=0` 时指纹短路。
另 `:1829-1834` 每轮对全部工具重跑 schema 压缩，注册表工具对象是确定性的，可缓存产物。

---

## 3. 缓存口径（Provider 层）

- 主脑 MiniMax-M3 的 prompt 缓存本身健康（探针实测命中≈100%）。真正的漏点是
  **`prompt_cache_key` 与实际发送的 tools 不一致**：key 用 `visibleTools`（未做
  会话稳定化），实际发的是 `stableApiTools`（经 `stabilizeToolOrderForSession`）——
  `openai-official-provider.ts:201` / `minimax-provider.ts:109`。每轮可见集一变，
  key 就换分片，缓存被稀释。**优化**：key 的 tools 签名改用稳定化后的并集。
- `.env.local:19 OPENAI_PREFIX_CACHE_ENABLED=0` 只关的是 **openai 槽位**（DeepSeek 不认
  `prompt_cache_key`），不影响 minimax 路径——排查时勿被误导。

---

## 4. 落地顺序与验收

**Phase 0（先做，零风险）**：读 `[turn-timing]` / `[llm-timing]` 确认瓶颈段。
**Phase 1（低风险高收益，每轮固定成本）**：
1. 逆地理编码加 LRU（§1.2）——改动最小、收益立竿见影。
2. 路由降重试 + 换快档模型（§1.1-1、1-2）。
3. 去掉对话面投机搜索（§1.5）。
> 预期：普通对话 `preMainMs` 明显下降。
**Phase 2（工具面）**：PRO 关思考或门控（§2.1）、跳过冗余汇总探针（§2.2）。
> 预期：工具轮 `firstRaw`、总跳数下降。
**Phase 3（缓存/CPU）**：前缀 key 口径（§3）、折叠策略（§2.4）、审计序列化（§2.5）。

**验收口径**：同一批固定消息（含闲聊 / realtime / 单工具 / 多工具各 ≥10 条），
对比 `preMainMs` 与 `firstRaw` 的 p50/p95，以及 `[turn-trace] durationMs`。

## 附：关键文件速查

| 关注点 | 位置 |
|---|---|
| 路由阻塞点 | `agent-core.ts:836`、`route-llm-call.ts:175`、`structured-call.ts:85` |
| 路由预算/超时 | `provider-profiles.ts:52,58,113` |
| 逆地理无缓存 | `reverse-geocode-service.ts:157`、`user-location-service.ts:75`、`agent-core.ts:1111` |
| cognize 护栏 | `agent-core.ts:879` |
| 同步装配 | `prompt-context-builder.ts:617`、`agentic-memory/sqlite-store.ts:19` |
| PRO 开思考 | `agent-core.ts:2494,2610`、`minimax-provider.ts:82` |
| 汇总探针 | `openai-compatible-tool-loop.ts:3430` |
| replan 折叠 | `openai-compatible-tool-loop.ts:2176` |
| 前缀 key 口径 | `openai-official-provider.ts:201`、`minimax-provider.ts:109`、`prefix-cache.ts:74` |
| 埋点 | `turn-trace.ts:76`、`agent-core.ts:1153`、`openai-compatible-tool-loop.ts:2378` |
