# 主动性模块优化方案

> 前置判断：**当前最缺的不是触发源，而是出口。** 检测层一直在跑（`signals.jsonl` 数千条信号），
> 但主动消息在"仲裁挂起 + 离线作废"上集体蒸发。所以本方案按 **先通出口 → 再松闸门 → 后补目标感** 排序，
> 明确标注每步的**收益 / 风险 / 是否可回滚**。

---

## 一、先看堵在哪（一句话）

```
传感器（✓ 一直在跑）
   → 9 条规则（✓ 有产出：66 条事件）
   → 仲裁 ArbiterV2（✗ 26 条被判 wait_for_pause，最终无声作废）
   → 管道投递（✗ 100 条 deferred，其中 97 条 offline_wait_reconnect）
   → 用户（只送达 31 条，其中大头是 meeting_soon / digest_beat 这类"流程性"消息）
```

两条独立的泄漏口：
- **口 A：离线时 social 层没有兜底** —— `attemptOfflinePush()` 第一行就把非 must/critical 的提案 return 掉，既不落离线信箱也不推手机 → 挂 8h TTL 过期。
- **口 B：`wait_for_pause` 在"稳定高成本"下永不触发** —— 用户一直 coding/听歌（成本恒定 >4.5）就永远等不到"跃迁"，只靠 45min 兜底那条还有 `cost<=4.5` 的附加条件。

**这两条修的优先级高于一切**——不修，再多的新规则也只是把更多内容送进这两个泄漏口。

---

## 二、P0：打通出口（预计能救回 60%+ 的现有产出）

### P0-1　离线时 social 层落"离线信箱"，而不是挂起等死

**现状**（`proactive-pipeline.ts:243`）：
```ts
private attemptOfflinePush(p: ProactiveProposal): void {
  const push = this.deps.mobilePush;
  if (!push || (p.tier !== "must" && p.importance !== "critical") || !push.hasChannel(p.actorId)) return;
  ...
}
```
`inbox-service.ts` / `mobile-push-service.ts` 都**已经建好、客户端也能渲染**（`inbox_api.dart` + `ambient_feeds_controller.dart`），只是管道没接。

**改法**（分层兜底，不动现有 must/critical 路径）：
1. 给管道注入 `inbox: InboxService`（`create-app-services.ts` 里 `inboxService` 已存在，直接透传）。
2. 在 `attemptOfflinePush` 里加"social 层落信箱"分支：
   ```
   若 offline 且（must/critical 且 push 可用）→ 走手机推送（现状不变）
   否则（含 social 层）→ inboxService.send({ actorId, title, body, kind: `proactive:${p.kind}`, importance })
   ```
3. 落信箱后**标记 delivered**（channel 记为新的 `offline_inbox`），避免重连后重复直推。
4. 用户"活跃度降级"兜底：`importance=low/normal` 的 social 消息不必进信箱（避免收件箱被灌爆），只对 **medium 及以上** 落信箱；low 保留原挂起语义。

**收益**：97 条 `offline_wait_reconnect` 里，medium+ 的部分能被"下次打开 app 就看到"接住，而不是静默过期。
**风险**：低。收件箱是"拉取式"展示，不产生打扰；且已读状态服务端记账，多端不重复。
**可回滚**：`PROACTIVITY_OFFLINE_INBOX=0` 一键关。

### P0-2　`wait_for_pause` 的 TTL 到期"降级投递"而非静默作废

**现状**（`arbiter-v2.ts` `tick()`）：
```ts
for (let i = this.parked.length - 1; i >= 0; i--) {
  if (this.parked[i].expireAt <= now) this.parked.splice(i, 1);  // ← 直接删除，无任何输出
}
```
26 条 `wait_for_pause` 事件就是这样消失的。**"最坏也要说出来"应该优于"宁可不说"。**

**改法**：
- 挂起项到期时，**不再静默删除**，而是调用一个新的 `onExpire` 回调：
  - `alert` 档 → 走 P0-1 的离线信箱/推送兜底（"当时没找到合适时机，还是告诉你一声"）
  - `normal/low` 档 → 若当下 `cost<=4.5` 则立即投递，否则进收件箱的低优先级区
- 保留"降级为沉默日志"作为最终兜底（极低价值项仍可丢弃，但要**在 silence-log 留痕**，让 `whySilent` 能解释）。

**收益**：把"挂起到过期"的漏斗损耗从 100% 降到接近 0。
**风险**：中低。可能出现"迟到很久的提醒"——用 `expiresAt` 语义兜底：已过保质期的事件（如会前提醒）仍应作废，**只有无明确时效的场景才降级投递**。
**可回滚**：`PROACTIVITY_PARK_EXPIRE_DELIVER=0` 关。

### P0-3　修正 pause 检测的"稳定高成本死区"

**现状**：兜底条件是 `now - oldestParkedAt >= 45min && cost <= 4.5 && !inConversation`。用户稳定 coding（cost = 3 + receptivity 项，可能 >4.5）时三条都不满足 → 饿死。

**改法**（二选一，建议都做）：
- 把"稳定态放行"的成本阈值从 `4.5` 放宽到 `< 6`，但**加间隔保护**（同一挂起队列每 45min 至多放行 1 条，防止连发）。
- 或引入"用户空闲窗口"信号：`presence=active` 且**屏幕分类连续 10min 未变化且非 meeting/coding/terminal** → 视为自然停顿。
- 与 P0-2 配合：即便没等来 pause，TTL 到期也有兜底，不再有"完全消失"的路径。

