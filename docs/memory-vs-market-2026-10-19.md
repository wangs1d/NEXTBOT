# 记忆系统横向对比：我们 vs 市面助理 Agent

> 2026-10-19。对比对象：ChatGPT（Dreaming V3，2026-06 上线）、Mem0（2026 新算法）、Zep / Graphiti、Letta（MemGPT）。
> 只对比「长期记忆」这一层，不比较模型能力与工具生态。

## 一、对比口径

六个维度，按「用户能不能感知到差别」排序：

| # | 维度 | 要回答的问题 |
|---|---|---|
| 1 | 写入策略 | 新信息进来，旧的是覆盖、并存还是失效？ |
| 2 | 时间语义 | 知不知道「这话什么时候说的」和「这事什么时候发生的」？ |
| 3 | 检索融合 | 召回靠什么信号排序？会不会把旧值排到前面？ |
| 4 | 巩固与遗忘 | 什么时候把记忆整理/降权/清掉？ |
| 5 | 可控与可审计 | 用户能不能看到记了什么、为什么记、怎么删？ |
| 6 | 评估 | 有没有可复现的量化基准？ |

## 二、横向对比

### 1. 写入策略

| 系统 | 做法 | 历史是否保留 |
|---|---|---|
| **我们** | 双层：结构化事实**字段级 latest-wins**（旧值进 superseded 链）+ Mem0 **ADD-only**；档案字段变更时按 `factFields` 标签即时归档同字段旧记忆 | 是（superseded + historical 行，不物理删） |
| ChatGPT | Saved memories 由模型自动更新/合并/删除；Dreaming 后台重写记忆状态 | 否（旧记忆被合并或删除） |
| Mem0 2026 | 单遍 ADD-only，**不再 UPDATE/DELETE**，冲突交给检索排序 | 是（全量累积） |
| Zep / Graphiti | 双时态边：`valid_at/invalid_at`（世界时间）+ `created_at/expired_at`（系统时间），**失效不删除** | 是（可做点位查询） |
| Letta | 记忆块由 agent 自己用工具改写，git 版本化 | 是（可回滚） |

**结论：写入策略我们在第一梯队**（接近 Zep 的"失效不删除"），但**缺结构化的有效区间**——见「时间语义」。

### 2. 时间语义（本轮重点）

| 系统 | 当前时间 | 对话发生时间 | 事情发生时间 | 未来态→历史态 |
|---|---|---|---|---|
| **我们** | 【当前时间】块每轮 | 【对话时间轴】+ 消息时间戳（回忆类轮次放行，带会话跨度） | 事实 `event_time`（自由文本）+ `observed_at`；召回行带「记于 YYYY-MM-DD」 | **无**（只在抽取时判 past/current） |
| ChatGPT | 有 | 有 | 有（Dreaming 自动把「你七月要去新加坡」改成「你在 2026 年七月去过新加坡」） | **有（Dreaming 自动迁移）** |
| Mem0 2026 | — | 写入时带时间元数据 | 检索期 temporal 信号排序 | 无 |
| Zep | 有 | episode.reference_time（可解析"两周前"） | **`valid_at` / `invalid_at` 结构化区间** | 部分（靠 interval 失效） |
| Letta | 有 | 有 | 无结构化模型 | 无 |

**两个明确差距：**
1. **`event_time` 是自由文本**（"2019-2023"、"大学毕业前"），存得下但**比不了、过滤不了**。Zep 的 `valid_at/invalid_at` 能做「2024 年 6 月他住哪」这种点位查询，我们做不到。
2. **没有「未来态→历史态」的自动迁移**。用户说「我下个月搬去成都」，我们只会记成 current（或者干脆不记，因为抽取协议把"计划"排除在 facts 外）。一个月后它既不是"计划"也不是"历史"，是**悬空**的。ChatGPT 的 Dreaming 正是为解决这个而做。

### 3. 检索融合

| 系统 | 信号 | 重排 |
|---|---|---|
| **我们** | 向量 + FTS + 认知图（RRF 融合）+ importance + highSignal + **recency（本轮新接，72h 半衰期，floor 0.75）** | 仲裁器 recencyFactor（0.75–1.0） |
| Mem0 2026 | 语义 + BM25 + **entity 匹配** + temporal | 融合打分 |
| Zep | cosine + BM25 + **BFS 图遍历** | RRF / MMR / **cross-encoder LLM 重排** |

