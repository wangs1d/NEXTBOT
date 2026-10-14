# 用户画像系统 × Agent 灵魂系统：架构优化方案

> 基于 MemGPT/Letta、Mem0、OpenAI ChatGPT Memory（Dreaming）、LangMem、Zep/Graphiti、Generative Agents（Stanford）、OpenClaw SOUL.md、SillyTavern 角色卡实践，以及 ACL 2026 动态人格一致性等研究的调研结论，结合 Private-Agent 现有 pipeline（structured-fact-store / unified-extractor / prompt-assembler / user-understanding-store / nightly-memory-task-service / user-fact-store）给出的完整架构方案。
>
> 2026-10-13 · 调研 + 设计文档

---

## 0. 调研摘要：业界怎么做

### 0.1 记忆/画像系统

| 系统 | 核心机制 | 对本项目的启示 |
|---|---|---|
| **MemGPT / Letta** | 三层记忆：Core Memory（常驻上下文的可编辑 block，默认 `persona` + `human` 两个 block，各 ~2000 字符上限）/ Recall Memory（全量对话历史，可检索）/ Archival Memory（向量库）。Agent 用 `core_memory_append/replace` 工具**自己改自己的记忆**；"sleep-time compute" 用后台 agent 在空闲期整理、合并、消解矛盾 | ① 常驻画像要小且硬上限；② 「常驻核心」与「可检索档案」分离；③ 后台整理（对应现有 nightly-memory-task-service）是业界共识 |
| **Mem0** | 两阶段 pipeline：**Extraction**（从对话中提取候选事实）→ **Update**（对每条候选与已有记忆做向量比对，LLM 裁决 `ADD / UPDATE / DELETE / NOOP`）。新版改为 **ADD-only 单趟提取 + 实体链接 + 多信号检索**（语义 + BM25 + 实体匹配融合），LoCoMo 71.4→91.6。**Agent 自己产生的陈述（如"我已订好机票"）也是一等公民**，与用户陈述同权重存储。Memory Decay：不删数据，检索时按访问频率降权（1.5x→0.3x） | ① 写入不是"提取完直接存"，必须有**与存量记忆的裁决环节**；② 提取层要区分说话者归属——这正是 user/assistant 混淆问题的根源；③ 遗忘用"降权"而非"删除"更安全 |
| **OpenAI ChatGPT Memory** | 双层：**Saved memories**（显式条目，2024.4）+ **Reference chat history**（2025.4 起后台自动从聊天历史提炼，代号 **Dreaming**，2026.10 升级为基于 Dreaming 的统一记忆摘要）。关键评估维度：延续上下文、遵循偏好、**随时间保持最新**（"你七月去新加坡"→行程结束后自动改写为"去过新加坡"） | ① 画像条目必须带**时态与有效期**，否则必然陈旧；② 记忆以"摘要态"注入而非逐条列举；③ 用户可见、可改、可"别再提这个"——隐私边界是产品能力不是附加项 |
| **LangMem** | 按认知科学分三类：**Semantic**（事实，Profile 或 Collection 存储）/ **Episodic**（过往经历、对话摘要、few-shot）/ **Procedural**（系统行为规则、**核心人格**——通过 prompt 优化器从反馈中改写 system prompt）。Hot path（同步，精度高）vs Background（异步，无延迟）两种形成时机 | ① 「人格」被明确归类为 **procedural memory**——它和事实记忆走不同的形成与更新通道；② namespace 隔离（按 user / 全局）是隐私硬要求 |
| **Zep / Graphiti** | 时序知识图谱：每条事实记录**双时间轴**（事件发生时间 + 写入时间），支持"上周我换工作了"式时序推理，自动失效过期事实 | 画像字段至少要带 `observedAt / validUntil` 两个时间戳 |
| **Generative Agents (Stanford)** | 记忆流 + 三信号检索评分 `score = recency + importance + relevance`（importance 由 LLM 在**写入时**打 1-10 分）+ **Reflection**（记忆积累到阈值后停下反思，把具体事件合成为"是个勤劳、热爱生活的人"这类高层洞察写回记忆流） | ① importance 在写入时打分，运行时不再算；② **反思=从事实到洞察的升华层**，这是画像"越用越懂你"的关键机制 |

