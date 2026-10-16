# Agent 能力认知系统 - 完整实现

## 📋 概述

本次更新让 **Agent 完全知道自己拥有的所有能力**，包括：
- ✅ World 状态和技能
- ✅ 虚拟电话能力
- ✅ 钱包与支付
- ✅ 日历与日程管理
- ✅ 天气查询
- ✅ Agent间通信
- ✅ AIP协议
- ✅ 视觉识别
- ✅ 桌面自动化
- ✅ Web浏览
- ✅ 生活助手
- ✅ 协议统一管理
- ✅ Agent账号管理

---

## 🔄 文件重命名

### 原文件名
```
server/src/agent/world-agent-capabilities.ts
```

### 新文件名
```
server/src/agent/agent-capabilities.ts
```

**原因**：这个文件不只是关于"World Agent"的能力，而是包含**所有Agent的通用能力**，所以改名更准确。

---

## 📝 核心修改

### 1. 函数名更新

**旧名称：**
```typescript
export function isWorldCapsPromptEnabled(): boolean
export function buildWorldCapabilityPromptSection(...)
```

**新名称：**
```typescript
export function isAgentCapsPromptEnabled(): boolean
export function buildAgentCapabilityPromptSection(...)
```

### 2. 引用更新

**文件：** `server/src/services/agent-core.ts`

```typescript
// 旧导入
import {
  buildWorldCapabilityPromptSection,
  isWorldCapsPromptEnabled,
} from "../agent/world-agent-capabilities.js";

// 新导入
import {
  buildAgentCapabilityPromptSection,
  isAgentCapsPromptEnabled,
} from "../agent/agent-capabilities.js";
```

---

## 🎯 新增能力说明

在 System Prompt 中新增了 **【你的核心能力清单】** 部分，包含 11 大类能力：

### 生成的 System Prompt 示例

```
【你的核心能力清单】
💡 以下是你拥有的所有内置工具和能力，可以根据用户需求主动调用：

1️⃣ 【钱包与支付能力】
可用工具：
- wallet.get_balance: 查询真实资金钱包余额
- wallet.transfer: 向其他Agent转账（需要配对验证）
- wallet.get_transactions: 查看交易记录
- wallet.recharge: 充值到钱包
提示：可用于管理用户资金、处理支付请求

2️⃣ 【日历与日程管理能力】
可用工具：
- calendar.create_from_text: 从自然语言创建日程（如"明天下午3点开会"）
- calendar.create_task: 创建任务提醒
- calendar.list_tasks: 查看待办事项列表
提示：可帮助用户管理时间、设置提醒、安排会议

3️⃣ 【天气查询能力】
可用工具：
- weather.get_local: 获取本地天气预报
提示：可提供天气信息、出行建议

4️⃣ 【Agent间通信能力】
可用工具：
- world.link.send_message: 向好友Agent发送站内消息（仅限好友关系）
提示：需要双方完成配对才能通信

5️⃣ 【AIP协议能力】
可用工具：
- aip.dispatch: 分发任务到其他Agent
- aip.list_my_state: 查看当前Agent状态
- aip.get_proposal: 获取协作提案
提示：用于多Agent协作场景

6️⃣ 【视觉识别能力】
可用工具：
- vision.http_pull: 从HTTP地址拉取图像进行分析
- vision.periodic_start: 启动周期性视觉监控
- vision.periodic_stop: 停止视觉监控
- vision.periodic_list: 查看正在运行的视觉监控任务
提示：可分析屏幕内容、监控变化

7️⃣ 【桌面自动化能力】
可用工具：
- desktop.visual.screenshot: 截取电脑屏幕（或指定区域）并返回 PNG 图片
- desktop.visual.run_task: 执行桌面视觉自动化任务（VLM驱动键鼠操作）
提示：可截取屏幕查看内容、操作用户桌面、自动执行任务

8️⃣ 【Web浏览能力】
可用工具：
- web.search: 执行网络搜索
- web.fetch: 获取网页内容
提示：可帮助用户查找信息、浏览网页

9️⃣ 【生活助手能力】
可用工具：
- budget.calculate: 计算预算和收支
- shopping.suggest: 提供购物建议
- reminder.plan: 制定提醒计划
提示：可提供生活建议、财务管理

🔟 【协议统一管理能力】
可用工具：
- protocol.unified.quota_adjust: 调整计算配额
- protocol.unified.memory_patch: 更新记忆
- protocol.unified.memory_get: 获取记忆
- protocol.unified.human_directive: 接收人类指令
- protocol.unified.governance_probe: 治理探测
提示：用于系统级管理和配置

【虚拟电话能力】
✅ 您的虚拟联络号：123456（登记在 Agent 名下，与您共用）
三种通路：
- Agent↔Agent：phone.virtual_call（双方均须已申领联络号）
- Agent→用户：phone.call_user
- 用户→Agent：App 内呼叫（不必再输 6 位号）

【其他 Agent 的虚拟电话】
- 拨打另一 Agent 前，对方 Agent 也须已申领 6 位号码
- 与用户通话不要用 virtual_call，用 phone.call_user 或等用户来电
```

