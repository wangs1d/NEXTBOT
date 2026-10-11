# 扫描架构优化方案 —— 「跨源汇聚统一采集层」

> 用户重点：Muse 的「**扫描收件箱、日历、健康、购物、社交 App；跨源汇聚到自己的数据库**」。
> 判断：**我们各信源的扫描都做了，但"扫描的架构设计"不够** —— 各扫各的。

---

## 一、诊断：我们不是"没有扫描"，是"44 个扫描器各自为政"

### 1.1 量化证据

```
server/src 下独立的 setInterval 轮询器：44 个
```

每个外部信源都是一套**完整的、重复的**基础设施：

| 信源 | 轮询实现 | 退避实现 | 状态落盘 | 健康暴露 |
|---|---|---|---|---|
| 邮件 MailWatch | 自己的 setInterval | 自己的（30s 起指数退避） | `data/mail-watch/processed-uids.json` | 自己的 status() |
| 财务账单 | 自己的 setInterval | 自己的 | `data/finance-bill-auto-fetch/state.json` | 自己的 |
| ICS 日历 | 自己的 setInterval | 自己的 | `data/ics-sub/state.json` | 自己的 |
| 购物比价 | 自己的 setInterval | 自己的 | `data/shopping/` | 自己的 |
| 兴趣热搜 | 自己的 setInterval | 自己的 | `data/interest-watch.json` | 自己的 |
| ... | ... | ... | ... | ... |

**四处重复**：轮询调度、失败退避、水位/去重状态、健康上报——每加一个信源就抄一遍。

### 1.2 更关键的矛盾：统一内核"名存实亡"

项目里**早就设计好了**统一采集内核 `SensorKernel`（`sensors/kernel.ts`），它的注释白纸黑字写着：

> "任何物理/数字数据源（桌面窗口、日程、消息、rhythm、**财务**、兴趣、天气、未来的家居/手机/电子产品）都以**同一格式产出 Signal**，进 SensorKernel **统一去重、落盘、分发**。"

`SignalStream` 类型里也**已经预留了** `finance` / `interest` / `weather` / `device`。

**但是**，实际装配时（`create-app-services.ts:4669`）内核只挂了 4 个：

```
sensorKernel.register(screenSensor);        // ✅
sensorKernel.register(scheduleSensor);      // ✅
sensorKernel.register(fileWatcherSensor);   // ✅
sensorKernel.register(new ClipboardSensor)  // ✅
registerFeeder(sensorKernel, "goal_board")  // ✅
registerFeeder(sensorKernel, "message_hub") // ✅
                                            // ❌ 邮件、财务、ICS、购物、位置 —— 全在门外
```

**结论：架构设计意图是对的（统一内核），但执行到一半就分叉了。** 内线的"本地传感器"走了内核，外线的"外部信源"全部自建轮询，且**互不连通**。

### 1.3 后果（这才是"架构不够"的实际代价）

1. **数据没有"自己的数据库"** —— Muse 是"跨源汇聚到一个库"，我们是**6 个信源 6 个目录的散落 JSON**。想做"聚合查询"（"我这月一共在哪些地方花了钱？"）只能逐个服务去问。
2. **无法跨源关联** —— 邮件里的航班 + 日历里的会议 + 购物里的比价，本来可以拼成"你要去出差"的完整图景，但现在三个服务各扫各的，**永远看不到彼此**。
3. **健康不可观测** —— 内线传感器有 `/api/proactivity/sensors` 健康面板（熔断/水位/连续失败），**外部信源全都没有**。邮件 IMAP 挂了，只有它自己的 `status()` 知道，主动性系统完全不感知。
4. **加信源成本高** —— 每接一个 App/数据源，都要重写一遍轮询+退避+落盘+健康四件套。
5. **与 Goal 层无法打通** —— 上一轮方案里"Goal→感知按需检索"，因为信源不统一，根本无法统一调用。

---

## 二、方案：把外部信源"收编"进统一采集层

### 核心思路

**不是重写，是"收编"**：外部信源服务（MailWatch / 财务 / ICS / 购物…）**保留自己的业务逻辑**（IMAP 连接、账单解析、比价算法），但把**"何时扫、失败怎么办、状态存哪、健康谁看"这四件事从各服务剥离出来，统一交给 SensorKernel**。

