# 主动性架构优化方案（架构级）—— 对标 Muse 的「目标驱动」重构

> 用户重点：Muse 的**触发模型**——「Goal（长期目标）为一等公民，用户给宽泛目标，Agent 在后台持续推进」。
> 本文档回答：我们的**信息检测其实做了**，但**架构设计不够好**，具体差在哪、怎么改。

---

## 一、先承认：检测层我们做得不比 Muse 差

把两边的"感知能力"摊开看：

| 感知源 | Muse | Private-Agent | 评价 |
|---|---|---|---|
| 邮件 | ✅ 扫描收件箱 | ✅ MailWatch（IMAP 轮询 + 分级 + 财务/票务入账） | **打平** |
| 日历 | ✅ 扫描日历 | ✅ ScheduleSensor + ICS 订阅 + MailScheduleBridge | **打平** |
| 屏幕/前台 | ❌ 未提及 | ✅ ScreenSensor（9 类分类 + 15min 心跳） | **我们更强** |
| 剪贴板/文件 | ❌ | ✅ ClipboardSensor + FileWatcherSensor | **我们更强** |
| 主动消息 | ✅ | ✅ MessageWatchTrigger + unread_burst | **打平** |
| 位置/围栏 | ❌ | ✅ LocationTrigger + Geofence | **我们更强** |
| 兴趣/热搜 | ⚠️ Feed 板块 | ✅ InterestWatcher（热搜 + 语义匹配） | **我们更强** |
| 设备信号 | ❌ | ✅ deviceFeeder（物理设备上行） | **我们更强** |

**结论：信息检测我们不但做了，而且感知面比 Muse 更广。** 问题不在"看不看得见"，而在**看见之后，没有一个持续运转的引擎去追问"为了用户的什么目标，这件事现在该不该推进"**。

---

## 二、架构差距的本质：我们的 Goal 是"配件"，Muse 的 Goal 是"主引擎"

### 2.1 Muse 的架构（从公开资料反推）

```
┌─────────────────────────────────────────────────┐
│  Goal（长期目标）= 一等公民，是系统的"心跳源"      │
│  用户给宽泛目标："帮我准备下个月的旅行"            │
└──────────────────────┬──────────────────────────┘
                       │ 后台持续推进（App 关闭仍在跑）
                       ▼
        ┌──────── 自主循环（Autonomous Loop）────────┐
        │  ① 目标分解 → 步骤                          │
        │  ② 主动检索信息（搜网/读邮件/查日历）        │
        │  ③ 执行步骤（比价/预订/填表）                │
        │  ④ 判定：需不需要用户拍板？                  │
        │      否 → 静默继续                          │
        │      是 → 推送"待批/结果"（决策点才打扰）     │
        └────────────────────┬──────────────────────┘
                             ▼
                    Goal 状态持续推进 → 下一轮
```

**关键**：Goal 不只是"一件事的记录"，它是**驱动整个系统运转的马达**。感知层（读邮件/看日历）是**为 Goal 服务的工具**，不是独立触发源。

### 2.2 我们的架构（实际情况）

```
传感层（6 路常驻）──┐
                    ├──→ WorldBoard ──→ MappingExecutor（9 条固定规则）──→ ArbiterV2 ──→ 管道
兴趣/邮件/位置 ─────┘         ↑                                              ↑
                              │                                              │
                    ┌─────────┴─────────┐                                    │
                    │  GoalBoard        │  ← 配角！只在"会前准备"时被调一次     │
                    │  （watching/      │     产出 goal_ready 事件（social 层） │
                    │   preparing/ready）│                                    │
                    └───────────────────┘                                    │
                                                                             │
        GoalPlanner ─────────────────────────────────────────────────────────┘
        （plan 型目标拆步推进）
             ▲
             │  ⚠️ 入口是工具 goal.plan.create —— 只能模型在对话里被动调用
             │  ⚠️ 推进是工具 goal.plan.advance —— 只能模型在对话里被动调用
             │  ⚠️ 没有后台自主循环推进它
```

**三个致命的架构问题**：

1. **Goal 是"被动的配件"**：`GoalBoard.maybeStartMeetingPrep()` 只在会前 20-40min 被定时器调一次；`goal.plan.*` 全是**工具**，必须模型在对话中被调用。**没有对话 = goal 系统完全静止。** 而 Muse 的 goal 是**自驱的**。

