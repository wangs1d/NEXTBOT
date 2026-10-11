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

**验收指标**：
- 阶段一：无对话状态下，24h 内至少一个活跃 plan 被推进 ≥1 步
- 阶段二：出现"感知信号 + 目标上下文"复合文案的主动消息
- 阶段三：新增一类主动场景 = 加一条模板，**零代码改动**
