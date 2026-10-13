# 旅行数据链路（采集 → 存储 → 供给）

> 2026-10-12 落地。回答一个问题：POI 信息、照片、底图这些数据，**怎么长期维护、随时更新**，
> 而不是每次规划都现去网上找一遍。

## 一、动手前先量化（三个硬事实）

用户反馈「每次现找不是长期方案」。先查量，再改：

| 事实 | 实测值 |
|---|---|
| POI 配图覆盖率 | **3.4%**（11 个目的地 / 436 个 POI，只有 15 个有图） |
| 图片引用形态 | 59 处**全是外链**，本地 0 |
| 存储形态 | `poi-cache`（11 份 JSON）+ `travel-media`（JSON + assets）两套并行 |

**根因排查（不是"源不够权威"，是"源不可达"）：**

```
commons.wikimedia.org/api.php   →  http=000  12.0s 超时（完全不可达）
zh.wikipedia.org/api.php        →  http=000  10.2s 超时（完全不可达）
cn.bing.com/images/async        →  http=200   0.55s（可达且快）
```

而 `travel-planning-service.ts` 的 POI 配图链路**只走 Wikimedia**（geosearch + 文本搜索两段）。
后果是双重的：拿不到图（3.4%）**且**每个 POI 先白等一轮 10~12s 超时——后台回填是
3 并发 × 2 次重试，等于每个 POI 白烧 ~24s。

另一个发现：**SQLite 收敛层其实早就写好了**（`travel-poi-db.ts`，523 行，四表 + WAL +
旧数据迁移），但**全仓库零引用**——`data/travel-poi.db` 从未被创建。所以"上数据库"
不是引入新技术栈，而是把现成的接上（`server/data/human-memory.sqlite` 已在用 SQLite）。

## 二、四层改造

### P0 配图源：可达性优先，而不是权威性优先

`travel-planning-service.ts` 的 `fetchRealImages` 增加「阶段 0」：

1. **宿主注入的搜索端口**（`upstreamSearchService.searchImages`：API 优先、cn.bing.com
   兜底、结果转存 PNG）——由 `create-app-services.ts` 注入
2. 未注入/失败 → **内置必应抓取**（`fetchBingImages`）
3. Wikimedia 降为兜底，且**带可达性探测**：一次 3s 轻量探测判定，结论缓存 10 分钟。
   不可达时后续 POI 直接跳过，不再逐个白等超时。

结果：单 POI 从 **24s（超时×重试）降到 0.3s**，行程内 POI 配图 **3/13 → 13/13**。

### P1 SQLite 成为权威源

`poi-cache-manager.ts` 与 `travel-media-store.ts` 的持久化从「每城市一个 JSON 文件」
切到 `travel-poi.db`：

| 表 | 内容 |
|---|---|
| `cities` | 目的地 + 中心坐标 + `access_count` / `last_accessed_at`（刷新服务据此排优先级） |
| `pois` | POI 结构化列（查/排序用）+ `payload_json`（**完整原始对象，图片随它落库**） |
| `media_pois` | 媒体条目头（`poiKey` = `type:name` 确定性键） |
| `media` | 图/评/视频各行，`payload_json` 存各自结构 |
| `meta` | 迁移标记等 |

旧 JSON 由 `migrateLegacyJson()` 一次性导入，目录改名 `*.migrated` 保留（可回滚）。
迁移结果：**11 城 / 436 POI / 40 条媒体**，与迁移前完全一致。

### P2 照片本地化（内容寻址）

照片必须落本机：网搜给的是第三方外链（新浪/携程/去哪儿/图虫…），会失效、会防盗链。
写入路径改为「先下载、再登记」：

```
data/travel-media/assets/poi-<sha1(poiKey)[:12]>/<sha256(字节)[:16]>.<ext>
```

- **内容寻址**：同图不同链只存一份（旧实现按 URL 哈希，同图不同链会存多份）
- **`originUrl` 保留**：溯源 + 外链失效时回溯
- 单张失败只降级那一条（保留外链），不牵连其余
- 对外只暴露 `/travel/media/assets/<dir>/<file>`（两级路径，中文不进文件名）

新增两个方法：`localizeAndAttach`（新增图时本地化）与 `materializeEntryImages`
（存量原地替换，不产生「外链+本地」双份）。

### P3 底图离线包

瓦片缓存原本是「被动 LRU + 事后预热」，缺的是**范围覆盖与完整度结论**。
新增 `packDestination(destination, points)`：