2. **感知层和 Goal 层是"两套并行系统"**：传感层 → 9 条固定规则 → 仲裁；Goal 层 → goal_ready 事件。两者**没有交汇**。传感器看到"用户连续 coding 3 小时"，不会去问"这是不是在推进某个目标、该不该鼓励/提醒"；反之 goal 需要"查一下这个航班价格"，也不会主动去调感知层。

3. **规则是"场景清单"，不是"目标推演"**：9 条规则（away_return/meeting_soon/work_marathon...）是**离散的场景枚举**。Muse 是**从一个目标出发推演该做什么**。前者加场景要改代码（`buildBoardRules` 数组加一行），后者是**目标驱动的通用推理**。

---

## 三、优化方案：把 Goal 从"配件"提升为"主引擎"

### 阶段一（P0）：给 Goal 装上"后台自主循环"——最小可用版

**核心改动：新增 `GoalRunner` 服务，作为 goal 的常驻执行引擎。**

```
server/src/proactivity/goal-runner.ts（新增）
├── start()：setInterval（tick 5min，env GOAL_RUNNER_TICK_MS）
├── tick()：
│     for each actor（复用 proactivityHub.exportActors 活跃过滤）
│       for each activePlan（GoalBoard.list → kind=plan 且非 done/ready）
│         ① 取下一个 todo 步骤
│         ② 判定是否可自动推进（sensitivity != act_external）
│         ③ 可推进 → goalPlanner.advance()（复用现有逻辑！）
│         ④ 不可推进（外部动作）→ 提交一条"等你确认"提案进管道
│         ⑤ 阶段性进展（每完成 N 步）→ 提交汇报提案进管道
│       for each preexec/watching goal
│         检查是否有"补充信息"可主动获取（见阶段二）
```

**关键点：`GoalRunner` 不新写执行逻辑，而是复用 `GoalPlanner.advance()`**——它已经有完整的拆步、外部步骤确认闸、TaskHub 终态回调。缺的只是**"谁在后台定期调它"**。

**这一步直接对齐 Muse 的"后台持续跑"**：用户设一个目标就不管了，系统会自己盯着、自己推进、卡住了才来找人。

| 收益 | 风险 | 回滚 |
|---|---|---|
| goal 系统从"静态"变"动态"；无对话也能推进 | 中：需防"后台狂派任务烧 token" | `GOAL_RUNNER_ENABLED=0` 一键关；复用现有 `PROACTIVITY_GOAL_DAILY_BUDGET=24` 预算闸 |

> ⚠️ 注意：现有 `goalDailyBudget`（每日 24 步上限）+ 轻步骤车道已经是很好的成本护栏，**`GoalRunner` 必须走同一预算闸**，不能绕开。

### 阶段二（P0）：打通"感知层 → Goal 层"的双向桥

新增 `goal-signal-bridge.ts`，让感知信号可以**喂给活跃目标**，而不是各自为政：

**方向 A：感知 → Goal（信号增强）**
```
ScreenSensor 连续 coding 3h + 存在活跃 plan "学英语"
  → 不再只说"你累了"（现在的 work_marathon）
  → 而是"你计划今天学英语，现在还在写代码，要现在开始吗？"
```
实现：`MappingExecutor` 的规则 ev 函数里，注入 `activeGoalsOf(actorId)` 供规则读取（现有 `RuleServices` 已是这个模式，加一个 provider 即可）。

**方向 B：Goal → 感知（按需检索）**
```
活跃 plan "下月去三亚" 的第 3 步是"查机票"
  → GoalRunner 自动发起 realtime_search 获取航班信息
  → 结果落 goal payload → 下一步推给用户
```
实现：`GoalRunner` 能调用 `toolRegistry.execute`（现有能力），把检索结果写回 goal。

### 阶段三（P1）：从"场景规则"升级为"目标推演"

这一步是**架构性重构**，风险最高，建议前两阶段验证有效后再做。

**现状**：`buildBoardRules()` 返回 9 条固定规则，每条是"if 状态命中 then 产出事件"。