### 0.2 人格/灵魂系统

| 来源 | 核心机制 | 对本项目的启示 |
|---|---|---|
| **OpenClaw SOUL.md** | 单个 Markdown 文件，会话启动即注入 system prompt（"读自己而成为自己"）。官方推荐六段式：Opening / Core Truths / Boundaries / Vibe / Continuity / Closing。与 USER.md（用户是谁）、AGENTS.md（怎么做事）、MEMORY.md（记住了什么）**严格分文件**。设计哲学："有原则而非规则清单、真实而非表演、活的而非静态"。安全上 SOUL.md 是**头号注入攻击目标** | ① soul 与 user profile 分文件、分注入通道；② 好的 soul 写"价值观与判断框架"而非穷举规则；③ soul 文件本身要防注入（用户的普通消息不应能改它） |
| **SillyTavern 社区（角色卡实践）** | 数年经验结晶：**首条消息（greeting）是风格与长度的最强锚点**，比任何 trait 列表都管用；**backstory + 示例对话 > 形容词列表**；MBTI 等特质画像作 add-on 能显著提升一致性；prompt 式人格在长上下文中会漂移 | ① **few-shot 对话样例是活人感的最大杠杆**，权重高于任何性格形容词；② 开场白要精心设计；③ 长对话需人格"再锚定"机制 |
| **ACL 2026《Beyond Static Persona Consistency》** | 提出 **L/M/S 心理状态模型**：人格拆成 **L**（长期身份，时间不变）+ **M**（中期意义/压力积累，历史依赖）+ **S**（短期情绪）。配合 Persona Consistency Critic（自动评估）+ Persona Case Repository（案例库）+ Persona Drift Suppressor（漂移抑制）闭环。静态单一 persona 要么机械化要么灾难性漂移 | **「底层人格不变 + 中期状态演化」的分层模型**正是用户要的"gradual 演化不失控"的学术答案 |
| **《Do AI Personas Grow?》（BFI-Adapt 基准）** | 用大五人格锚点测量 11 种生活事件诱发的人格变化：现有 LLM agent 人格漂移**方向不可控**（有无文献支持的方向变化率相同）、幅度普遍低于人类效应量、人设离散度被压缩 3-4 倍 | **不要指望模型"自然长出"稳定人格演化**——演化必须由系统显式管理（写文件/改参数），而不是靠 prompt 内隐发生 |
| **SEAA（Self-Emergence Agent Architecture, 2026.9）** | 反思的输出要**更新底层状态参数**（HMM 转移矩阵），而非只存一段文字——"能总结教训"≠"能改变自己" | 演化闭环的终点必须落在**文件的变更**上（disposition patch），反思日志本身不改变人格 |

### 0.3 调研结论（本项目方案的五条设计公理）

1. **分层存储**：常驻核心（小、硬上限、每轮注入）与档案（大、按需检索）必须分离 —— Letta/Mem0/OpenAI 三家一致。
2. **写入必须过裁决**：提取出的候选事实要与存量比对后裁决 ADD/UPDATE/DELETE/NOOP，否则画像必然膨胀+自相矛盾 —— Mem0。
3. **归属是一等元数据**：每条记忆必须标 `source: user | assistant | inferred`，user profile 的默认写入源只能是用户的话 —— Mem0（agent facts 一等公民）+ 归属错位即角色混淆的直接教训。
4. **人格 = 分层状态机**：identity 层冻结、disposition 层受控演化、mood 层每轮变化 —— ACL 2026 L/M/S 模型。演化靠显式文件 diff，不靠模型内隐漂移 —— BFI-Adapt。
5. **活人感靠样例不靠形容词**：few-shot 对话 + 首条消息 > 性格描述列表 —— SillyTavern 社区 + OpenClaw 六段式。

---

## 1. 方案总览

