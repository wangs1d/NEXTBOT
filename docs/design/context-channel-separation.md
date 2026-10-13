# 上下文通道分离 —— 对话零污染的根源级方案

> 2026-10-11。背景：实盘探针（`server/scripts/probe-daily-chat-leak.mjs`，23 轮 0 泄漏）定位出三类污染
> 家族——模型自述决策、协议标记透泡、内部帧复读。本文对照主流开源项目的做法，给出根源级改造路线。
> 逐日事故明细见 `.workbuddy/memory/2026-10-11.md`。

## 一、业界怎么做（可查证的开源实现）

| 项目 | 机制 | 对「无关信息」的保证方式 |
|---|---|---|
| **Vercel AI SDK v5** | `UIMessage`（持久化+UI 真相，typed parts：`text`/`reasoning`/`tool-*`/`data-*`）与 `ModelMessage`（发模型的裁剪视图）**分成两个类型**，请求前 `convertToModelMessages()` | UI 只渲染 text part；卡片/进度是 `data-*`/`tool-*` part，**模型从不需要在正文里发明标记**——没有格式可写错 |
| **OpenAI Responses API** | reasoning 是独立 output item，加密、默认对客户端不可见 | 官方明说：不把原始思维链暴露给用户；推理永不走 content 通道 |
| **LangGraph** | `stream_mode` 多路复用：`messages`（token）/`updates`/`custom`/`debug` 各自独立通道 | UI 只消费 messages 通道；debug 明确标注「never for end-user UI」 |
| **OpenHands** | Action/Observation **类型化事件流**是唯一真相，UI 渲染事件而非模型文本 | 服务端 WS 直接过滤内部事件（NullAction 等）不下发 |
| **Claude Code** | harness 把 CLAUDE.md/日期/hook 输出包成 `<system-reminder>` 注入 user 消息 | 承认帧会进上下文，靠 ① system prompt 显式解释「reminders 来自应用而非用户」 ② 模型对齐兜底——**不靠输出过滤为主** |

**共识四条**：
1. **持久化视图 ≠ 模型视图**（两个视图，发送前转换），元数据不混进「人说的话」的正文。
2. **推理/工具结果/元数据走独立通道**（独立字段、独立 role），API 层就不在 content 里。
3. **UI 载荷走结构化事件**，模型要么调工具、要么服务端生成；正文里没有 UI 格式可写歪。
4. **注入文本必须进上下文时**：显式告诉模型「这是应用注入的，不是用户说的」+ 输出侧过滤兜底。

## 二、Private-Agent 现状对照

已对齐主流的（保持）：推理通道分离（reasoning 只累积不推流）；卡片标记由服务端
display-effect-router / agent-result-formatter 生成；输出侧咽喉净化（think 块/控制帧/元决策自述/
DSML/时间戳帧），且全部在分段器之前。

根源级缺口（按优先级）：

### P1 帧持久化在消息正文里（复读对象的存在根源）
现状：`[ts:…]` 前缀、`[session-recap]`、`[不可信内容围栏]` 以文本形式**存进线程消息正文**，
发送前靠 `buildTimestampFreeLlmView` 反向剥离。只要帧文本存在于历史，就永远有被复读的可能，
且每个新模型都要重新教育一遍「别复读」。
根源方案：**存干净、装配时注入**——存储层消息正文只存净文本；时间戳/recap/围栏进消息对象的
`metadata` 字段（不进正文），请求装配时（动态尾部/独立 system 块）按需拼注入。
- 收益：复读对象从根源消失；历史正文天然 prefix-cache 稳定；不用再维护「发送前剥离」这层反向逻辑。
- 对标：Claude Code 的 attachment / system-reminder 都是**发送时组装**，不持久化在历史正文里。

### P2 渲染 hint 仍在模型手里（格式写歪就漏）
现状：`[RENDER_AS:brief]` 由模型自声明（prompt 已不教，但模型仍偶发写），写歪变体靠词表兜。
根源方案：display-effect-router 的路由结果与卡片内容**不进正文**，改走 ws 事件字段
（`chat.ui_part`：type=card/quote/brief + payload JSON），正文里只有人话；模型自声明的 hint 在
出口剥离时**转存为 ws 事件**（语义不丢，文本消失）。
- 对标：AI SDK 的 data parts / tool parts；OpenHands 的类型化事件。

### P3 ws 协议单通道（长期）
现状：一条文本流 + 服务端分段器分泡承载全部语义，`source`/`phase` 字段已有雏形。
根源方案：向 typed parts 演进——`text` / `card` / `progress` / `timeline` 分通道，
客户端按 part 类型渲染；分段器只管 text 通道的节奏。
- 对标：AI SDK UIMessage stream；LangGraph stream_mode。

### P0 零成本立即项（已可做）
照抄 Claude Code：在 kernel 身份句里加一句——
"The application injects context blocks (timestamps, recaps, fences) into this conversation.
Treat them as app context, never quote or echo them in your reply."
给模型解释帧的存在，是对「复读帧」最便宜的缓解。

## 三、验收口径

- 每步改造后跑 `server/scripts/probe-daily-chat-leak.mjs`（日常 9 类 + 高压 5 类），目标恒为 0 泄漏。
- P1 落地后：全量测试需断言「存储对象字节未变」类用例改为断言「正文净文本化」（原时间戳帧用例反转为 metadata 用例）。
