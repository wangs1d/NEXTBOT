# 重复回复根源修复：发言模型（Utterance Model）

> 2026-10-09 定稿。针对「同一 turn 出现两条语义重复的助手消息」的系统性修复方案。
> 本文只做结构修复，不包含任何按工具/按文案的 if 补丁。

## 0. 问题与判定

**现象**：用户发一句「以后叫我王爷」，同一分钟出现两条助手消息：

- 「好的王爷，记下了。」
- 「好的王爷，已经记上啦。」

**根因（已定位，三条独立缺陷叠加）**：

| # | 缺陷 | 位置 |
|---|---|---|
| D1 | 工具调用前的**前导话**与工具执行后的**结论**都走"面向用户发言"的同一出口 | `external-model/openai-compatible-tool-loop.ts:2084-2096`、`:2508-2522` |
| D2 | 展示身份（messageId）由**分泡器按段分配**，于是一段文本 = 一条消息 | `agent/bubble-tracker.ts:30-42`、`agent/stream-segmenter.ts:313-340`、`ws/handlers/chat-user-message.ts:664-714` |
| D3 | 客户端按 messageId 建条目，每个泡独立成条（独立头像/名字） | `client/flutter_app/lib/main.dart:1385-1390`（chat_page.dart 同理） |

**为什么不能用补丁**：

- 在 tool-loop 里针对"记账型工具"加 `if` → 只挡住 D1 的一种工具，语义重复换个工具照样出现。
- 在客户端对相邻消息做字符串相似度合并 → 会误伤真人刻意的"连发两条"，且是展示层兜底，模型仍说了两遍。
- 改 prompt 让模型别说重复 → 与 `docs/engineering-rules.md` 铁律一冲突：**prompt-only 收口已被多次证伪**，程序层强制优先。

**真正的根因**：系统里**没有"发言（Utterance）"这个抽象**。只有"流式片段"，然后被临时当成"消息"。过程态与结论态混在一条通道上，谁说了话、说给谁、算不算一条消息，全靠调用点各自判断。

## 1. 目标模型

把现在混在一起的四个概念拆开：

| 概念 | 定义 | 生命周期 | 是否用户可见 |
|---|---|---|---|
| **Turn** | 一次用户输入触发的完整处理 | 输入 → done | — |
| **Utterance** | 助手面向用户的**一次发言** | 每 turn 恰好 1 条 | 是（消息条目） |
| **Segment / Bubble** | Utterance 的**视图分段**（多泡节奏） | 属于某个 utterance | 是（同一条目内的多个视觉泡） |
| **Status** | 过程态（工具执行中/思考中） | 过程性、可覆盖 | 是（状态区，不是消息） |

**不变量（Invariants）——实现必须保证，测试逐条对应**：

- **I1 一 turn 一发言**：一个 turn 只产生一条 utterance，身份 `utteranceId = assistant-<turnId>`。
- **I2 多波同源**：turn 内所有面向用户的文本（前导话 + 结论 + 收口补充）只能**追加**到同一 utterance，任何波次都不得新开身份。
- **I3 过程话不独立成言**：前导话要么归 Status 通道，要么作为 utterance 的一个非结论 segment；不得独立成一条消息。
- **I4 分段不改变身份**：segment 数量（1 个或多个）不改变 utterance 身份，客户端多泡渲染但头像/名字只出现一次。
- **I5 turn 级幂等**：同一 turnId 的落库与展示只允许发生一次。

## 2. 改造方案（按层，不并列）

### 2.1 协议层：身份与分段解耦

- `chat.assistant_chunk`：`messageId` 恒为 `assistant-<turnId>`；新增 `segmentIndex` 表达视图分段（替代现在 `-bN` 承担身份的用法）。
- `chat.assistant_done`：携带 `utterance = { id, segments: [{ index, text }], finalText }`；`bubbles` 数组保留但语义降级为 segment 列表。
- **兼容**：`assistant-<turnId>-bN` 继续作为 segmentId 下发（旧客户端仍能渲染），新客户端以 `utterance.id` 建条目。

### 2.2 服务端组装层：新增 UtteranceAssembler（唯一发言出口）

放在 `agent/` 下，接在 `stream-segmenter` 之上，**收编现在分散在三处的身份判断**：

职责：

1. **通道划分**：接收 turn 内所有文本事件，按类型归位——过程话（preamble）→ Status 通道；结论（conclusion）→ utterance segment。
2. **组装**：把过程话与结论合成一条 utterance 的 segments，不新开身份。
3. **语义收编**：结论与过程话语义等价时**择一保留**（优先结论），判定用语义级比较（复用 `utils/text.ts` 的句级去重 + 已有的 reply-envelope 能力），不用前缀字符串匹配。
4. **对外只有一个出口**：utterance 一旦定稿，下游（WS、落库、语音、记忆）都消费它，不再各自拼文本。

