# Muse 主动发消息能力 vs Private-Agent 主动性设计 —— 差异分析与「为什么不主动开口」根因报告

> 结论先行：**我们的主动性不是"没做"，而是被"等用户停下来才开口"的仲裁策略 + 在线依赖卡死在了投递前一步。**
> 生产数据实证：最近 157 次管道裁决里 **100 次 deferred（其中 97 次是 `offline_wait_reconnect`）**，0 次因为"话题/内容不值得说"被拒。
> 也就是说，检测一直在跑、事件一直在产出，但消息**从来没走到用户面前**。

---

## 一、Muse（Meta 个人 AI 智能体）的主动发消息机制

根据公开资料（Meta Connect 2026 发布，Muse Spark 1.3 驱动），Muse 的主动性由以下几个要点构成：

| 维度 | Muse 的做法 |
|---|---|
| **触发模型** | 「Goal（长期目标）」为一等公民。用户给出宽泛目标，Muse 在后台持续推进；不在前台等 prompt。五大板块里 **Goals / Ideas / Feed** 三个都是"主动推送位"。 |
| **信息检测** | 主动**读取并联网**：扫描收件箱、日历、健康、购物、社交 App；跨源汇聚到自己的数据库。可代读邮件、比价、谈判账单。 |
| **后台运行** | **App 关闭后仍在跑**（Secure VM 常驻云端），"只在需要决策时通知用户"。 |
| **通知哲学** | **后台干活、需要拍板才找你**。绝大多数动作静默执行；只有"敏感动作（购买/发邮件）"才触发审批门。通知是**动作的结果/待批**，不是"聊天问候"。 |
| **安全边界** | 独立 Secure VM + Sentinel 安全代理：联网动作先过 Sentinel，敏感动作必须用户批准。 |
| **交互载体** | iOS/Android/Web(muse.ai)/WhatsApp + 硬件（Ray-Ban 眼镜、Muse Charm 挂件）。 |

**Muse 主动性的本质**：它把"主动性"定义为 **agentic execution（把事办完）+ 决策点才打扰**，而不是"陪你聊天式地主动找话"。它的推送绝大部分是 **must 层的动作结果/待批**，几乎没有"我猜你此刻想聊点什么"的社交型主动。

---

## 二、我们的设计：一套更"细腻"但也更"犹豫"的架构

我们的主动性是**五层架构 + 双通道**，设计完成度其实**高于** Muse 的公开描述：

```
L1 传感（SensorKernel）      screen / schedule / clipboard / file / presence / message 6 路常驻轮询
        │  每 5s 调度，指纹去重，落盘水位
        ▼
   世界状态板（WorldBoard）  obligations / current / session / background 四层"现在"
        │
L2 评估（MappingExecutor）   9 条声明式规则，零 LLM，每 60s tick：
        │                    away_return / meeting_soon / work_marathon / unread_burst /
        │                    digest_beat / goal_ready / sleep_boundary / commitment_chain / morning_brief
        ▼
L3 仲裁（ArbiterV2）         打断成本(0-10) × 紧迫度矩阵；**"等用户停下来才开口"(pause 语义)**
        │                    deliver_now / wait_for_pause / log
        ▼
    统一管道（ProactivePipeline）去重 → 静默时段 → 分层预算 → 投递(在线 WS fan-out / 离线挂起)
        │
L4 目标板（GoalBoard）+ L5 直达车道 / ProactiveCaller（真实来电汇报）

另一条并行：ProactivityHub 快路径（对话规则判 followup / 兴趣热议 / 各类业务 submitIntent）
          → 直达车道 → ArbiterV2 → 同一管道
```

**护栏三层**（这是设计里最"讲究"的地方）：
1. `FrequencyGovernor` —— 频率（每日预算 15 + 分 kind 冷却 + 静默时段 23-7）
2. `SuppressionStore` —— 用户明确拒绝
3. `TemporalAdmissionGate` —— 话题时效（"这件事现在还该不该提"）

**设计者意图很明确**：宁可少说、不可打扰；"错过时机的关心没有价值，但错误的打扰代价更大"。

---

## 三、核心差异对照

| 维度 | Muse | Private-Agent | 谁更激进 |
|---|---|---|---|
| **主动性的定义** | 后台把事办完，决策点才找你 | 后台检测 + 择机"开口聊天" | Muse 更偏 **agentic**，我们更偏 **social** |
| **触发权归属** | 目标驱动，agent 自己推进 | 传感器/规则驱动，**仲裁器最终否决** | Muse 的执行几乎必达；我们的执行**随时可被挂起** |
| **在线依赖** | 云端常驻，**App 关着也发** | **必须 WS 在线才 fan-out**，离线一律挂起 | ★ **决定性差异** |
| **静默策略** | 只在需要决策时通知（天然低频） | 额外叠了 23-7 静默 + pause 择时 + burst 熔断 | 我们**多重叠加**，过度保守 |
| **投递判定** | 动作完成即结果 | "用户停下来的那一刻"才放行 | 我们**把投递和一个很难满足的条件绑定** |
| **LLM 参与** | Spark 模型做规划/执行主体 | **决策层零 LLM**（刻意设计，防烧钱） | 各有取舍；我们更省 token |

