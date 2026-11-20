# 工具曝光层重构方案：归一为「可视面 + 延迟目录」

> **执行状态（2026-11-20 16:30 完成）**：P0/P1/P2/P3 全部落地并部署——关键词分类裁剪（selectRelevantTools / ALWAYS_INCLUDED_TOOLS / TOOL_CATEGORY_MAPPINGS / token 预算裁剪）已删除；CORE_TOOL_LIBRARY 分层（core-tool-library.ts / splitCoreAndDeferredTools / classifyToolExposureTier）已删除；contextual/light 档位统一走可视面装配。现存仅两个概念：可视面（residency.ts）+ 延迟目录（catalog + skill/域/query 三通道）。

> 2026-11-20 · 背景：`ride_hailing.quote` 因三套清单不同步导致「工具在手却看不见」，
> 用户定稿目标模型：**全系统只保留两个概念——可视面（Visible Face）与延迟目录（Deferred Catalog）**。

## 一、现状：3 个概念 + 4 个动态机制

| # | 机制 | 文件 | 职责 | 问题 |
|---|---|---|---|---|
| 1 | `CHAT_LANE_CORE_NAMES` / `TASK_LANE_CORE_NAMES` | `external-model/lane-tool-sets.ts` | 每轮可见面（官方定义） | 与 #2/#3 人工同步，已漏过 ride |
| 2 | `CORE_TOOL_LIBRARY`（perception/dialogue/desktop/browser…5 层） | `tools/tool-search/core-tool-library.ts` | 标为 core 的工具不进延迟目录 | 名字与 #1 混淆；概念冗余（见 §三.3） |
| 3 | `ALWAYS_INCLUDED_TOOLS` + `TOOL_CATEGORY_MAPPINGS` | `external-model/openai-compatible-tool-loop.ts` | 关键词分类裁剪的保底集（contextual/light 档，默认档） | 第三套"核心"语义；与 #1 重复 |
| 4a | 域预载 `buildDomainPreloadTools` | `lane-tool-sets.ts` | 按 BM25 域信号动态补可见面 | 合理，属可见面动态扩展 |
| 4b | 高频晋升 `buildPromotedChatTools` | 同上 | actor 近窗真实调用 ≥3 次常驻 | 同上 |
| 4c | media pin | `agent-core.ts` | 纯媒体轮钉住 web_search | 同上 |
| 4d | 工具面冻结 + grow 名单 | `openai-compatible-tool-loop.ts` | 冻结可见面保前缀缓存 | 同上 |

## 二、目标模型（两个概念 + 两个参数）

```
ToolExposurePlan =
  | { mode: "full";  }                        // 全量可见：任务面 / plan-execute / delegate(full)
  | { mode: "face";  pinned?: string[] }      // 可视面 + 延迟目录：默认对话面

VisibleFace(mode=face) = Resident(lane)
                       ∪ Pinned
                       ∪ Dynamic（域预载 / 晋升 / media pin）
DeferredCatalog        = Registry − VisibleFace          // 唯一一条拆分规则
```

**四条不变量：**
1. 每个工具在任意一轮**要么可见、要么在延迟目录**，不存在"两边都没有"（本次事故形态）。
2. 延迟目录的成员就是"不可见"的全集，**不需要额外的 core 分层来决定谁不进目录**。
3. 可视面只能通过 `resident` 声明与 `Dynamic` 两处增加，**任何新增常驻工具只改一个地方**。
4. 前缀缓存安全：可视面在会话首轮冻结，动态扩展经 `toolFaceGrowNames` 显式声明。

## 三、目标目录结构

```
server/src/tools/exposure/
  residency.ts        # 唯一声明源：resident 工具表（lane + reason + 可选前缀糖）
  visible-face.ts     # 组装可见面：resident ∪ pinned ∪ dynamic，含冻结/grow
  dynamic-additions.ts# 从 lane-tool-sets 迁入：域预载 / 晋升 / media pin
  deferred-catalog.ts # Registry − VisibleFace，BM25 索引（现 tool-search/catalog 改造）
  preload-feedback.ts # 原样保留（动态扩面的质量反馈）
  guard.test.ts       # 一致性守卫（见 P0）
```

