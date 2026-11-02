---
name: study-notes
description: >-
  把学习/会议/视频/读书/灵感等知识内容沉淀为本地笔记,并由 Agent 主动参与
  整理、摘要、抽问、复习提醒全流程。覆盖「记一下/整理笔记/总结这段/抽几道题/
  复习」等用户意图。存储为单用户本地 JSON，不进入 Agent World 经济与社交。
---

# 学习笔记 / 知识笔记

> 工具集合：`notes.create` / `notes.list` / `notes.get` / `notes.update` / `notes.delete` /
> `notes.search` / `notes.summarize` / `notes.flashcards` / `notes.quiz` /
> `notes.schedule_review`
> HTTP：`/notes` `/notes/:id` `/notes/search` `/notes/:id/summarize` 等

## 适用范围

- **学习**：课程笔记、读书摘录、视频字幕、概念速记
- **会议**：会议纪要、决策、行动项
- **内容沉淀**：长文摘要、关键引用、灵感闪念
- **复习**：基于已存笔记生成摘要/卡片/题目并安排提醒

## ⚠️ 状态连续性（最高优先级）

1. **写入前查重**：调 `notes.create` 之前先 `notes.search`，若标题完全一致或
   内容重合度高，应改走 `notes.update` 合并到现有笔记，而非创建重复条目。
2. **基于真实 id 操作**：`update` / `delete` / `get` / `summarize` / `flashcards` /
   `quiz` / `schedule_review` 必须使用 `notes.list` 或 `notes.search` 返回的
   真实 `id`；禁止凭用户口述构造 id。
3. **工具结果为准**：用户说"刚才那个"时，先 `notes.list` 看最近笔记、再询问
   用户想操作哪条，而非直接猜测。

## 工作流

### 1. 用户说"帮我记一下" / "记一下" / 给出要记的内容

```
1) notes.search({ query: 标题关键词, topK: 3 })
   - 若命中标题完全一致 → 改走 update（合并到现有笔记的 content 末尾）
   - 否则 → notes.create
2) 把用户原文作为 content；source 设为 "chat"；category 推断：
   - 学习/课程/书本 → study
   - 会议/讨论 → meeting
   - 视频/直播/字幕 → video
   - 读书/摘录 → reading
   - 灵感/闪念 → idea
   - 待办/行动项 → todo
   - 其它 → other
3) 返回 note.id 给用户
```

### 2. 用户说"整理一下刚才" / "整理笔记" / "把这段总结成要点"

```
1) notes.list 拿到最近/相关笔记 id
2) 调 notes.summarize({ id, force?: false })
   - 已有缓存（note.summary）会直接返回；force=true 重新生成
3) 若用户希望落库展示，告诉用户摘要内容 + 笔记 id
```

### 3. 用户说"出几道题考考我" / "抽几道题" / "考我"

```
1) notes.list 找到目标笔记 id
2) notes.quiz({ id, count: 3 }) 默认 3 道；用题目引导用户逐题作答
3) 用户给出答案后，可再次调 notes.quiz 重新生成，或继续对话讲解
```

### 4. 用户说"出几张记忆卡片" / "做成记忆卡"

```
1) notes.list 找到目标笔记 id
2) notes.flashcards({ id, count: 5 })
3) 把卡片列表发给用户；支持来回翻看
```

### 5. 用户说"提醒我复习" / "明早 9 点复习" / "下周提醒"

```
1) notes.list 找到目标笔记 id
2) notes.schedule_review({ id, runAt: ISO时间串, timezone, recurrence })
   - 内部走 calendar.create(kind=reminder) + notesService.markReviewed
3) 返回 taskId + nextRunAtLocal 给用户
```

## 工具速查

| 工具 | 何时调用 | 必填 | 选填 |
|------|---------|------|------|
| `notes.create` | 用户给一段要记的内容 | title, content | category, tags, source |
| `notes.list` | 任何「查看/列出笔记」 | （自动取 sessionId） | category, tag, limit |
| `notes.get` | 读单条详情 | id | — |
| `notes.update` | 改写、补充、合并 | id + 至少一个字段 | title, content, category, tags, source |
| `notes.delete` | 删除 | id | — |
| `notes.search` | 关键词查询（BM25 排序） | query | topK, category |
| `notes.summarize` | 总结要点 | id | force |
| `notes.flashcards` | 生成 q/a 记忆卡片 | id | count, persist |
| `notes.quiz` | 生成自测题 | id | count, persist |
| `notes.schedule_review` | 安排复习提醒 | id, runAt(ISO) | timezone, recurrence, reminderMessage |

## HTTP 端点（给前端/脚本直接调用）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/notes?sessionId=...&category=study` | 列表（过滤） |
| GET | `/notes/:id` | 详情 |
| POST | `/notes` | 创建 |
| PATCH | `/notes/:id` | 更新 |
| DELETE | `/notes/:id` | 删除 |
| POST | `/notes/search` | 检索 |
| POST | `/notes/:id/summarize` | 摘要（懒写回） |
| POST | `/notes/:id/flashcards` | 卡片 |
| POST | `/notes/:id/quiz` | 抽问 |
| POST | `/notes/:id/schedule-review` | 复习提醒 |

