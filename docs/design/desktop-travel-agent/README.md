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
| 地图 | 固定 viewBox 560×720 + `slice` | 按**实际可见窗口**重投影（`projectDay`） | slice 会切掉上下：宽窗口下站点会跑出屏外 |
| 地图底图 | 西湖/西山抽象水系 | 演示数据不变；真实数据只换水印文字为目的地 | 无地理底图数据，保持设计稿的示意风格 |

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

- 真实行程同一天内多站地理上聚簇时，地图标签会重叠（示意底图无避让算法）。
- 行程页暂不消费 `showRouteCard` / `drawRoute` / 已选路线（设计稿没有这部分）。
  旧的桌面双栏页 `panel.html`（带 MapLibre 底图与实时路线规划）已于 2026-10-11 删除；
  需要那套能力时从 git 历史取回，或在本页补进左栏 tab。
- 「偏好」左栏图标仍是 toast 占位（设计稿即为占位）。
