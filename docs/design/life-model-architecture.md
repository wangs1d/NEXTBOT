# 用户生活模型（Life Model）记忆架构设计

> 定位：私人管家 / 私人助理 Agent 的核心记忆架构设计方案。
> 2026-10-20 · 设计文档（评审稿，评审通过后再动代码）

---

## 0. 问题陈述：为什么短长期记忆架构不够

通用助手（客服 / 问答 / 工具调用）的记忆需求是「**取回**」：用户问什么，能捞回相关的一句话即可。所以业界主流架构（MemGPT 的 core/recall/archival、Mem0 的两阶段提取、短长期双层）都在解决**检索命中率**问题。

但私人管家 / 私人助理的目标不是「答得准」，而是「**越来越懂这个人**」——它要**走入用户的生活**：

- 知道用户有个妹妹叫小满、养了只猫叫团子、上司姓陈、最好的朋友是老王；
- 知道「上次和谁去的京都」「跟老婆吵架那天之后情绪低了两周」；
- 能纵向比较——「你以前不爱喝咖啡的」「你最近是不是在赶那个项目」；
- 关系本身会演化：和某个朋友的亲密度随时间、事件起伏，形成轨迹。

这些问题的共同点是：**它们不是「某条记忆藏在哪」，而是「这个人的生活被建模成了什么结构」**。一句话记忆 + 向量检索的结构，天然回答不了「我妹妹叫什么」「我上次和谁去的」——因为答案是「一个实体」和「一条关系边」，不是一段文本。

**结论：当前架构强在「取回」，弱在「建模」。** 本文的主张是补上「建模」这一层，把它做成一个**持久化、可查询、可演进**的一等实体——**用户生活模型（Life Model）**。

---

## 1. 现状盘点：我们强在哪、弱在哪

### 1.1 能力地图（真实落点）

| 层 | 能力 | 落点（file） | 强度 |
|---|---|---|---|
| **取回** | 8 通道召回 + 仲裁融合 + 反馈闭环 + 连续性三件套 | `brain/memory-cortex.ts`（recall）、`brain/memory-arbitrator.ts`、`memory-strength-model.ts`、会话情景层 `short-term-memory-gateway.ts` | ★★★★ 已经很成熟 |
| **固化事实** | KV 式精确寻址、latest-wins、superseded 演变链、时态三态、双时间轴 | `agentic-memory/structured-fact-store.ts` | ★★★★ 比预期强 |
| **结构化理解** | 图式归纳、经验学习（episode/belief）、关联扩散、推理引擎 | `brain/memory-cognitive/*`（schema-formation / experience-learning-loop / associative-graph / inference-engine） | ★★ 产出不落盘 |
| **画像** | 夜间提炼的用户事实（JSON）、核心画像 Markdown | `services/user-personalization/*`（user-profile-facts / user-profile-store） | ★★ 与事实库平行、形态扁平 |
| **关系** | 用户↔Agent 亲密度标量 + 里程碑 | `services/relationship-graph-service.ts` | ★ 名不副实（见 §3.1） |
| **隐私闭环** | 级联清空（purgeActor 全家桶）、记忆 CRUD | `services/memory-clear-service.ts`、`routes/http/memory-crud.ts` | ★★★★ 底座完整 |

### 1.2 一句话结论

**「取回」和「固化事实」已经不错，「建模」几乎是空白。** 而私人管家的核心价值恰恰在建模。

亮点要说清楚：`structured-fact-store.ts` 其实已经比很多论文方案做得细——它已经有 `entity`（主体，预留家庭成员）、`temporal`（current/past/upcoming）、`eventTime`（事情何时发生）、`observedAt`（何时被告知）、`validFrom/validTo`（有效区间）、`planState`、`confirmCount`，并有 superseded 演变链。**这套东西是好底子，本文的主张是「以它为骨架、向上长出 Life Model」，而不是推倒重建。**

---

## 2. 四层抽象金字塔

```
                        ┌───────────────────────────────┐
   顶层（缺口）          │  ④ 用户生活模型 Life Model      │  ← 本次要补
                        │     实体 / 关系图 / 时间轴        │     可查询·可演进
                        ├───────────────────────────────┤
   已有（部分散落）      │  ③ 结构化理解                   │  图式/信念/轨迹
                        │     schema / belief / trajectory │
                        ├───────────────────────────────┤
   已有（较成熟）        │  ② 固化事实                     │  structured-fact-store
                        │     KV 精确寻址 + 演变链         │
                        ├───────────────────────────────┤
   已有（成熟）          │  ① 原始经历                     │  对话流水 / journal / 情景层
                        │     会话 · 事件 · 摘要           │
                        └───────────────────────────────┘
```

