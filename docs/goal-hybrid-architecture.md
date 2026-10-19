# Goal 混合架构 · 最终方案 v2.0

> 目标：让私人管家具备"持续办一件事直到达成"的能力，同时**不增加每轮 token 开销**。
> 前篇：`docs/proactivity-goal-driven-architecture.md`（阶段一 GoalRunner、阶段二信号桥已落地）。
> 本篇合流两条线：**goal 的长期主键**（跨会话到达成）+ **执行的 TaskPlan**（单次多步、执行中生长）。
> 二者不是两套系统，是同一族对象的两个时间尺度。

---

## 0. 决策摘要

| # | 决策 | 理由（一句话） |
|---|---|---|
| **D1** | **三层尺度**：轮次 / TaskPlan / Goal | 现在只有两极——`goal.plan.*` 管跨月目标、`plan-execute` 管一次性任务，**中间那层（单次多步、跨会话续跑）无人管** |
| **D2** | **一套原语**：plan-as-artifact | 拆解是 agent 自己的写操作（工具），不是路由分支；三个尺度共用 steps / 状态 / 事件 / 验收 |
| **D3** | **触发靠压力软提示**，不靠意图闸门 | 闸门在信息最少时猜复杂度；真实信号（工具调了几次、跨几域、有没有失败）只在执行中出现 |
| **D4** | **执行四档**：L0 轮次 / L1 TaskPlan / L2 Goal 步进 / L3 Goal 日批 | 省钱靠把 LLM 决策收进批处理点、执行路径留给确定性闸门 |
| **D5** | **验收两路**：确定性 0 token 顺手判，语义只在终审一次 | 执行成功 ≠ 目标达成；但每步都 LLM 验收 = 成本乘以步数 |
| **D6** | **执行失败必须开口**，只有成本类阻塞可静默 | 悄悄失败比高失败率更致命（Muse 实证） |

判断一件事落在哪一层，只有一条标准：**它有没有"达成"这个概念、以及这个达成要跨多久。**

---

## 1. 为什么必须是三层

现状是**两个极端 + 一个大洞**：

| 入口 | 覆盖什么 | 问题 |
|---|---|---|
| `goal.plan.*`（`proactivity/goal-planner.ts`） | 跨月长期目标（"三个月内搬到东站"） | 要模型主动召回；带每日预算和主动推进，语义重 |
| `plan-execute-loop.ts` | 一次性任务 | **默认关**（`AGENT_PLAN_EXECUTE_LOOP`），双请求贵，执行时计划只是一段提示词 |
| `agent-task-orchestrator` | 后台 RPA 任务 | `plannedSubtasks`（`agent-task-types.ts:226`）**全仓零写入零消费**，`subtasks` 恒空，`:672` 的「planning 且 subtasks>0 → executing」永不因拆解触发，实际靠正则「任务完成」推进 |

**落在中间地带的场景最多**："订下周去三亚的行程，酒店和接机一起排了"——不是跨月目标，也不是一次工具调用能办完，更不是一次性问答。这类任务现在**没有任何 plan 载体**。

**而管道其实已经通了**：

- `chat-user-message.ts:1372` `onPlanReady` 已经在发 `plan_step` 事件（`:1381` / `:1399`）
- `turn_state.dart:302` 已经接住 `plan_step`
- 但 `onPlanReady` 只由默认关闭的 `plan-execute` 触发 → **主路径上 `plan_step` 永远是空序列**

所以这不是"加一套系统"，是**给已经修好的管道接上水源**。

---

## 2. 三层定义与边界

| | **轮次** | **TaskPlan** | **Goal** |
|---|---|---|---|
| 时间尺度 | 一轮 | 会话内，可跨轮续跑 | 跨会话，跨天到跨月 |
| 存储 | 不存 | `data/session-plans/<sessionId>.json` | `data/goals.json` |
| 生命周期 | 回复结束即止 | 完成/放弃即归档（保留 7 天） | 到达成 / 作废 / 衰减 |
| 谁写入 | — | 模型调工具（压力提示促成） | 模型调工具 + 显式确认 |
| 每轮注入 | 无 | 有 plan 才注入完整步骤（≤400 tok） | 摘要 3 行（≤120 tok） |
| 验收 | — | 仅确定性（0 token） | 确定性 + 语义终审一次 |
| 失败处置 | 本轮内重试 | 步骤失败 → 停下问（不静默） | failStreak 退避 + 开口 |