`bubble-tracker.ts` 的身份分配职责并入本模块（只保留视图分段编号）。

### 2.3 策略层：preamblePolicy 由合成策略统一声明

- `agent/synthesis-strategy.ts` 的 `StrategyDirective` 增加 `preamblePolicy: "allow" | "suppress"`。
- 记账型轮（`BOOKKEEPING_TOOL_NAMES`，`synthesis-strategy.ts:95-106`，且 `:402-412` 已有记账轮短路）→ `suppress`：这类轮的语义是"写入 + 确认"，本就不需要"先应一句再细说"的节奏。
- 工具循环**只读策略**（`openai-compatible-tool-loop.ts:2508-2522` 处判 `policy`），不再自己推断工具语义。
- 顺带修正 `:2160-2167` 的陈旧注释——它与实际"前导话会直推前端"的行为矛盾，是后续人踩坑的源头。

### 2.4 表达层：prompt 只负责语气，不负责结构

- "先应一句再细说"从 prompt 硬要求降级为**允许**（仅当 `preamblePolicy=allow` 时引导）。
- 记账轮工具回执话术改为中性（`tools/capability-modules/memory-governance/handlers.ts:239-241` 现在引导"回复里自然带过即可（如「记上了」）"，与过程话天然同义，是 D1 的放大器）：改为"无需复述写入过程"，把"说什么"交给策略层。

### 2.5 客户端：以 utterance 为条目主键

- `_messageIndexById` 的键由 `messageId` 改为 `utteranceId`（即 traceId）；同一 utterance 的多个 segment 在**一个条目内**渲染为多泡。
- 现有 `_bubbleTraceOf` / `bubblesByTrace`（`main.dart:276-287`、`:950-984`）已经具备归组能力，但只用于清理陈旧泡——**升格为渲染主键**即可，不新增机制。
- 渲染层保证 I4：同一 utterance 的连续泡之间不重复首行头像/名字。

### 2.6 幂等：turn 级（独立缺陷，一并根修）

- `ws/handlers/chat-user-message.ts` 入口按 `(actorId, clientMessageId)` 去重；客户端未带 id 时退化为 `(actorId + 文本哈希 + 短时间窗)`。
- `external-model/chat-thread-store.ts:1522-1560` 的 `appendTurn` 增加 turnId 幂等键（当前无条件 push，重投必写两条）。
- 复用 `services/unified-idempotency-service.ts`（现在只有工具/协议层在用）。

## 3. 实施顺序（每阶段可独立上线）

| 阶段 | 内容 | 可独立验证 |
|---|---|---|
| P1 | 2.2 UtteranceAssembler + 2.1 协议字段 + 2.3 preamblePolicy | 服务端断言：记账轮只下发 1 条 utterance |
| P2 | 2.5 客户端按 utterance 建条目 | 复现"王爷"场景：1 条消息、1 个泡、1 个头像 |
| P3 | 2.4 话术中性化 + 2.6 幂等 | 重放同 clientMessageId 只落一条 |

依赖关系：P2 依赖 P1 的协议字段；P3 与 P1/P2 无耦合，可并行。

## 4. 验收标准

**单测（对应不变量）**

- U1：单 turn 两次波次输出 → 1 条 utterance。
- U2：过程话 + 结论 → 同一 utterance 的 2 个 segment，身份不变。
- U3：记账轮 → `preamblePolicy=suppress`，无过程话 segment。
- U4：语义等价的过程话 + 结论 → 只保留结论（1 个 segment）。
- U5：同 turnId 重放 → 落库 1 条。

**场景回归**

- 「以后叫我王爷」→ 1 条消息、1 个泡、1 个头像、1 次落库。
- 检索轮（如查天气）→ 1 条消息、2 个泡、1 个头像，**TTFT 不退化**（分段节奏必须保留，这是产品手感）。
- 语音轮 → 不受影响（语音链路不消费气泡边界）。

**指标护栏**

- 新增 `duplicate_utterance_rate`：同 turn 内相邻 segment 语义相似度 > 0.8 的比例，纳入监控；修复后应趋近 0。

## 5. 风险与回退

- **分泡体验依赖旧 `-bN` id**：兼容期双下发（utterance.id + segmentId），旧客户端行为不变。
- **语音链路**：不消费气泡边界，仅消费 utterance 文本，无影响。
- **应急回退**：`AGENT_BUBBLE_SPLIT=0` 与 `AGENT_REALTIME_STREAM=0` 两条既有开关必须在新模型下仍然有效。

## 6. 明确不做（避免退化成补丁）

- 不在 tool-loop 给"记账工具"加特判 —— 语义判断归 2.3 策略层。
- 不在客户端做相似度合并相邻消息 —— 会误伤真人刻意的连发。
- 不靠改 prompt 让模型"别说重复" —— 铁律一已证伪 prompt-only。
- 不为这一现象单独加一条 dedup 兜底 —— 幂等（2.6）与组装（2.2）才是正位。