## 存储

- 路径：`data/notes.json`（所有 session 共享一份文件，按 sessionId 分组）
- 字段：`id / sessionId / title / content / category / tags / source? /
  summary? / flashcards? / quiz? / createdAt / updatedAt /
  lastReviewedAt? / reviewCount`
- 进程内缓存 + 启动时 `load()` 重建 BM25 索引
- 关键词检索：BM25 + 标题/正文包含加权 + token 重叠
- **不进入 Agent World**：不写到 `world.*`、不消耗世界点数、不分享

## 权限与沙箱

- 默认沙箱即可用（纯本地 + 复用现有 LLM provider）
- 无需「完全访问」、不读屏、不写桌面
- LLM 摘要/抽问/卡片：复用 `createExternalChatProviderFromEnv()`，
  provider 未配置时退化为本地启发式（不会报错）

## 排错指引

- **搜索无结果**：先 `notes.list` 看是否笔记根本未创建；确认
  `sessionId` 与当前会话一致（`resolveActorId(context)` 解析结果）
- **重复创建**：写入前必须 `notes.search` 查重；如已存在则 `update`
- **LLM 摘要空**：provider 未启用时会退化为"取前 280 字符"，提示用户
  配置 `EXTERNAL_CHAT_*` 环境变量获得更好质量
- **复习提醒失败**：`runAt` 须是合法 ISO 字符串；`recurrence` 必须是
  `none / daily / weekly`；sessionId 必须与笔记归属一致

## 笔记对话页（独立上下文 / 独立记忆）

笔记系统除了上述「写完之后用工具调用」的工作流外，还提供一个**独立对话页**，
让用户能"和 Agent 一起学习"，而不是先写再问。

### 入口

- Web 端：从主聊天页 (`/chat`) 侧边栏点「学习笔记」，或直接访问 `/chat/notes`
- Flutter 端：从「学习笔记」列表页右上角「和笔记 Agent 聊」按钮进入

### 上下文隔离机制（关键）

- 笔记对话的 WebSocket `session.init` 会发送
  `sessionId = userId = "notes:" + actorId`（与主对话 `actorId` 区分）
- 服务端 `isNotesChatSessionId()` 据此判定为 `context = notes`：
  - 聊天线程落盘到 `data/chat-threads-notes.json`（与主对话 `chat-threads.json` 物理隔离）
  - `agentic-memory` 把这一轮对话写入 `context=notes` 桶
  - 默认 `buildRecall` 仍只查 `main` 桶，不互相污染
- Agent 看到的是「自己的笔记 Agent」人格（与主 Agent 隔离开），但**底层
  使用同一组工具**（`notes.*` + `notes_chat.*`）

### 跨上下文记忆（重要能力）

虽然两个上下文相互隔离，但 Agent 在合适场景下可以**主动跨上下文召回**：

| 工具 | 调用者 | 用途 |
|------|--------|------|
| `notes.recall_history` | 主 Agent | 在主对话中拉取该 Actor 的 `context=notes` 记忆，补全背景 |
| `notes_chat.recall_main` | 笔记 Agent | 在笔记对话中拉取 `context=main` 关键结论 |
| `notes_chat.recall_history` | 笔记 Agent | 在笔记对话中拉取同 `context=notes` 之前的笔记对话要点 |
| `notes_chat.recall_main` | 笔记 Agent | 同上但拉 `context=main` |

调用方式（不需要查全表时优先用工具内联召回）：

```
// 在主对话中
notes.recall_history({ query: "数据库连接池", scope: "all" })
// scope: "notes" | "main" | "all"

// 在笔记对话中
notes_chat.recall_main({ query: "用户说过的项目方向" })
```

返回的每条结果会带 `[notes]` 或 `[main]` 标签，方便 Agent 判断来源。

### 笔记对话里的工作流

- 用户：「帮我把今天的学习整理成一条笔记」
  1. 笔记 Agent 先 `notes.search` 查重
  2. 不存在 → `notes.create` → 落盘
  3. 落盘后由 `chat.assistant_done` 钩子自动刷新侧边栏列表
- 用户：「我之前还说过这个」/ 「上次聊过数据库」：
  1. 笔记 Agent 先 `notes_chat.recall_main` 跨上下文确认
  2. 再 `notes.search` / `notes.list` 找到具体笔记 id
  3. 用真实 id 调 `notes.update` 合并，**禁止凭口述造 id**
- 用户：「3 天后提醒我复习」：走 `notes.schedule_review`，同主对话一致

### 排错（笔记对话特有）

- **消息没落盘到 notes 文件**：检查 `session.init` 里的 `sessionId` /
  `userId` 是否真的带了 `notes:` 前缀；客户端日志会显示 `boundActorId`。
- **跨上下文召回为空**：用户 `actorId` 与 `notes:` 命名空间一致才会匹配，
  默认只回 `topK=5`；可加 `topK` 参数扩展。
- **Flutter 端 ws 连接复用冲突**：每个 `NotesChatPage` 会创建独立
  `WsChatService`，与主聊天页完全隔离；不要在两个页面间共享同一个实例。