纵向箭头含义：**从下往上，每层是对下层的抽象升华**（Generative Agents 的 reflection 思想：从具体事件 → 高层洞察）。
横切含义：**每一层都必须可被召回通道访问，并统一进仲裁器**（读侧单一出口，避免又长出平行旁路）。

生活模型在第 ④ 层，但**不是另起一套存储**——它是把 ③② 层已有的产出（图式 / 信念 / 事实 / 关系）**收敛**成一个有结构、能回答「谁 / 什么关系 / 什么时候」的模型。

---

## 3. 三处结构性缺口（附证据）

### 3.1 缺口一：「关系层」名不副实

所谓 `RelationshipState`（`user-personalization-service.ts`）学的是：

```ts
type RelationshipState = {
  warmth: number; humorTolerance: number; proactiveTolerance: number;
  encouragementNeed: number; directnessPreference: number; rapport: number;
  lastUpdatedAt: string;
};
```

这是**用户 ↔ Agent 之间的亲密度标量**（我该多热情、多幽默、多主动），**不是用户的社会关系**。`relationship-graph-service.ts` 的其余能力也一样：

- 里程碑类型 `first_meeting / trust_established / rapport_milestone / emotional_shift`——全是**用户与 Agent 的关系**事件；
- 存储走 `HumanLikeMemoryService` 的 `domain: "relationship"`，产出 `getRelationshipSummary` 只返回一段 **≤200 字符的 text blob**（`"关系: warmth=0.62, rapport=0.41; 默契达成(...)"`）。

**它回答得了「我和用户处得怎么样」，回答不了「用户的妹妹叫什么」「用户和谁去的京都」。**

### 3.2 缺口二：没有实体 / 本体

事实是扁平的 `(category, key, value)`（`user-profile-facts.ts` 的 `UserFact`：`habit | interest | personality | communication_style | decision_style | privacy_preference | travel`）。没有「人 / 物 / 地点 / 宠物」这样的**实体**概念。

- `structured-fact-store.ts` 虽有 `entity` 字段，但**默认恒为 `"user"`**，只作「预留家庭成员/设备扩展」，从未真正物化出实体节点；
- 所以「我妹妹叫什么」「团子（猫）几岁了」这类问题，**结构上无处安放答案**——只能靠向量检索去捞一段文本，命中率不稳定，还不支持跨实体聚合（"关于我妈的所有事"）。

### 3.3 缺口三：时间轴不统一 / 缺失

「越来越了解」依赖**纵向比较**（过去 vs 现在），这要求所有层用同一种时间观。现状是**三套时间观并存**：

| 存储 | 时间字段 | 问题 |
|---|---|---|
| `structured-fact-store` | `eventTime` + `observedAt` + `validFrom/validTo` | 完整（双轴 + 区间）✅ |
| `UserFactStore`（夜间 JSON） | 只有 `lastSeenAt / createdAt` | **缺 occurredAt**，分不清「何时发生」与「何时被告知」❌ |
| `relationship-graph` 里程碑 | 只有 `occurredAt` | 缺「何时被告知」，无区间❌ |
| `schemaFormation` / `experienceLearning` | `createdAt / updatedAt` 仅登记时间 | 无事件时间❌ |

**这是阻塞项**：数据模型不统一，「纵向演化」就建不起来。

### 3.4 附加：认知子模块的产出不落盘

- `MemorySchemaFormation` 的 `SchemaNode` 只存在**进程内 `schemaCache`（内存 Map）**——重启即失（`memory-schema-formation.ts` L266）；
- `MemoryExperienceLearningLoop` 的 `episodes / beliefs` 同样只在内存 Map（`memory-experience-learning-loop.ts` L169）；
- 关联合成 `memory-association-synthesizer.ts` 的高置信结果会回写 `humanLike` 图，但**图式与经验学习两路的沉淀跨不过一次重启**。

也就是说：③ 层「结构化理解」**学着学着就忘了**——对「越来越懂你」是致命的。

---

## 4. 设计主张

**加一层「用户生活模型（Life Model）」一等实体，把散落在 ③② 层的产出收敛进来，而不是再加一堆平行模块。**

