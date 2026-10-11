# 「规划马尔代夫一周游」三症状诊断（2026-10-10）

复现输入：`帮我规划一下去马尔代夫游玩一个星期左右的行程`（13:12 真机轮）

## 一、现场证据

`logs/autostart/server-2026-10-10.log:947`

```
[turn-trace] {"stage":"main_chat_tools","model":"MiniMax-M3","turnIntent":"knowledge_qa",
 "turnEvidenceInjected":false,"routeConfidence":0.72,
 "visibleTools":32,"deferredActive":true,"deferredCount":271,
 "waves":2,"toolCalls":[{"name":"search_web","ok":false},{"name":"search_web","ok":true},{"name":"search_web","ok":true}],
 "finalTextChars":499}
```

- 路由判 `knowledge_qa`（对话面），不是任务面；无前置检索证据块。
- 模型只调了 `search_web` ×3，**零 `travel.*` 调用**。
- `server/data/chat-threads.json` 实锤落库的正文尾段（见第三节）。

---

## 二、症状① 没调用对应工具 —— 两个叠加缺陷

### 根因 A：对话面语料里根本没有技能工具（必修）

`services/agent-core.ts:2218-2237` `buildChatLaneExplicitOpts()`：

```ts
const corpusSafe = webForbidden ? filterWebSearchTools(getBuiltinAgentChatTools()) : getBuiltinAgentChatTools();
return {
  toolExposureProfile: "explicit",
  chatToolsBuiltin: [...coreFiltered, ...buildDomainPreloadTools(text, corpusSafe, coreNames), ...],
  chatToolsExtra: corpusSafe,          // ← 语料 = 纯内建，零技能工具
  toolLoop: { maxRounds: chatLaneMaxRounds() },
};
```

该对象在 `agent-core.ts:2273-2284` 展开时**排在** `this.promptContextBuilder.build({...})` **之后**，因此 `chatToolsExtra` 被覆盖。

而被覆盖掉的那份是 `agent/prompt-context-builder.ts:630`：

```ts
const chatToolsExtra = this.sessionSkillTools(input.actorId);   // build() 返回 { chatToolsExtra }
```

`sessionSkillTools`（`prompt-context-builder.ts:1280`）→ `buildSessionSkillChatTools`（`skills/skill-openai-bridge.ts:69`）会把 `skillManager.list(true)` 里**所有非 community 技能**转成 chat tool。travel 六件套 `kind: "builtin"`（`travel-planning-skills.ts` 六处），本该全部在列。

**实测探针**（`server/scripts/probe-travel-tool-visibility.ts`）：

| 语料 | 域预载产出 |
|---|---|
| `getBuiltinAgentChatTools()`（113 个，生产 chat 车道口径） | `voice.transcribe, voice.send_message, interest.manage, voice.speak` — **零 travel** |
| 同语料 + travel 六件套（任务面/`sessionSkillTools` 口径） | `travel.plan-itinerary, travel.get-itinerary, travel.edit-itinerary, travel.destination-info, travel.compute-route, travel.search-poi` |

**影响面不止可见集**：延迟目录（`deferred=271`）同源这份语料 → `tool_discover` 也搜不到 travel → 模型连"发现工具"这条路都不存在。

**为什么单测是绿的**：`test/chat-lane-domain-preload.test.ts` 在文件里手动把 travel 六件套 push 进 corpus（文件头第 10-11 行已注明「travel 技能族不在静态 builtin 注册表，生产由 bootstrap 注册链注入；测试环境按注册链同源构造」）—— 测试构造了生产没有的语料，于是「测试绿灯、线上失效」。

### 根因 B：L1 意图集没有「旅行规划」语义位

`agent/intent-router.ts:11-30` 与 `agent/route-llm-call.ts:25-33` 的封闭 8 类：

`chat / knowledge_qa / realtime_lookup / personal_data_query / media_retrieval / action_write / multi_step_task / meta_capability`

`understanding.travel_query`（`route-llm-call.ts:51`）只是**上下文标记**（注入 TRIP 快照 + 手写兜底闸），不驱动执行。于是「帮我规划…行程」只能被塞进 `knowledge_qa` 或 `chat`，而 `intent-router.ts:66`：

```ts
knowledge_qa: { plane: "chat", capabilities: [], budget: 0, tier: "flash" },
```

→ 对话面、零工具束、无前置检索。**没有任何确定性机制保证 travel 工具被调用**（与 2026-10-08「手写行程导致旅游卡缺席」同源）。

---

## 三、症状② 旅游卡片被渲染成搜索结果卡