**目标**：引入**目标模板库（Goal Templates）**，把规则表达为"为了达成 X 类目标，需要监测 Y 信号、触发 Z 动作"：

```
// 现在（场景枚举）
{ id: "meeting_soon", eval: (ctx) => { if (next.runAt - now <= 15min) {...} } }

// 目标驱动（同一件事，但归属到目标）
{
  goalType: "meeting_readiness",   // 目标：为会议做好准备
  signals: ["schedule.nextEvent"], // 监测：下一个日程
  conditions: [{ minBefore: [60, 15] }],
  actions: [
    { kind: "prepare_brief", tool: "recallMemory", when: "60min" },  // 提前备材料
    { kind: "notify", when: "15min" },                                // 临会提醒
  ],
  escalate: { onMissed: "deliver_anyway" },  // 错过也要说（对齐上一轮的 P0-2）
}
```

**好处**：
- 加场景不改代码，**加一条目标模板即可**（真正解决"打地鼠"问题）
- 每个模板自带"该监测什么信号、该做什么动作、错过怎么办"——**结构上强制思考完整性**
- 用户可以**显式开启/关闭某类目标**（对齐 Muse 的"Goals/Feed 板块"可配置）

---

## 四、与上一轮「出口优化」的关系（务必一起看）

上一轮方案（`docs/proactivity-optimization-plan.md`）解决的是**"产出的东西发不出去"**；
本方案解决的是**"根本没东西产出/产出的东西没目标"**。

**两者必须配合，顺序建议**：

```
┌─ 第一优先：出口（上一轮 P0）────────────────────────────┐
│  离线落信箱 + TTL 降级投递 + pause 死区修复             │
│  → 不修这个，GoalRunner 推进的结果照样发不出去           │
└──────────────────────────────────────────────┘
                        ▼
┌─ 第二优先：GoalRunner（本方案阶段一）──────────────────┐
│  让 goal 系统动起来；结果走已修好的出口送达              │
└──────────────────────────────────────────────┘
                        ▼
┌─ 第三优先：双向桥（本方案阶段二）──────────────────────┐
│  感知层与 Goal 层交汇，产生"有上下文"的主动             │
└──────────────────────────────────────────────┘
                        ▼
┌─ 第四优先：目标模板（本方案阶段三）────────────────────┐
│  架构性重构，工作量最大，前序验证后再做                  │
└──────────────────────────────────────────────┘
```

---

## 五、一个更本质的判断

回头看，我们和 Muse 的差距可以浓缩成一句话：

> **Muse 是"目标系统"，我们是"规则系统"。**
> 规则系统的能力上限 = 你写了多少条规则；目标系统的能力上限 = 用户给了多少目标。

我们的 9 条规则其实是 9 个"写死的目标"（离开问候、临会提醒、过劳干预……）。**方向没错，只是表达方式错了**——把目标写成了 if-else，所以：
- 加能力要改代码 → 扩展慢
- 规则之间不共享上下文 → 主动内容"碎片化"（无法说"你正在为旅行做准备，顺便提醒你会议要开始了"）
- 没有"目标进度"概念 → 用户感受不到"这个 Agent 在替我做一件长期的事"

**把 Goal 提为主引擎，本质上是把"场景枚举"换成"目标推演"**，这也正是 Muse 那行被圈出来的重点所指向的架构方向。

---

## 六、共享发现层（Shared Discovery Layer / Blackboard，2026-10-19）

> 这一节回答上一节没答的问题：把 Goal 提为主引擎之后，**多条感知线 + 多个出口**之间
> 「谁读到谁」的连线数怎么控制。答案是**一条总线 + 一个共同键 + 一个开口闸**。

### 6.1 病根：四套存储、三个出口、没有共同键

把开口方摊开看，其实是四套各自为政的存储喂三个出口：

| 存储 | 存的是 | 谁写 | 出口 |
|---|---|---|---|
| SourceStore | 传感原料（邮件/日历/位置…） | 各路 sensor | arbiterV2.admit |
| WorldBoard | 整理后的「现在」（9 条规则产出） | MappingExecutor | proactivePipeline.submitProposal |
| GoalBoard | 长期目标（track/preexec/plan） | GoalPlanner / GoalRunner | proactivityHub.submitIntent |
| 会话拆步 | 计划步骤的临时状态 | 会话工具 | （同上，经 hub） |

