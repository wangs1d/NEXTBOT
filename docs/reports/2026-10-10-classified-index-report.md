# recap 分类索引视图落地与实测报告

日期：2026-10-10 00:15（工作跨 10-09 深夜至 10-10 凌晨）
范围：server/src（2 个源文件）+ server/test（2 个测试文件）+ server/scripts（1 个探针）

## 一、本轮改了什么

目标：把「模型自己从 recap 里翻旧账当现事说」（10-09 21:38「刚才你说好饿」事故）从
**提示词约束**升级为**确定性代码拦截**——即上一轮讨论的「分类索引」方案。

| 文件 | 改动 |
|---|---|
| `services/conversation-rolling-summarizer.ts` | 新增 `indexifyRecapForLlm`：瞬时状态条目（`RECAP_TRANSIENT_TOPIC_RE`）超过在途窗口（`RECAP_TRANSIENT_TTL_DAYS`，默认 1 天）→ **从注入视图剔除**；持久事项跨天未闭环 → 行尾策略位「勿主动提」；`UNCLOSED_OPEN_LOOP_RE` 补「尚待」。幂等、日粒度、仅视图层 |
| `external-model/chat-thread-store.ts` | `buildRecapLlmViewContent` 管线改为：年龄标注 → 分类索引（替换原 decay 调用；import 同步） |
| `test/temporal-anchor.test.ts` | 新增 F 段 6 例（瞬时识别 / 跨天剔除+当日在途保留 / 持久策略位 / 幂等 / TTL=0 回退 / 视图集成终验），E 视图层断言改用持久行 |
| `test/awareness-sleep-samples.test.ts` | 修午夜敏感假失败：样本时长手算补跨天进位 `(end-start+24)%24` |
| `scripts/probe-temporal-guard.ts` | 升级实测探针：终验「事故原话不得出现在注入视图」+ 分类标记输出 |

关键设计不变式（与前几轮一致）：

- **存储不动**：所有加工只发生在 `buildTimestampFreeLlmView` 的视图克隆上，
  `chat-threads.json` / `extractSessionRecapLines` / 事件去重零影响；
- **日粒度**：同一天内视图字节恒定 → prefix cache 不被打断，只跨天刷新一次；
- **TTL 在代码端执行**：瞬时条目（好饿/想吃/困/累/心情…）跨天根本不进上下文，
  不靠模型自觉；误杀面刻意收窄（「在忙装修」这类持续事项不剔除，只降级）；
- **可回退**：`RECAP_TRANSIENT_TTL_DAYS=0` 关闭瞬时剔除；
  `RECAP_STALE_LOOP_DROP_DAYS` 可开「未闭环超 N 天直接剔除」硬档。

## 二、实测结果（真实线程数据回放事故当刻 2026-10-09 21:38）

`node --import tsx scripts/probe-temporal-guard.ts`，读真实 `data/chat-threads.json`：

1. **注入层**：13 行真实 recap 中——
   - `[2026/10/08 22:07] 用户表示"好饿"，尚未决定今晚吃什么` → **从视图消失**
     （瞬时 + 跨天，TTL 剔除；模型无原话素材可说「刚才你说好饿」）；
   - `[2026/10/08 22:28] 兴义周末路线尚待确认` → 冷索引留存 + 策略位
     `（跨天未闭环 · 策略:勿主动提：仅当用户本轮主动提起才可承接…）`；
   - `[关键钉]` 逐字保留行、已闭环事实行原样保留；
   - 视图末尾补一行静态 `[时效索引] …用户主动提起时可按需检索历史原文`；
   - 存储隔离校验 true；终验断言：好饿/还没决定/吃什么 均不在注入视图 ✅。
2. **主动性层**（temporal-admission 闸，同前轮结论不回退）：
   - A 事故复现（23.5h 旧事 + 当轮话题不搭）→ **拦截** `irrelevant_to_active_topic`；
   - B 用户当轮真聊到吃饭 → 放行（承接能力保留）；
   - C 超保质期 71.5h → 拦截 `stale_topic`；
   - D 新鲜事件 / E 顺嘴过期升级 → 放行（既有行为不变）。

## 三、回归

- `tsc -p tsconfig.json --noEmit`：exit 0、零输出；
- 定向 12 套件 156 例全绿（含新增 F 段）；
- **全量（Node 24 真实运行环境，`--test-timeout=30000`）**：
  **2604 例 / 通过 2592 / 失败 10 / 取消 1 / 跳过 1，114s**。

剩余 10+1 条全部为已知基线（与本次改动无关，逐一核对过依赖）：

| 类别 | 条数 | 根因 |
|---|---|---|
| 承诺物化 | 5 | 测试写死 `2026-09-24~27`，相对今天已过期（真实时钟 vs 固定日期） |
| ICS | 2 | `runAt must be in the future`，同上 |
| admin / bill | 3 | 环境类（公网门禁 200≠404 / 入账 0≠3500） |
| shared-browser | 1（取消） | 30s 超时 |

与上一轮基线（2598 例 / 败 12）对比：**零新增失败**；memory/embeddings 402 的
2 条本轮自愈通过（外部额度波动）；另修复 1 条午夜敏感测试假失败。

## 四、对「好饿」类事故的最终状态

两条路径现在都被**确定性代码**封住，不再依赖提示词纪律：

1. **模型自翻 recap**（事故实际路径）：瞬时旧事的**原话已不在上下文里**——
   没有素材，说不出「刚才你说好饿」；持久旧事带日期+策略位，最多说
   「你 X 天前提到 X 还没定」（这是正确行为）。
2. **主动性模块复活旧事**：temporal-admission 闸按年龄 + 话题相关性拦截并留痕。

残余窗口：同一自然日内的更早时刻（如今天早上说饿、晚上被提）仍在在途窗口内
——这属于正确行为（当天的事当天可承接），且句式有年龄标注兜底。

## 五、回滚开关

- `RECAP_TRANSIENT_TTL_DAYS=0`：关闭瞬时剔除（回退到只标注+策略位）
- `RECAP_STALE_LOOP_DROP_DAYS=N`：未闭环超 N 天直接从视图剔除（默认 0）
- `PROACTIVITY_TEMPORAL_ADMISSION=0`：关闭主动性准入闸