### 2.1 升格与降格

```
        单次多步任务（TaskPlan）
                │
                │ 用户表达"以后都这样 / 下周还要再来一次"
                ▼  升格（复用 steps + 成功路径，补 successCriteria）
        Goal（跨会话）
                │
                │ 派发某一步时
                ▼  降格（该步生成本地 mini-plan，scope=step）
        TaskPlan（嵌套）
```

升格不是自动的：命中"以后/每次/下周还要"这类信号时，**问一句**"要不要立个目标盯着"，用户点头才升。降格自动发生，因为每一步本来就该有步骤感。

### 2.2 为什么 TaskPlan 不进 goals.json

- 短任务会冲爆长期台账（`persist()` 只保留 7 天，仍会被日常琐事占满）
- `GoalBoard.list(actorId)` 是每轮注入的数据源，混进短任务会让注入失去意义
- 语义不同：Goal 有 `budget/nextEligibleAt/salience` 这些**后台自驱**字段，TaskPlan 不需要

**结构复用、存储分离**——这是关键取舍。

---

## 3. Plan 原语（一套，四个工具）

| 工具 | 作用 | 参数要点 |
|---|---|---|
| `plan.write` | 写 2-8 步（可覆盖） | `goal`（一句话）、`steps[]`、`scope`（session/default）、`note` |
| `plan.set_status` | 单步置 running / done / failed / skipped | `stepId`、`status`、`note` |
| `plan.replan` | 只重排尾部 todo，保留 done/failed 存档 | `steps[]`、`reason` |
| `plan.read` | 读当前 plan（跨轮续跑、被问"进行到哪了"） | 无 |

**状态机**（与 Goal 共用同一套语义）：

```
pending → running → done
   │         │
   │         ├→ failed ──┐
   │         └→ awaiting_confirm（外部动作，等人点头）
   └→ skipped ◄──────────┘
```

**事件**：写入即发 `plan_step`（复用 `chat-user-message.ts:1372` 已有管道），用户当场看见 pending→running→done，不需要新增 UI 协议。

**与 `goal.plan.*` 的关系**：P0 新增 `plan.*`，两者并存但描述里写清边界（跨天+有达成判据 → goal.plan.create；本轮/本会话多步 → plan.write）。P2 把 `goal.plan.*` 收敛为 `plan.*({scope:"goal"})` 的别名，减少模型选择困难。

---

## 4. 触发：执行压力软提示（不是闸门）

**判据（确定性，零 LLM）**，三个条件同时成立：

1. 本会话累计工具调用 ≥3 次
2. 最近两轮内仍有工具调用（防止把十轮前的一次查询算进来）
3. 当前 session 无 TaskPlan

**动作**：在**这一波工具结果消息的末尾**追加一条系统提示：

> 若还需继续多步，先用 `plan.write` 记下步骤。

**三条纪律**：

- 只追加提示，**不改正文、不换稿**——守住「已流式即定稿」
- 闲聊轮永远凑不到 3 次工具调用 → **零触发、零 token**
- `multi_step_task` 标签**不作为增强条件**，只在审计里记录（用标签判复杂度，正是"闸门治标"的老路）

为什么这个天然按需：判断权交给最了解上下文的那一方（执行模型），代码只提供**载体和时机**。

---

## 5. 执行四档与成本账

| 档 | 载体 | 触发 | 单次成本 | 回答什么问题 | 闸门 |
|---|---|---|---|---|---|
| **L0 轮次** | 无 | 闲聊 / 单点查询 | 一次对话 | 当下要什么 | 无 |
| **L1 TaskPlan** | session plan | 压力软提示 | 工具调用本身（几十 token） | 这轮要怎么走 | 无（凑不到压力就不存在） |
| **L2 Goal 步进** | GoalRecord | GoalRunner / TaskHub 回调 | 一个后台任务 | 下一步做什么、能不能做 | 全局日预算 + 目标级预算 + failStreak 退避 + quiet-hours |
| **L3 Goal 日批** | GoalRecord | 夜间任务 | **1 次 flash 处理全部 active goal** | 还作不作数、要不要重排、达成没有 | salience 取前 N |