四条硬原则：

1. **收敛而非叠加**：schemaFormation / experienceLearning / relationshipGraph / structuredFactStore 的产出，**收敛进 Life Model 的实体-关系-时间结构**；Life Model 作为召回的一条通道进入仲裁器，不新增旁路（呼应 2026-10-19 刚完成的「读侧收敛」）。
2. **时间双轴 + 区间**：一切生活模型条目必须有 `occurredAt`（事件发生）+ `recordedAt`（登记/被告知）；关系与偏好类实体再加 `validFrom/validTo` 区间。统一到 §5.4。
3. **社会关系图结构化**：节点 = 人 / 组织 / 地点 / 宠物（+ 用户自己）；边 = 关系类型 + 亲疏 + 情感价 + 时间区间 + **变化轨迹**；用户 ↔ Agent 是其中**一条特殊边**（不是唯一的关系）。
4. **隐私本地优先**：本地存储 + 可选静态加密 + 明确出境边界 + 用户可查可删（复用 `memory-crud.ts` / `memory-clear-service.ts` 底座）。

---

## 5. Life Model Schema 设计

### 5.1 实体节点 `LifeEntity`

```ts
type LifeEntityKind = "self" | "person" | "org" | "place" | "pet";

interface LifeEntity {
  id: string;              // 归属 actor 的命名空间：ent:<actorId>:<hash>
  actorId: string;         // namespace 隔离（同 LangMem，多 agent 各持一份）
  kind: LifeEntityKind;    // self = 用户本人
  canonicalName: string;   // 规范名："妈妈" / "张伟" / "老王" / "团子"
  aliases: string[];       // 别名："妈" / "母亲" / "老妈"
  /** 属性：指向 structured_fact 的 factId（复用确定性 KV + 演变链，不另存值）*/
  attributeFactIds: string[];
  firstSeenAt: string;     // 首次出现
  lastSeenAt: string;      // 最近提及
  confidence: number;
  sourceRefs: string[];    // 溯源（消息 ID / 记忆节点 ID）
}
```

要点：**属性不另起炉灶**——实体不自己存「妈妈的生日」，而是指向 `structured_fact` 里 `entity="妈妈"` 的那批事实行（目前该字段恒为 user，本次让它物化）。这样 `eventTime/validFrom/superseded` 全部白拿，零重复建设。

### 5.2 社会关系边 `SocialEdge`

```ts
type RelationKind =
  | "family" | "partner" | "friend" | "colleague"
  | "acquaintance" | "pet_owner" | "self_agent";

interface SocialEdge {
  id: string;
  actorId: string;
  fromEntityId: string;    // 通常 = self（用户）
  toEntityId: string;      // 目标实体
  kind: RelationKind;      // 大类
  subKind?: string;        // 细分：母亲 / 妹妹 / 上司 / 大学同学 / 前同事
  /** 亲疏（0-1）与情感价（-1..1）：行为可观测、可演化 */
  intimacy: number;
  sentiment: number;
  /** 关系有效区间（认识→结束），支持"前女友/已离职"式过期 */
  validFrom: string | null;
  validTo: string | null;
  status: "active" | "ended" | "unknown";
  /** 关系变化轨迹：亲疏/情感随时间的关键点（供纵向比较与叙事）*/
  changeLog: EdgeChangePoint[];
  confidence: number;
  sourceRefs: string[];
}

interface EdgeChangePoint {
  at: string;              // occurredAt
  intimacy: number;
  sentiment: number;
  /** 触发事件引用（如里程碑 / 共同经历 / 记忆节点 ID）*/
  triggerRef?: string;
  note?: string;
}
```

**这一步直接解决 §3.1**：用户的妹妹、老王、陈上司，都成为 `SocialEdge`；「上次和谁去的京都」= 从某条共同经历记忆反查到 `fromEntityId/toEntityId`。

### 5.3 用户 ↔ Agent 特殊边

现有 `relationship-graph-service` 的 warmth/rapport 里程碑**不废弃**，而是收敛为一条特殊边：

```ts
// kind = "self_agent" 的 SocialEdge
{ fromEntityId: self, toEntityId: agentEntity, kind: "self_agent",
  subKind: "私人管家", intimacy: <由 warmth 映射>, sentiment: <由 rapport 映射>,
  changeLog: [ {at: 里程碑时间, intimacy, sentiment, triggerRef: milestoneNodeId} ] }
```

