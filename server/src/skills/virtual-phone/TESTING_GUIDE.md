# 虚拟电话功能测试指南（2026-09-24 修订）

> 本版对应「号码注册制 + 服务门禁」改造：Agent↔Agent 通话已删除（Agent 间联络走
> `world.link.send_message` 文本通道）、本地 ASR 已移除（通话中用户回复为打字，语音输入
> 待云端端到端语音服务接入）。旧版（2026-08 双向通话版）中的互拨/配对场景作废。

## 🧪 服务启动

```bash
cd server
npm run dev
```

数据文件（均原子写、可随时删除重建）：

| 文件 | 内容 |
| --- | --- |
| `data/virtual-phones.json` | 站内号注册表（actorId → 6 位号） |
| `data/virtual-phone-calls.json` | 活跃通话会话（重启时被消费后清空） |
| `data/virtual-phone-history/*.json` | 通话记录（TTL 默认 30 天，`VIRTUAL_PHONE_HISTORY_TTL_DAYS` 可调） |

---

## 测试场景

### 场景 A：新用户 —— 未申领号码

发送：「你能打电话吗？」

- System Prompt 的【语音触达】段应显示「尚未申领 6 位联络号码」；
- Agent 应介绍功能并引导用户说「帮我申请虚拟号码」；
- 此时 Agent 调 `phone.call_user` 会被**门禁拒绝**（见场景 G）。

### 场景 B：申领号码

发送：「帮我申请虚拟号码」

- Agent 调 `phone.ensure_my_number` → 返回 6 位号码，写入 `virtual-phones.json`；
- 客户端设置页 →「站内号码」分区 → 应显示该号码（HTTP `GET /phone/me`）；
- 设置页「去申领」按钮：跳回聊天页并**预填**申领话术（不自动发送）。

### 场景 C：已申领 —— 查询与释放

- 发送：「我的虚拟号码是多少？」→ Agent 复述号码；
- 设置页「释放」按钮 → 确认弹窗 → `DELETE /phone/me` → 号码回池，
  页面回到「尚未申领」；释放后可再次申领（会拿到新号）。

### 场景 D：Agent 打给用户（呼出）

发送：「给我打个电话，说明天下午三点开会」

- 主叫已申领 → 前摇振铃 8 秒 → 自动接通 → TTS 播报；
- 通话中打字回复 → LLM 回应经 `agent.phone.voice_reply` 回播；
- 挂断 → 双方清理，`data/virtual-phone-history/` 新增一条记录（含语音稿）。

### 场景 E：提醒电话交互轮

触发一个 phone_call 级提醒（或主动触达 L4）：

- 接通后进入交互循环：回复「收到/退下」→ 告别语 → ended（reason=acknowledged）；
- 其他回复 → LLM 对话回播；无输入超时 → ended（reason=timeout）；
- 收尾后服务端会话表必须清空（否则忙线护栏会把该用户锁到 TTL）。

### 场景 F：用户拨打 Agent（拨号盘 / `POST /phone/call-agent`）

- 已申领号码 → ringing → connecting → connected（Agent 问候/回应留言）；
- 点挂断 → `phone.call_hangup` → ended，会话清理。

### 场景 G：门禁 —— 未申领号码

- 用户侧：未申领时发「拨打 Agent」→ `400`/WS 错误，文案引导「帮我申请虚拟号码」；
- Agent 侧：未申领时调 `phone.call_user` → 工具返回 `ok:false`（retryable=false），
  Agent 应向用户说明需要办理，办理后重试成功。

### 场景 H：忙线护栏

第一通通话进行中再触发第二通来电：

- 服务端**不再推第二条 incoming**（旧会话不会被顶掉）；
- 用户端只收到 `call_status{status:"busy"}`；呼叫方收到 `ok:false, busy:true`；
- 第一通挂断后可正常发起下一通。

### 场景 I：服务重启韧性

通话进行中重启 server：

- 启动时消费 `virtual-phone-calls.json` → 客户端补推 `ended(reason=server_restart)`；
- 客户端通话 UI 干净收尾，不留僵尸通话页；会话文件被清空。

---

## 自动化覆盖

```bash
cd server
npm test
```

虚拟电话相关：`test/virtual-phone-service.test.ts`（号码/门禁/忙线/重启恢复/记录落盘）、
`test/phone-call-handler.test.ts`（提醒交互轮）、`test/phone-call-intent.test.ts`（显式来电意图）、
`test/phone-call.test.ts`（电话代办 `phone_call.*`，默认关闭）、`test/phone-bridge-dial.test.ts`（拨号桥）、
`test/phone-call-e2e-mock.test.ts` / `test/phone-dial-virtual-e2e.test.ts`（联调）。

## 🐛 常见问题

### Q1: Agent 不知道虚拟电话功能

- 检查 `virtualPhoneService` 是否传入 AgentCore（`create-app-services.ts`）；
- 检查 System Prompt 是否含【语音触达】段（`agent-capabilities.ts` 的 `buildPhoneCapabilityLines`）。

### Q2: 申领后仍显示「未申领」

- `data/virtual-phones.json` 是否有该 actorId；客户端 `userId` 是否与申领时一致
  （号码按 actorId 绑定，actorId = userId ?? sessionId，见 `agent/actor-id.ts`）。

### Q3: 提醒电话打不出去

- 主动触达有频控（proactive-caller 门禁），忙线/离线会走文本兜底，属预期；
- 查 `virtual-phone-calls.json` 是否有未清理的会话（正常应随通话结束即时清空）。

---

**修订日期**: 2026-09-24
**待办**: 云端端到端语音服务接入后——桌面端「说话回复」、通话语音输入、删除文字回复过渡态；
真实 PSTN 号码属 `phone_call.*` P2 云线路（资质先行）。