**删除清单：**
| 删除对象 | 替代 |
|---|---|
| `CHAT_LANE_CORE_NAMES` / `TASK_LANE_CORE_NAMES`（作为独立常量） | `residency.ts` 的 lane 字段 |
| `CORE_TOOL_LIBRARY` 的 5 层 tier + `classifyToolExposureTier` | `resident` 二值语义（可见 / 延迟） |
| `ALWAYS_INCLUDED_TOOLS` | 其成员并入 `residency.ts`（它们本来就该是 resident） |
| `selectRelevantTools` + contextual/light 关键词裁剪分支 | `mode:"face"` 的统一装配 |
| `TOOL_CATEGORY_MAPPINGS`（作为曝光裁剪依据） | 保留其**分类数据**供失败提醒/提示词使用，但从曝光链路解耦 |
| `resolveExposureTokenBudget` / `trimToolsToTokenBudget`（曝光裁剪路径） | 可视面体积由 `residency` 评审控制；延迟目录天然不占 schema token |

## 四、分阶段迁移（每阶段独立可上线、可回滚）

### P0 · 一致性守卫（0.5 天，止血）
- 新增 `guard.test.ts`：断言 `residency` 声明的每个工具名都能在 registry 解析；断言可见面构造结果满足「可见 ∪ 目录 = 全集」。
- 顺手把 `toolFaceGrowNames` 的漏声明场景加进测试（历史事故：预载工具被冻结吃掉）。
- 收益：本次这类 bug 在 CI 直接红。

### P1 · 声明归一（1 天，零行为变化）
- 建 `residency.ts`：把三份清单合并为一张表，字段 `{ name, lanes: chat|task|both, reason, residentSince }`；前缀规则保留为声明糖（`"browser."` 展开为名清单，展开函数唯一）。
- `CHAT_LANE_CORE_NAMES` 等改为从该表派生（先保留旧导出名做薄壳，避免一次性改 20 个引用点）。
- 收益：手工同步彻底消失；ride 这类"声明漏层"结构上不可能再发生。

### P2 · 删除关键词裁剪路径（1.5 天，行为有变，需灰度）
- `resolve-chat-tools.ts` 的 profile 收敛：`explicit/full/delegate(full)` → `mode:"full"`；`contextual/light/scoped/none` → `mode:"face"`（scoped = `pinned` 参数）。
- 删除 `selectRelevantTools`、`detectRelevantCategoriesFrom`、`ALWAYS_INCLUDED_TOOLS`、token 预算裁剪分支。
- Providers 的 `toolExposureProfile === "contextual" | "light"` 判定改为 `mode === "face"`（3 个 provider 各一处）。
- 灰度：`TOOL_EXPOSURE_MODE=legacy|face` 环境开关，默认 legacy 一周，按 turn-trace 对比 TTFT / 工具召回率后翻默认。
- 验收：desktop / phone-bridge / disableToolSearch 轻量白名单三条降级路径的 e2e 全绿。

### P3 · 删除 core 分层（1 天，零行为变化）
- `catalog.ts` 的 core 拆分改为「在 VisibleFace 中即不进目录」——与新模型第 2 条不变量同构，行为等价。
- 删除 `CORE_TOOL_LIBRARY`、`isCoreToolRegistryName`、`classifyToolExposureTier` 及 gateway 重导出。
- 收益：延迟目录的成员定义只剩一条规则，不再有两套"核心"语义打架。

### P4 · 清理与文档（0.5 天）
- 删除 `toolExposureProfile` 旧枚举与各处注释里的"三处须同时在场"警告。
- 更新 `capability-modules/index.ts` 的接入文档：**新工具只需在 `residency.ts` 声明一次**。

**总计约 4.5 人日**，P0/P1/P3 零行为变化可随时上；P2 是唯一有行为差异的阶段（默认档从关键词裁剪变成域预载 + 目录发现），必须灰度。

## 五、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 去掉关键词裁剪后可视面变大 | schema token 涨（19→约 22-24 个） | residency 审查上限 24；域预载 cap 12 不变；前缀缓存冻结保证增量只在 grow 轮发生 |
| contextual 档是某些 provider 的默认 | 老 provider 行为变化 | 开关 + 灰度周；provider 内判定统一走 mode |
| 延迟目录召回不稳（CJK 口语变体，如"打个车"） | 工具找不到 | 保留域预载动态通道（P2 不动它）+ `tool_discover` domain 直取；BM25 之外可后续加 embedding |
| 工具面冻结与动态扩展冲突 | 预载工具被冻结吃掉（历史事故） | P0 守卫测试覆盖 |

## 六、验收指标

1. `visible ∪ deferred = registry` 恒成立（守卫测试）。
2. `turn-trace.visibleTools` 数量稳定在 20-24，回合间抖动 ≤ 2（冻结生效）。
3. prefix cache 命中率不低于重构前（当前会话稳定态 98%+）。
4. 「帮我打个车去梦乐城」这类口语变体 → `ride_hailing.quote` 调用率 ≥ 95%（回归样本集 20 条口语表达）。
5. 三条降级路径（desktop 离线段 / phone bridge / disableToolSearch）e2e 全绿。