---

## 💡 Agent 获得的关键认知

### 1. 完整的能力地图
Agent 现在知道：
- ✅ 自己有 11+ 大类能力
- ✅ 每个类别下有哪些具体工具
- ✅ 每个工具的用途和使用场景
- ✅ 什么情况下应该使用哪个工具

### 2. 主动服务能力
Agent 可以：
- 🎯 根据用户需求主动推荐合适的工具
- 🎯 解释自己为什么选择某个工具
- 🎯 在用户不知道某些功能时主动介绍
- 🎯 组合多个工具完成复杂任务

### 3. 错误处理能力
当工具调用失败时，Agent 知道：
- 🔍 可能的原因是什么
- 🔍 如何解决或绕过问题
- 🔍 是否有替代方案

---

## 🧪 测试场景

### 场景 A：用户询问能力
```
用户："你能做什么？"

预期 Agent 回答：
"我拥有多项能力，包括：
1. 钱包管理：查询余额、转账、查看交易记录
2. 日历管理：创建日程、设置提醒
3. 天气查询：获取本地天气预报
4. 虚拟电话：申领号码、拨打语音电话
5. 视觉识别：分析屏幕内容
6. 桌面自动化：执行自动化任务
7. Web浏览：搜索信息、获取网页内容
8. 生活助手：预算管理、购物建议
...等等

请问您需要哪方面的帮助？"
```

### 场景 B：用户提出需求
```
用户："帮我查一下明天的天气"

预期 Agent 行为：
1. 识别到天气相关需求
2. 知道可以使用 weather.get_local 工具
3. 调用工具获取天气信息
4. 返回结果给用户
```

### 场景 C：用户不知道某功能
```
用户："我想给另一个Agent打电话"

预期 Agent 回答：
"要打给其他 Agent 的话，我先确认您是否已申领虚拟联络号…"
[调用 phone.ensure_my_number]

"您的虚拟号码是 123456（与 Agent 共用）。请提供对方 Agent 的 6 位号码；对方也需已申领才能接通。

若只是在 App 里让我通知您，可用 phone.call_user，不必再输号码。"
```

### 场景 D：组合能力使用
```
用户："明天下午3点有个会议，帮我设置提醒，并且查一下那天的天气"

预期 Agent 行为：
1. 调用 calendar.create_from_text 创建日程
2. 调用 weather.get_local 查询天气
3. 综合两个结果回复用户

"已为您设置明天下午3点的会议提醒。
另外，明天的天气预报是：晴，气温20-25°C，适合出行。"
```

---

## 📊 能力分类统计

| 类别 | 工具数量 | 主要用途 |
|------|---------|---------|
| 钱包与支付 | 4 | 资金管理、转账、交易记录 |
| 日历与日程 | 3 | 时间管理、提醒、会议安排 |
| 天气查询 | 1 | 天气预报、出行建议 |
| Agent通信 | 1 | Agent间消息传递 |
| AIP协议 | 3 | 多Agent协作、任务分发 |
| 视觉识别 | 4 | 图像分析、屏幕监控 |
| 桌面自动化 | 1 | 桌面操作、自动任务 |
| Web浏览 | 2 | 网络搜索、网页获取 |
| 生活助手 | 3 | 预算、购物、提醒计划 |
| 协议管理 | 5 | 系统配置、记忆管理 |
| Agent账号 | 1 | 账号注册、身份管理 |
| 虚拟电话 | 2 | 号码申领、语音通话 |
| **总计** | **30+** | **全方位AI助手能力** |

---

## 🚀 优势

### 1. 对用户的优势
- ✅ Agent 更智能，能主动提供服务
- ✅ 用户不需要记住所有功能
- ✅ 交互更自然，像真人助手
- ✅ 减少学习成本

### 2. 对开发者的优势
- ✅ 能力说明集中管理
- ✅ 易于维护和扩展
- ✅ 统一的认知框架
- ✅ 便于调试和优化