- **概览层**（z6/8/10/11）：按行程点集的外接矩形（含 10% 余量）整块覆盖
- **细节层**（z12/13/14）：按 POI 周边覆盖
- 输出清单 `data/tile-cache/packs/<slug>.json`：`total / ready / fetched / failed / complete`

排查中修掉两个真 bug（表现为「预热了一批但一大半 404」）：

1. **镜像被当成多份数据**：样式里 tiles-a/b/c/d 四个 host 承载**同一份瓦片**，
   全用会让每个格子被请求 4 次 → `pickPrimaryTemplates` 只取一个 host
2. **瓦片模板被当静态资源直接请求**：带 `{z}/{x}/{y}` 的模板要先实例化，
   直接请求只会 404；sprite 同理（它是 `sprite.json`+`sprite.png`+`@2x` 四件套）；
   样式里 URL 还带代理注入的 `&v=2`，须先剥掉

另外 **Carto 免费底图最高 z14**，更高缩放由 MapLibre overzoom 承担，不再下载 z15（必然 404）。

## 三、运维入口

```bash
# 数据健康快照（城市/POI/图片/本地化率/库大小/热点）
curl -s localhost:3000/travel/data

# 把仍是外链的图片抓成本机资产（幂等，可反复跑）
curl -s -X POST localhost:3000/travel/data/refresh -H 'Content-Type: application/json' \
     -d '{"mode":"localize"}'

# 对某目的地缺图的 POI 重抓一轮
curl -s -X POST localhost:3000/travel/data/refresh -H 'Content-Type: application/json' \
     -d '{"mode":"media","destination":"杭州"}'

# 底图离线包：列表 / 补建
curl -s localhost:3000/travel-basemap/offline
curl -s -X POST localhost:3000/travel-basemap/offline -H 'Content-Type: application/json' \
     -d '{"destination":"杭州","points":[{"latitude":30.2489,"longitude":120.1492}]}'
```

- 维护任务**互斥**：已有任务在跑时返回 `409`（避免叠加打满外网）
- 启动后 **45s 自动跑一次存量本地化**（`TRAVEL_DATA_AUTO_LOCALIZE=off` 可关）
- 行程载荷下发时自动建/补离线包（`POST /travel-plans`）

验收脚本：`node scripts/probe-travel-data-pipeline.mjs`（一条命令给出四层判定）

## 四、验收结果

```
【P1 权威源 · SQLite】城市 11  POI 436  媒体 42  库 4.5 MB
【P0+P2 配图与本地化】图片 137  本地 109 → 79.6%
【P3 底图】瓦片 4,021 个 / 133 MB；离线包「杭州」共 51 已有 51 失败 0 → 离线可用

✓ P0 配图可用   ✓ P1 数据在库   ✓ P2 图片本地化过半   ✓ P3 至少一个离线包完整
```

回归：`node --import tsx --test test/travel-*.test.ts` → **119/119 通过**。

## 五、已知限制

- 本地化率 79.6%：剩余 28 张外链是下载失败（防盗链/死链），**保留外链而非删除**——
  这些图仍可能显示，只是不保证长期可用。重跑 `localize` 会再试一次。
- 离线包只保证「概览 + 站点周边」，**不覆盖两个站点之间的沿途走廊**（那需要按路径
  buffer 取瓦片，量级大一个数量级）。断网时缩放/拖动出范围会看到空白。
- 跨岛/跨省类目的地的 bbox 过大时，单级超过 400 格会**整级跳过概览**并告警——
  宁可少一层概览，也不打满外网。
- 媒体库的 `reviews` / `videos` 目前仍为空（没有抓取源），本次只把存储与本地化打通。

## 六、相关文件

| 文件 | 职责 |
|---|---|
| `server/src/skills/travel-planning/travel-poi-db.ts` | SQLite 权威源（五表 + 迁移） |
| `server/src/skills/travel-planning/poi-cache-manager.ts` | POI 缓存（内存加速 + 写穿 DB） |
| `server/src/skills/travel-planning/travel-media-store.ts` | 媒体库（本地化 + 内容寻址） |
| `server/src/skills/travel-planning/travel-data-refresh.ts` | 维护服务（存量本地化/快照/按目的地重抓） |
| `server/src/skills/travel-planning/travel-planning-service.ts` | 配图多源链路 + Wikimedia 探测跳过 |
| `server/src/services/travel-tile-cache.ts` | 瓦片缓存 + 目的地离线包 |
| `server/src/routes/http/travel-data.ts` | `/travel/data` 运维入口 |
| `server/src/routes/http/travel-map.ts` | `/travel-basemap/offline` 等 |