**L3 是现在完全缺失的一环，也是省钱的真正来源。** 当前的病不是"推得太勤"，而是**用执行档干反思档的活**——"这个目标还作不作数""是不是算办成了"一天做一次就够，却在每 5min tick 里反复花大钱。

### 5.1 每轮固定开销

| 来源 | 成本 |
|---|---|
| Goal 摘要（仅 active 前 3） | ≈120 tok |
| TaskPlan 完整步骤（有才注入） | ≤400 tok（通常几轮内归档） |
| 两者皆空（绝大多数闲聊） | **0** |

---

## 6. 验收

| 对象 | 方式 | 成本 | 时机 |
|---|---|---|---|
| TaskPlan | 只做确定性（产物非空 / 链接可访问 / 日程已建） | **0 token** | 步骤完成时顺手判 |
| Goal | 确定性 + 语义终审 | 终审 1 次 flash | **只在 finishPlan 前**，一次判全量 |

```
全部步骤终结
    ├─ 确定性通过 且 无 successCriteria → met → 完成/readyTray
    ├─ 有 successCriteria → 语义验收一次
    │     ├─ met     → 完成（"办成了"）
    │     ├─ partial → 停住，交 L3 重排（"办到一半，差这个"）
    │     └─ failed  → failStreak+1（"没办成，原因：…"）
    └─ 确定性不过 → 不许宣布完成（防假完成）
```

**绝不每步 LLM 验收**——那是把 L2 成本乘以步数。

---

## 7. 预算、退避、失败开口

三层预算：全局（已有 `isDailyBudgetExceeded`）/ **目标级**（`budget.dailySteps` 跨天重置）/ 颗粒级（已有 `isLightStep` 轻车道）。

```
nextEligibleAt = now + backoff(attempts.failStreak)   // 0→10min, 1→2h, ≥2→冻结
```

**阻塞分两类，处置必须不同**：

| 类型 | 例子 | 处置 |
|---|---|---|
| 成本类 | 预算超限、后台通道未就绪 | 静默，额度恢复后自愈 |
| **执行类** | 步骤失败、依赖断、凭证失效、连续两次同一原因 | **必须开口**，带具体原因 |

判据：**用户能不能自己修。能 → 说；不能（只是等额度）→ 不说。**

另两条：同一 Goal **串行**执行；quiet-hours 不推。

---

## 8. 沉淀：过程策略记忆

| 类型 | 沉淀什么 | 用途 |
|---|---|---|
| **成功流程** | 达成过的 plan 存模板 | 同类目标**零 LLM 拆步**（省一次 pro 调用，更稳） |
| **失败规避** | 反复失败的步骤模式（"直接比价"总缺日期） | 写回模板成"先确认日期再比价" |
| **操作偏好** | 结果形态偏好（Excel / 一页纸 / 先看结论） | 影响产出格式，不再反复问 |

度量：`auditStage: "goal_plan_stage"`（已有）聚合成 `/api/proactivity/goals/cost`——按类型看 token 与达成率。**没有这个闭环，能力不会自己变强，只是跑得更多。**

---

## 9. 实施清单

> **进度（2026-10-19）**：P0-A / P0.5 / P0-B / P1 / P2 全部实现，`tsc --noEmit` 零错误，83 个相关测试全绿。
> 前后效果对比见 `docs/goal-arch-comparison.md`（由 `server/scripts/compare-goal-arch.ts` 实跑生成）。
>
> 落地时的三处工程取舍（与本文原计划不同，均已实测）：
> 1. **语义验收不进 `finishPlan`**（那是同步路径）。终审只做确定性；语义验收器接口留在 `goal-verifier.ts`，由 L3 内省异步调用，不阻塞「办成了」的交付。
> 2. **承诺不迁表**。`CommitmentBoard` 的证据链/梯度提醒/升级退避/代催渠道搬进 `goals.json` 风险远大于收益 → 先做只读统一视图 `goal-unified-view.ts`，等真正重叠的语义显形再谈同表。
> 3. **`AgentPromptMemoryContext` 新字段必须进 `RENDERED_MEMORY_FIELDS`**，否则 `hasAnyPromptMemory` 会把「只有目标没别的记忆」的轮次判空、整块不渲染（承诺板老坑的第二种形态）。

