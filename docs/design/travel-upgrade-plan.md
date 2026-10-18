# 旅游功能双端升级方案 — 电脑端深度攻略 × 手机端行中伴侣

> 2026-10-18 · 状态:待评审
> 核心思想:**一个大脑,两端分工**。电脑端做"攻略生产"(细致、沉浸、可执行),手机端做"行中伴侣"(接驳、天气、当日跟随)。两端共享同一套 POI 库、规划服务与用户画像,攻略在电脑端生成后自动成为手机端行中功能的数据源。

---

## 1. 现状盘点(基于代码事实)

| 模块 | 已有 | 缺口 |
|---|---|---|
| 行程数据结构 `ItineraryItem` | 逐站交通衔接 transportFromPrev、tips、bookingNote、餐厅 avgPrice/cuisine、真实价格、3DGS | 无网红度/出片/漂亮饭维度;无"交通大段"(航班/高铁)概念 |
| 偏好 `TripPreferences` | seaside/pool/kids/elderly/pace/budget/cuisine/hotelTier | 无 photoDriven(出片向)、无体验向信号、无同行人结构 |
| POI 库 travel-poi.db | cities/pois/media_pois/media 四表,Wikimedia 图片、高德/OSM 评分 | 无社交热度字段、无"机位/漂亮饭"标签 |
| 用户画像 UserFact | category/key/value/confidence 结构化事实台账 | 无旅行类别(旅行风格/饮食/是否自驾/出片偏好) |
| 主动推送 | mapping-rules 确定性规则(meeting_soon 先例)+ FrequencyGovernor kind 注册 + evening-digest-scheduler 动态时刻 | 无接驳提醒 kind;无行程感知的调度源 |
| 手机端 Flutter | travel_plan_archive 行程存档、行程卡、briefing 页 | 无行中模式:无接驳确认、无当日行程卡、无导航跳转 |
| 电脑端 Web | travel-map/desktop.html 行中地图页 + 已确认的规划主界面设计稿 | 攻略展示形态未升级(清单式,非剧本式) |

## 2. 画像引擎 — "动态决定"的基础

不硬编码性别标签,用**偏好信号 + 画像置信度**驱动,性别只是冷启动先验。

### 2.1 三层数据源
1. **UserFact 扩展 travel 类别**(落 `user-profile-facts.ts` 抽取规则 + 台账):
   - `travel_style`: photo_driven(出片向)/ experience_driven(体验向)/ checkin_driven(打卡向)/ relax_driven(躺平向)
   - `diet`: 辣/甜/素/清真等
   - `drives_own_car`: bool → 决定是否需要接驳提醒
   - `travel_companion`: 情侣/闺蜜/家庭/独自 → 影响节奏与项目
2. **InterestWatcher 已有链路**:对话中提到"喜欢拍照/爱探店/钓鱼/徒步" → interest.manage 入库 → 规划 prompt 注入。
3. **历史行程隐式反馈**(新增):`travel-plan-store` 记录"推荐了什么/用户删了什么/改了什么",下次规划作为权重信号——**用户用脚投票,比口述更真实**。

### 2.2 冷启动与动态修正
- 首次规划时 Agent 最多问 2 个关键问题(如"更想出片还是想玩得尽兴?和谁一起去?"),答案写入 UserFact,此后不再重复问。
- 用户中途改行程(删掉网红点换成博物馆)= 强信号,立即更新 `travel_style` 置信度。

## 3. 电脑端 — 攻略工作室

### 3.1 数据层升级(POI 库扩字段)
`pois` 表新增(全部"宁缺毋滥",拿不到就不展示,沿用项目不造假原则):

| 字段 | 含义 | 来源 |
|---|---|---|
| social_heat | 热度档位 hot/mid/none + 来源标签 | UpstreamSearchService 聚合"地名+抖音/小红书"搜索结果,定性判断 |
| photo_score | 出片指数 1-5 + 最佳机位描述 + 最佳时段(黄金时刻) | 搜索聚合 + LLM 归纳,标注"供参考" |
| pretty_food | 漂亮饭标签:环境出片/摆盘/人均/排队预估/招牌菜 | 同上;排队数据拿不到就不写 |

回填脚本仿 `scripts/seed-travel-poi-db.ts` 增量模式,先跑已入库 18 城。