即：**「我和管家处得多熟」成为生活模型里的一条边，和「我和妹妹的关系」同构**——统一了表示，也让 Agent 的自我认知（soul 的 disposition 层）与关系层可对齐（见 `docs/agent-memory-soul-architecture.md` 三层人格）。

### 5.4 时间双轴 + 区间（统一时间观）

所有 Life Model 条目（实体 / 边 / 轨迹点）强制：

| 字段 | 语义 | 作用 |
|---|---|---|
| `occurredAt` | 事情**发生/生效**的时间（用户原话里的时间） | 「你七月去的新加坡」 |
| `recordedAt` | 系统**得知/登记**的时间 | 审计、冲突排序、去重 |
| `validFrom/validTo` | 结构化**有效区间**（关系/偏好类必填） | 「前女友（2023 分手）」「以前住杭州」 |

映射到现有：`occurredAt ↔ eventTime`、`recordedAt ↔ observedAt`、区间 ↔ `validFrom/validTo`（`structured-fact-store.ts` 已有）。**本设计把这三件套推广到 `UserFactStore` / 关系里程碑 / 图式 / 经验学习**，终结 §3.3 的三套时间观。

### 5.5 关系演化轨迹

`SocialEdge.changeLog` 是有序的 `EdgeChangePoint[]`。夜间固化任务在检测到亲疏/情感跳变时追加一个点（复用 `detectAndRecordMilestone` 的规则化跳变检测思想，零 LLM）。轨迹即「越来越了解」的**可比较证据**：

- 叙事：「你和老王这两年走得比以前近了」
- 预警：「过去两周你提到妹妹的频率骤降，情绪价走低——要不要聊聊？」

### 5.6 与现有存储的字段映射（收敛表）

| 现有 | 去向 | 处理 |
|---|---|---|
| `structured-fact-store.entity`（恒 "user"） | `LifeEntity` | **物化**：每个 distinct entity 长出一个节点；user → kind=self |
| `UserFactStore`（JSON, 扁平） | `structured_fact` | 迁移：补 `occurredAt`，按 category→field 归一，废弃平行 JSON |
| `RelationshipState`（标量） | `self_agent` 边 | 映射为 intimacy/sentiment；标量保留为「当前值快照」 |
| `relationship-graph` 里程碑 | `self_agent.changeLog` | 里程碑节点 ID 作 `triggerRef`，HumanLike 存储继续承载原文 |
| `SchemaNode`（内存） | `life_pattern` 表 | **落盘**（§3.4） |
| `episodes / beliefs`（内存） | `life_belief` 表 | **落盘**（§3.4） |

---

## 6. 存储与迁移策略

### 6.1 存储选型：复用 agentic sqlite，不新建后端

新建表挂在**同一个** `openAgenticSqlite` 库里（`agentic-memory/sqlite-store.ts`）：

```
life_entities(id, actor_id, kind, canonical_name, aliases_json,
              first_seen_at, last_seen_at, confidence, source_refs_json)
life_edges(id, actor_id, from_entity_id, to_entity_id, kind, sub_kind,
           intimacy, sentiment, valid_from, valid_to, status,
           confidence, source_refs_json)
life_edge_history(id, edge_id, at, intimacy, sentiment, trigger_ref, note)
life_patterns(id, actor_id, scene_tag, steps_json, preconditions_json,
              expected_outcomes_json, instances_json, warning_count,
              created_at, updated_at)          -- 承接 SchemaNode
life_beliefs(id, actor_id, claim, status, confidence,
             support_json, contradict_json, use_count,
             success_count, failure_count, updated_at)  -- 承接 belief
```

**为什么复用同一个库**：`memory-clear-service.ts` 的隐私级联（`purgeActor` 全家桶）天然覆盖，不用再补一段清理逻辑——隐私闭环不破。索引：`life_edges(actor_id, from_entity_id)`、`life_entities(actor_id, kind)`。

### 6.2 迁移（一次启动自动迁移，幂等）

1. **实体物化**：扫 `structured_facts`，把 distinct `entity` 建成 `life_entities` 行（含 user→self）。
2. **UserFact JSON → structured_fact**：读 `data/user_profiles/<actor>/` 的 facts，按映射表写入，补 `occurredAt = lastSeenAt`（保守回填，宁缺毋滥：无事件时间就留 null，不编造）。
3. **图式/信念落盘**：把内存缓存的 schemaCache / experienceLearning store 首次落盘（当前进程内的丢失不可追，从今往后持久化）。
4. **旧目录改名 `*.migrated`**（照 `travel-poi-db` 迁移的既有惯例），**不物理删除**，保留回滚窗口。