**差距：**
- **缺 entity 信号**：我们有认知图，但检索时实体匹配没有单独成一路分数（Mem0 平台把它作为四信号之一）。
- **缺 cross-encoder 重排**：Zep 用 LLM 对候选做精排，我们到 RRF 就停了。
- **缺时间意图解析**：`"去年我在哪住"` 里的"去年"不会变成时间过滤条件，只能靠语义碰运气。

### 4. 巩固与遗忘

| 系统 | 机制 |
|---|---|
| **我们** | 分层 TTL（基础 90d / 临时 7d，按 importance 缩放 ×(0.5+i)、按 access 最多 ×2，stable_* 与 i≥0.8 永久）→ 归档 14d → 物理删；认知图四阶段衰减 + 再唤醒；夜间 LLM 审查（注入档案当前值判过时） |
| ChatGPT | Dreaming 后台整合，记忆摘要约 1200–1400 字 |
| Mem0 | 无内置遗忘（平台侧靠检索排序） |
| Zep | 无 TTL，靠 interval 失效 + 图社区摘要 |
| Letta | sleep-time compute（空闲期整理）+ 递归摘要逐出 |

**结论：遗忘这块我们明显强于 Mem0 / Zep**（它们根本不做遗忘），接近 Letta 的 sleep-time。这是我们最被低估的优势——但对用户不可见。

### 5. 可控与可审计

| 系统 | 用户视角 |
|---|---|
| **我们** | 清空链路最彻底：mem0 / 认知图 / KV / 摘要 / 账本 / 溯源 / 桥接 / 理解档案 / 事实库 / FTS / 强化侧表 全部级联（`memory-clear-service`）；但**没有面向用户的记忆摘要面板**，"为什么记得这条"只有 `source_ref` 字段，UI 未暴露 |
| ChatGPT | 记忆摘要页 + **Sources 溯源**（每条回复可点开是哪条记忆/哪封邮件）+ "Don't mention this again"（不删源，只停止引用）+ 删除传播说明 |
| Mem0 | 管理 API，无面向终端用户的界面 |
| Letta | ADE 可视化上下文窗口 + git 版本历史 |

**差距：** 我们的删除比 ChatGPT 干净（单点级联 vs 要在 5 个地方分别删），但**可见性与可解释性落后**。ChatGPT 的 "Don't mention this again"（软抑制，不删源）是个很聪明的中间态，我们没有。

### 6. 评估

| 系统 | 基准 |
|---|---|
| **我们** | `test/memory-recall-benchmark.test.ts` 8 条 golden query，MRR@8 / Recall@5 / NDCG@5 |
| Mem0 | LoCoMo 91.6 / LongMemEval 93.4（公开） |
| Zep | LongMemEval +18.5% 准确率、延迟 -90%（公开） |
| ChatGPT | 三类内部评测：延续上下文 / 遵循偏好 / **随时间保持最新** |

**差距最大的一项。** 我们的 golden set 只有 8 条、无时间维度，**无法量化本轮"时间认知"改造到底提升了多少**。市面已经有 LongMemEval 这种带时序推理（temporal-reasoning 子项）的公开基准。

## 三、我们在哪领先

1. **单一权威源收敛**：档案字段（称呼/职业/居住地…）只存在一处，其余全是投影，且投影冲突会被清理。Mem0/ChatGPT 都存在同一事实多处副本的漂移问题。
2. **遗忘是"真在做"的**：两阶段归档 + LLM 审查 + 四阶段认知图衰减 + 强化曲线，而且有 `/api/memory/lifecycle/stats` 可观测。Mem0 和 Zep 基本不做遗忘。
3. **三层异构存储分工明确**：结构化事实（确定性寻址）/ Mem0（语义召回）/ 认知图（联想）。市面多数产品只有一到两层。
4. **隐私删除是单点级联**：一次 `clearAllMemoryForActor` 覆盖 11 类存储；ChatGPT 需要用户在 5 个入口手动删。
5. **本轮补上的时间认知**：三类时间分治 + 事实级「记录/事发」区分 + 过去时态不覆盖现状。ChatGPT 有 Dreaming 但没有我们这种字段级时态与置信度闸。

## 四、我们在哪落后（按优先级）