四者**没有共同键**。于是源数从 3 涨到 N 时，"谁读到谁"的连线数按 **≈ N²** 涨：
邮件说「提到搬家」、GoalRunner 说「搬家卡在第 1 步等确认」、夜间内省说「搬家三天没动静」，
**三句话谁也读不到对方**——同一件事被三层各说一遍，用户收到三条碎片。

**这不是"去重没做好"，是"没有共享面"。** 给下游 dedup 打补丁只是把症状压住：
补丁只能按"刚不刚说过"降档，**读不到内容**，也**说不清它们说的是不是同一件事**。

### 6.2 架构：一条总线、一个共同键、一个开口闸

```
                    ┌──────────── 共享发现层（复用 SourceStore）────────────┐
  邮件 / 日历 / 天气 ─┤  finding 条目：{ subject, source, content, at, ttlMs } │
  GoalRunner        ─┤  共同键 = subject（目标用 goalId，其余用主体词）        ├─→ composeBeforeOpen ─→ 单开口
  夜间内省 L3       ─┤  联系 = findByEntity 自然相遇（不需要两两耦合）         │      ▲
  财务 / 位置 / …   ─┘  白拿：指纹去重 / 按天分区 / 实体倒排 / 保留期 / LRU     │      │ noteSpoken(verdict)
                                                                              └──────┘  「真的说出口」才算消费
```

**四条设计决策**（全部零 LLM、不新建存储）：

1. **一条总线 = 复用 SourceStore，不新建存储。**
   `SignalStream` 增加 `"finding"` 条目类型，发现作为普通信号落进同一条流，
   白拿指纹去重、按天分区、实体倒排 `findByEntity`、保留期与 LRU——**架构上不欠债**。

2. **共同键 = `subject`。** 目标类开口传 `goalId`；其余开口由
   `primarySubjectOf(title + summary)` 推断主体词（如"三亚"/"搬家"）。
   三源天然汇聚到同一个键，不需要任何两两耦合。

3. **「联系」由 `findByEntity` 自然产生。** 邮件里提到"房东"、目标是"搬家"，
   靠共同实体"搬家"在倒排索引里相遇——**联系是索引的副作用，不是写死的规则**。

4. **单开口闸 = `composeBeforeOpen`。** 任何出口在开口前：读同 subject 的未消费 finding +
   实体命中上下文，**零 LLM 模板拼接**进正文。于是：
   - 同一件事被第二层发现时，**合并进正文**（`（另：…）`）而不是各发一条；
   - **重复降档从"另加一条规则"变成"发现已被读走"的副作用**——等级由目标状态 +
     重复状态推导，**不再有任何硬编码等级**。

**关键补充：读走 ≠ 说出——消费拆三态（2026-10-19 二期）。**
`composeBeforeOpen` 读走发现时只**预留**（`reserve`，带 TTL）：第二个出口在同一窗口内读不到
它，于是"同一发现被两个出口各说一遍"在开口瞬间就挡住了；但**预留 ≠ 消费**。真正结算由
`settle(fingerprints, disposition)` 按提案最终去向执行：

| 最终去向 | 结算 | 含义 |
|---|---|---|
| `delivered`（真说出口） | `commit` | 转消费，下次不再说 |
| `pending`（deferred，入队等时刻） | 维持预留 | 等那次真的投出去再 commit |
| `dropped`（去重丢弃 / 抑制 / 静默 / 过期） | `release` | 释放回总线，等下一个出口带出 |

旧版把 `deferred` 也算消费——挂起的提案若后续被静默清理 / 48h 僵尸丢弃，它读走的他人发现
已被吞掉 = **信息蒸发**（正是修 `merged` 想堵的洞，在 deferred 上又裂一道）。三态把这道裂缝
补上：只有 `delivered` 才消费，其余一律回到总线。台账 `findingStats()` 相应区分
`pending / reserved / consumed` 三项。

### 6.3 收口点：唯一收口 = `ProactivePipeline.submitProposal`

`submitProposal` 的文档自述就是"统一入口：任何触发源只调这一个方法"——它是**所有**主动
提案的共同底：直达车道（hub 的 speak/advise）、评估器事件（`mappingExecutor.onEvent`）、
消息监控、承诺板扫描、到点提醒、早报/晚间 digest、承诺代催、wellness（周期关怀/SOS）……
无一例外。所以把发现层收口放在这一个方法里：