### 6.3 写入通道

- **热路径**：`structured-fact-store.ingest` 已在写事实时拿到 `entity`——同一次写入旁路建/更新 `life_entity` 与 `life_edge`（若语句含关系词「我妈/我朋友老王」）。
- **夜间固化**：`memory-consolidation-service` / nightly task 扫描当日证据，跑关系跳变检测（零 LLM）+ 轨迹点追加 + 实体去重合并（别名归并）。

---

## 7. 接线点（真实调用链，含召回通道）

> 原则（项目铁律「真实挂载」）：新能力必须接到入口/路由/注册/配置，旧实现真替换或彻底停用，不留死代码。

| # | 接线点 | 文件 | 动作 |
|---|---|---|---|
| 1 | **召回通道** | `brain/memory-cortex.ts`（recall，channels.push → arbitrateMemories） | 新增 `channel: "lifeModel"`，把实体/关系/轨迹命中作为一条通道并入仲裁（**已完成的读侧收敛**之上加一路，不新增旁路） |
| 2 | **仲裁 channel 枚举** | `brain/memory-arbitrator.ts` | `ChannelRecallResult.channel` 增加 `"lifeModel"`，配置权重与 domain 配额 |
| 3 | **装配** | `bootstrap/create-app-services.ts`（记忆认知块 L4306-4410） | 实例化 `LifeModelStore`，注入 `memory-cortex.setLifeModelStore(...)`；把 `schemaFormation / experienceLearning` 的内存 Map 换成落盘适配器 |
| 4 | **抽取写入** | `agentic-memory/structured-fact-store.ts` ingest | 副作用建实体/边（§6.3），复用同一 LLM 产物，零新增调用 |
| 5 | **prompt 注入** | `prompt-context-builder` + `agent-core` | 新增 `【用户关系一览】` block（如「妹妹·小满；好友·老王(近)；上司·陈」），带角色锚定头与无痕运用规则（禁元话语） |
| 6 | **显式查询工具** | 新 `life.manage` / `relationship.query` tool schema | 回答「我妹妹叫什么」「我和老王最近怎么样」，注册进 `CORE_TOOL_LIBRARY` 或 life 分类（对齐 `interest.manage` 先例） |
| 7 | **关系服务收敛** | `services/relationship-graph-service.ts` | warmth/rapport 映射为 `self_agent` 边；`getRelationshipSummary` 从「text blob」改为结构化边摘要，旧旁路删除 |
| 8 | **隐私级联** | `services/memory-clear-service.ts` | `purgeActor` 列表加 `lifeEntities/lifeEdges/lifePatterns/lifeBeliefs` |
| 9 | **用户 CRUD / 可见** | `routes/http/memory-crud.ts`、`profile-manage.ts` | 关系与实体可查可删；`profile-manage` 已读 `getActiveFacts`，扩展读 life_entities |
| 10 | **过时清理** | `routes/http/chat-data.ts` | 老人格画像 `UserFactStore` JSON 通道真停用（不留双写） |

**读侧单一出口保证**：lifeModel 与其他 7 条通道一样进 `arbitrateMemories`——归一化 + 跨通道指纹去重 + 通道权重重排 + minScore 阈值，一个都不绕。这与 2026-10-19 刚完成的「把 relationship/experienceLearning/forgotten 从仲裁后拼接改为并入仲裁」是同一条纪律。

---

## 8. 隐私边界

私人管家掌握的是「用户的生活」，含家庭、情感、健康、财务——隐私是产品能力不是附加项。

1. **本地优先**：Life Model 存本地 sqlite（`data/`），默认不出设备。
2. **静态加密（可选）**：敏感表（family/health/finance 级实体与边）支持静态加密；密钥本地托管。
3. **明确出境边界**：仅 `user` 主体、且非敏感分级的条目可进云端 LLM 上下文；assistant 自述永不进用户画像（沿用归属铁律）。
4. **敏感分级**：实体/边带 `sensitivity: normal | sensitive`；`sensitive` 只在用户主动提起该话题时准入（对齐 `prompt-assembler` 既有敏感规则）。
5. **可查可删**：`memory-crud.ts` 提供实体/关系查询与删除；`memory-clear-service.purgeActor` 级联清空；「忘掉我妹妹」→ 删实体 + 边 + 相关事实行。
6. **无痕运用**：注入块禁元话语（「根据我的记忆」「资料显示」），像老朋友一样自然运用（既有 `GLOBAL_MEMORY_RULE` 纪律）。

