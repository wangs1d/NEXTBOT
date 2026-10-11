# 2026-10-10 recall_history 真实数据测试报告

## 结论：发现并修复 1 个真实缺陷，探针全绿

### 测试对象
`memory.recall_history`（跨会话历史原文检索，本次时间观拼图的最后一块）在**真实持久层**上的行为。

### 测试方式
真实 `chat-threads.json`（53KB，含「好饿」事故会话）快照拷贝到临时目录 → 走真实 `ChatThreadPersistence` 加载管线（sanitize + master migrate）→ 直接调 `searchCrossSessionHistory` 与注册后的工具 handler。真实数据文件零写入。

### 发现的真实缺陷（已修复）
**缺陷：线程级时间回退会把旧消息渲染成"刚刚"。**
主会话消息落盘不带 `[ts:]` 前缀，时间回退线程 `updatedAt`（10-10 02:21 = 探针运行时刻）。10-09 21:38 的「好饿」复读被显示成精确的 `2026-10-10 02:21`——比没有时间更糟，反而诱导模型说「刚才你说好饿」。在真实数据上完整复现了事故叙事。

**修复**（`server/src/tools/memory-recall-tools.ts`）：
- 回退时间加「约」前缀：`约 2026-10-10 02:21`；`HistoryHit` 新增 `timeSource: "message" | "session"`
- handler 返回 message 增加引用规则②：「约」开头的时间是会话更新时间，只准用『之前/更早时候』等模糊表述，禁止当精确时刻引用

### 同时校准的 exclude 语义
运行时裸 `actorId` = 当前活跃线程（排除）；`master:{actorId}` = migrate 合并出的历史线程（正当回查目标，不排除）。首轮修复曾把 master 也排除，经真实数据探针校准后修正。

### 测试结果
| 场景 | 结果 |
|---|---|
| ① 跨会话命中 + 时间锚 | ✅ 命中 proactive 会话原文，时间带「约」标记，当前线程排除 |
| ② 事故回放 query=好饿 | ✅ 零原话命中（仅 query 词撞上 mood 信号消息嵌的摘要行，score=1 弱命中，非事故素材） |
| ③ 新会话回查主线程 | ✅ 能捞到原文，时间带「约」粗粒度标记 |
| ④ 防污染 | ✅ 6 条命中均不含 recap 摘要区 / system-reminder |
| ⑤ actor 隔离 | ✅ 跨账号零命中 |
| ⑥ handler 层 | ✅ 返回结构与兜底文案正确（查不到→如实告知） |
| 单测 6/6 | ✅ pass |
| tsc --noEmit | ✅ 0 错误 |

### 产物
- 修复：`server/src/tools/memory-recall-tools.ts`
- 单测更新：`server/test/memory-recall-history.test.ts`（6 例，含 timeSource 断言）
- 新探针：`server/scripts/probe-recall-history.ts`（用法 `cd server && node --import tsx scripts/probe-recall-history.ts`）

### 遗留（低优先级披露）
- 主会话消息级时间戳缺失：如需精确时间锚，落盘时写 `[ts:]` 前缀是后续增强方向
- proactive 信号消息内嵌的历史摘要行可被低分命中（确属持久化历史原文，非污染）