### 3.2 攻略生成升级 — 从"清单"到"剧本"
`travel-planning-service` 规划 prompt 重写,产出结构化剧本(所有内容仍是结构化字段,不是自由散文,保证可渲染可交互):

- **每日主题线**:如"Day1 老城漫游·出片日 / Day2 海岛躺平日",给行程叙事感。
- **每站四件套**(在现有 transportFromPrev/tips 基础上扩展):
  - `why`:一句话种草(为什么去,30 字内)
  - `photoTip`:机位/穿搭/时段建议(出片向用户)
  - `pitfall`:避坑提示(排队时长、门票陷阱、拍照要收费等)
  - `alternative`:同区域备选(已有)
- **三个横向清单**(新增聚合视图):出片清单(全部机位+时段)、漂亮饭清单(按餐段排好)、避雷清单。
- **人群差异化路由**(由 2.1 画像驱动):
  - photo_driven:餐厅侧重漂亮饭,景点侧重机位与光线,节奏放缓留足拍照时间
  - experience_driven:侧重体验型项目(运动/驾驶/科技馆/特色玩法),效率优先,标注排队预估与替代方案
  - 混合型按同行人结构混排

### 3.3 电脑端展示(在已确认的主界面设计上扩展)
- 攻略产出页改为**四 Tab 结构**:行程时间轴 / 出片清单 / 漂亮饭 / 实用信息(签证·电压·紧急·随身物品,已有 TravelInfo 直接复用)。
- **机位地图**:MapLibre 底图上 POI 按 photo_score 分色标注,点击看机位描述。
- **照片墙**:Wikimedia 已落盘资产按天铺开,海报区沿用 coverImage。
- 电脑端定位是"规划前的工作台",不做行中实时功能——行中交给手机端。

### 3.4 与小红书的差异化(立身之本)
| 小红书攻略 | 本方案 |
|---|---|
| 营销文/情绪文,不可执行 | 结构化数据:逐站时间轴+真实评分价格+营业时间+预订提示 |
| 一篇攻略所有人通用 | 画像驱动,千人千面,且随历史行为进化 |
| 看完还要自己做 Excel | 预算总表(pricingSummary 已有真实价格)+ 交通衔接自动算 |
| 规划结束就完了 | 攻略→行中跟随→回程→沉淀偏好,全链路闭环 |
| 图片是精修摆拍 | Wikimedia 实拍 + 数据质量标签(real/knowledge/synthetic)明示可信度 |

## 4. 手机端 — 行中伴侣

### 4.1 交通段模型 + 接驳提醒(核心新增)

**数据模型**:`PlanningResult` 新增 `transferSegments[]`:
```ts
interface TransferSegment {
  type: 'flight' | 'train';
  role: 'arrival' | 'departure';   // 到达目的地 / 离开返程
  flightNo_or_trainNo: string;
  depTime: string; arrTime: string; // 票面时间
  from: string; to: string;
  needPickup?: boolean;             // 用户已确认需要接驳
}
```

**时间来源**(三个入口,不强迫用户):
1. 规划对话中 Agent 问一句"高铁还是飞机?把车次/航班号发我" → 文本或截图(视觉模型已有,vision 链路可读订单截图);
2. 用户在行程存档里手动补一条;
3. 检测不到就不提醒——**宁可不服务,不可瞎打扰**。

**触发规则**(mapping-rules 新增,仿 meeting_soon 的"提前量+去重+模板"模式):
- 高铁 `role=arrival`:**到站前 30min** 推送"快到站了,需要我帮你预约一辆去酒店的滴滴吗?"(沿途有网,可实时推)
- 航班 `role=arrival`:**起飞后推一次**确认接驳意向(此时未断网)→ **落地时刻**推送叫车入口(落地恢复网络,靠 WS 重连补投送达,好友消息已有 replayed 补投先例)
- `role=departure`(返程):按酒店→机场/车站路程 + 路况,出发前 90-120min 提醒"该出发了,需要叫车吗?"
- `drives_own_car=true` 的用户全部跳过。

**调度器**:新建 `transfer-watch-service.ts`(仿 evening-digest-scheduler 的每分钟 tick 模式),扫描未来 7 天行程的交通段,动态计算触发时刻。