- **write**（登记本次发现）→ **composeBeforeOpen**（读合成：同 subject 未消费的他人发现 +
  实体命中上下文，读走即预留）→ **settle**（按提案最终去向结算：delivered=消费 /
  pending=维持预留 / dropped=释放）——三件事只在这一处发生一次；
- 上游出口只负责各自本职（直达车道派生 urgency、评估器做目标归属），**不再各自 compose**；
  于是"之后的信息都走共享层"是**结构性保证**，而不是靠约定给 N 个生产者逐个打补丁。
- 关键不变量：**发现指纹随提案持久化**（`ProactiveProposal.findingFingerprints`）——deferred
  挂起后真的投递出去（`flushDue` 重裁决 / 离线推送成功回调）才结算成消费；提案被丢弃则释放。

两个边界：
1. **无 `directText` 的提案**（走 hub 的 speak LLM 话术闭环）本次只登记发现 + 按重复状态
   调档，不读合成——发现留给那句真正带正文的开口合并带走。该跳转必须**转交
   `subject`/`needsUser`**（装配层 `speak` 桥），否则共同键在这里丢掉、三源汇聚失效。
2. **被去重丢弃的开口**（`verdict=merged`，用户没看到）**释放**发现（旧版靠 `SPOKEN_VERDICTS`
   只认 `delivered`，现在由 `settle(..., "dropped")` 直接释放）——否则被合并进这条丢掉的开口里的
   他人发现会人间蒸发。

### 6.3.1 两个开口出口合流同一道闸（2026-10-19 二期）

共享层的"开口"不止管道投递这一个出口。**顺嘴搭车（turn-aside）是第二条出口**：
hub 把 low/medium 意图挂起、经 `takeTurnAsideForTurn` 织进下一轮对话的 prompt，
它**不经管道投递**、天然绕开 `submitProposal`。二期把它也纳入同一道闸：

- hub 晚绑定 `setDiscovery()`（镜像既有 `setDirectLane`，因 hub 早于 discovery 构造）；
- `takeTurnAsideForTurn` 取货即开口：`write`(自己那句) → `composeBeforeOpen`（合并同主题
  他人发现进旁注）→ `settle(..., "delivered")`（进对话 prompt 即视为说出，读走的发现转消费）；
- `TurnAsideItem.subject` 透传（`submitIntent` 的 `intent.subject` 一路带下来）。

于是"全系统一道开口闸"从"今天恰好只有一个入口"升级为**被测试守住的不变量**：
管道出口与旁注出口都走 `composeBeforeOpen` + `settle`，同一发现在任一时点只被一个出口带走。

### 6.3.2 唯一入口 + 类型约束（2026-10-19 收口加固）

二期把"两个出口合流"做成**被测试守住的**不变量——但测试只能事后报警，挡不住新代码绕过。
加固把它抬到**类型层**：把"开口"收成一个动作，让"绕过开口闸"根本编译不过。

- **唯一入口**：`DiscoveryLayer.openMouth(input)` 一次完成 登记本次发现 → 读合成
  （读走即预留）→ 返回句柄。管道出口（`submitProposal`）与旁注出口
  （`takeTurnAsideForTurn`）都只调它，不再各自拼 `write + composeBeforeOpen`。
- **branded 正文**：`openMouth` 返回的 `body` 是 `OpenedBody = string & { readonly [OPENED_BODY]: true }`
  （`OPENED_BODY` 为模块私有 `unique symbol`）。**投递出口** `ProactiveDeliveryService.deliver`
  的 `text` 参数**只接受** `OpenedBody`。
- **效果**：任何代码想把主动内容发给用户，只能先拿到 `openMouth` 产出的 `OpenedBody`；
  拿一句裸 `string` 去 `deliver` 会得到
  `TS2345: Argument of type 'string' is not assignable to parameter of type 'OpenedBody'`。
  第三个出口若想绕过开口闸，**在编译期就被挡下**，不再依赖"今天恰好只有两个出口"。
