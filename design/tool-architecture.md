# NEXTBOT 工具架构与全量清单

> 自动生成（2026-11-20 08:11）——数据源：capability-modules 代码枚举 + mcp-servers.json + residency.ts + skill-bundles.ts。

## 一、架构总览

```
模型每轮看到的 tools = ①常驻可视面（residency.ts，单一声明源）
                    + ②延迟目录桥（tool_discover / tool_search / tool_call）

① 常驻可视面  = 基础设施(6) + 对话高频(4) + 时点性刚需(2) + 任务车道(11)
② 延迟目录    = 22 个能力域 / 118 个工具 + 13 个 Skill 包（意图粒度索引）
                   └ 发现方式：skill 名 → 整族 / 域名 → 单域 / query → 语义检索
```

**四条不变量**：①每个工具要么可见要么在目录；②目录 = 不可见全集（无需额外分层）；③新增常驻只改 residency.ts；④首轮冻结可视面，动态扩展走 grow 名单。

## 二、常驻可视面（residency.ts）

| 工具 | 车道 | 为什么常驻 |
|---|---|---|
| `clock.get_user_location` | chat+task | 时间/定位感知，几乎每轮 |
| `web_search` | chat+task | 复合检索（天气/行情/图片/视频/热搜/深搜 action 合一） |
| `web_fetch` | chat+task | 网页正文抓取 |
| `agent` | chat+task | 子 Agent 委派 |
| `brain.recall` | chat+task | 记忆回溯 |
| `obs_recall` | chat+task | 压缩结果的原文读回（服务每轮被折叠的工具输出） |
| `calendar` | chat+task | 日程/提醒唯一入口 |
| `phone` | chat | 手机号查询（口语召回不稳，进目录即嘴硬“没权限”） |
| `world.link` | chat+task | Agent World 链接 |
| `profile.update` | chat | 用户画像自编辑（进目录模型会忘记搜、谎称已记） |
| `ride_hailing.quote` | chat | 打车报价：选点卡续报价入口，错过窗口整单失效 |
| `ride_hailing.book` | chat | 打车两阶段确认下单，同理（status/cancel 低频留目录） |
| `task.dispatch` | chat+task | 任务派发 |
| `task.status` | chat+task | 任务状态 |
| `task.cancel` | chat+task | 任务取消 |
| `perception.overview` | task | 感知总览 |
| `browser.session.list` | task | 后台浏览器会话 |
| `desktop.visual.screenshot` | task | 桌面截图 |
| `code.run` | task | 代码执行 |
| `code.write_file` | task | 写文件 |
| `code.read_file` | task | 读文件 |
| `tool_discover` | task | 延迟目录发现桥（chat 车道由 prepareTools 自动注入） |

## 三、Skill 包 → 域 → 工具（13 包 / 22 域 / 118 工具）

### `ride`（打车出行）· 4 个工具

> 叫车/打车报价与下单（含上下车点选择、两阶段确认、行程追踪/取消）

| 域 | 说明 | 工具 |
|---|---|---|
| `ride_hailing` | 打车/网约车（统一预订抽象层） | `ride_hailing.quote` `ride_hailing.book` `ride_hailing.status` `ride_hailing.cancel` |

### `travel`（城际出行）· 5 个工具

> 机票/火车票/酒店搜索、比价、下单与行程售后

| 域 | 说明 | 工具 |
|---|---|---|
| `travel_booking` | 机票/火车票/酒店预订（统一预订抽象层 + 多源报价比价） | `travel_booking.search` `travel_booking.book` `travel_booking.status` `travel_booking.cancel` `travel_booking.refund` |

### `local_life`（本地生活下单）· 17 个工具

> 餐厅订座、家政上门、电商购物下单与跨平台比价（含降价监控）

| 域 | 说明 | 工具 |
|---|---|---|
| `restaurant_booking` | 餐厅预订（统一预订抽象层） | `restaurant.search` `restaurant.book` `restaurant.status` `restaurant.cancel` |
| `home_services` | 家政/本地生活预订（统一预订抽象层） | `home_service.search` `home_service.book` `home_service.status` `home_service.reschedule` `home_service.cancel` |
| `shopping_order` | 购物/下单（后台无头浏览器代用户下单） | `shopping.order.search` `shopping.order.place` `shopping.order.track` `shopping.order.cancel` `shopping.order.list` `shopping.pay.submit` `shopping.pay.check` |
| `shopping_compare` | 购物比价（跨平台同款比价 + 降价监控 + 保险/服务调研对比） | `shopping.compare` |

### `finance`（财务记账）· 18 个工具

> 导入流水、消费分析、预算设定与账单管理（只读优先，写操作两阶段确认）

| 域 | 说明 | 工具 |
|---|---|---|
| `finance_deep` | 财务深度能力 | `finance.import_transactions` `finance.analyze_spending` `finance.set_budget` `finance.get_budget_status` `finance.reconcile` `finance.categorize` `finance.export_report` `finance.list_subscriptions` `finance.confirm_subscription` `finance.update_subscription` `finance.cancel_subscription` `finance.savings_summary` `finance.add_bill` `finance.list_bills` `finance.update_bill` `finance.pay_bill` `finance.bills.sync_now` `finance.bills.auto_fetch` |

### `phone_call`（电话代办）· 6 个工具

> 代拨真实电话：预约、确认、回电

| 域 | 说明 | 工具 |
|---|---|---|
| `phone_call` | 电话代办（代拨真实电话：预约/确认/回电） | `phone_call.prepare` `phone_call.start` `phone_call.status` `phone_call.finish` `phone_call.list` `phone_call.cancel` |