**一句话概括差异**：
> Muse 是「**做完事，需要你拍板时敲门**」；我们是「**观察到事，等你安静下来才小声说**」。
> 前者天然会发；后者在**没有"安静时刻"或"设备不在线"时，永远发不出来**。

---

## 四、根因：为什么"实际对话中不会主动发起"

### 根因 1（最致命）：投递强依赖 WebSocket 在线，离线即挂起

`ProactiveDeliveryService.deliver()` 唯一的投递路径是 `trySend(actorId, json)`；**发送失败只返回 `{ok:false, reason:"no_online_device"}`**，不落任何离线信箱。

管道 `decide()` 收到失败后改判 `deferred / offline_wait_reconnect`，然后每 30s 重仲裁一次，直到设备重连或 8h 保质期过期。

**生产实证**（`data/proactivity/proposals.json`，157 条 decisions）：

```
deferred  : 100   ← 全部是 offline_wait_reconnect (97) / in_conversation_defer_90s (2) / quiet_hours (1)
delivered :  31
expired   :  20   ← 挂起 8h 后作废
merged    :   3
throttled :   3
```

而 `events.ndjson` 里的事件**绝大部分 action = `wait_for_pause`（26/66）或最终 `verdict=None`**——事件产出了，但**卡在仲裁/投递环节**。

对比 `Muse`：它有 Secure VM 云端常驻 + 移动端推送，**用户不在线照样送达**。我们这边桌面端一旦没开着（或只开着但 WS 未连该 actor），消息 100% 死在 `offline_wait_reconnect`。

### 根因 2：`wait_for_pause` 语义让投递依赖一个"很难同时满足"的状态跃迁

`ArbiterV2.detectPauseFor()` 只在**上下文发生跃迁**时才放行挂起项：
- 对话结束 / 会议散场 / 专注降档 / 静默时段结束 / idle→active / 成本从 >4.5 跌破 ≤4.5
- 或"挂起超过 45min 且当前成本 ≤4.5 且不在对话中"这条兜底稳态规则

而 pause 放行还附加了 `cost <= 4.5` 的前置条件。**如果用户一直在写代码/听歌（成本 3+2=5 或叠加 nextEvent 后 >4.5），或设备一直 offline（成本=10），pause 永远不触发**，挂起项只能等到 8h TTL 过期。

`events.ndjson` 实证：`away_return`（用户离开 9 小时回归，最典型的"开口时机"）判定结果是 **`wait_for_pause`**，然后 **`None`**——连这么强的信号都被挂起后无声作废。

### 根因 3：多重"沉默闸"叠加，主动性的净出口被压到接近 0

一个主动意图要真正说出口，需要**全部**满足：
1. 传感器采集到 delta（✓ 一直在跑：signals.jsonl 里 screen 918 / presence 735 / clipboard 457 条）
2. 映射规则的**去重键**没命中过（`mapping-state.json` 里 `announced` / `lastBriefDay` / `burst:bucket` 一旦置位当天不再触发）
3. 不被 `SuppressionStore` 拦
4. 不被 `TemporalAdmissionGate` 拦
5. `FrequencyGovernor.canTrigger` 放行（预算 + 分 kind 冷却 + 静默时段）
6. `ArbiterV2` 判 `deliver_now`（或能等到 pause）
7. **投递时 WS 在线**（根因 1）

任一步失败 → 静默。**7 道闸串联，整体通过率 = 各步通过率之积**，这是"设计上很稳健、体验上几乎不说话"的数学必然。

### 根因 4：真正会主动说话的通道——`morning_brief` 等——需要"用户变为 active"

`morning_brief` 触发条件是 `presence === "active" && hour ∈ [7,10)`，兜底是 8:30。
`away_return` 要求"离开 ≥4h 且非跨夜"。
`work_marathon` 要求"连续 coding/terminal ≥3h 且屏幕样本不过期（20min 内）"。

而 `PresenceService.getPresence` 的 active 判定是"**WS 在线** 且 **10min 内有活跃**"。**桌面端 app 没开 → deviceCount=0 → 永远 offline → 所有依赖 presence 的规则全部哑火。** 这就是为什么 `mapping-service.json` 里这些规则的状态基本都是空 `announced` —— 它们**根本没被触发过**。