- **结算耦合**：句柄同时是唯一的结算通道（`handle.settle(delivered|pending|dropped)`），
  说不出 / 丢弃都要经它归位——"读走却不归位"同样无处可写。

边界（诚实标注）：`OpenedBody` 的名义类型只能由 `openMouth` 产出，但 `as` 断言无法被
TS 完全封死——管道 `dispatch` 作为**唯一被授权**的投递点，保留一处显式
`p.directText as OpenedBody`（无发现层 / 单测回退用），是当前方案的已知边界：
它把"绕过"从"随手可写"抬高到"必须写一处刺眼的断言"。

### 6.4 三期落地

| 期 | 内容 | 落点 |
|---|---|---|
| A | 目标三源汇聚到 `subject=goalId` | GoalRunner / GoalNightly / 规则桥 emitProposal |
| B | 扫描源迁入同一条总线 | sensor_bridge → `discovery.write` |
| C | 收口：删降档 → 通用 `composeBeforeOpen`；其余读点（活跃目标行 / 在办事项视图）统一走共享层 | 收口下沉到 `ProactivePipeline.submitProposal`（所有触发源的共同底）+ `create-app-services.ts` 装配层 |
| 二期 | ① 消费拆三态（reserve/commit/release，deferred 不再算消费）；② 第二条出口（顺嘴搭车）并入同一道闸；③ `subject` 显式化（生产者可选提供，推断只兜底） | `source-store.ts`（预留台账）· `discovery-layer.ts`（compose 预留 + `settle`）· `pipeline-types.ts`（`findingFingerprints`）· `proactive-pipeline.ts`（按去向结算）· `proactivity-hub.ts`（`setDiscovery` + `takeTurnAsideForTurn`）· `turn-aside-queue.ts`（`subject` 透传） |
| 收口加固 | 唯一开口入口 `openMouth()` + branded `OpenedBody`：投递出口只接受已过闸的正文，"绕过开口闸"在编译期被挡下 | `discovery-layer.ts`（`openMouth` / `OpenedBody`）· `delivery-service.ts`（`deliver(text: OpenedBody)`）· `proactive-pipeline.ts`（走 `openMouth`；`dispatch` 为唯一授权断言点）· `proactivity-hub.ts`（旁注出口走 `openMouth`） |

C 期删除的 `gateGoalOpening` 是**旧补丁**，其"开口时间戳 + 重复降档"语义已被
`composeBeforeOpen`（未消费发现 + 目标状态推导）完全吸收，行为等价且**读得到内容**。

### 6.5 前后对比（可复现）

`server/scripts/compare-shared-discovery.ts` 用同一份输入跑**旧实现（忠实复刻各层不共享发现源）**
与**新实现（共享层）**，两条场景：

| 场景 | 旧 | 新 |
|---|---|---|
| A「三源撞车」（同一件事被三层同时发现，均 delivered） | **3 条**消息（三层各说各的） | **1 条**（一条说完全部，附「另：…」） |
| B「抑制后」（两条被频控挡下，一条送达） | 信息覆盖 **1/3**（被挡下的两条无人转述） | 信息覆盖 **3/3**（被挡下的两条被下一个出口说出） |

两场景信息覆盖度**均不下降**（A 3/3→3/3、B 1/3→3/3），而消息条数从 3 降到 1（A）、
覆盖从 1/3 升到 3/3（B）。对比报告：`shared-discovery-before-after.html`。

---

## 附：新增/改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/src/proactivity/goal-runner.ts` | **新增** | Goal 后台自主循环引擎（tick 5min，复用 GoalPlanner.advance） |
| `server/src/proactivity/goal-signal-bridge.ts` | **新增** | 感知层 ↔ Goal 层双向桥 |
| `server/src/proactivity/goal-templates.ts` | **新增（阶段三）** | 目标模板库，替换 buildBoardRules |
| `server/src/proactivity/mapping-executor.ts` | 改 | `RuleServices` 增加 `activeGoals` provider |
| `server/src/proactivity/mapping-rules.ts` | 改 | 规则 ev 读活跃目标，产出带目标上下文的文案 |
| `server/src/bootstrap/create-app-services.ts` | 改 | 装配 GoalRunner + bridge；接预算闸 |
| `server/src/tools/capability-modules/goal-planning/` | 改（可选） | 增加 `goal.runner.status` 诊断工具 |
| `test/goal-runner.test.ts` | **新增** | 后台推进 / 预算闸 / 外部步骤转确认 三组回归 |