### P0-A（半天）· Goal 进对话面

| 文件 | 改动 |
|---|---|
| `external-model/types.ts` | `AgentPromptMemoryContext` + `activeGoals?: string` |
| `agent/prompt-context-builder.ts` | 加 `activeGoalsProvider` + setter（照 `setInterestListProvider`） |
| `agent/prompt-assembler.ts`（动态层 :223） | 渲染【在办目标】，置易变块之后，**绝不进 stable 层** |
| `agent-core.ts` / bootstrap | 注入 provider（`goalBoard.list` + `goalPlanner.progressLine`） |
| `test/active-goals-injection.test.ts` | 契约测试 |

**验收**：① 新会话问"我那事怎么样了"能准确复述进度；② 块 ≤200 tok；③ 无 goal 时零注入；④ 块不在 stable 段。

> **实测补充（第二道「只填不渲染」的坑）**：新增字段必须同时加进 `prompt-assembler.ts` 的 `RENDERED_MEMORY_FIELDS`——`hasAnyPromptMemory` 按这个白名单判空，漏加的话「只有目标、没有其他记忆」的轮次会整块不渲染。契约测试已锁（`test/active-goals-injection.test.ts`）。

### P0-B（1-2 天）· TaskPlan 原语

| 文件 | 改动 |
|---|---|
| 新增 `agent/task-plan-store.ts` | session 级 plan 存储（`data/session-plans/`，重启可恢复，7 天归档） |
| 新增 `tools/capability-modules/task-plan/` | `plan.write / set_status / replan / read` 四工具 |
| `ws/handlers/chat-user-message.ts:1372` | 复用 `onPlanReady` 管道路径发 `plan_step`（不新增协议） |
| `external-model/openai-compatible-tool-loop.ts` | 压力检测 + 波末软提示（env 单开关，便于对照） |

**验收**：① 闲聊轮 **0 次 plan 工具调用、0 个 plan_step 事件、0 额外请求**；② 复杂轮 plan 被调用 ≥1 次，事件序列 pending→running→done 在前端可见；③ 多出的成本只有工具调用本身（几十 token）；④ 软提示不改正文（对照流式输出字节）。

### P1（约 1 周）· 调度与内省 ✅

- `GoalRunner`：tick 默认 5min→30min（显式配置仍可 ≥30s）、`nextEligibleAt` 退避、扩到全 kind（track/preexec 只做过期收尾）、**blocked 按成本/执行切开**
- 新增 `proactivity/goal-introspector.ts`：夜间批量（衰减 / 失效询问 / partial 重排建议），**零 LLM**
- 新增 `proactivity/goal-cost.ts` + `GET /api/proactivity/goals/cost`：按 kind 聚合目标/步骤/达成率 + goal stage token 占比
- 新增 `GET /api/proactivity/goals/introspect`：内省 finding 查询面
- `agent-task-orchestrator`：`subtasks` 改为读 TaskPlan（**不修 plannedSubtasks 解析**，直接让它成为唯一来源）
- ~~在办目标可见页~~ → 改由 `goal-unified-view.ts` 提供视图数据（前端迭代另排，不在本次范围）

**验收**：① goal 主动执行 token 占日总量 ≤15%；② 无对话 24h 内 ≥1 个 plan 推进 ≥1 步；③ 单用户单日 goal 派发 ≤12 次；④ 制造一次执行失败 → 24h 内收到带原因的告知。

### P2（重构）· 收敛与模板 ✅

- `plan.write({scope:"goal"})` 统一入口（`goal.plan.*` 保留为既有入口，两套并存、描述互指；彻底收敛成别名留给下一轮）
- `CommitmentBoard` → **不迁表**，改 `proactivity/goal-unified-view.ts` 只读聚合（承诺的证据链/升级策略留在 SQLite）
- `goal-templates.ts`：成功流程 / 失败规避 / 操作偏好三类，内置 5 类（出行/搬家/备考/装修/求职）；`createPlan` 不传 steps 即自动套用
- `PlanStep` 预留 `dependsOn?: string[]`（不实现调度）

