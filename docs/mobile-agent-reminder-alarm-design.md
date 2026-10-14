# 手机端 Agent 提醒能力设计方案（即时提醒 + 闹钟）

> 版本：v1.0（2026-10-08）
> 范围：mobile（Android / iOS，Flutter 客户端 `client/flutter_app`），兼容桌面端已有提醒通道
> 关联：`docs/foreground-background-architecture.md`、`docs/loop-orchestrator-architecture.md`

---

## 0. 结论速览

| 能力 | 一阶段（现在） | 二阶段（E2E 语音模型就绪后） |
|---|---|---|
| 即时提醒 | 系统通知 / 满屏弹窗 / 桌面端共享弹窗 | 主动"来电"式语音提醒，全屏通话 UI，自然语音对话完成确认 |
| 闹钟 | 本地精确闹铃（原生 AlarmManager / UNNotificationTrigger） | 到点 Agent 主动开口说话 + 播放音乐，语音交互"叫醒"并对话 |
| 降级 | — | 语音模型不可用 / 超时 → 自动退回一阶段（弹窗或普通闹铃） |

核心决策：**触发以客户端本地调度为准，服务端调度为兜底 + 管理面**。闹钟本地存储、本地触发，保证离线与杀进程后仍能响；服务端只负责意图解析、跨设备同步和"即时提醒"的下发。

---

## 1. 现状盘点（可复用地基）

| 已有资产 | 位置 | 复用方式 |
|---|---|---|
| 本地通知 | `flutter_local_notifications` 已接入 | 一阶段即时提醒与闹钟通知的展示层 |
| 主动语音事件 | WS 事件 `agent.proactive_voice` / `voice.speak` / `voice.alarm` | 二阶段语音提醒/闹钟直接复用事件通道 |
| 来电 UI | `lib/app/phone_call_controller.dart`（ringing_start / call_connecting / incoming） | "电话式提醒"复用来电全屏 UI，新增 `call_reason=reminder` |
| 弹窗状态机 | `lib/app/notification_flow_controller.dart`（reminder_popup、confirm/dismiss/timeout 配对） | 即时提醒的弹窗确认/超时回执逻辑直接复用 |
| Android 前台服务 | `MessageBridgeForegroundService.kt` | 闹钟触发服务可新建同类 `AlarmRingService`，或扩展该服务 |
| 桌面端提醒 | `windows/runner/desktop_notification_window.cpp` | 多端联动：手机端不可达时桌面端弹窗兜底 |
| 权限 | `permission_handler` 已接入 | 通知/麦克风/精确闹钟权限申请统一入口 |

---

## 2. 数据结构设计

### 2.1 闹钟（Alarm）

```jsonc
{
  "id": "alarm_01J9X...",            // ULID，客户端生成，服务端确认
  "userId": "u_123",
  "deviceId": "dev_mobile_01",       // 创建设备；null 表示跟随用户任意设备触发
  "label": "起床",
  "kind": "alarm",                   // alarm 闹钟 | reminder 即时提醒 | task_task 到期提醒
  "fireAt": "2026-10-09T07:30:00+08:00",  // 首次触发时间（ISO8601 带时区）
  "repeat": {
    "rule": "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR",  // RFC5545 RRULE；单次为 null
    "until": null,
    "count": null
  },
  "snooze": {
    "enabled": true,
    "presetsMinutes": [5, 10, 15],
    "maxCount": 3                    // 最多贪睡次数，超过自动升级响铃强度
  },
  "wakeMode": {                      // 二阶段生效，一阶段忽略
    "level": "gentle_normal",        // gentle_normal 普通闹铃 | voice_talk 语音叫醒 | music 播放音乐
    "voiceScript": "早上好，今天有 9 点的会，先喝口水！",  // Agent 开场白，可由意图生成
    "musicPlaylist": "wake_up_soft", // music 模式播放列表 id
    "volumeRamp": true               // 音量渐强
  },
  "dnd": {
    "bypass": true                   // 闹钟默认突破免打扰；即时提醒不突破（见 §7）
  },
  "status": "active",                // active | paused | done | canceled
  "createdAt": "...",
  "updatedAt": "...",
  "lastFiredAt": null,
  "nextFireAt": "2026-10-09T07:30:00+08:00"   // 服务端/客户端共同维护的下一跳
}
```