```
┌───────────────────────────────────────────────────────────┐
│                  统一采集层（CollectFabric）                 │
│  ┌─────────────── SensorKernel（已有，需扩展）──────────────┐ │
│  │  统一调度（单定时器，按各源 nextPollAt 调度）             │ │
│  │  统一退避（熔断 + 半开恢复，已有）                        │ │
│  │  统一水位（watermarks.json，已有）                        │ │
│  │  统一健康（health()，已有）                                │ │
│  │  统一分发（Signal → 订阅者）                              │ │
│  └──────────────────────────────────────────────────────────┘ │
│         ▲ 内线（已有）              ▲ 外线（本次新增）           │
│   screen / schedule /          mail / finance / ics /        │
│   file / clipboard             shopping / interest / location│
└───────────────────────────────────────────────────────────┘
                            │
                            ▼ 统一落盘
              ┌─────────────────────────────┐
              │  Source Store（"自己的数据库"）│
              │  按 stream 分区的统一存储      │
              │  + 跨源索引（时间/actor/实体） │
              └─────────────────────────────┘
```

### 阶段一（P0）：外部信源适配成 `ProactiveSensor`

**不改业务逻辑，只加一层适配器**。每个外部服务实现 `ProactiveSensor` 接口：

```ts
// 新增 server/src/proactivity/sensors/mail-sensor.ts
export class MailSensor implements ProactiveSensor {
  readonly id = "mail_watch";
  readonly stream = "mail" as const;          // SignalStream 新增 "mail"
  readonly pollIntervalMs = 60_000;

  constructor(private readonly mailWatch: MailWatchService) {}

  async collect(since: number): Promise<Signal[]> {
    // 复用 MailWatch 已有的轮询结果，只做"形状转换"：
    //   新邮件 → Signal { stream:"mail", payload:{from,subject,importance,...} }
    const fresh = await this.mailWatch.fetchNewSince(since);
    return fresh.map((m) => ({
      stream: "mail",
      at: m.date,
      fingerprint: `mail:${m.uid}`,
      salience: m.importance === "critical" ? "high" : "low",
      delta: `新邮件：${m.subject}`,
      payload: { from: m.from, subject: m.subject, importance: m.importance },
    }));
  }
}
```

**关键约束**：适配器只做 **"拉取结果 → Signal 形状"** 的转换，**业务逻辑（IMAP、解析、分级）仍留在原服务**。这样风险最小、可增量迁移。

> 需要给外部服务开一个"`fetchNewSince(since)`"的**只读取数口**——大部分服务已有类似能力（如 MailWatch 的 handleIncoming、ICS 的 diff），只是没有对外暴露成"给我 since 以来的新条目"。

### 阶段二（P0）：统一"Source Store"——兑现"自己的数据库"

现在 6 个目录散落，改为**统一分区存储**：

```
data/
├── sensor-fabric/
│   ├── streams/
│   │   ├── mail.ndjson        ← MailWatch 产出
│   │   ├── finance.ndjson     ← 财务账单
│   │   ├── schedule.ndjson    ← ICS + 本地日程
│   │   ├── shopping.ndjson    ← 比价
│   │   ├── interest.ndjson    ← 热搜
│   │   └── ...                ← 内线信号（screen/clipboard…，本就统一）
│   └── index.json             ← 跨源索引：按时间/actor/实体建倒排
└── proactivity/
    └── (保留：这是主动性状态，不是采集数据)
```

**注意边界**：外部服务**自己的业务状态**（如 `processed-uids.json` 是 IMAP 去重游标）**保留原地**，不要动——那是"服务的账本"，不是"采集的数据"。只把**"产出的、可供消费的信号"**汇聚到 sensor-fabric。

**收益**：真正意义的"跨源汇聚到一个库"。之后"我这月的钱花在哪"、"提到三亚的三方消息"这类跨源查询才有可能。

### 阶段三（P1）：跨源关联（Muse 的"汇聚"价值所在）

有了统一 Source Store，可以做**实体级关联**：

```
index.json 里维护实体索引：
  "三亚" → [mail:机票确认信, calendar:三亚行程, shopping:酒店比价]
  "张总" → [message:未读5条, mail:合同邮件, commitment:答应今天回]
```

**这才是 Muse "跨源汇聚"的真正价值**——不是把数据堆在一起，而是**让不同源里的同一件事能拼起来**。产出的主动消息就能从"你有一封邮件"升级为"张总发来合同邮件，你今天还答应过回他，要现在处理吗？"

### 阶段四（P1）：健康面板统一

外部信源接入内核后，**自动获得** `/api/proactivity/sensors` 的健康上报（熔断/连续失败/水位），与内线传感器同权。**这是白送的收益**——现有 `whySilent` 诊断以后能看到"邮件链路挂了"这种根因。

---

## 三、与整体架构的关系

这个方案是上一轮「Goal 驱动」方案的**前置依赖**：

```
扫描架构统一（本方案）
        │  没有统一的"库"，GoalRunner 想"按需检索任意信源"就无从下手
        ▼
Goal 驱动（上一轮方案）
        │  Goal 需要什么信息，从统一 Source Store 取
        ▼
出口修复（第一轮方案）
        │  取到的东西要能发出去
        ▼
用户
```

