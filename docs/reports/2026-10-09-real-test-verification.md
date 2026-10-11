# 真实环境全量测试验证报告

- 日期：2026-10-09 23:1x
- 范围：时间锚 / 时效准入 / recap 衰减 全量改动（P0/P1/P2）的**真实环境回归验证**
- 结论：**本次改动零回归**。12 条失败全部为改动前既有失败，已用纯净 HEAD 基线对照证明。

## 一、真实运行环境确认

| 项 | 值 |
|---|---|
| 打包 runtime `windows_dist/installer-staging/runtime/node.exe` | **v24.18.0** |
| `node_modules/better-sqlite3` 原生模块 ABI | 按 Node 24 编译（NODE_MODULE_VERSION 137） |
| 受管 Node（`.workbuddy/binaries`） | v22.22.2（ABI 127，**与原生模块不匹配**） |

→ 项目真实测试必须用 Node 24。用受管 Node 22 跑会凭空多出 **137 条** `NODE_MODULE_VERSION 137` 伪失败（上一轮即踩此坑）。

## 二、真实全量结果

命令：

```bash
cd server && "D:/nodejs/node.exe" --import tsx --test --test-timeout=30000 "test/**/*.test.ts"
```

| 指标 | 数值 |
|---|---|
| 用例总数 | 2598 |
| 通过 | 2584 |
| 失败 | **12** |
| 取消 | 1 |
| 跳过 | 1 |
| 耗时 | 91.7s |

> 必须带 `--test-timeout=30000`：裸跑 `npm test` 会被无超时用例挂住（>40min 不退出）。

对比上一轮（受管 Node 22）：失败 145 → 现在 12，减少的 133 条全部是 sqlite ABI 伪失败。

## 三、12 条失败归因（全部为改动前既有）

| 类别 | 条数 | 用例 | 根因（实证） |
|---|---|---|---|
| 真实时钟漂移 | 7 | `commitment-schedule-outlet` 5 条：active+未来 deadline 物化 / pending confirm 后物化 / deadline 变更反向改期 / 终态软取消 / 重复 persist 幂等 | `services/commitment-schedule-outlet.ts:37` 用**真实 `Date.now()`**：`if (deadlineMs <= Date.now() + MATERIALIZE_MIN_LEAD_MS) return null;`；测试把 BASE/deadline 写死为 `2026-09-24 ~ 09-27`，相对今天 2026-10-09 已过期 14 天 → 全部不物化 |
| 真实时钟漂移 | 2 | `ics-subscription`：首拉全量建日程 / 源改期与消失 | `services/schedule-task-service.ts:1087` `throw new Error("runAt must be in the future")`；测试固定日期已过期 |
| 外部依赖 | 2 | `memory-forgetting-controller`（集成：召回命中 downranked 反弹）、`human-like-memory-dreaming`（recall 标记 faded） | `[HumanLikeMemory] computeEmbedding 失败: embeddings HTTP 402 {"code":30001,"message":"Sorry, your account balance is insufficient"}` —— **embedding 额度耗尽** |
| 环境类 | 3（另 1 条超时记为取消） | `admin-console-loopback-gate`（actual 200 / expected 404）、`bill-management` 2 条（入账 actual 0 / expected 3500） | 公网 IP 门禁判定 / 记账入账路径，均与环境相关 |
| 超时 | 1（cancelled） | `shared-browser-coordinator`：invoke times out | 30s 超时未触发预期可重试错误 |

## 四、基线对照（决定性证据）

为排除"这 12 条是否由本次改动引入"，用 `git worktree` 拉取**完全不含本轮改动**的纯净 HEAD 树，跑同一批失败文件：

```bash
git worktree add ../pa-head HEAD --detach
cmd //c mklink //J "E:\ws-project\pa-head\node_modules" "E:\ws-project\Private-Agent\node_modules"
cd ../pa-head/server && "D:/nodejs/node.exe" --import tsx --test --test-timeout=30000 <7 个文件>
```

| | 纯净 HEAD（零改动） | 本轮工作区 |
|---|---|---|
| tests | 56 | 56（同批文件） |
| pass | 44 | 44 |
| fail | **12** | **12** |
| 失败清单重合度 | — | **12 / 12 完全重合** |

洁净性校验：worktree 中 `temporal-admission.ts` 不存在、`proactivity-types.ts` 的 `originAt` 计数 = 0。

补充证据：失败测试依赖的源码（`schedule-task-service.ts` / `commitment-schedule-outlet.ts` / `ics-subscription-service.ts` / `bill-management-service.ts` / `human-like-memory.ts` / `memory-forgetting-controller.ts`）**全部处于 HEAD 干净状态**，未被本轮改动触碰。

> 清理要点（防误删依赖）：必须先 `cmd //c rmdir <worktree>\node_modules` 摘掉 junction，再 `git worktree remove --force`。Windows 上 `rm -rf` 会跟随 junction 删掉主仓 node_modules。已校验主仓 `node_modules` 完好（417 项、`better_sqlite3.node` 存在）。

## 五、结论

1. 真实环境（Node 24）全量 **2584 / 2598 通过**，12 条失败经基线对照证明**与本次改动零关系**。
2. 12 条失败分三类：真实时钟漂移 7、embedding 额度不足 2、环境/门禁 3（+1 超时）。
3. 本次时间锚 / 时效准入 / recap 衰减改动**无回归**。

## 六、既有失败修复建议（另行安排）

1. **时钟漂移（7 条，优先）**：测试改用相对 `now` 的日期（如 `now + 1d`）而非写死 `2026-09-xx`；或让 `commitment-schedule-outlet` 接受注入时钟（与 `CommitmentBoard` 的 `() => new Date(nowMs)` 保持一致）。
2. **embedding 402（2 条）**：为测试环境配额度，或在单测中注入本地 embedding stub，避免测试依赖线上额度。
3. **admin / bill（3 条）**：核对门禁 IP 判定与本机网络环境，以及账单入账路径的预算联动断言。

---

附：本轮改动文件（10 源 + 3 测试 + 1 脚本）

```
server/src/services/conversation-rolling-summarizer.ts
server/src/external-model/chat-thread-store.ts
server/src/brain/working-memory-cortex.ts
server/src/proactivity/turn-aside-queue.ts
server/src/proactivity/triggers/conversation-triggers.ts
server/src/proactivity/temporal-admission.ts        (新增)
server/src/proactivity/proactivity-hub.ts
server/src/proactivity/proactivity-types.ts
server/src/proactivity/silence-log.ts
server/src/bootstrap/create-app-services.ts
server/test/temporal-anchor.test.ts
server/test/temporal-admission.test.ts              (新增)
server/test/turn-aside-queue.test.ts
server/scripts/probe-temporal-guard.ts              (新增)
```