要点：

- **重复周期用 RRULE**（RFC5545），与日历生态互通，天然支持"每天/工作日/每周一三五/每月 1 号"，避免自造字段。
- **nextFireAt 是唯一调度依据**：客户端 AlarmManager / iOS UNCalendarNotificationTrigger 都只订这一跳，触发后再计算下一跳（客户端与服务端各算一次，互为校验）。
- **时区随 fireAt 携带**，跨时区旅行时策略由客户端决定（默认"跟随当地时钟"，可配置）。

### 2.2 即时提醒（Reminder）

即时提醒是一次性投递，不需要 RRULE，创建即调度：

```jsonc
{
  "id": "rem_01J9Y...",
  "userId": "u_123",
  "text": "3 点提醒我拿快递",
  "fireAt": "2026-10-08T15:00:00+08:00",
  "channelPlan": ["notification", "popup", "voice_call"],  // 阶段升级路径：逐级尝试
  "escalateAfterSec": 120,           // 通知 2 分钟未读 → 升级下一通道
  "requireAck": true,
  "status": "scheduled"              // scheduled | delivered | acked | escalated | failed
}
```

---

## 3. 接口设计

### 3.1 REST（服务端，管理面 + 跨设备同步）

```
POST   /api/v1/alarms                 # 创建（Agent 意图解析后调用，或用户手动）
GET    /api/v1/alarms?status=active   # 查询列表
GET    /api/v1/alarms/:id             # 详情
PATCH  /api/v1/alarms/:id             # 修改（时间/标签/贪睡/wakeMode）
DELETE /api/v1/alarms/:id             # 取消（软删 → status=canceled）
POST   /api/v1/alarms/:id/snooze      # 贪睡：body { minutes }
POST   /api/v1/alarms/:id/dismiss     # 停止响铃（本次完成）
POST   /api/v1/reminders              # 创建即时提醒
PATCH  /api/v1/reminders/:id          # 修改/取消
```

幂等：创建接口带 `Idempotency-Key`（客户端 ULID），避免语音重试造成重复闹钟。

### 3.2 服务端 → 客户端（WebSocket 下行事件）

沿用现有事件总线风格：

```jsonc
// 即时提醒下发（阶段一）
{ "event": "reminder.deliver",  "payload": { "reminder": {...} } }

// 闹钟跨设备同步（在另一台设备创建/取消）
{ "event": "alarm.sync",        "payload": { "alarm": {...}, "op": "upsert|delete" } }

// 服务端兜底触发（客户端本地调度失联时）
{ "event": "alarm.trigger",     "payload": { "alarmId": "...", "via": "server" } }

// 阶段二：语音提醒（复用现有事件）
{ "event": "agent.proactive_voice", "payload": { "reason": "reminder", "reminderId": "...",
                                                 "tts": { "format": "mp3", "base64": "..." },
                                                 "ringDurationMs": 30000 } }
```

### 3.3 客户端 → 服务端（触发回调 / 回执）

```jsonc
POST /api/v1/alarms/:id/trigger-callback
{
  "firedAt": "2026-10-09T07:30:02+08:00",
  "via": "local",                 // local 本地触发 | server 服务端兜底
  "outcome": "ringing",           // ringing | missed(未处理) | acked | snoozed
  "snoozeCount": 1
}
```

服务端以 `trigger-callback` 做三件事：① 记录触发历史（喂给"用户真实起床时间"学习）；② 客户端 5 分钟未上报 → 判定失联，走服务端推送兜底；③ 幂等去重（同一 alarmId 同一跳只算一次）。

---

## 4. 触发链路：为什么"本地为准、服务端兜底"

```
用户意图（"明早 7 点叫我"）
   │ Agent 意图解析（NLU/LLM）
   ▼
服务端创建/更新 Alarm ──WS alarm.sync──► 所有在线设备写入本地闹钟库
   │                                        │
   │ 服务端调度器（兜底）                    │ 客户端本地调度（主路）
   │ - 定时任务扫描 nextFireAt              │ - Android: AlarmManager.setExactAndAllowWhileIdle
   │ - 到点 WS/Push 推 alarm.trigger        │   + FCM 高优先级推送兜底
   │                                        │ - iOS: UNCalendarNotificationTrigger（见 §6 说明）
   ▼                                        ▼
        AlarmRingService（前台服务，闹铃/语音）→ trigger-callback 回报
```