**推送链路**:ProactivityHub 新 kind `transfer_reminder` → FrequencyGovernor 注册(冷却 60min、每日预算 6,保证"问了就不再问")。

**滴滴实现(已接入,直接真实下单)**:项目已接入滴滴官方 MCP(McpClientService 别名 didi,沙箱/生产可切)+ `ride_hailing.quote/book/status/cancel` 工具族(book 支持两阶段确认,scheduleAt 支持预约单)。接驳流程:到点推提醒 → 用户点"要" → **Agent 直接走 ride_hailing.quote → ride_hailing.book(scheduleAt 预约单)真实下单** → status 持续追踪司机位置,全程对话内闭环,无需跳转第三方 App。

### 4.2 行中天气
- 行程期间的每一晚(挂在已有晚报调度或独立 trip_weather kind),推送"明天行程天气":逐日天气 + 当天行程适配提示(如"明天有雨,Day2 的海岛日建议和 Day4 对调")——**天气不止预报,还要联动行程给动作建议**,这是差异点。
- 当日行程卡顶部常驻当天天气胶囊(数据已有 dayWeather)。

### 4.3 当日行程与打卡跟随
- **当日卡**:手机端会话页顶部插入当日时间轴简卡(下一站大字突出 + 一键导航 deep link 到高德/百度地图)。
- **打卡清单**:攻略里的出片清单/漂亮饭清单在手机端变成可勾选 checklist,勾选同步回 travel-plan-store,行程结束后生成"本次打卡 X/Y"小结,同时沉淀进画像(去了网红点且好评 → photo_driven 加权)。
- 到站检测:LocationCoordinator 已有 GPS 按需请求链路,检测到抵达目的地城市 → 推"欢迎卡:今天玩什么"。

## 5. 技术落点清单(文件级)

| 改动 | 文件 |
|---|---|
| TripPreferences 扩展 photo/experience 信号 | `server/src/skills/travel-planning/travel-planning-service.ts` |
| 规划 prompt 升级(剧本式+每站四件套+transferSegments 采集) | 同上(prompt 段) |
| POI 表加 social_heat/photo_score/pretty_food + 回填脚本 | `poi-cache-manager.ts`、`scripts/seed-travel-poi-db.ts` |
| UserFact travel 类别抽取规则 | `server/src/services/user-personalization/user-profile-facts.ts` |
| transfer_reminder 规则 + kind 注册 | `server/src/proactivity/mapping-rules.ts`、`frequency-governor.ts` |
| 接驳调度器(新文件) | `server/src/services/transfer-watch-service.ts` |
| 行程隐式反馈沉淀 | `server/src/skills/travel-planning/travel-plan-store.ts` |
| 电脑端四 Tab 攻略页 + 机位地图 | `server/web/travel-map/`(desktop.html 及配套) |
| 手机端当日卡/接驳确认卡/打卡清单(接驳确认后走 ride_hailing 真实下单) | `client/flutter_app/lib/features/chat/travel_plan_archive.dart` 等 |
| 天气联动行程建议 | 复用 weather-service + 晚报调度扩展 |

## 6. 分期交付

- **P1 电脑端攻略升级**:画像 travel 类别 → POI 热度/出片/漂亮饭字段 → 剧本式攻略 → 四 Tab 展示。验收:同一目的地,切换"出片向/体验向"画像,产出结构明显不同;每个推荐有真实数据支撑。
- **P2 手机端接驳闭环**:交通段模型 → transfer-watch-service → transfer_reminder 推送 → 手机端确认卡 → 用户确认后 Agent 经 ride_hailing.quote/book(scheduleAt)真实下单 + 行中天气。验收:模拟高铁 30min 后到站,手机端准时收到接驳询问;航班场景断网重连后补投可达;确认后沙箱下单链路真实可跑。
- **P3 体验完善**:当日卡+导航跳转、打卡清单闭环、攻略导出长图、历史行程隐式反馈反哺画像。

## 7. 边界与原则
- 所有"网红/出片"数据是**搜索聚合的定性参考**,标注来源,拿不到就不展示——宁缺毋滥,不造假(项目既有铁律)。
- 推送克制:接驳提醒是"场景必需"才发,频控兜底;用户拒绝一次,该段行程不再问。
- 坐标数字禁止出现在任何用户可见内容(经纬度禁令沿用)。