**共享发现层（§六）追加清单**：

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/src/proactivity/discovery-layer.ts` | **新增** | 共享发现层核心：`write`/`composeBeforeOpen`/`noteSpoken`/`previewOpen` + 主体词推断 |
| `server/src/proactivity/source-store.ts` | 改 | `SignalStream` 加 `"finding"`；finding 台账 API（noteFinding/findingsFor/findingsByEntity/consumeFindings/…） |
| `server/src/proactivity/proactive-pipeline.ts` | 改 | **唯一收口**：`submitProposal` 内做 write/composeBeforeOpen/noteSpoken；`discovery` 可注入（未注入=原行为） |
| `server/src/proactivity/pipeline-types.ts`·`proactivity-types.ts`·`proactivity-hub.ts` | 改 | `subject`/`needsUser` 下传至 proposal |
| `server/src/proactivity/goal-unified-view.ts` | 改 | 在办事项视图接共享层读点 `pendingFindingsOf` |
| `server/src/bootstrap/create-app-services.ts` | 改 | 管道注入 `discovery`；directLane/onEvent 只留本职（urgency/归属），删重复 compose + `gateGoalOpening` 旧补丁 |
| `server/test/shared-discovery.test.ts` | **新增** | 9 组回归：幂等/共同键/重复降档/实体联系/时效/主体词推断/旁路生产者走共享层 + 消费三态/管道按去向结算 |
| `server/scripts/compare-shared-discovery.ts` | **新增** | 前后对比脚本（旧路径忠实复刻 → 报告） |

**共享发现层二期追加清单（2026-10-19）**：

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/src/proactivity/source-store.ts` | 改 | 预留台账：`reservedFindings` 映射 + `reserveFindings`/`commitFindings`/`releaseFindings`/`isFindingReserved`/`isFindingAvailable`；`findingStats()` 增 `reserved` |
| `server/src/proactivity/discovery-layer.ts` | 改 | `composeBeforeOpen` 读走即**预留**；新增 `settle(fps, disposition)`（delivered=commit / pending=维持 / dropped=release）；旧 `noteSpoken` 语义改为"预留→结算" |
| `server/src/proactivity/pipeline-types.ts` | 改 | `ProactiveProposal.findingFingerprints?`（读走的 finding 随提案持久化，供按去向结算） |
| `server/src/proactivity/proactive-pipeline.ts` | 改 | `submitProposal` 带 fingerprints；`decide` 依最终去向 `settle`；merged 快路径释放；离线推送成功回调 commit |
| `server/src/proactivity/proactivity-hub.ts` | 改 | `discovery?` 依赖 + `setDiscovery`（晚绑定）；`takeTurnAsideForTurn` 重写为"取货即开口"（write→compose→settle） |
| `server/src/proactivity/turn-aside-queue.ts` | 改 | `TurnAsideItem.subject?` 透传（共同键一路带下来） |
| `server/src/proactivity/triggers/location-trigger.ts` | 改 | 到达意图显式给 `subject=地点名`（修正推断在长句里挑出的无区分度词） |
| `server/src/bootstrap/create-app-services.ts` | 改 | `proactivityHub.setDiscovery(discovery)`；`speak` 桥转交 `subject`/`needsUser` |
| `server/test/proactivity-hub.test.ts` | 改 | 新增"顺嘴搭车取货也走同一开口闸"回归（第二条出口合并他人发现并结算消费） |

**验收指标**：
- 阶段一：无对话状态下，24h 内至少一个活跃 plan 被推进 ≥1 步
- 阶段二：出现"感知信号 + 目标上下文"复合文案的主动消息
- 阶段三：新增一类主动场景 = 加一条模板，**零代码改动**
- 共享层：多源发现同一件事时**合并成一条**开口；被静音的开口信息**不蒸发**（由下一个出口带出）
- 共享层二期：挂起（deferred）的开口**不消费**发现，丢弃则**释放回总线**；管道与旁注**两个出口**
  同一发现在任一时点只被一个出口带走（由 `shared-discovery` / `proactivity-hub` 回归守住）