- **主路在客户端**：离线、杀进程、弱网都能响（Android 精确闹钟由系统保证；iOS 见 §6 的平台差异）。
- **服务端兜底**：通过 FCM/厂商推送（高优先级 data message + full-screen intent）或真实短信/电话（§9 可选通道）触达。
- **双算互验**：客户端与服务端各自计算下一跳，不一致时以服务端为准并回写客户端（防 DST/时区计算错）。

---

## 5. 阶段一：即时提醒（通知/弹窗）

**触发方式**：Agent 判断到点（或用户指定时间），服务端下发 `reminder.deliver`。

**端上呈现（按注意力强度递进）**：

1. **普通系统通知**（默认）：横幅 + 声音振动，点进 App。
2. **弹窗确认卡**（requireAck 且重要）：Android 用 full-screen intent 满屏展示；桌面端复用 `DesktopNotificationWindow`；用户 confirm/dismiss 均回执服务端（复用 `NotificationFlowController` 的闭合事件配对）。
3. **升级通道**：`escalateAfterSec` 内未读未确认 → 升级为持续响铃通知（Android channel 置 `bypassDnd`）或二阶段语音外呼。

**Android 实现要点**：

- `flutter_local_notifications` 创建两个 channel：`reminder_normal`（默认免打扰下静默）与 `reminder_urgent`（`setBypassDnd(true)`，仅升级用）。
- full-screen intent 需申请 `USE_FULL_SCREEN_INTENT` 权限（Android 14 起需用户在设置中确认，引导话术见 §8）。

**iOS 实现要点**：

- 一阶段用 `UNNotificationRequest` + `interruptionLevel = .timeSensitive`；"重要的人的提醒"可申请 `.critical`（需 Apple Critical Alert entitlement，一般 ToC 应用拿不到，方案里只作为可选）。

---

## 6. 阶段一：闹钟（本地闹铃）

**Android（主战场，能力完整）**：

- `AlarmManager.setExactAndAllowWhileIdle()` 预约下一跳；Android 12+ 需申请 `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM`（闹钟类 App 可用后者，商店审核友好）。
- 到点启动前台服务 `AlarmRingService`（`foregroundServiceType="microphone|mediaPlayback"` 二阶段需要）执行响铃，锁屏上显示满屏 Activity + `setShowWhenLocked(true)`。
- 设备重启后 `BOOT_COMPLETED` 接收器重建所有 active 闹钟（本地持久化用 sqflite/Hive）。

**iOS（关键平台差异，必须如实设计）**：

- iOS 没有 App 级 API 能在 App 被杀后"确保响铃"，可行方案按优先级：
  1. **UNCalendarNotificationTrigger 本地通知 + 自定义提示音（≤30s）** —— 杀进程也能响，这是一阶段主方案；30 秒音长限制意味着"持续响铃直到用户解锁"做不到。
  2. **后台音频**：App 在前台/后台常驻时用 `AVAudioSession(.playback)` 循环播放闹铃直到用户确认（受 iOS 后台挂起限制，仅 App 未被杀时有效）。
  3. **Live Activity / 灵动岛**（iOS 16.1+）：睡前展示"下次闹钟 07:30"常驻信息，到点配合通知。
  4. 如需 iOS 真正的"不断响铃 + 语音叫醒"，接受产品约束：引导用户保持 App 后台挂起（iOS 后台音频会被挂起，需 BGTaskScheduler 续命，可靠性有限），或走 §9 的真实电话外呼兜底。
- **结论**：iOS 一阶段以"本地通知 + 30s 提示音"为承诺上限，二阶段语音叫醒在 iOS 上走"通知点击后进入语音会话"或服务端电话外呼，并在 UI 中明示。

---

## 7. 阶段二：语音提醒 / 语音闹钟（E2E 语音模型）

依赖：端到端语音模型（流式 ASR + LLM + TTS，或端侧模型）就绪，现有 `agent.proactive_voice` / 来电 UI / `voice.alarm` 事件通道均已具备。