---

## 9. 分阶段演进路径

### P0 — 打地基（统一时间轴 + 落盘）
- 认知子模块产出落盘（`SchemaNode` / `episodes` / `beliefs` → sqlite 表）；
- `UserFactStore` 有 `occurredAt`，与 `structured_fact` 时间观统一；
- 实体物化（`structured_facts.entity` → `life_entities`）。
- **验收**：重启后图式/信念/实体仍在（`getAllSchemas` 非空）；`UserFact` 携带 `occurredAt` 且映射测试通过；旧 JSON 目录改名迁移成功。

### P1 — 社会关系图 + 用户↔Agent 边
- `life_edges` + `EdgeChangePoint`；关系词抽取建边；`relationship-graph` 收敛为 `self_agent` 边；
- 召回新增 `lifeModel` 通道进仲裁；`【用户关系一览】`注入；`life.manage` 工具。
- **验收**：`life.manage` 能答「我妹妹叫什么」；`【用户关系一览】`命中测试；仲裁器新增通道权重不劣化既有 8 通道 recall 指标；关系服务旧 text-blob 旁路已删。

### P2 — 轨迹演化 + 隐私分级 + 用户可见
- 关系跳变检测 → `changeLog` 追加；亲疏/情感轨迹叙事；敏感分级 + 静态加密；
- 记忆管理 UI 可查可删实体/关系。
- **验收**：构造亲疏跳变序列，断言 `changeLog` 追加且规则化（零 LLM）；敏感实体不出境（LLM 上下文断言）；「删妹妹」后实体+边+事实三清。

---

## 10. 收敛关系总图

```
       raw 经历 (journal/情景层)
              │ 提取
              ▼
   ┌───────────────────────┐   物化    ┌──────────────────────────┐
   │ structured-fact-store │ ────────▶ │  Life Model              │
   │ (KV + 双时间轴 + 链)   │           │  ├ LifeEntity (人/org/…) │
   └───────────────────────┘           │  ├ SocialEdge (关系图)    │
   ┌───────────────────────┐            │  │  └ changeLog (轨迹)    │
   │ schema / experience   │  落盘收敛  │  └ self_agent 边         │
   │ (内存 → 落盘)          │ ────────▶ │                          │
   └───────────────────────┘            └────────────┬─────────────┘
   ┌───────────────────────┐                         │ 作为一条通道
   │ RelationshipState     │ ──映射──▶ self_agent 边   │
   │ (用户↔Agent 标量)      │                         ▼
   └───────────────────────┘            ┌──────────────────────────┐
                                        │ memory-cortex.recall      │
                                        │  8 通道 + lifeModel ──▶   │
                                        │  arbitrateMemories (单一   │
                                        │  出口：归一/去重/配额)     │
                                        └──────────────────────────┘
```

---

## 附：关键文件索引

- 取回：`server/src/brain/memory-cortex.ts`（recall channels L1371-1478）、`server/src/brain/memory-arbitrator.ts`
- 固化事实：`server/src/agentic-memory/structured-fact-store.ts`（`StructuredFact` L54-85、`getActiveFacts` L815、`getPastFacts` L844）
- 认知子模块：`server/src/brain/memory-cognitive/memory-schema-formation.ts`（`schemaCache` L266）、`memory-experience-learning-loop.ts`（内存 store L169）
- 画像：`server/src/services/user-personalization/user-personalization-service.ts`（`RelationshipState` L76-84）、`user-profile-facts.ts`（`UserFact` L10-19）、`user-profile-store.ts`
- 关系：`server/src/services/relationship-graph-service.ts`
- 装配：`server/src/bootstrap/create-app-services.ts`（记忆认知块 L4306-4410）
- 隐私：`server/src/services/memory-clear-service.ts`、`server/src/routes/http/memory-crud.ts`、`routes/http/profile-manage.ts`
- 相关既有设计：`docs/agent-memory-soul-architecture.md`（画像 + 灵魂三层人格）