### `media`（影音娱乐）· 8 个工具

> 音乐搜索与播放控制、AI 图像生成

| 域 | 说明 | 工具 |
|---|---|---|
| `media_music` | 媒体音乐播放控制 | `media.search` `media.play` `media.pause` `media.resume` `media.stop` `media.now_playing` `media.login_status` |
| `image_gen` | 图像生成（text-to-image） | `image.generate` |

### `docs`（文档与消息）· 7 个工具

> 本地文件读写/PDF·Office 解析/导出，邮件与短信发送

| 域 | 说明 | 工具 |
|---|---|---|
| `file_doc` | 文件/文档处理（read/write/parse/export） | `file.read_text` `file.write_text` `file.parse_pdf` `file.parse_office` `file.export_format` |
| `email_sms` | 邮件/短信主动发送 | `email.send` `sms.send` |

### `web_ops`（网页操作）· 9 个工具

> Agent 虚拟浏览器多步操作、与用户共用浏览器（点击/输入/读页）

| 域 | 说明 | 工具 |
|---|---|---|
| `agent_browser` | Agent 虚拟浏览器（通用网页多步操作） | `agent_browser` |
| `shared_browser` | 共用浏览器（用户与 Agent 共用客户端浏览器） | `shared_browser.navigate` `shared_browser.control` `shared_browser.click` `shared_browser.type` `shared_browser.scroll` `shared_browser.read_page` `shared_browser.export_state` `shared_browser.trusted` |

### `code`（代码执行）· 6 个工具

> 沙盒内跑 Python/Node、读写工程文件（任务面执行主力）

| 域 | 说明 | 工具 |
|---|---|---|
| `code_sandbox` | 代码执行沙盒（python / node） | `code.run` `code.shell` `code.list_files` `code.read_file` `code.workspace_map` `code.write_file` |

### `planning`（目标与计划）· 10 个工具

> 长期目标拆步与自主推进、会话内多步计划（写/改/重排）

| 域 | 说明 | 工具 |
|---|---|---|
| `goal_planning` | 计划推进（长期目标拆步+自主推进+动态重排） | `goal.plan.create` `goal.plan.list` `goal.plan.advance` `goal.plan.step` `goal.plan.replan` `goal.plan.abandon` |
| `task_plan` | 任务计划（会话内多步 + 长期目标统一入口） | `plan.write` `plan.set_status` `plan.replan` `plan.read` |

### `social`（社交发布）· 6 个工具

> 在外部平台发布/评论/转发/点赞（对外动作需明确授权）

| 域 | 说明 | 工具 |
|---|---|---|
| `social_outreach` | 社交主动出击（外部平台） | `social.post` `social.comment` `social.repost` `social.like` `social.get_feed` `social.search_posts` |

### `memory`（记忆治理）· 4 个工具

> 定向遗忘、行为时间线回查、事件回忆与画像校正

| 域 | 说明 | 工具 |
|---|---|---|
| `memory_governance` | 记忆治理（定向遗忘 + 行为审计 + 事件回忆） | `memory.forget` `activity.timeline` `memory.recall` `profile.update` |

## 四、复合工具（一个 schema 多 action，省 token 的主力）

| 工具 | 覆盖的 action / 子能力 | 说明 |
|---|---|---|
| `web_search` | web / weather / quote(行情) / images / images_batch / videos / find_video / parse_video / hot / deep | 检索+天气+行情+媒体五族合一的常驻入口 |
| `phone` | number（号码查询/拨号意图） | 手机号与语音入口 |
| `calendar` | create / update_task / delete_task / list_tasks | 日程/提醒唯一入口 |
| `profile.update` | 画像字段结构化写入 | 自编辑，缺失即谎称已记 |
| `brain.recall` / `obs_recall` | 记忆回溯 / 压缩原文分页读回 | 感知类只读 |
| `tool_discover` | domain(skill/域) / query / name / include_schema | 延迟目录唯一发现桥（domain 可直接传 skill 名） |

## 五、MCP 外部工具（独立于能力域，按 server 分组）

| server | 状态 | 工具族 | 说明 |
|---|---|---|---|
| `didi` | 启用 | 滴滴官方 MCP：网约车（taxi_estimate/taxi_create_order/taxi_query_order/taxi_cancel_order/taxi_get_driver_location/taxi_generate_r… | 滴滴出行 |
| `luckin` | 启用 | 瑞幸咖啡官方 AI 开放平台 MCP（https://gwmcp.lkcoffee.com/order/user/mcp，Streamable HTTP）：8 个工具覆盖点单全流程——queryShopList 查门店 / searchPr… | 瑞幸咖啡点单 |

> 滴滴 13 个工具中 10 个已接（封装在 `ride` skill 的 ride_hailing.* 之下，裸 `mcp.didi.*` 对模型不可见，避免绕过选点卡抽象层）。

## 六、分类维度速查

| 分类 | 判定 | 数量 | 举例 |
|---|---|---|---|
| 常驻工具（每轮可见） | residency.ts 声明 | 22 | calendar、ride_hailing.quote、web_search |
| 域（延迟目录内部切分） | capability-modules 的 domain 字段 | 20 | ride_hailing、finance_deep、code_sandbox |
| Skill 包（意图粒度） | skill-bundles.ts 声明 | 12 | ride、travel、local_life、web_ops |
| 复合工具 | 一个 schema 多 action | 6 | web_search、phone、calendar |
| MCP 外部工具 | mcp-servers.json 注册 | 2 servers | didi(13)、luckin(8) |
| 技能族工具（运行时注册） | self-programming skills | 动态 | travel.pickup-* 等，自动进目录 |