### 3. 对系统的优势
- ✅ 提升用户体验
- ✅ 增加功能使用率
- ✅ 减少无效对话
- ✅ 提高任务完成率

---

## 🔮 未来扩展

### 1. 动态能力发现
```typescript
// 未来可以添加工具，让 Agent 实时查询其他 Agent 的能力
- agent.query_capabilities(actorId): 查询指定Agent的能力
- agent.compare_capabilities(actorId1, actorId2): 比较两个Agent的能力
```

### 2. 能力推荐引擎
```typescript
// 根据用户历史行为，推荐可能需要的能力
- 用户经常查询天气 → 主动推送天气预报
- 用户经常转账 → 推荐快捷转账功能
- 用户经常设置提醒 → 推荐智能提醒模板
```

### 3. 能力组合优化
```typescript
// 智能组合多个工具完成复杂任务
用户："帮我安排明天的行程"
→ 自动组合：calendar + weather + traffic + reminder
```

### 4. 个性化能力展示
```typescript
// 根据用户偏好，调整能力介绍的顺序和重点
- 商务用户：优先展示日历、邮件、会议功能
- 个人用户：优先展示生活助手、娱乐功能
- 开发者用户：优先展示自动化、API功能
```

---

## 📝 维护指南

### 添加新能力时的步骤

1. **在工具注册文件中添加工具**
   ```typescript
   // server/src/tools/xxx-tools.ts
   registry.register("xxx.new_tool", async (input, context) => {
     // 实现逻辑
   });
   ```

2. **在 agent-capabilities.ts 中添加说明**
   ```typescript
   lines.push(`\n🆕 【新能力类别】`);
   lines.push(`可用工具：`);
   lines.push(`- xxx.new_tool: 工具描述`);
   lines.push(`提示：使用场景说明`);
   ```

3. **测试验证**
   - 重启服务
   - 与 Agent 对话，确认它知道新能力
   - 测试工具调用是否正常

### 修改现有能力

直接编辑 `agent-capabilities.ts` 中对应的说明文字即可。

---

## ✅ 验收标准

- [x] 文件已重命名为 `agent-capabilities.ts`
- [x] 函数名已更新为 `buildAgentCapabilityPromptSection`
- [x] 引用已更新（agent-core.ts）
- [x] 添加了 11 大类能力说明
- [x] 保留了原有的 World 状态和技能信息
- [x] 保留了虚拟电话能力说明
- [x] 保留了其他Agent能力说明
- [x] TypeScript 编译通过
- [x] System Prompt 生成正确

---

## 📚 相关文件

- `server/src/agent/agent-capabilities.ts` - 能力说明构建器
- `server/src/services/agent-core.ts` - Agent核心，调用能力构建器
- `server/src/agent/agent-runtime.ts` - AgentCore依赖注入
- `server/src/bootstrap/create-app-services.ts` - 服务初始化

---

## 记忆与压缩架构（OpenHuman 对齐）

### Mem0 记忆图（`server/src/agentic-memory/`）

- **引擎**：Mem0 OSS（`mem0ai`），实体链接 + 语义/BM25 多信号融合检索
- **写入**：对话归档、进化循环 observe、世界事件等经 `NarrativeMemoryFacade.ingest` → `memory.add(infer=true)`
- **检索**：`memory.search` 按 actor 过滤 → 注入 system 的 `narrativeRecall`（文案块：「记忆图联想检索」）
- **向量存储**：优先 Qdrant（`AGENT_QDRANT_URL` + `AGENT_AGENTIC_MEMORY_COLLECTION`）；无 Qdrant 时用本地 `MemoryVectorStore`
- **KV 慢变量**：`AgentMemorySyncService` 仍负责人格/价值观/能力/`memory_summary`；`AGENT_KV_SUMMARY_APPEND_MODE=minimal` 时世界事件不再重复写 KV 流水

### TokenJuice（`server/src/tokenjuice/`）

- 工具环在写入 `role:tool` 前经 `compactToolOutputForLlm`（npm `tokenjuice` + 项目 `.tokenjuice/rules/`）
- `AGENT_TOKENJUICE_ENABLED=0` 恢复全量 JSON（带硬截断兜底）

### 统一端口

- `NarrativeMemoryFacade`（`narrative-memory-port.ts`）对外 `ingest` / `buildNarrativeRecall`；底层为 Mem0 记忆图

---

**最后更新：** 2026-05-21  
**版本：** v2.2 - Mem0 记忆图 + TokenJuice