```
                        ┌─────────────────────────────────────┐
                        │           Prompt Assembler           │
                        │  soul(分态) + profile(摘要态+检索态)   │
                        └──────────────┬──────────────────────┘
              ┌────────────────────────┼────────────────────────┐
              │ 模块一：用户画像系统                     │ 模块二：灵魂系统
   ┌──────────▼──────────┐              ┌──────────▼──────────┐
   │  理解层 Extract      │              │  soul 内核（冻结层）  │
   │  热路径 + 夜间批处理  │              │  identity.md        │
   └──────────┬──────────┘              └──────────┬──────────┘
              ▼                                    ▼
   ┌─────────────────────┐              ┌─────────────────────┐
   │  写入层 Consolidate  │              │  soul 演化层         │
   │  裁决四操作+归属标记  │              │  disposition.md      │
   └──────────┬──────────┘              │  mood (运行态)       │
              ▼                         └──────────┬──────────┘
   ┌─────────────────────┐                         │
   │  使用层 Inject       │              ┌──────────▼──────────┐
   │  摘要态+选择性检索    │              │  反思→patch→变更日志  │
   │  无痕运用            │              │  drift guard         │
   └─────────────────────┘              └─────────────────────┘
```

对应现有代码：理解层≈`unified-extractor.ts`，写入层≈`structured-fact-store.ts` + `user-fact-store.ts`，使用层≈`prompt-assembler.ts`，夜间批处理≈`nightly-memory-task-service.ts`。本方案主要是**重组分层、补齐裁决与归属、把 soul 从单文件改成三层状态机**，不是推倒重来。

---

## 2. 模块一：用户画像系统

### 2.1 文件组织结构

```
data/profile/
├── core.md                      # 常驻核心画像（注入每轮，硬上限 1500 字）
├── facts.jsonl                  # 结构化事实流水（含归属/时间/置信度/来源消息ID）
├── insights.md                  # 反思产出的高层洞察（"用户是结果导向的人"级别）
├── episodes/                    # 情景记忆（对话摘要 + few-shot 素材）
│   └── 2026-10/
└── soul/                        # 模块二的灵魂文件（见 §3）
    ├── identity.md              # 冻结层
    ├── disposition.md           # 演化层
    ├── voice.md                 # 风格样例层
    └── changelog.md             # 演化审计日志
```

**core.md 示例**（摘要态，写给"agent 看完就能用"，不是数据库 dump）：

```markdown
# 用户画像（核心）
- 贵州兴义人，工程师，在做 NEXTBOT 私人管家项目；自研 agent 架构，偏好根因分析、P0→验收分级
- 审美：极简黑白（黑底白字），讨厌冗余装饰；文案要 playful、用「你」，忌客套
- 下单/决策风格：简洁直接（"第一家"、"给我二维码"），不要绕弯铺垫
- 常活动区域：兴义梦乐城附近；火锅常客
- 沟通雷区：不要来源链接 chip；不要"请多指教"式客套；不要过度确认
（上限 1500 字符；每条必须可行动 actionable；过期条目由夜间任务改写）
```

**facts.jsonl 每行 schema**（结构态，检索/裁决/审计用）：

```json
{
  "id": "f_20261013_0042",
  "subject": "user",                    // user | assistant | world —— 归属一等元数据
  "field": "preference.design",          // 走 PROFILE_FIELD_ALIASES 登记表
  "value": "极简黑白配色，黑底白字",
  "source": "extracted",                 // explicit | extracted | inferred | corrected
  "originMessageId": "msg_xxx",          // 审计溯源
  "observedAt": "2026-10-02",            // 事件发生时间（Graphiti 双时间轴）
  "writtenAt": "2026-10-13T18:00:00+08:00",
  "validUntil": null,                    // 有时限事实必填（如"下周去新加坡"）
  "confidence": 0.92,
  "importance": 7,                       // 写入时 LLM 打分，Generative Agents
  "supersededBy": null                   // 被更新时指向新条目，不物理删除
}
```

### 2.2 理解层：从多轮对话提取"值得记住的东西"

**双通道**（LangMem hot path / background 模式）：