- 屏幕上那张 8 条列表 = **`search_web` 的 tool 回执卡**（前端按工具类型渲染），原始结果无二次组织。
- 行程卡由 `resolveTravelReceipt` / 确定性附卡链生成（`services/deterministic-card-chain.ts`），**前提是 travel 工具产生过回执** → 本轮零回执 → 无卡。
- 手写兜底闸（`ws/handlers/chat-user-message.ts:1610-1616`）要求 `looksLikeHandwrittenItinerary(finalText)` 命中（正文含逐日行程表结构）；模型只写了独白 → 不命中。
- **根因 A/B 修好后此症状自愈**（travel 被确定性调用 → 回执 → 附卡）。

---

## 四、症状③ agent 自述被放出来

`server/data/chat-threads.json` 中该轮 assistant 正文原文（重复出现两遍）：

```
（用户已通过 profile_update 记录固定称呼"王哥"；本轮用户从多次重复"搜马尔代夫照片"切换为正式请求
"规划马尔代夫一周游行程"。前置任务：马尔代夫搜图+刘浩存照片处理方式均已搁置/被新指令取代。
本轮主任务：交付一份马尔代夫一周游规划初稿，包含时间节奏、岛屿选择、玩法、预算、注意事项等。
基于已联网检索的 2026 年最新岛屿信息和成本数据，我需要做的是把信息组织成清晰的方案呈现给王哥，
并就关键参数（出发时间、出发地、人数/构成、预算档位）向他追问。）

好，资料拉到了。王哥这是正经事，我先出方案，参数再问你。

（同一段又重复了一遍…）
```

判定：**模型把注入的任务上下文（活跃目标 / 任务栈）复述成了元叙述，直接作为 assistant 正文落库并渲染**。

- 项目已有一张**同款词表闸**，但只建在记忆写入侧：`agentic-memory/ltm-write-gate.ts:31` 用正则拒绝含「该轮次 / 活跃目标 / 路由：/ 优先级= / EvolutionLoop …」的文本写长期记忆（本轮日志确实打印了 `[ltm-gate] 拒绝 narrative 写入(task_state)`）。
- **回复出口没有对应的闸**：`agent/execution/reply-style-guard.ts` 现有 violation 仅 `apology_persona / hedge_pileup / offer_pileup / self_explain / overlong`，缺「元叙述 / 独白」这一类。

---

## 五、修复建议（按性价比）

**P0-1 · 对话面语料别丢技能工具**（治 ①②）
`agent-core.ts` `buildChatLaneExplicitOpts()`：把 `sessionSkillTools(actorId)` 并进语料（`chatToolsExtra: [...corpusSafe, ...skillTools]`，或 chat 分支不再覆盖 `chatToolsExtra`）。
注意：技能 30+ 个进 BM25 目录，需复核 `DOMAIN_PRELOAD_CAP`、preload 负反馈与重名收敛；目录不占 prompt token，代价可接受。
回归：`test/chat-lane-domain-preload.test.ts` 应改为**从真实装配产出取语料**，而不是手搓 corpus —— 否则永远测不到这个 bug。

**P0-2 · 回复出口加 meta_narration 闸**（治 ③）
`reply-style-guard.ts` 新增一类 violation：① 结构判据「整段被（）/【】包裹且含元词」；② 词表复用 `ltm-write-gate` 的元叙述正则（本轮/该轮次/前置任务/主任务/活跃目标/路由：/优先级=/我需要做的是…）。处理=整段剥离 + 相邻重复段去重，且**早于流式阶段**（否则用户已经看到）。

**P1 · 给旅行规划一个语义位**（治 ①的架构位）
- 最小改法（与 `media_retrieval` 的确定性预执行同构）：`understanding.travel_query === true` 时，由代码构造 `travel.plan-itinerary` 的 input 并**确定性预执行**，模型只叙述。
- 常规改法：`IntentLabel` 新增 `travel_planning`，路由表 `{ plane: "task", capabilities: ["full"], budget: 3, tier: "pro" }`，同步 `INTENT_ALIASES` / 路由 prompt / 黄金用例。

**P2 · 顺手看**：本轮 `[turn-timing] cognize 护栏超时（3500ms）`、`HumanLikeMemory computeEmbedding 402`（余额不足）与 AnySearch 5000ms 超时 —— 非本次三症状根因，但影响该轮整体质量。

---

## 六、复现命令

```bash
cd server && D:/nodejs/node.exe --import tsx scripts/probe-travel-tool-visibility.ts
```