**可回滚**：阈值走 env `PROACTIVITY_PARK_COST_CEIL`（默认 4.5）。

---

## 三、P1：松闸门（减少"串联否决"）

### P1-1　合并语义重叠的去重闸

`mapping-state.json` 里的"当天一次"键（`digest_beat` 的 `beatKey`、`sleep_boundary` 的 `dayKey`）与 `FrequencyGovernor` 的分 kind 冷却**在干同一件事**。两层串联 = 通过率相乘。

**改法**：规则层只负责"事件是否发生"，去重**统一交给频控**（单一事实源）。删除规则内的 `st.has(...)` 当日去重，或改为"只在频控已拦时记 st 用于诊断"。

**收益**：`digest_beat` 18 条、`sleep_boundary` 7 条不再被双重拦截。
**风险**：低。频控仍在，只是不再叠一层。

### P1-2　静默时段对 medium 不应等同 high

现状 `quiet-hours` 对 low 有 `awake` 豁免，但 medium 仍被完全静默 + 冷却叠加。建议：**用户在设备前（`presence=active`）时，medium 也享受静默豁免**（对齐"用户在电脑前就不算惊扰"的既有设计意图，`frequency-governor` 已有 `awake` 参数，只是没对 medium 生效）。

### P1-3　去重键的时效性——别让"当天一次"变成"当天绝缘"

部分规则的 `announced` 集合只在 runAt 变化时清理，若用户当天改了一次日程，后续同日程可能被旧键遮蔽。建议给所有 `announced` 键加**统一的天级 GC**（进入新日历日即清空），与 `DAILY_ONCE_KINDS` 的日历日语义一致。

---

## 四、P2：给它一个"目标感"（对齐 Muse 的核心优势）

前面都是"减少损耗"。但 Muse 真正强的地方是**它有个目标在推进**，而我们的仲裁器是纯避害的——**永远在问"现在打扰合适吗"，从不问"这件事值不值得办"**。

### P2-1　GoalBoard 从"配角"升为"一等触发源"

现状 `goal_ready` 规则只在 goal 到 `ready` 时产出一条 `social` 层事件，和"闲聊"抢同一个社交预算。建议：
- goal 相关提案走**独立预算池**（不占社交预算，对齐 must 层的做法）；
- 新增规则 `goal_progress`：长期目标（`GoalPlanner` 的 plan 型）有阶段性推进时主动汇报（"你上周定的学英语计划，今天该第 3 课了"）。

### P2-2　引入"值得说"的正向评估（而不只是"能不能说"）

在仲裁器里，除了 `interruptCost`（打断成本），补一个 `informationalValue`（信息价值）维度：
- 高价值 + 高成本 → 挂一会儿，但**不放弃**（P0-2 兜底）
- 低价值 + 低成本 → 可降级为"顺嘴搭车"（现有 `TurnAsideQueue` 已有基建，只是只用于 low）
- 低价值 + 高成本 → 直接沉默（唯一合理丢弃的场景）

**这一步是架构性调整**，建议放在 P0/P1 验证有效之后再做。

---

## 五、执行顺序与验收标准

| 阶段 | 动作 | 验收指标（对比当前基线） |
|---|---|---|
| **P0**（先做） | 离线信箱兜底 + TTL 降级投递 + pause 阈值修正 | `offline_wait_reconnect` 从 97 → 下降 ≥70%；`expired` 从 20 → 下降 ≥80%；delivered 从 31 提升 |
| **P1** | 合并去重闸 + medium 静默豁免 | 事件产出到投递的转化率提升；`whySilent` 能解释每一次丢弃 |
| **P2** | GoalBoard 独立预算 + 信息价值维度 | goal 类主动消息开始出现在 delivered 里 |

**观测手段**：现有 `whySilent` / `arbiterPreview` / `events.ndjson` 已够用；建议补一个**全局漏斗计数**（产出→仲裁→投递→送达各阶段），一眼看清损耗在哪一段。

---

## 六、不建议做的事（避坑）

1. **不要再加新传感器/新规则**——出口堵着，加了也是蒸发。
2. **不要把主动性全交给 LLM 现场决策**——这是历史上"纯烧钱零投递"踩过的坑（`proactivity-hub.ts` 顶部注释有记录），确定性决策的架构是对的，问题在执行链而非决策链。
3. **不要为了"能发声"就整体调低所有护栏**——那会从"不说话"滑向"话痨"。正确做法是**分层兜底**（P0 的落信箱/降级），而不是全面松绑。

---

## 附：改动文件清单（预估）

| 文件 | 改动 |
|---|---|
| `server/src/proactivity/proactive-pipeline.ts` | `attemptOfflinePush` 加 social 层落信箱分支；注入 `inbox` 依赖；`decide` 的 offline 分支改为"落信箱后标记 delivered" |
| `server/src/proactivity/arbiter-v2.ts` | `tick()` 过期项改调 `onExpire` 回调；`detectPauseFor` 成本阈值 env 化 |
| `server/src/proactivity/pipeline-types.ts` | `DeliveryChannel` 增加 `offline_inbox` |
| `server/src/bootstrap/create-app-services.ts` | 管道构造传 `inbox: inboxService`；`arbiterV2` 传 `onExpire` |
| `server/src/proactivity/frequency-governor.ts` | medium 的 `awake` 静默豁免 |
| `server/src/proactivity/mapping-rules.ts` | 移除当日去重键（交频控统一） |
| `test/proactivity-*.test.ts` | 新增离线落信箱、TTL 降级、pause 阈值三组回归 |