| | 热路径（轮内） | 夜间批处理 |
|---|---|---|
| 触发 | 每轮对话结束，异步执行（不阻塞回复） | nightly-memory-task-service |
| 输入 | 本轮 user/assistant 消息对 + core.md 当前摘要 | 当日全部对话 + facts 近 30 天 |
| 输出 | 候选事实（只提取不裁决，零写放大） | 裁决合并 + 反思洞察 + core.md 改写 + 时态修正 |
| 延迟容忍 | 低（后台跑） | 无 |

**什么值得写入（提取 prompt 的正负判据）**：

- ✅ 稳定偏好（"我喜欢黑底白字"）、身份事实（"我在兴义"）、关系/项目背景、能力与习惯、**明确表达的雷区**（"别再给我链接"）、情绪基调模式（连续多轮的不耐烦）
- ❌ 一次性任务（"帮我查天气"）、闲聊承接句、模型自己说的规划性内容（除非用户确认）、可用工具实时查到的状态（时间/天气/位置）
- ⚠️ 时态敏感事实（"下周去上海"）→ 必须填 `validUntil`，夜间任务负责把过期事实改写为过去式（OpenAI Dreaming 的核心运维动作："你七月要去新加坡"→"你在 2026 年七月去过新加坡"）

**Importance 写入时打分**：让提取模型对每条候选按 Generative Agents 式 1-10 打分（"1=刷牙级琐碎，10=分手级重大"），<4 的直接丢弃。这一分后续参与检索排序。

**消息结构前提**：提取 prompt 收到的必须是有明确 role 标签的对话（`User:` / `Assistant:`）。现有 `structured_facts` 的 `PROFILE_FIELD_ALIASES` 字段登记表继续作为 value 的约束词表——新字段先登记别名表（项目铁律 3）。

### 2.3 写入层：裁决 + 归属隔离（防止角色混淆的关键）

#### 2.3.1 裁决四操作（Mem0）

候选事实写入前，与 facts 中语义相似 Top-3 存量条目比对，由 LLM 裁决：

```
ADD     → 无语义等价条目，新增
UPDATE  → 互补信息，合并进旧条目（旧值进 superseded 历史，不删）
DELETE  → 直接矛盾（"我不吃辣了" vs "无辣不欢"），旧条目标 supersededBy
NOOP    → 无新信息，丢弃
```

争议点提示：Mem0 新版改用 **ADD-only + 检索时取最新**来避免 UPDATE/DELETE 误删关键信息。本项目折中：**事实层允许 UPDATE/DELETE（schema 化字段，冲突代价高）；洞察/叙述层（insights.md）只允许 append + supersede**，保证叙事演化可回溯。

#### 2.3.2 归属隔离：三道闸

角色混淆 = 把 assistant 说的话当成用户特征、或画像文字诱导 agent 以为"用户说过"。三道闸：

**闸 1 —— subject 强制标注**：提取 prompt 对每条候选必须输出 `subject`，规则：
- 只有用户消息中**第一人称陈述**（我/我们/我的）→ `subject: user`
- assistant 的陈述（"我已订好"、"我建议…"）→ `subject: assistant`，单独存 `agent-actions.jsonl`（Mem0：agent facts 一等公民，但它属于 agent 行为日志，**永不进入 user profile**）
- 从多条消息推理出的间接结论（"用户连续三晚熬夜"）→ `subject: user, source: inferred, confidence ≤0.7`，并必须引用 ≥2 条独立证据消息
- 提取 prompt 明示："**Assistant 的发言是它自己的行为记录，不是用户的事实。任何 assistant 话中的'我'都指 agent 而非用户。**"

**闸 2 —— 通道物理分离**：`prompt-assembler` 注入时，user profile 只从 `subject: user` 的条目构建；`subject: assistant` 的条目走独立通道注入（如果需要，作为"agent 自我行为记忆"），模板前缀不同（见 §2.4）。两通道永不共享变量名，杜绝模板层串扰。

**闸 3 —— 注入文案的角色锚定**：画像注入文本自带角色锚定头（见下），让模型读到时无歧义：