**三者是"数据层 → 决策层 → 投递层"的完整链条**：
- 本方案 = **数据层**（跨源汇聚，对齐 Muse 那句"汇聚到自己的数据库"）
- Goal 方案 = **决策层**（目标驱动推演）
- 出口方案 = **投递层**（必达）

---

## 四、执行建议

**不做"大爆炸式重构"**，按信源逐个收编：

1. **先做 MailSensor**（邮件是最高价值信源，且 MailWatch 结构最完整）——验证适配器模式可行
2. **再做 FinanceSensor + IcsSensor**（这两个有明确的"增量取数"语义，好改）
3. **建 Source Store**（此时已有 3+ 信源，迁移有实际收益）
4. **补跨源索引**（有足够数据后才有意义）
5. **其余信源（shopping/interest/location）按需收编**

每个信源独立迁移、独立验证、独立回滚（env `SENSOR_FABRIC_<SOURCE>=0` 走旧路径）。

---

## 五、一个判断

> **我们建好了"统一采集层"这个盒子（SensorKernel），却只往里放了一半东西，另一半自己另起炉灶。**

Muse 的"跨源汇聚"强，不在于它扫得多，而在于它**所有源的产出进了同一个池子，能被同一个大脑消费**。我们现在是 44 个扫描器 + 6 个散落目录 —— **扫描能力不缺，缺的是"汇聚"这个动作本身**。

---

## 附：改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `sensors/types.ts` | 改 | `SignalStream` 补 `mail` / `shopping` / `location`（finance/interest/weather 已有） |
| `sensors/mail-sensor.ts` | **新增** | MailWatch → ProactiveSensor 适配器 |
| `sensors/finance-sensor.ts` | **新增** | 财务账单适配器 |
| `sensors/ics-sensor.ts` | **新增** | ICS 日历适配器 |
| `sensors/shopping-sensor.ts` | **新增** | 购物比价适配器 |
| `proactivity/source-store.ts` | **新增** | 统一分区存储 + 跨源索引 |
| `services/mail-watch-service.ts` | 改 | 暴露 `fetchNewSince(since)` 只读取数口 |
| `services/finance-bill-auto-fetch-service.ts` | 改 | 同上 |
| `services/ics-subscription-service.ts` | 改 | 同上 |
| `bootstrap/create-app-services.ts` | 改 | 收编注册：外部信源 sensor 进 kernel |
| `test/sensor-fabric-external.test.ts` | **新增** | 适配器形状转换 / 统一落盘 / 健康上报 三组回归 |

**验收指标**：
- 外部信源出现在 `/api/proactivity/sensors` 健康面板（当前只有 4 个内线）
- `data/sensor-fabric/streams/` 下出现 mail/finance/ics 分区文件
- 跨源查询："提到三亚的所有来源"能一次返回 ≥2 个源的条目

---

## 六、持久化与清理：从"日志"升级为"可查的库"（2026-10-10 二次改造）

首版 SourceStore 只解决了"汇聚动作"，但持久层是**内存窗口 + 单代轮转 + 启动不加载**，离 Muse「扫进自己的库、随时可查」还差一层。三处缺口与修法：

### 缺口 → 修法

| 缺口 | 症状 | 修法 |
|---|---|---|
| **单代轮转 = 死存储** | `streams/<stream>.ndjson` 超 4MB 就 `rename` 覆盖 `.1`；而没有任何代码读 `.1` → 那 4MB 占盘、不可查、等着被覆盖 | **按天分区** `streams/<stream>/<YYYY-MM-DD>.ndjson`（同日超限追加 `.N.ndjson` 分片），取代单代覆盖 |
| **索引"满则拒新"** | `ENTITY_INDEX_MAX_KEYS=5000` 满后**新实体进不来**、老实体永久占位 → 索引老化，`dropped` 只增不减 | 满时**按 LRU 淘汰最旧键**（Map 迭代序即 LRU 序，命中 `delete+set` 置尾），`evicted++` |
| **重启即失忆** | 内存窗口从空开始，磁盘文件不加载 → 重启后"提到三亚的所有来源"只剩新采的 | **启动分段加载** `loadRecent()`：读最近 N 天日分区重建窗口 + 索引（只读不写、幂等），装配层延迟 1.5s `unref` 执行不阻塞引导 |

### 保留策略

- `SENSOR_SOURCE_RETENTION_DAYS`（默认 **30**，`0`=永久保留）。
- 清理时机：写入时**每日至多一次**惰性 `pruneExpired()`（`lastPruneDay` 防频繁扫目录），另公开给定时任务/诊断接口手动调用。
- 判定：按天分区文件名取日期；旧式扁平文件 / 旧轮转文件按 `mtime`。两者统一收口。

### 加载策略