**即时提醒 → "电话式提醒"**：

1. 到点服务端下发 `agent.proactive_voice (reason=reminder)`，客户端复用来电全屏 UI（显示 "NEXTBOT 来电 · 提醒"）。
2. 用户接听 → 进入实时语音会话：Agent 播报提醒内容，支持追问（"帮我顺延到明天"→ Agent 解析并调 API 改闹钟/日程）。
3. 用户挂断/超时未接 → 回执 `missed`，降级为普通通知 + 消息记录。

**闹钟 → "叫醒"**：

1. `AlarmRingService` 到点根据 `wakeMode.level`：
   - `voice_talk`：先播 1s 柔和铃声 → Agent 开口（`voiceScript` 开场白，音量渐强）→ 进入对话，用户说"再睡 10 分钟"即贪睡，说"知道了"即关闭；
   - `music`：播放指定歌单，叠一层"Agent 声音插话"（每 2 分钟一次），直到语音确认关闭。
2. 端侧 `speech_to_text` 已接入，可在模型不可用时做"本地关键词贪睡/关闭"（"停""贪睡"两个唤醒词）。

**与语音模型的会话协议**：复用现有 WS 双向音频/事件流；闹钟场景在会话首个 system prompt 中注入 `{alarmId, label, snoozePresets}`，使 Agent 能在对话中直接调用 `POST /alarms/:id/snooze`。

---

## 8. 依赖关系与降级策略

### 8.1 依赖矩阵

| 能力 | 依赖 1 | 依赖 2 | 缺失时的降级 |
|---|---|---|---|
| 即时提醒一阶段 | 通知权限 | 服务端可达 | 通知权限缺失 → App 内横幅 + 角标；服务端不可达 → 退化为客户端本地定时通知 |
| 即时提醒二阶段 | E2E 语音模型可用 | 麦克风权限 | 模型不可用/超时 3s → 直接播 TTS 单向播报；TTS 也不可用 → 退回阶段一弹窗 |
| 闹钟一阶段 | 精确闹钟权限(Android) | 通知权限 | 精确闹钟被拒 → setWindow(±10min) 粗略闹钟 + 明确告知用户 |
| 闹钟二阶段 | E2E 语音模型 | 音频焦点/媒体权限 | 同上逐级降级；最终兜底 = 普通闹铃 |
| 服务端兜底推送 | FCM/厂商通道 | 设备网络 | 推送失败 → 短信/电话外呼（§9，可配置开关） |

### 8.2 统一降级链（每个提醒创建时确定 plan）

```
voice_call（二阶段）→ tts_broadcast（单向播报）→ popup（满屏弹窗）→ notification（普通通知）→ in_app_banner（App 内横幅）
```

运行时按 `plan` 顺序探测，任一环节失败/超时自动落到下一级，**全程对用户无感**；回执中记录 `actualChannel` 便于事后分析。

### 8.3 时序与超时约定

- 触发瞬间探测语音模型健康：`GET /api/v1/voice/health`（服务端缓存，2xx 且 RTT<500ms 视为可用），探测预算 ≤ 1.5s，超时即降级。
- 语音外呼无人接听 30s → 挂断 → 降级通知；同一提醒最多外呼 1 次（防骚扰）。

---

## 9. 其他可选触达方式（补充通道，按成本排序）

除"通知/弹窗"和"端上语音"之外，还有这些真实可行的路径，建议作为**升级链的远程兜底或增值项**：

1. **运营商真实电话外呼**（服务端：Twilio / 阿里云语音通知 / 腾讯云 VMS）：服务端 TTS 合成播报，拨打用户手机号。**这是 iOS 上唯一能 100% 保证"到点一定有人叫你"的方式**，也是 Agent 提醒与系统闹钟的本质差异点。适合"不可错过"级提醒（赶飞机、吃药）。
2. **短信**：纯文本兜底，零依赖，适合完全离线场景。
3. **可穿戴设备**：手表震动/响铃（Android Wear 通知桥接；Apple Watch 上 iOS 通知自动镜像且手表在手腕上震动唤醒率远高于手机）。
4. **智能音箱 / 蓝牙音箱联动**：家里有音箱时，Agent 通过其 SDK 播报（小米/天猫精灵开放平台），实现"跨设备叫醒"。
5. **桌面端联动**（本项目已具备）：手机端失联时 `DesktopNotificationWindow` 弹窗 + 桌面端扬声器播放语音。
6. **锁屏小组件 / Live Activity**：常驻展示"下一次提醒 15:00"，被动可见。
7. **全屏白噪声/渐进式唤醒**（闹钟增值）：结合 wakeMode，用"音量渐强的鸟鸣→Agent 人声"模拟自然唤醒。

