# 桌面端「行迹」行程界面（旅行 Agent 桌面端）

设计源：用户提供 `C:\Users\Administrator\Desktop\旅行Agent桌面端规划\desktop.html`（595 行自包含设计稿）。

落地形态：**行程独立系统窗口**里的整页 WebView，页面 = `server/web/travel-map/desktop.html`
（`GET /travel-map/desktop`）。与「行程卡 → 打开行程规划」是同一条链路：

```
行程卡「打开行程规划」/ autoOpen
      │  main.dart _openTravelPlanWindow
      ▼
TravelPlanWindowLauncher（spawn 子进程，信箱轮询换载）
      ▼
travel_plan_window.dart：无边框窗口（1140×740，设计稿尺寸）
      ▼
TravelWebPanelHost → WebView2 → GET /travel-map/desktop?host=1
      ▼
window.__travelPanel.loadPlan(payload)   ← 真实行程（Dart 桥注入）
```

- 桌面端**不再**用系统浏览器打开行程（2026-10-11 收敛）：此前「独立窗口 + 网页」两条路并存，
  是用户报的「有两种打开方式」。手机端仍走应用内浏览器（webview_windows 不支持移动端）。
- 无边框窗口：页面自带设计稿的自绘标题栏（三色按钮 + 拖拽区），系统标题栏会重复，
  所以窗口去边框，拖动/最小化/最大化经 `notifyHost({event:'windowDrag'|'minimize'|'maximize'})`
  → `TravelWebPanelController.onWindowAction` → `windowManager`。

## 与设计稿的差异（有意为之）

| 项 | 设计稿 | 落地 | 原因 |
|---|---|---|---|
| 外壳 | 深色桌面上浮着圆角窗口盒 | 面板铺满窗口（`100vw/100vh`，无圆角/投影） | 真实窗口由系统提供边界；外层桌面背景是展示壳 |
| 标题栏 | 静态文案「行迹 · 杭州 2 日」 | 动态「行迹 · {目的地} {N} 日」，三色按钮可用 | 1:1 版面 + 真窗口可用 |
| 天数胶囊 | 固定 Day 1 / Day 2 | 按行程天数生成（>4 天自动收窄字号） | 7 天行程常见 |
| 天气胶囊 | 固定 26° 晴 / 24° 多云 | 演示数据沿用；真实载荷无天气字段则整枚隐藏 | 不编造天气读数（项目「数据诚实化」） |
| 停留时长 | 手写 base 分钟 | 载荷有 `duration` 用它；否则按相邻时刻差推，再兜底 45 分 | 载荷字段缺失时不臆造 |
| 时间锚点 | `anchor`（午餐/日落不动） | 一律留空（不显示锚点徽章） | anchor 语义只有 Agent 侧能定 |
| 交通 leg | 手写 `EDGE` | 有 `leg` 用它；否则按坐标估（<1.2km 步行 / <4km 骑行 / 其余打车），上限 180 分 | 跨岛长距离用市区车速会算出十几小时 |
| 地图 | 固定 viewBox 560×720 + `slice` | **MapLibre 真实底图**（Carto 暗色矢量，经本机 `/travel-basemap` 代理） | 2026-10-12 用户定调：示意底图看不出真实路线 |
| 路线 | 手绘折线（设计稿示意） | `/travel-route` 真实路网几何；首次打开白线**依次连接**（逐段生长）→ 连完转流光 | 同上；「依次连接」是用户指定的呈现方式 |
| 地图底图 | 西湖/西山抽象水系 | Carto dark-matter 矢量（瓦片/精灵/字形全部磁盘缓存 + 载荷到达即预热） | 真实坐标必须配真实底图才读得懂 |

## 真实地图（2026-10-12）

左栏「路线地图」由示意 SVG 换成 MapLibre GL：

- **底图**：`/travel-basemap/style/dark` → Carto dark-matter 矢量，内部 URL 已被服务端改写成
  `/travel-basemap/fetch*` 白名单代理（磁盘缓存 134MB 级 + SWR），弱网/离线可复现。
- **站点**：`days[].entries[]` 里带 `latitude/longitude` 的站按真实经纬度落 Marker
  （编号 + 名称，点击切站；`hotel` 等 stay 类型以圆点表示）。**无坐标的站不上图**——
  地图不是排布示意图，凑位置等于造假。
- **路线**：页面把当天的坐标序列交给 `GET /travel-route?stops=lat,lng;…`，服务端逐段调
  OSRM 开放路网，**按段自动选 profile**（<1.5km 步行 / <4km 骑行 / 其余驾车），返回
  GeoJSON 线段。任一失败只丢该段（前端用直线补，图例显式写「N 段未接路网」）。