---

## 五、Muse 为什么会"主动"而我们不会：一句话对照

| | Muse | 我们 |
|---|---|---|
| 用户不在线 | Secure VM 继续干活，推送兜底送达 | **挂起，8h 后作废** |
| 用户很忙（成本高） | 后台静默把事办完，办完再通知 | **不办也不说，等 pause，等到过期** |
| 消息的价值 | 由"事情办没办成"定义 | 由"此刻打不打扰"定义 → **被不停否决** |
| 决策者 | Spark（模型，有目标感） | 确定性规则 + 仲裁器（**无目标，只避害**） |

**核心症结**：我们把主动性做成了一个**纯防御系统**（层层防打扰），而 Muse 把它做成了一个**有目标的进攻系统**（推进目标、完成即触达）。防御系统在缺乏"合适时机"的输入时，**理性地选择了永远不说话**。

---

## 六、可落地的修复方向（按优先级）

### P0：让消息在离线/高成本时仍能落地（对齐 Muse 的"必达"）
- 投递失败时**落离线信箱**（`MessageHub` / `InboxService` 已有基建），设备重连即补投，而不是挂起 8h 作废。
- 对 `must` 层 + `importance>=high`：接入移动端系统推送（`MobilePushService` 已存在，但当前只在"两端离线"时用，且需用户配好 JPUSH/BARK）。
- 现状 `offline_wait_reconnect: 97` → 目标：这部分应转为"落信箱 + 重连补投"。

### P0：修正 `wait_for_pause` 的"饿死"问题
- 当前兜底规则是"挂起 >45min 且 cost ≤4.5"。建议 **把 TTL 缩短到 1-2h 并保证过期前至少放行一次**（"最坏也要说出来，而不是静默作废"）。
- 或者：`alert` 档挂起项在 TTL 到期时**降级为一条轻量通知**，而非直接 `expire`（因为 26 条 `wait_for_pause` 最终都消失了）。

### P1：给系统一个"目标感"（而不是只会避害）
- 强化 `GoalBoard` / `GoalPlanner` 的权重——把"主动推进用户目标"作为一等触发源，而不是只做"会前准备包"。
- 现有 `goal_ready` 规则只有在 goal 达到 `ready` 状态时才产出事件，且是 `social` 层；建议提升为独立预算池，不受社交频控挤压。

### P1：降低串联闸门的数量
- `mapping-state.json` 的"当天一次"去重键（`digest_beat` / `sleep_boundary`）与 `FrequencyGovernor` 的分 kind 冷却**语义重叠**，二者留一即可。
- 静默时段对 `importance=medium` 不应像 high 一样严格（当前 medium 也会被 30min 冷却 + 静默叠加）。

### P2：可观测性
- 现有 `whySilent` 诊断接口很好，但**只查单个 actor 的最近 5 条事件**。建议增加"过去 24h 全局漏斗计数"（产出→仲裁→投递→送达各阶段），让"为什么不说话"一眼可见。

---

## 七、附：关键代码位置索引

| 环节 | 文件 |
|---|---|
| 装配总入口 | `server/src/bootstrap/create-app-services.ts`（L4258 起 ProactivityHub 段；L4969 起五层架构段） |
| 传感内核 | `server/src/proactivity/sensors/kernel.ts` |
| 世界状态板桥接 | `server/src/proactivity/mapping-rules.ts` / `world-board.ts` |
| 映射规则（9 条场景） | `server/src/proactivity/mapping-rules.ts` |
| 仲裁器（pause 语义） | `server/src/proactivity/arbiter-v2.ts`（`decideAction` / `detectPauseFor`） |
| 统一管道 | `server/src/proactivity/proactive-pipeline.ts` |
| 管道静态仲裁 | `server/src/proactivity/arbiter.ts`（`offline_wait_reconnect` 出处） |
| 投递出口 | `server/src/proactivity/delivery-service.ts`（唯一 `trySend` 路径） |
| 在场判定 | `server/src/proactivity/presence-service.ts` |
| 频控 | `server/src/proactivity/frequency-governor.ts` |
| 静默时段 | `server/src/proactivity/quiet-hours.ts` |

**关键运行时数据（诊断用）**：
- `server/data/proactivity/proposals.json` —— 157 条裁决，deferred=100（offline=97）
- `server/data/proactivity/events.ndjson` —— 66 条事件，wait_for_pause=26
- `server/data/proactivity/signals.jsonl` —— 传感器产出（screen 918 / presence 735），**证明检测一直在跑**
- `server/data/proactivity/world-board.json` —— 当前板状态（presence=offline）
- `server/data/proactivity/known-actors.json` —— 唯一真实用户 `2378709729@qq.com`