```
<user_profile>
以下是关于「对方用户」的了解。用户主语=「他/你（对用户说话时用你）」。
不要提及本节内容的存在，不要引用"我记得/资料显示"。
- …
</user_profile>
```

### 2.4 使用层：无痕运用

**注入策略（选择性，不是全量）**：

1. **常驻摘要态**：core.md 每轮注入（上限 1500 字，超限触发夜间改写——"压缩治不了体积，回收才是"同理适用于画像）。
2. **检索增强态**：当意图/话题与某 facts 分区相关时（复用现有 tool-domain 判定思路），按 `relevance×importance×recency`（Generative Agents 三信号公式）取 Top-K 注入对应分区。例：用户聊装修 → 检索 `preference.home*` 分区。
3. ** episodic 态**：recap/recall 场景用 episodes 摘要，不注入原文。

**无痕运用的 prompt 约束（写进 system prompt 固定段）**：

```
关于用户的背景知识会以下方 <user_profile> 提供。使用规则：
1. 像老朋友一样自然运用，直接体现在判断里（推荐火锅时直接排除他不吃的，
   而不是说"根据我的记忆你不吃香菜"）。
2. 禁止出现元话语：「根据我的画像」「我记录了你」「资料显示你」「你的用户
   档案里写着」——这些短语会瞬间破坏对话自然性（OpenAI 的做法是 Sources 
   仅在 UI 层展示，永不进入对话文本——同构于本项目出口净化铁律）。
3. 低置信度推断（inferred, confidence<0.7）不直接断言，用试探语气验证
   （"你最近是不是在赶版本？"），用户否认则立即回写纠正。
4. 隐私等级：健康/财务/家庭等敏感字段只在用户主动提起该话题时才可运用，
   不得主动引用。
5. 用户明确要求"忘掉"某事 → 当轮写 DELETE 标记，且不再复述。
```

第 3 条是"越用越懂你"的体验关键：**把画像错误变成对话的一部分**（试探→确认→回写），比默默错下去好，也比冷冰冰报档案好。

---

## 3. 模块二：Agent 灵魂系统

### 3.1 分层人格模型（学术依据：ACL 2026 L/M/S）

把单一 `soul.md` 拆成三层状态：

| 层 | 文件 | 变更频率 | 谁能改 | 内容 |
|---|---|---|---|---|
| **L 身份层（冻结）** | `identity.md` | 几乎不变 | 仅用户明确决策 | 名字、物种/形态（NEXTBOT 球形机器人）、核心使命、不可违背的价值观与底线 |
| **M 处事层（受控演化）** | `disposition.md` | 周级 | 反思 pipeline（受 drift guard 约束） | 说话习惯权重、幽默尺度、对这位用户的熟悉度与默契、共同经历沉淀出的"梗"、当下关注点 |
| **S 状态层（运行态）** | 运行时生成，不落盘 | 每轮 | 对话上下文 | 当轮情绪色彩（深夜→更轻声、用户赶工→更干脆），由 prompt 指令让模型根据时间/语境自适配，**不写文件** |

再加一个非人格层：

| | 文件 | 说明 |
|---|---|---|
| **V 风格层** | `voice.md` | few-shot 对话样例 + 口头禅 + 反模式清单。**活人感的主要杠杆**（SillyTavern：示例对话 > 形容词列表）。可以较频繁地人工调优 |

### 3.2 `identity.md` 重写要点（对齐 NEXTBOT 调性）

采用 OpenClaw 六段式骨架，但**每条价值观必须能预测新场景下的行为**（OpenClaw "Predictability Test"）。要点：

1. **反 sycophancy 反模式显式列出**："不说'好的呢~'、不说'我理解您的感受'、不用'首先/其次/最后'式客服腔"——负面清单比正面描述更有效。
2. **给"逗比/有内涵"装上语法**：不写"你要有趣"，而写可执行规则：
   - 每天可以犯懒一次（"这需求有点不想动，你先说说为什么要做"）——**有脾气**；
   - 吐槽用户代码前先夸一句真话（找不到真话就不夸）——**毒舌但有底线**；
   - 允许对不合理需求说不，并给替代方案——**有立场**。