- **动画**：首次打开某天时，白线从第一站开始**逐段生长**依次连接所有站；全部连完转为
  白色流光线（`line-dasharray` 循环推进）。回看已播过的天直接落线 + 流光，不重播。
- **数据回填**：真实路网的距离/耗时回填到 `EDGE`，底部「下一站」与右栏时间轴、
  「预计结束」全部改用实测值（此前是 haversine 估算，与地图对不上）。
- **底图可辨识度**（2026-10-12 补）：Carto dark-matter 原样有两处致命伤——水域 `#2C353C`
  与陆地 `#0e0e0e` 贴在一起（西湖在屏幕上就是一片黑），湖名在 z13 只有 9px 灰字；
  且地名按 zoom 切字段，z<13 全用 `{name_en}`（整张图是 XINGYI / Pingdong 这类拉丁文）。
  页面加载样式后只调 paint/layout（不动几何与数据）：
  ① 水域提成湖青 `#17414F`、水岸压深，湖面一眼可辨；
  ② 湖名 z13 提到 15px 并提亮、描边压深；
  ③ `place_* / watername_* / roadname_*` 三类图层的 `text-field` 统一成
  `coalesce(name, name_zh, name_en)` → 中文行程配中文地名（兴义那一屏出来就是
  「兴义市 / 坪东街道 / 万丰街道 / 则戎镇」）；
  ④ 叠加**目的地水印**（复刻设计稿的 `alab`：城市名 + 当天线路名），深色地图上
  「这是哪」直接有答案。
- **定位兜底**：站点坐标优先（`fitBounds` 到当天范围）；一个都没有时退回载荷的
  `center`（目的地），不会停在一个不相干的默认点。`(0,0)` 视为「未知中心」哨兵
  （服务端 `center: knownCenter ?? {0,0}` 会产生它），当真实坐标用会把地图甩到几内亚湾。
- **冷启动**：拿到载荷即 `POST /travel-basemap/warm`（只发坐标）让服务端后台预热瓦片；
  地图视图用 `map-loading` 占位，首屏瓦片真正画出（`idle`）后才撤，避免几秒纯黑被当成卡死。

### 验收

`node scripts/probe-travel-map-real.mjs`（需本机 server 在 3000）。脚本跑三段：
① 杭州西湖环线（真实经纬度）—— 断言地图就绪 / Marker 数 = 有坐标的站 / 图例给出
真实距离与来源 / `routeFeatures` 全为 `real:true`；② 换兴义 —— 断言视野与地图水印
都跟着换（回答「对应地点的底图」）；③ 无站点坐标但有 `center` 的载荷 —— 断言底图
仍落在目的地。截图落在 `shots/`（连接中 / 连接中后段 / 完成 / 兴义 / 无坐标）。

## 载荷字段（`days[].entries[]`）

读：`name / type / time / duration / description / priceInfo / tips / address / images /
latitude / longitude / optional`；兼容行程仓库形态（`days[].items[]` + `startTime` +
`visitDuration`，见 `normalizePlan`）。
可选：`weather`（天气胶囊文案）、`signal` + `signalNote`（Agent 侧感知结论）。

缺图时按需向 `/travel-poi/details` 取真实实拍（与 mobile.html 同源接口），取不到走深青渐变兜底。

## 截图

- `ref-design-source.png` —— 设计稿原页（1140×740 窗口盒）渲染，对照用
- `impl-1-now-real.png` —— 真实行程（马尔代夫 7 天）· 今日视图
- `impl-2-map-real.png` —— 真实行程 · 路线地图（坐标投影 + 路线）
- `impl-3-demo-fallback.png` —— 无宿主载荷 · 演示数据兜底（= 设计稿版面）
- `impl-4-map-demo.png` —— 演示数据 · 路线地图
- `impl-5-signal-rain.png` —— 信号重排（下雨：户外收起进备选）

## 已知限制

- 同一天内多站地理上聚簇时（如楼外楼与孤山相距 300m），Marker 标签会互相压住——
  MapLibre 无自动避让，极端聚簇场景需要人工错位或聚合，当前不做。
- 演示数据（`var DEMO=`，无宿主载荷时兜底）只有设计稿的示意坐标、没有经纬度，
  因此**演示模式下地图视图没有站点与路线**（真实地图拒绝用假坐标凑位置）。
  要看地图请走真实载荷。
- 行程页暂不消费 `showRouteCard` / `drawRoute` / 已选路线（桥 API 保留兼容）。
  旧的桌面双栏页 `panel.html` 已于 2026-10-11 删除，其 MapLibre 底图与实时路线
  规划能力已于 2026-10-12 补进本页左栏「路线地图」。
- 手机端 `mobile.html` 未同步改造（手机已走原生行程页 `travel_plan_mobile_page.dart`）。
- 「偏好」左栏图标仍是 toast 占位（设计稿即为占位）。
