# 工程铁律（2026-09-24 定稿）

本文是硬约束清单：合入前自查，评审对照。四条铁律 + 两条默认策略，全部来自真实事故或一线对标结论。

## 铁律一：出口收口 —— 任何绕过聊天管线的 LLM 出口必须自带收口

**背景**：三次同类事故（2026-09-22~24）——NEXT_UP 建议泄漏进任务面收尾、RENDER 协议泄漏进正文、早报正文泄漏 `[RENDER_HINT:brief]`。根因全部相同：提示词里的渲染协议/协议标记只在聊天面该出现，而新开一条 LLM 出口（任务面收尾、简报润色、电话口语）时没带对应的剥离/收口层。

**规则**：
1. 新增任何 LLM 调用出口（简报、任务收尾、主动推送、电话轮次、计划摘要……）时，默认**不注入**渲染协议提示词；确需结构化形态时，出口必须自带协议剥离层（参照聊天面三层修复与 TurnFinalizer 的程序层收口）。
2. 程序层强制（如 reply-style-gate）优先于提示词约束——prompt-only 收口已被多次证伪。
3. 自查问题只有一个：「这条出口的正文，用户会看到什么？」——把协议标记、内部指纹、NEXT_UP 尾巴当成用户可见内容审一遍。

## 铁律二：敏感动作分级 —— 外部副作用默认 handoff，先确认再动手

**背景**：对标 Muse（敏感操作前确认 + Sentinel 出口闸）与 Shopify Agentic Storefronts（协议开放、能力分级、默认不让 agent 碰支付）的一致结论：信任对 agent 是一碰就碎的资产（Muse 上线即遭 WSJ 信任质疑、iMessage 隐私事故）。

**规则**：
1. 动作分三档（`server/src/security/sensitive-action.ts`）：`read`（只读）/ `act_internal`（内部可撤销）/ `act_external`（触达外部世界）。
2. `act_external`（下单/支付/代发消息/外呼/代改外部账户）**默认 handoff**：自主推进路径（计划步骤自动推进、后台任务链）遇到外部动作必须停下转用户确认（GoalPlanner 的 awaiting_confirm 是参照实现）。
3. 新工具接入时按表登记分档；表外工具从严对待，不确定就当 `act_external`。

## 铁律三：凭据不进模型上下文 —— 凭据只进执行层

**背景**：Muse/1Password 模式（agent 发"用已存登录"指令但永远见不到明文）+ 本机 Playwright+Cookie 链路的现实风险：异常消息可能携带请求头/URL 查询串。

**规则**：
1. Cookie/密码/token 只允许出现在执行层（Playwright 浏览器上下文、HTTP 客户端签名函数）内部；工具返回值、错误消息、日志、审计文本不得出现凭据明文。
2. 所有拼接进工具返回值的错误消息，过一遍 `redactCredentials`（`server/src/security/redact.ts`）；结构性返回值用 `redactDeep`。
3. 联盟 API 凭据（淘宝客/京东联盟/多多进宝）只在本模块内读取 env + 签名，错误统一脱敏后上抛（official-price-source.ts 为参照）。
4. 授权边界在用户侧的动作（加购/下单/账号操作），不找服务器代劳的捷径；平台官方 agent 授权通道（如淘宝桌面 MCP）是唯一正门。

## 铁律四：用户事实单一权威源 —— 定字段只允许一个写入者，其余是投影

**背景**：2026-10-09 事故——用户说「以后叫我王哥」，agent 口头应下（读的是画像/KV，已是王哥），但桌面端问候仍显示旧称呼。根因不是「改不了」，而是同一份档案字段（称呼/职业/居住地/技术栈/生日/公司/学历）同时落在 **7 个地方**（结构化事实库 / USER_PROFILE.md / KV `user_profile` / KV `memory_facts` / KV `memory_preferences` / KV `user_profile_facts` / `data/user-facts/*.json`），每条链路各自独立写入、各自覆盖，任一处漏更就自相矛盾；写入闸门还漏判（L1 判了 `personal_fact`，但 `personalFact` 只接了召回、没接写入）。

**规则**：
1. **定字段的权威源唯一**：`structured_facts`（`server/src/agentic-memory/structured-fact-store.ts`）是称呼/职业/居住地等确定性字段的唯一权威，也是唯一写入者。新增档案字段在 `PROFILE_FIELD_ALIASES` 登记。
2. **其余位置只能是投影**：USER_PROFILE.md 的「基本信息」字段行由 `profile-fact-authority.ts` 重渲染（同字段只留一行、清别名行与行内历史注解）；KV 槽位不再保留档案字段副本；画像全文的 KV 副本必须与磁盘画像逐字一致。
3. **发现「某字段在别处又写了一份」时，不是加同步，而是接到权威源上**——加同步只会多一条会漂移的链路。
4. **存量漂移用一次性收敛清**：`npm run` 之外用 `cd server && node --import tsx scripts/reconcile-profile-facts.ts [actorId]`（幂等，可反复跑）；运行期由写钩子（字段变更去抖收敛）+ 夜间任务 + 启动收敛维持。

## 默认策略 A：降价监控/比价数据源 —— 官方 API 优先、浏览器兜底、注明来源时效

查价走联盟 API（服务器侧、零用户操作），Playwright+用户 Cookie 降级为兜底；比价卡与到价提醒必须注明数据源（official_api/browser）与抓取时效。参照 `shopping-compare-service.ts` 双通道。

## 默认策略 B：行为可审计 —— agent 做的事、在办的事、等确认的事，三本账对得上

新自动化能力（计划推进、后台代办、主动操作）落地时同步回答：用户问「你最近都干了什么」时，系统拿什么回答？答案是 `AuditTrailService` 聚合的台账（activity-store / goal-board / task-hub / pending-confirmations），新能力要么写进其中一本账，要么自己实现同级别的台账。参照 GET /agent/audit-timeline 与 activity.timeline 工具。
