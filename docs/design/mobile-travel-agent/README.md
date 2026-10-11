# 行迹 · 手机端行程规划界面（设计稿）

Private-Agent 手机端「旅游卡片 → 进入界面」的设计稿。设计原型来自
`C:\Users\Administrator\Desktop\旅行Agent移动端规划\`（index / detail），
本目录是其**手机版**在仓库内的落位 + 演示载荷 + 评审长图。

> 桌面版（`desktop.html`）按需求已移除，本目录只保留手机版。

## 文件

| 文件 | 说明 |
| --- | --- |
| `mobile-home.html` | 主界面（一屏一站）。可交互：呼出地图、上滑全程抽屉。实时信号只由 Agent 侧推入呈现，页面无手动上报控件 |
| `mobile-detail.html` | 站点详情页。`?stop=<id>&day=<n>` 定位到具体站 |
| `plan-data.js` | **真实行程数据**（生成物，勿手改），由 `tools/build-plan.mjs` 从服务端真实行程仓库生成。加 `?empty=1` 看空态 |
| `tools/build-plan.mjs` | 真实行程仓库 → `plan-data.js` |
| `tools/shoot-design.mjs` | 渲染本目录设计稿，重出 `shot-*.png` + `mockup.png` |
| `tools/shoot-impl.mjs` | 走服务端真实行程仓库（`?planId=`）重出 `impl-*.png` |
| `shot-*.png` | 五屏截图（主界面 / 信号重排 / 全屏地图 / 全程抽屉 / 站点详情） |
| `impl-*.png` | **接入后手机实拍**（同五屏，走真实行程仓库 + 真实底图 + 真实 POI 实拍） |
| `mockup.html` / `mockup.png` | 五屏并排 + 设计令牌 / 结构 / 交互契约 / 落地映射 的评审长图 |

## 打开方式

直接双击 HTML 即可（`plan-data.js` 里的真实行程会自动注入）。想确认「无数据时的空态」，
打开 `mobile-home.html?empty=1`。刷新数据：`node tools/build-plan.mjs`。

## 设计要点

- **一屏一站**：放弃「时间轴 + 地图」分栏。竖屏一次只给当下这一站，地图不占屏、
  按需呼出、看完即收。
- **弹性旅程带**：每段宽度 = 停留时长 + 站间交通时长；Agent 调速时平滑伸缩，
  被收起的备选站渲染为虚线段。
- **Now 主卡**：实拍大图 → 时间档（时间锚点显式标注）→ Agent 的安排理由 →
  建议停留进度 → 下一站条 → 底部主按钮直达下一站。
- **按需全屏地图**：已走实线（带流动光效）+ 未走虚线，站名常驻；底部停当前站，
  可一键转「看全程」抽屉。
- **全程抽屉**：78% 上滑，Day 切换 + 时间轴列表 + 「AGENT 暂时收起 · 可请求加回」。
- **站点详情**：大图头图 + 时间档 + 事实 chip + 安排理由 + 介绍/亮点/贴士/实用信息
  + 到达·下一站动线。

视觉上只有一个强调色（琥珀 `#F5A552`），数字与时间用 Sora，正文 Noto Sans SC，
底色 `#0B0C0E`、卡 `#17191F`、圆角 22px。

## 交互契约（前端只呈现，不做规划）

```
PA_TRAVEL_SET_PLAN(plan)      注入每轮规划 → 整页重渲染
PA_TRAVEL_SIGNAL(ev, note)    Agent 侧感知（步速/位置/天气/对话）后推入，页面只被动重排
PA_TRAVEL_REQUEST_ALT(id)     请求把 Agent 收起的备选站加回
```

**时间锚点由 Agent 侧保护**，页面不自行改动已锚定时间。

## 落地（已接入仓库）

### 服务端

| 位置 | 说明 |
| --- | --- |
| `server/web/travel-map/mobile.html` | 移动端页本体（首页 / 站点详情 / 全屏地图 / 全程抽屉 合成单页 SPA） |
| `server/src/routes/http/travel-map.ts` | `GET /travel-map` 按 UA 分流；`GET /travel-map/mobile` 强制移动版 |

- **取数**：`?planId=<planId>` 读服务端**真实行程仓库** `GET /travel/plans/:planId`
  （手机端默认，客户端传卡片自带的 planId）；`?id=<planId>` 同源取回内存载荷；
  `?host=1` 由宿主桥 `window.__travelPanel.loadPlan` 注入（桥 API 与桌面 `desktop.html` 同名，
  客户端可复用）。
- **分流**（2026-10-11 起）：`MOBILE_UA_RE` 命中手机 UA → `mobile.html`，否则桌面 `desktop.html`
  （旧的双栏页 `panel.html` 已删除）；
  显式覆盖 `?mobile=1` / `?desktop=1`。响应带 `Vary: User-Agent`（同一 URL 两种页面）。
- **零外部依赖**：MapLibre 走本地 `vendor/` 内联；底图走已有代理
  `/travel-basemap/style/dark`（Carto dark 矢量样式，内部 URL 已改写到本地瓦片缓存）；
  无坐标时回落 SVG 弹性动线。站间连线由前端直连绘制，**不请求外部路由服务**。

### 客户端

`TravelPlanBrowserLauncher`（`client/flutter_app/lib/features/chat/travel_plan_browser_launcher.dart`）
按平台分流进入方式：Android / iOS 用 `LaunchMode.inAppBrowserView`（应用内浏览器，
不离开 App；不可用时退系统浏览器），Windows 桌面保持 `externalApplication`。

### 载荷适配（`mobile.html` 内 `adaptPayload`）

现有载荷 `{destination, center, days:[{label, subtitle, entries:[…]}]}` → 本稿视图模型
`days[].stops[]`：

| 视图字段 | 来源 | 备注 |
| --- | --- | --- |
| `start` | `entry.time` 解析（ISO / `HH:mm` / `HH:mm-HH:mm` / 时段词） | 缺失按上一站 + 停留 + 交通递推 |
| `duration` | `entry.duration` 或时间范围差 | 缺失按下一站间隔推算，兜底 45 分 |
| `leg` | `entry.leg` | **缺失时按两站坐标估算**（<1.2km 步行 / <4km 骑行 / 其余打车） |
| `loc` | `entry.latitude/longitude` | 无坐标 → 地图回落 SVG |
| `tag/kind` | `entry.type`（attraction/restaurant/hotel/transport） | 映射景点/餐饮/住宿/交通 |
| `detail.*` | `description / tips / priceInfo / address / highlights / hours` | 空节自动隐藏 |
| `anchor`（时间锚点） | `entry.anchor` | **需 Agent 侧回填**，前端不臆造 |
| `alts`（收起的备选） | `entry.optional` 或 `day.alts[]` | 需 Agent 侧回填 |

### 已知项

- 底图样式自带 sprite 走代理会 404（`fetch@2x.json`），只影响厂商 POI 图标，
  与本站点标记（DOM Marker）无关，地图与连线正常。
- 站点图片只用行程自带的**真实 POI 实拍**（服务端 `/travel-poi/details` 补齐）；
  拿不到图时页面回落暗色渐变，不塞任何占位/假图。
- 主动改时间的语义（时间锚点 / 停留时长 / 站间交通）属 Agent 侧职责；前端只呈现，
  收到回填字段即优先采用。
- 实时信号由 Agent 侧感知后经 `applySignal` 推入；页面没有手动上报 UI。

## 备注

- 早先的 `docs/design/mobile-travel-plan-redesign/`（自拟风格版）已被本稿取代。