**验收**：① 新增一类场景 = 加一条模板 + **0 代码**；② 同类目标第二次拆步不再调用 LLM。

---

## 10. 明确不做

| 不做 | 原因 |
|---|---|
| 重开 plan-execute 双请求 | 规划一次 + 执行一次要各带全量上下文；且执行时计划只是段提示词，会漂 |
| 复活每轮 LLM 进度评估 | `LoopOrchestrator` 已因此被删 |
| 用 `multi_step_task` 当分支开关 | 闸门在信息最少时猜复杂度；最多留作审计字段 |
| 修 `plannedSubtasks` 解析链 | 让 TaskPlan 成为 `subtasks` 唯一来源，比补一个零消费字段更省 |
| 每条消息都建 plan / goal | 压力信号不到就不存在；goal 还需一句显式确认 |
| 全量注入 | 摘要 3 行 + 命中展开 + 工具按需，细节永不全塞 |
| 每步都 LLM 验收 | 成本乘以步数 |
| **DAG 调度** | Muse 是 DAG，但生活事务撑不起调度器/环检测/局部重算 |
| 多 agent 辩论 | 同题多视角交叉验证，成本 1.5-2.5x，生活事务不需要 |
| goal 自动执行外部动作 | 下单/支付/代发/预约必须点头；`GOAL_PLAN_AUTO_EXTERNAL` 不得默认开 |
| 同一 goal 并发多步 | 对齐 Manus「子代理不通信、只经 controller 收敛」：串行 |
| 执行失败后静默等待 | 见 D6 |

**补充**：plan 处于 `awaiting_confirm` 时，外部动作类工具这一轮**不进工具面**——不是靠 prompt 写"不要下单"，而是让它压根不可见（对齐 Manus 的 state machine / logits masking）。

---

## 11. 业界依据

| | Muse（Meta） | Manus | Claude Code | Devin |
|---|---|---|---|---|
| 拆解是什么 | 持久任务状态（DAG 队列），跑在 Secure VM | 外置 `todo.md`（文件即状态） | `TodoWrite` 工具 | plan 对象，可 amend |
| 谁决定 | Agent 自己，Goal 为主引擎 | 模型自己写自己改 | 模型自主，prompt 只给软引导 | 生成后可协商 |
| 怎么改 | 决策点才回来找你 | 执行中随时重写，用户可编辑 | 每步更新状态 | 用户直接改步骤 |

**三条共性**：① 拆解是 agent 自己的写操作，不是路由分支；② plan 与执行同一循环、渐进细化；③ plan 可见可干预。

另两条工程结论：**上下文外置**（没有一家靠更大窗口）、**KV-cache 命中率是第一指标**（Grok 靠共享 cache 把 4 agent 压到 1.5-2.5x）。

**一条血泪教训**：Muse 承认最痛的不是失败率，是**悄悄失败**——监控停了、登录失效、出错没通知，三天后才发现。这是 D6 的由来。

---

## 12. 回滚

| 风险 | 回滚 |
|---|---|
| 注入块打断缓存 | 已在 dynamic 层，契约测试锁"不在 stable 段" |
| 压力提示误触发 | env 单开关关闭；提示只追加不改正文 |
| TaskPlan 状态腐烂 | 7 天自动归档；完成即收敛成结果卡 |
| 后台狂派任务烧 token | `GOAL_RUNNER_ENABLED=0` + 三层预算 |
| 注入后模型过度提目标 | 摘要限 3 条 + salience 阈值 + 频控（**不新增出口闸**） |
| 台账收敛（P2）破坏承诺链 | 前四期验证后再动；承诺卡口与「沉默≠同意」原样保留 |

---

## 13. 一句话总结

> **轮次是时间的主键，TaskPlan 是一次任务的主键，Goal 是意图的主键。**
> 拆解不是路由的分支，是 agent 在执行中自己写下的东西；
> 省钱不靠少调用，靠把判断留给最了解上下文的那一方、把 LLM 决策收进日批。