- `SENSOR_SOURCE_LOAD_DAYS`（默认 **7**，`0`=不加载历史）。
- 单文件尾部最多 `2000` 行、跳过 `>32MB` 异常文件，避免大文件拖慢启动。
- 加载顺序按 `at` 升序，保证窗口 FIFO 语义与索引命中顺序正确。

### 查询面

- 跨源实体检索 `findByEntity(entity)` —— 走**常驻索引**，重启后仍可查历史（旗舰能力）。
- 按 stream 热查询 `byStream()` —— 走**内存窗口（2000 条 FIFO）**，只保最近。
- 诊断回放 `readPartition(dataPath, stream)` —— 跨天分区 + 旧扁平文件一并读（日期升序）。

### 配置项

| env | 默认 | 说明 |
|---|---|---|
| `SENSOR_SOURCE_STORE` | 开 | `0` 整库关闭（回退：不汇聚、不落盘） |
| `SENSOR_SOURCE_RETENTION_DAYS` | `30` | 分区保留天数；`0` 永久 |
| `SENSOR_SOURCE_LOAD_DAYS` | `7` | 启动加载天数；`0` 不加载 |

### 验收

- 新增单测 6 例（按天分区跨天 / 保留清理 / 保留 0 天=永久 / 启动加载命中 / 旧格式兼容 / LRU 淘汰 5005 键），`test/sensor-fabric-external.test.ts` 共 19 例全绿。
- `/api/proactivity/sensors` 的 `sources` 字段增 `evicted` / `loaded` / `prunedFiles` / `retentionDays` / `loadDays`。

---

## 七、端到端实测：外部数据 → 统一库 → 主动发起（2026-10-11）

用户要求「外部数据应该扫进统一数据库，然后看是否需要主动发起对话」。用真实组件跑了一遍全链
（`server/test/sensor-to-proactive-e2e.test.ts`，只有 IMAP/HTTP 读端口是桩），**发现三处断层**：

| 断层 | 症状 | 修法 |
|---|---|---|
| **① 世界板不认外部流** | `ingestSignal` 只处理 presence/screen/schedule/message/goal，`mail` 与 `finance` 落 `background.lastEnv` 尾迹 → **信号进了统一库，却永远驱动不了任何规则**（`unread_burst` 读的是 `message` 流写的 `current.unreadRecent`） | 世界板新增 `case "mail"`（→ `current.unreadRecent`，带 sender/subject/importance）与 `case "finance"`（→ `current.recentTx`） |
| **② ICS 日程形状不匹配** | `schedule` 分支只认任务快照的 `nextRunAt/nextTitle`；ICS 适配器给的是 `startMs/summary` → **静默丢弃**，订阅日历永远驱动不了 `meeting_soon`。且 ICS 的 `signal.at` 就是**事件开始时刻**（非观测时刻），用 `at` 判断"是否未来事件"会恒等 → 必须对比板钟 `nowFn()` | `schedule` 分支加 ICS 回退形状（`startMs>nowFn()` 且"更近的未来事件才覆盖"），旧形状行为逐字不变 |
| **③ finance 无消费方** | 账本入板后没有任何规则读它 | 新增规则 `spend_alert`（≥`PROACTIVITY_SPEND_ALERT_AMOUNT`，默认 1000 元；`current.recentTx` 驱动；7 天去重键；模板直出零 LLM） |
| **④ 跨源实体召回漏（附带发现）** | `tokenize` 用 `[\u4e00-\u9fa5]{2,4}` 贪婪整段 → 「新邮件：三亚合同 review」只切出「三亚合同」，**「三亚」不是独立词元** → 邮件的三亚与日历的三亚在倒排索引里永不相遇，「一次查询命中所有来源」形同虚设 | 改为「整段词元 + **2 字滑窗**」（CJK 检索惯例）；每信号实体上限 12→20 |

### 实测结论（修复后 5/5 绿）

```
E2E-1 三源进统一库（mail / schedule / finance）   ✓
E2E-2 跨源实体检索：「三亚」同时命中邮件+日历       ✓
E2E-3 邮件爆发 → unread_burst → 真正投递           ✓
E2E-4 ICS 日程 → meeting_soon → 投递               ✓
E2E-5 账本 → spend_alert → 投递                    ✓
```

### 运行期限制（如实记录）

- 外部读端口只采**进程启动之后**的新数据（邮件环形缓冲 200 条 / 账本按交易时间 / ICS 按水位），
  重启前的历史**不会重采**（有意防重放）。跨重启的**查询**能力由 `SourceStore.loadRecent()`
  从磁盘日分区恢复内存窗口与实体索引兜住——两者互补，不冲突。
- 因此「统一库能查多久的历史」= `SENSOR_SOURCE_RETENTION_DAYS`（默认 30 天），
  与「传感器能主动发现多老的事」= 运行时长，是两个不同的问题。