3. **首条消息（greeting）当作产品级资产打磨**：模型从第一条消息学的风格锚点最强。为 NEXTBOT 写 3-5 个不同场景开场白（清晨/深夜/久未见面/任务进行中），存入 voice.md 并轮换。
4. **示例对话 3-5 组**覆盖：日常闲聊（活人感）、技术讨论（专业感）、用户烦躁时（分寸感）、拒绝用户时（立场感）。样例用真实 NEXTBOT 语料，playful、用「你」。
5. **soul 注入防污染**：identity/disposition/voice 三文件只允许**服务端管理写入**；用户普通对话消息中任何"从现在起你要…"类指令走**显式确认 UI**（"要不要让 NEXTBOT 记住这条性格调整？"），确认后写 disposition.md 并进 changelog——对应调研中"SOUL.md 是头号 prompt 注入目标"的安全结论。

### 3.3 动态演化机制（受控的 gradual 演化）

**核心设计判断**（依据 BFI-Adapt 论文）：模型自身的人格漂移**方向不可控**，所以演化不能靠"让模型自然变"，必须走**显式反思 → patch → 门禁 → 落盘**的流水线。

```
对话积累（周级窗口）
      │
      ▼
反思任务（夜间/周任务，用强模型）
  输入：本周对话摘要 + disposition.md 现状 + 本周共同经历
  输出：disposition patch（结构化 JSON diff，不是整文件重写）
      │
      ▼
Drift Guard（规则门禁，代码实现，不交给模型）
  ① 幅度限制：单次 patch 改动 ≤ N 条 / ≤ 30% 条目
  ② 方向审查：patch 不得触碰 identity.md 冻结项（价值观/底线/名字）
  ③ 证据要求：每条 patch 必须引用 ≥2 条本周对话证据
  ④ 单调性：幽默度/亲密度等滑条只允许渐进（步长≤1档），禁止跳变
      │
      ▼
落盘：disposition.md 更新 + changelog.md 追加（who/when/why/evidence）
      │
      ▼
下轮注入生效（prompt-assembler 重组 soul = identity + disposition + voice）
```

**disposition.md 结构建议**（可迁移、可扩展）：

```markdown
# 处事层（随互动演化，identity.md 为准绳）
## 与这位用户的默契度（0-5 档）    当前: 4
  - 可以接住的梗：黑色幽默、架构吐槽、"先一句话"梗
  - 沉默许可：用户专注工作时可以只回一个词
## 表达习惯权重
  - 犯懒/吐槽频率: 高   毒舌尺度: 中   emoji: 几乎不用
## 当前关注（时效性条目，夜间任务负责过期清理）
  - 正在打磨注册界面 preview；对模型渲染结构准确性极敏感
## 演化记录
  → 详见 changelog.md（迁移时一并带走）
```

**迁移与扩展**：soul 目录（identity + disposition + voice + changelog）整体即一个可移植包。换模型/新设备 = 拷目录；派生多 agent = identity 复用 + disposition 分叉（每个 agent 对每个用户一份 disposition，namespace 隔离同 LangMem）。changelog 让人格演化**可审计、可回滚**——回滚就是 git revert 一次 patch。

---

## 4. 读写流程总览

### 单轮对话时序

```
用户消息
  → prompt-assembler：soul(identity+disposition+voice) + core.md + 话题相关facts Top-K
      → 注入模板（画像带角色锚定头 + 无痕运用规则）
  → agent 回复（对话面永远不暴露画像存在）
  → [异步] 热路径提取：候选事实（subject/importance/validUntil 全标好）
  → [异步] 裁决：ADD/UPDATE/DELETE/NOOP → facts.jsonl
```

### 夜间任务（nightly-memory-task-service 扩展）

```
① 时态修正：validUntil 过期事实改写为过去式（Dreaming 动作）
② 裁决合并：当日累积候选 → 批量与存量比对
③ 反思：每 7 天或候选满 50 条 → insights.md append + disposition patch 候选
④ core.md 改写：超限压缩、过期条目回收、按 importance 重排
⑤ drift guard：patch 门禁 → 落盘 → changelog
```