**建议**：V1 落地 通知/弹窗/本地闹铃；V2 落地 端上语音；**真实电话外呼列为"重要级提醒"付费/高级开关**（有通信成本）。

---

## 10. 边界情况处理

### 10.1 后台保活

| 平台 | 手段 | 说明 |
|---|---|---|
| Android | 精确闹钟（系统级，杀进程也响）+ `BOOT_COMPLETED` 重建 + 前台服务响铃 | 不依赖 App 存活；引导用户关闭厂商省电（电池优化白名单 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`，小米/华为需在设置页引导加白） |
| Android 15+ | 前台服务类型必须声明 `mediaPlayback`/`microphone`，否则响铃时无法后台播音频 | Manifest 声明 + 运行时校验 |
| iOS | 本地通知由系统投递（杀进程可响）；后台音频需 BGTaskScheduler 续命，可靠性有限 | 见 §6 结论，iOS 高可靠触达走电话外呼 |

### 10.2 权限申请策略（时机 + 话术，全部走 permission_handler 统一入口）

| 权限 | 申请时机 | 被拒后 |
|---|---|---|
| 通知（Android 13+/iOS） | 用户第一次说"提醒我"时（上下文式申请，不冷启动就弹） | 提示改用 App 内横幅 + 设置页引导 |
| 精确闹钟（Android 12+） | 用户第一次创建闹钟时 | 降级 ±10min 粗略闹钟并明示 |
| 满屏 Intent（Android 14+） | 创建闹钟时一并引导 | 退回 Heads-up 通知 |
| 麦克风 | 二阶段第一次语音提醒/叫醒前 | 语音降级为单向播报（无对话），再降级为普通闹铃 |
| 电池优化白名单 | 创建闹钟后设置页温和引导（不阻塞） | 照常工作但可能有分钟级误差 |
| 免打扰突破 | 重要提醒触发前一次性系统弹窗（Android DND access） | 不突破，升级链兜底 |

### 10.3 免打扰（DND）时段

- 数据结构：用户设置 `dndWindows: [{start:"23:00", end:"07:30", allow:["alarm","critical"]}]`。
- 规则：**用户显式创建的闹钟默认突破免打扰**（`dnd.bypass=true`）；**Agent 主动发起的即时提醒默认不突破**，除非用户对该提醒标注"重要"或升级链走到最高级。
- Agent 意图解析时主动提示："现在是免打扰时段，要设为重要并突破吗？"（防 Agent 自己半夜弹窗打扰用户）。

### 10.4 重复周期 / 时区 / DST

- RRULE 由服务端展开为 nextFireAt 单跳下发；DST 切换日（如 3 月第二个周日）由"本地时钟语义"计算（闹钟跟当地 07:30，不跟绝对秒数）。
- 跨时区飞行后：客户端检测时区变化 → 重算所有 active 闹钟 → `alarm.sync` 回写。

### 10.5 贪睡（Snooze）

- 本地贪睡优先（离线可用）：直接再预约一次精确闹钟 `now + minutes`，`snoozeCount++`，超过 `maxCount` → 自动升级响铃强度（音量渐强 + 语音介入）。
- 贪睡状态跨设备同步（手机上贪睡了，手表不再响）。
- 语音交互中："再睡十分钟" → Agent 解析为 snooze(10) 并口头确认。

### 10.6 其他

- **重复创建防抖**：意图"明天 7 点叫我"连续说两遍 → 服务端按 `Idempotency-Key` + 语义相似度去重（同 label 同 fireAt ±1min 视为同一闹钟，返回已有 id）。
- **多设备**：`deviceId=null` 的闹钟由"响铃时前台/解锁中的设备"优先接管；同时最多两台设备响，一台确认全部静默。
- **触发历史**：`trigger-callback` 落库，用于学习用户真实起床时间（未来可自动建议闹钟时间偏移）。

---

## 11. 分期落地计划

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M1 阶段一 | Alarm 数据模型 + 本地调度（Android 精确闹钟/iOS 本地通知）+ reminder.deliver 通知/弹窗 + trigger-callback | 杀进程后 Android 闹钟准点响；iOS 锁屏收到 30s 提示音通知 |
| M1.5 | 贪睡/RRULE/免打扰/跨设备同步/降级链 | 工作日闹钟在免打扰下正常响；另一台设备取消后本端停响 |
| M2 阶段二 | 接入 E2E 语音模型：来电式提醒 + 语音叫醒 + 语音贪睡 + 健康探测降级 | 断网/模型超时 1.5s 内自动退回弹窗或普通闹铃，全程无感 |
| M3 可选 | 运营商电话外呼、手表镜像、音箱联动 | "不可错过"提醒经真实电话 100% 触达 |


---

## 12. 落地记录（2026-10-08）

M1 全量落地 + M2 骨架，代码位置：

**服务端（触发兜底路 + 管理面）**
- `server/src/services/alarm-clock/alarm-types.ts` —— Alarm/Reminder 领域类型（§2）
- `server/src/services/alarm-clock/alarm-rrule.ts` —— 最小 RRULE 展开（本地时钟语义，DST 不漂移）
- `server/src/services/alarm-clock/alarm-store.ts` —— JSON 落盘存储 + 幂等去重（Idempotency-Key / 语义 ±60s）
- `server/src/services/alarm-clock/alarm-clock-service.ts` —— 调度器（15s tick）+ WS 下发（alarm.sync / alarm.trigger / reminder.deliver）+ 推送兜底（离线 30s / 已送达未回报 5min）+ TTS 预合成（1.5s 预算）
- `server/src/routes/http/alarms.ts` —— REST：/api/alarms 全套 CRUD/snooze/dismiss/trigger-callback + /api/reminders + /api/voice/health
- `packages/agent-protocol/src/events.ts` —— 新增 AlarmSync / AlarmTrigger / ReminderDeliver 事件
- `server/test/alarm-clock.test.ts` —— 单测 6/6 通过（RRULE/贪睡/回执幂等/兜底去重）

**客户端 Flutter + Android（触发主路）**
- `lib/features/alarm/alarm_models.dart` —— Alarm 模型 + Dart 侧 RRULE 镜像实现（双算互验）
- `lib/features/alarm/alarm_local_store.dart` —— 本地闹钟库（JSON 落盘）
- `lib/features/alarm/alarm_platform.dart` —— MethodChannel 桥 + 原生通知动作回传
- `lib/features/alarm/alarm_engine.dart` —— 引擎：事件收口/降级链/trigger-callback/30s 看门狗/voice health 探测
- `AlarmClockPlugin.kt` —— setExactAndAllowWhileIdle 预约 + 权限缺失降级 setWindow(±10min) + 开机重建持久化
- `AlarmRingService.kt` —— mediaPlayback 前台服务：循环闹铃+振动+满屏通知+贪睡/关闭动作，5min 自动停
- `AlarmRingActionsReceiver.kt` —— 通知动作转回 Dart；Dart 不在场时 REST 兜底
- `BootReceiver.kt` / `AndroidManifest.xml` / `MainActivity.kt` —— 开机重挂、权限与组件注册
- `lib/main.dart` —— 引擎引导（Android/iOS）+ WS 事件三分发

**已知边界（待后续里程碑）**
- iOS 本地通知路径（flutter_local_notifications zonedSchedule，30s 提示音承诺上限）未接，当前 iOS 依赖服务端推送触达；
- 响铃全屏页 UI 复用通知动作交互，应用内响铃页（语音对话叫醒 M2 完整形态）待接 voice-duplex 会话；
- 通知/麦克风权限的上下文式申请话术与设置页引导未做 UI 落地（permission_handler 接口已备）。


### 12.1 提醒智能路由：单端触达，不两端齐发（2026-10-08 增补）

需求：提醒触发时判断用户当前在手机端还是电脑端，只发所在端。

实现（服务端，客户端零改动）：

- **在场判定**：`WsConnectionRegistry` 为每条连接维护 `lastActiveAt`（`touchActivity`）。
  连接建立（session.init 自报 platform 归一 desktop/mobile）时初始化；此后终端每条
  **业务** WS 消息（chat/ack/回执等，`src/ws/connection.ts` 统一入口）刷新；
  `ws.keepalive` 心跳**不**刷新——后台挂机只有心跳的手机不代表"人在看"。
- **判定核心**：`mostRecentActiveDeviceClass / trySendToActiveDevice(sessionId, data, withinMs)`
  ——活跃窗口内取最近活动的连接独占投递。窗口默认 120s，`AGENT_REMINDER_ACTIVE_WINDOW_MS` 可调。
- **投递策略**（`AlarmClockService.deliverTrigger`）：
  - `kind=reminder`：窗口内有活跃端 → 只发该端（`reminder_active_device`）；
    窗口内无活跃端（位置未知/全离线）→ 降级全端 fan-out，宁多勿漏（`reminder_fanout_location_unknown`）。
  - `kind=alarm`：闹钟跟人睡的地方走 → mobile 优先独占（`trySendToDeviceClassOrder(["mobile","desktop"])`），
    手机全离线才退桌面；两端齐响视为事故，永不发生。
- **不参与路由的流量**：`alarm.sync` 跨设备同步保持 fan-out（每台设备都要排本地调度）；
  兜底系统推送路径不变（客户端超时未回报时推送仍会发到手机——那是"已判定的端失联"场景）。
- **日志**：`fired ... route=<reminder_active_device|reminder_fanout_location_unknown|alarm_mobile_first|offline>`。

验证：单测新增"智能路由"用例（提醒活跃端命中不 fan-out / 闹钟 mobile 优先），7/7 通过；tsc 干净。


### 12.2 P0 接线：闹钟类提醒补建真闹钟（2026-10-13）

**问题**：M1 引擎建成后一直缺「创建入口」——聊天里「明早7点叫我起床」走的是日程提醒链
（schedule-task → schedule.reminder_fired 应用内通知，依赖 App 在线），POST /api/alarms
无任何调用方，真闹钟（杀进程也响）实际触发不了。

**方案**：意图分流双链并存——闹钟类提醒照常建日程任务（今日安排/编辑/删除生态不动），
同时补建 kind=alarm 的真闹钟（alarmClockService.createAlarm → alarm.sync →
手机端写入本地闹钟库并预约 AlarmManager 精确闹钟）。

**实现**（判定必须纯代码，与 L543 起床类判定同源）：
- `server/src/services/alarm-clock/alarm-intent.ts` —— `isAlarmLikeReminderText`
  （/叫我起床|起床|闹钟|叫醒|定时叫|叫早/，不含裸「叫我」防「叫我开会」误伤）+
  `repeatRuleFromRecurrence`（daily/weekly → RRULE；yearly 不在 alarm-rrule 子集 → 跳过闹钟）；
- `server/src/tools/calendar-tools.ts` —— `createLinkedAlarmIfAlarmLike`：
  calendar.create_from_text / create_task（kind=reminder）创建任务后补建真闹钟，
  幂等由 AlarmStore.findDuplicate（同 label 同 fireAt ±60s）兜底；闹钟链路异常不阻断日程创建；
  响应增加 `alarmId` / `alarmNextFireAt`，summary 变为「闹钟已设置（手机端到点响铃）」；
- `server/src/bootstrap/create-app-services.ts` —— alarmClockServiceRef 懒取用器
  （闹钟服务在装配序列后段构造，getter 解耦创建顺序）；
- 测试 `server/test/alarm-intent.test.ts` 5/5（判定/映射/补建/幂等/四类跳过）；回归
  alarm-clock 7/7、schedule-reminder-policy 23/23；tsc 干净。

**已知边界（P1 待办）**：
- calendar.update_task / delete_task 不同步闹钟（改期/删除日程后旧闹钟仍在）——需在
  update/delete 时按 alarmId 级联 updateAlarm/cancelAlarm；
- iOS 本地通知触发路仍未接（见 §12 已知边界）；
- 闹钟响铃页与语音叫醒（M2 完整形态）未接 voice-duplex。