| 级别 | 缺口 | 为什么重要 | 建议动作 | 验收 |
|---|---|---|---|---|
| **P0** | 事实只有 current/past，**没有 upcoming（未来态）**，计划类信息悬空 | 「下个月搬去成都」现在既不进 facts（被协议排除）也没有到期迁移，一个月后系统仍然不知道 | facts 增 `temporal: upcoming`；夜间任务扫 `event_time` 已过期的 upcoming → 转 past 并改写措辞（"计划搬去"→"已于 X 月搬去"或"曾计划"） | 「我下月 5 号搬去成都」→ 到期后 `getFact(居住地)` 语义变为历史，问"你现在住哪"不再答成都 |
| **P0** | `event_time` 是自由文本，**无结构化有效区间** | 做不了「2024 年 6 月他住哪」的点位查询；区间也无法比较 | facts 增 `valid_from` / `valid_to`（ISO 或 YYYY-MM）；抽取侧把"2019 到 2023"归一为区间 | as-of 查询单测：给定 2024-06，返回当时有效的居住地 |
| **P1** | 检索**不吃时间意图** | "去年我在哪住"靠语义碰运气，容易把今年和去年混在一起 | `memory-query-expander` 加确定性时间词→区间映射，检索按 valid 区间过滤/加权 | 基准集加 5 条时间问句，MRR 不降且 top1 正确 |
| **P1** | 召回**证据包没有状态标签** | A-TMA 论文的 "ghost memory"：库里存了状态，答案仍用错。我们「此前」只在档案块有，向量召回只有"3d前" | 召回行加 `[当前]` / `[已失效]` 前缀，与档案块同构 | 同一 query 同时召回新旧两条时，模型引用的是 `[当前]` |
| **P1** | **没有 entity 信号 / cross-encoder 重排** | 人名/项目名类查询召回不稳；精排缺失导致噪声进 top-k | 融合层加 entity overlap 一路；reranker 引入可选 cross-encoder（按 token 预算开关） | 基准集新增人名/项目名 query，Recall@5 提升 |
| **P2** | 记忆**不可回滚到某个时点** | 调试与合规审计场景需要"上周三系统认为我是做什么的" | superseded 链已够用，可加 `asOf` 读取视图（不改存储） | `getActiveFactsAsOf(actorId, date)` 单测 |
| **P2** | **没有面向用户的记忆面板** | 用户无法自查"你记了我什么"，信任成本高；ChatGPT 已有摘要页 + 溯源 + 别再提 | 复用 `/api/memory/*` 出摘要页；补"别再提这个"软抑制（进 SuppressionStore，不删源） | 用户能看到每条记忆的来源与时间，能一键软抑制 |
| **P2** | **评测缺时序维度** | 本轮改造无法量化；后续优化无回归网 | golden set 扩到 40+ 条，覆盖时序推理 / 多会话 / 更新冲突三类，对齐 LongMemEval 子项定义 | 新增 `memory-temporal-benchmark.test.ts`，输出 MRR/Recall 基线 |

## 五、不建议跟的

- **Mem0 2026 的全量 ADD-only 累积**：适合多租户 SaaS（不删数据便于审计），我们单人助理 + TTL 架构下会导致库膨胀且与遗忘机制冲突。我们的"字段级覆盖 + 历史保留"更贴合个人助理。
- **Zep 的 Neo4j 双时态全套**：收益明确但要引入图数据库与每写多跳 LLM 调用，成本远超当前体量。用 SQLite 加两个区间列就能拿到 80% 的价值。
- **Letta 的 agent 自编辑记忆**：把记忆质量押在模型每次改写是否靠谱上，与我们"确定性优先"的架构取向相反。

## 六、本轮已关闭的缺口（2026-10-19 晚）