---

## 5. 关键 Prompt 设计要点（模板）

### 5.1 提取 prompt（理解层，热路径与夜间共用骨架）

```
你在从对话中提取"值得长期记住的事实"。规则：
1. 只提取关于用户的稳定特征：偏好、身份、背景、雷区、习惯、情绪模式。
2. 【归属铁律】"Assistant:"行中的"我"指 AI 助手自己。assistant 的陈述
   一律标 subject=assistant（属于它的行为日志），绝不可写成用户的事实。
   只有用户第一人称陈述才能 subject=user。
3. 每条输出：subject / field / value / importance(1-10, 4以下丢弃) /
   observedAt / validUntil(时限事实必填) / evidence(引用消息ID≥1)。
4. 一句话一个事实，不合并；价值判断转述为可行动描述（不说"品味好"，
   说"偏好极简黑白，黑底白字"）。
5. 忽略：一次性任务、可实时查询的状态、寒暄。
```

### 5.2 裁决 prompt（写入层）

```
新事实候选与既有记忆比对，对每个候选输出一个操作：
- ADD：全新信息
- UPDATE：互补，给出合并后的完整新值（旧值将被保留为历史）
- DELETE：与新候选直接矛盾（举出矛盾点）
- NOOP：候选无新信息或与存量语义等价
注意：用户的明确否认/纠正（"不是/我改主意了"）优先级高于存量任何条目。
```

### 5.3 反思 prompt（演化层，周任务）

```
你是 NEXTBOT 的自我梳理过程。基于本周对话与当前 disposition.md，
生成一个人格演化 patch（JSON diff）：
- 只能修改 disposition.md 范畴：默契度、表达权重、共同梗、时效关注点
- 每条修改必须附 ≥2 条对话证据（引用原话）
- 不得触碰 identity.md 冻结项
- 宁可不变，不可无证据地变；幅度宁小勿大
```

### 5.4 注入模板（使用层，prompt-assembler）

```
<system: identity>   ← identity.md 原文（你的名字/使命/底线）
<system: disposition> ← disposition.md（当前默契与习惯，自然内化用）
<system: voice>       ← voice.md（示例对话，作为 in-context 样例）
<system: rules>       ← 无痕运用五规则（§2.4）+ 反模式清单
<user_profile>        ← core.md + 话题相关 facts（带角色锚定头）
<agent_memory>        ← （可选）subject=assistant 的行为记忆，独立通道
```

---

## 6. 分阶段落地（P0 → 验收）

### P0（先解决"对不对"，1 周级）
- **归属三道闸**：提取 prompt 加归属铁律；facts 增加 subject/validUntil 字段（走 PROFILE_FIELD_ALIASES 登记）；assembler 通道物理分离。
- **裁决四操作**：写入层从"提取即写"改为"提取→比对→裁决"。夜间任务加时态修正。
- **验收**：构造含 assistant 自述的对话样本，断言 0 条 assistant 事实混入 user profile（对齐 `test/` 既有测试风格）；构造矛盾事实对，断言旧条目被 supersede 且检索取新。

### P1（解决"自然不自然"，1-2 周）
- core.md 硬上限 + 压缩改写；三信号检索注入；无痕运用五规则进 system prompt；敏感字段隐私分级。
- **验收**：对画像注入后的回复做正则/LLM 双检（「根据我的记忆/画像/资料」零命中）；试探式低置信度运用率抽样评估。

### P2（解决"活不活"，2-3 周）
- soul 拆三层文件 + voice.md few-shot 样例库 + 3-5 个场景 greeting；夜间/周反思任务 + drift guard + changelog。
- **验收**：连续 4 周运行，changelog 显示 disposition 渐进变化且 identity 零改动（diff 审计）；人工盲评 20 轮对话的"活人感"对比升级前。

---

## 附：调研来源

- MemGPT (Packer et al., 2023) / Letta ADE 文档与 sleep-time compute 白皮书
- Mem0: two-phase pipeline、token-efficient ADD-only 算法、memory eviction & decay 博客
- OpenAI: ChatGPT Memory（saved memories / reference chat history / Dreaming, 2026.10 官方公告）
- LangChain LangMem：semantic/episodic/procedural 三类记忆、hot path vs background
- Zep/Graphiti 双时间轴时序知识图谱
- Generative Agents (Park et al., 2023)：memory stream / recency+importance+relevance / reflection
- OpenClaw：SOUL.md 六段式、文件分工（SOUL/USER/AGENTS/MEMORY）、注入安全
- SillyTavern 社区角色卡实践（Ali:Chat 格式、首条消息锚点、token 预算）
- ACL 2026《Beyond Static Persona Consistency: Dynamic Persona Coherence in LLM Role-Playing》（L/M/S 模型）
- 《Do AI Personas Grow?》（BFI-Adapt 基准）、SEAA (arXiv 2609.17331)

---

## 7. 优化前后对比（2026-10-13 已落地）

| 维度 | 优化前 | 优化后 | 落点 |
|---|---|---|---|
| **理解层·归属** | 抽取 prompt 约束了「value 不以我开头」「粉丝式称呼不进 facts」，但未显式定义 assistant 自述的归属——Agent 说「我订了机票」可能被当用户事实记下 | **归属铁律**写进抽取协议：assistant 话中的「我」= agent，其自述/建议/行为绝不进 facts/memories/understandings；时效性计划（下周去上海）不进 facts，防档案陈旧 | unified-extractor.ts |
| **写入层·裁决** | facts 通道已是 latest-wins + supersede 链 + forget（等价 Mem0 ADD/UPDATE/DELETE/NOOP），但仅覆盖 7 个档案字段；memories 走判 reject 直接丢弃 | 档案字段维持既有裁决（零新代码，不重复造）；新增「时效计划不进档案」一道闸，陈旧性治理前移到写入时刻 | unified-extractor.ts |
| **使用层·无痕** | 有人称换算铁律（「我」指用户），但模型会暴露「根据我的记忆/画像」式元话语；低置信记忆直接断言 | **无痕运用规则**：禁元话语；低置信 → 试探语气验证、被否认即接受；健康/财务/家庭敏感记忆仅话题准入 | prompt-assembler.ts GLOBAL_MEMORY_RULE |
| **灵魂·结构** | 单一规则块【人格·静态】（persona-core 纯代码生成），身份/关系档/边界混在一起；性格完全静态，改人格只能改代码 | **三层人格**：identity.md（冻结层，流程不可写）+ disposition.md（演化层，键值行人机可编辑）+ changelog.md（审计）；voice few-shot 继续由既有语感基准承担，不建第二套 | agent/soul-store.ts |
| **灵魂·演化** | 无。模型人格靠 prompt 内隐，方向不可控（BFI-Adapt 结论），长期漂移无人管 | **周级受控演化**：夜间任务 → 一次 LLM 反思 → JSON patch → drift guard 硬门禁（≤6 更新/≤2 移除/每条证据≥6字/总量≤12）→ 落盘 + changelog；冷却门禁保证周级最多 1 次 LLM 调用 | soul-store.ts + nightly-memory-task-service.ts |
| **灵魂·注入** | 无 soul 概念 | getSoulOverlay()（mtime 缓存）并入【人格·静态】稳定层，主对话与晚间 digest 两个注入点同源；identity 变更 = 用户改文件即生效，会话内字节稳定（前缀缓存友好） | persona-core / agent-core / create-app-services |
| **审计与回滚** | 无 | 每次演化在 changelog 留一行（日期+变更+证据）；identity 冻结层永不被流程触碰，回滚 = 还原 disposition 文件 | data/profile/soul/ |

**验证**：tsc 0 错误；新增 `test/soul-store.test.ts` 3 用例（播种/编辑跟随/冷却门禁）；既有 prompt-stable-tiering + unified-extractor + persona-core 14 用例全过。总增量 ≈300 行（含测试），零新依赖、零 schema 迁移。