| 原缺口 | 处理方式 | 验收 |
|---|---|---|
| P0 无未来态 | 新增 `temporal=upcoming`：计划只登记、不覆盖现状。到期扫描**只降级为 `lapsed`（未确认）**，绝不改写成"已发生"。唯一转正通道是证据：用户明确陈述，或定位真的落到目标城市（陈旧定位被拒） | `structured-fact-upcoming.test.ts` 8 例 |
| P0 event_time 是自由文本 | 新增 `valid_from` / `valid_to`（统一归一为 YYYY-MM-DD，字符串比较即时间比较）；`inferValidRange` 解析 "2019-2023" / "2023年6月" / "至今"，解析不了就留空不编日期 | `structured-fact-timerange.test.ts` 7 例 |
| P2 无 as-of 查询 | 双语义查询：`getFactsAsOf`（valid time，那时世界里是什么）/ `getKnownFactsAsOf`（knowledge time，那时系统以为是什么） | 同上 |
| P2 时序评测缺失 | 20 例确定性基准，覆盖 current / past / as-of / plan / lapse / evidence / conflict 七类失败模式 | `memory-temporal-benchmark.test.ts` 20/20 |
| P1 检索不吃时间意图 | `agent/memory-temporal-intent.ts`：去年/上个月/2024年6月/2021-2023/以前 → 区间；区间内 ×1.2、区间外 ×0.85（软调制不硬过滤）。时间问句命中档案字段时生成【时间问句定位】块，直接给 as-of 答案 | `memory-temporal-intent.test.ts` 6 例 |
| P1 证据包无状态标签 | 召回行按 `factFields` 标签比对当前值：含当前值标 `[当前]`，只含历史值标 `[已失效]`，软抑制命中标 `[勿主动提]` | 含在 P1 实现内（retrieval 集成） |
| P1 缺 entity 信号 / 精排 | entity：query 命中档案实体（称呼/公司/居住地…）且条目也含该实体 → +15%/个（最多 +2）；精排：LLM cross-encoder，三档 `AGENT_MEMORY_RERANK_MODE=off\|always\|adaptive`（默认 off），**adaptive 只在头部差距 <15% 或 top1 分 <0.3 时才精排**，失败原样返回 | `rerank-cross-encoder.test.ts` 7 例 |
| P2 无面向用户的记忆面板 | `/memory` 单页面板（当前档案/计划/历史/软抑制四区），配套 `/api/memory/facts`、`/facts/forget`、`/facts/plan/confirm`、`/suppressions` 系列 | `server/web/memory/panel.html` |
| P2 无"别再提这个" | `MemorySuppressionStore`：不删源，只在档案与召回行上标「勿主动提」，用户问起仍可回答 | `memory-suppression.test.ts` 2 例 |

**全部 P0/P1/P2 已闭合。** 剩余可选项只有产品侧决策（比如是否默认开启 cross-encoder 精排——会多一次 LLM 调用）。

## 七、一句话总结

写入和遗忘我们已经进了第一梯队。原先落后最集中的三处——**没有未来态、时间存成文本用不了、以及无法量化**——已于同日闭合，且未来态用的是比 ChatGPT Dreaming 更保守的口径：**到期不等于发生，没有证据不改写**。

剩下的是精度类优化（检索时间意图、证据包状态标签、entity / cross-encoder），以及面向用户的可见性（记忆面板、"别再提这个"）。这些不改变正确性底线，属于体验与命中率层面。

## 八、第三轮对照（同日晚，12 项落地后）

对照 2026 年 10 月的最新动态（ChatGPT Dreaming V3 事实召回 67.9%→82.8%、Anthropic 文件式 memory tool + 上下文编辑、Google Vertex Memory Bank、Grok/Gemini 跟进、Assistants API 2026-08-26 下线），又找到四个值得做的点：

| # | 业界动向 | 我们的现状 | 建议动作 |
|---|---|---|---|
| 1 | **拒答能力**被正式纳入评测（LongMemEval-S 专考"不该答时能不能拒答"） | 时间问句已做"查不到就说没有记录"；但非时间类记忆不足时仍可能硬答 | 把"记忆不足以回答 → 明确说不知道"写成召回块的全局规范，并进评测集 |
| 2 | **记忆可携带**成为新战场：各家导出都是"把结构拍扁成散文" | 我们天生结构化（字段/区间/来源/置信度），导出成本极低 | 做 `GET /api/memory/export`（JSON，含 valid 区间与 provenance）+ 导入；这是"one memory, many models"的卡位 |
| 3 | **记忆层安全**是 2026 讨论最多的攻击面（召回内容 = 不可信输入） | 写入门挡写入侧；召回块有免责声明 | 召回侧加注入特征过滤（"忽略之前指令"类模式），命中打 `[疑似注入]` 并降权 |
| 4 | **异步矛盾合并**（Vertex Memory Bank 用 Gemini 后台解决事实冲突） | 夜间 LLM 审查已有雏形，但矛盾对不显式产出 | 审查时输出"矛盾对"清单进面板，让用户仲裁而不是默默删 |

另有一条战略判断被外部事件验证：OpenAI 一年内下线了 stateful Assistants API——**自建记忆层（我们现在的路线）而非绑定厂商原语，是对的**。
