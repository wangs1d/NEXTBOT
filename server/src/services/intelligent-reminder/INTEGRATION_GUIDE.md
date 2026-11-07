# 智能提醒系统集成指南

## 📦 已完成的重构内容

### 1️⃣ **ASR + LLM + TTS 统一接口层** (新增)

```
server/src/services/voice-dialogue/
├── types.ts                          # 统一类型定义
├── voice-dialogue-service.ts         # 对话服务管理器
├── adapters/
│   ├── openai-tts-adapter.ts        # OpenAI TTS适配器
│   ├── openai-llm-adapter.ts        # OpenAI LLM适配器
│   └── openai-asr-adapter.ts        # OpenAI Whisper ASR适配器
└── main.ts                           # 统一导出
```

**核心特性：**
- ✅ 抽象化ASR/LLM/TTS接口，支持多Provider切换
- ✅ 完整的语音对话流程：音频输入 → ASR识别 → LLM理解 → TTS合成 → 音频输出
- ✅ 支持流式处理和批量处理
- ✅ 已实现OpenAI全套适配器（可替换为本地模型）

### 2️⃣ **用户响应持久化存储** (新增)

```
server/src/services/intelligent-reminder/
└── user-response-persistence.ts      # 用户响应分析与学习系统
```

**核心功能：**
- ✅ 记录每次提醒的完整生命周期（触发、响应时间、升级次数）
- ✅ 自动计算用户响应统计：
  - 响应率、忽略率、升级率
  - 平均响应时间
  - 各级别响应分布
  - 小时级活跃模式分析
- ✅ **智能推荐算法**：基于历史数据自动推荐最佳提醒级别
- ✅ 数据持久化到 `data/reminder-responses.json`
- ✅ 支持用户反馈收集（positive/negative/neutral）

### 3️⃣ **集成现有虚拟电话服务**

**已完成的整合：**
- ✅ PhoneCallHandler 直接使用现有的 `VirtualPhoneService`
- ✅ 复用现有TTS服务 (`TtsService`) 通过Adapter模式
- ✅ 电话通话支持完整的LLM对话交互（非预设脚本）

---

## 🔧 集成到 create-app-services.ts

在 [create-app-services.ts](file:///e:/W-Project/Private%20AI%20Agent/server/src/bootstrap/create-app-services.ts) 中添加以下代码：

### 步骤 1: 导入新模块

```typescript
// 在文件顶部添加导入
import { VoiceDialogueService } from "../services/voice-dialogue/voice-dialogue-service.js";
import { OpenAITTSAdapter } from "../services/voice-dialogue/adapters/openai-tts-adapter.js";
import { OpenAILLMAdapter } from "../services/voice-dialogue/adapters/openai-llm-adapter.js";
import { OpenAIASRAdapter } from "../services/voice-dialogue/adapters/openai-asr-adapter.js";
import { createIntelligentReminderSystem } from "../services/intelligent-reminder/index.js";
```

### 步骤 2: 初始化语音对话服务

```typescript
// 在 ttsService = new TtsService(); 之后添加：

const voiceDialogueService = new VoiceDialogueService();

// 注册OpenAI Provider（使用已有的API Key配置）
voiceDialogueService.registerProvider("openai", {
  asr: new OpenAIASRAdapter(),
  tts: new OpenAITTSAdapter(ttsService),  // 复用现有TTS服务
  llm: new OpenAILLMAdapter(),
});

// 设置为默认Provider
voiceDialogueService.setDefaultProvider("openai");
```

### 步骤 3: 初始化智能提醒系统

```typescript
// 在 virtualPhoneService 初始化之后添加：

const intelligentReminderSystem = createIntelligentReminderSystem({
  toolRegistry,
  virtualPhoneService,
  voiceDialogueService,
  sendToClient: (userId, payload) => {
    wsConnectionRegistry.trySend(
      userId,
      JSON.stringify(payload),
    );
  },
  logger: app.log,
});

// 加载用户响应历史数据
await intelligentReminderSystem.userResponsePersistence.load();
```

### 步骤 4: 导出服务（可选）

在返回的 AppServices 对象中添加：

```typescript
return {
  // ... 现有字段 ...
  voiceDialogueService,
  intelligentReminderSystem,
};
```

---

## 🎯 新增的Agent工具

集成后，Agent可以使用以下9个工具：

| 工具名 | 功能 | 示例 |
|--------|------|------|
| `reminder.create` | 创建智能提醒 | 支持3种模式 + auto智能选择 |
| `reminder.trigger` | 手动触发提醒 | 用于定时任务 |
| `reminder.acknowledge` | 确认收到提醒 | 记录响应时间 |
| `reminder.cancel` | 取消提醒 | 清理资源 |
| `reminder.get_status` | 查询状态 | 获取详情 |
| `reminder.list_active` | 列出活跃提醒 | 批量管理 |
| `reminder.escalate` | ~~手动升级~~ 已随升级链斩断移除（2026-11-05），电话仅保留为 reminder.create 的显式 initialLevel |
| **`reminder.get_user_stats`** | **获取用户统计** | **查看响应率、偏好等** ⭐ |
| **`reminder.get_response_history`** | **获取响应历史** | **查看最近N条记录** ⭐ |

---

## 💡 使用示例

### 场景1：创建带完整对话的电话提醒

```typescript
await toolExecutor.execute("reminder.create", {
  title: "紧急会议通知",
  message: "您有一个重要会议将在30分钟后开始",
  priority: "urgent",
  initialLevel: "phone_call",
  phoneConfig: {
    waitForResponse: true,
    maxRingDurationSec: 300,
    disconnectCommand: ["退下", "知道了"],
  },
  metadata: {
    userId: "user_123",
    actorId: "agent_456"  // 必须提供，用于调用VirtualPhoneService
  }
});
```

**执行流程：**
1. VirtualPhoneService.callUser() 发起呼叫
2. VoiceDialogueService.generateAndSpeak() 合成初始语音
3. 用户回应后 → OpenAIASRAdapter.transcribe() 识别语音
4. OpenAILLMAdapter.chat() 理解并生成回复
5. 循环直到用户说"退下"或超时

### 场景2：利用用户数据优化提醒策略

```typescript
// 先查看用户统计数据
const stats = await toolExecutor.execute("reminder.get_user_stats", {});
/*
返回示例：
{
  ok: true,
  analytics: {
    totalReminders: 150,
    totalResponses: 120,       // 响应率80%
    responseRate: 0.8,
    averageResponseTimeMs: 25000, // 平均25秒响应
    ignoreRate: 0.13,           // 忽略率13%
    preferredLevel: "popup",    // 系统推荐用弹窗
    levelDistribution: {
      popup: { count: 140, responses: 120, avgResponseTimeMs: 30000 },
      phone_call: { count: 10, responses: 10, avgResponseTimeMs: 5000 }
    }
  }
}
*/

// 根据数据创建优化后的提醒
await toolExecutor.execute("reminder.create", {
  title: "自适应提醒测试",
  message: "系统已根据你的习惯选择了最佳提醒方式",
  priority: "high",
  initialLevel: "auto",  // 让AI根据上述数据自动决策
});
```

### 场景3：查看响应历史以调整策略

```typescript
const history = await toolExecutor.execute("reminder.get_response_history", {
  limit: 10
});

// 分析最近10次提醒的响应情况
history.responses.forEach(r => {
  console.log(`${r.reminderTitle} [${r.level}] 响应:${r.responded ? '✅' : '❌'} 耗时:${r.responseTimeMs}ms`);
});
```

---

## 🔌 接入外部API指南

### 替换为本地Whisper ASR

```typescript
import type { ASRProvider } from "../services/voice-dialogue/types.js";

class LocalWhisperASR implements ASRProvider {
  name = "local-whisper";

  async transcribe(audio: AudioBuffer): Promise<ASRResult> {
    // 调用本地whisper.cpp或faster-whisper
    const result = await localWhisperModel.transcribe(audio.data);
    return {
      text: result.text,
      confidence: result.confidence,
      language: result.language,
      isFinal: true,
    };
  }
}

// 注册
voiceDialogueService.registerProvider("local-whisper", {
  asr: new LocalWhisperASR(),
  tts: existingTTSProvider,
  llm: existingLLMProvider,
});
```

### 替换为本地LLM（如Ollama）

```typescript
class OllamaLLM implements LLMProvider {
  name = "ollama";

  async chat(messages: LLMMessage[]): Promise<string> {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen2.5:7b',
        messages: messages,
        stream: false,
      }),
    });
    const data = await response.json();
    return data.message.content;
  }
}
```

### 替换为Edge TTS（免费）

```typescript
class EdgeTTS implements TTSProvider {
  name = "edge-tts";

  async synthesize(text: string, options?: {...}): Promise<AudioBuffer> {
    // 使用edge-tts库或microsoft-cognitiveservices-speech-sdk
    const audioBuffer = await edgeTTS.synthesize(text, options.voiceId);
    return {
      data: audioBuffer,
      format: "mp3",
    };
  }
}
```

---

## 📊 数据结构说明

### ReminderResponseRecord（单次响应记录）

```typescript
{
  id: "uuid",
  userId: "user_123",
  reminderId: "uuid",
  reminderTitle: "会议提醒",
  level: "phone_call",         // 最终触达的级别
  priority: "high",
  triggeredAt: "2026-05-27T...",
  respondedAt: "2026-05-27T...", // 用户确认时间
  responseTimeMs: 15234,        // 响应耗时(ms)
  responded: true,              // 是否已确认
  escalationCount: 1,            // 升级了几次
  finalLevel: "phone_call",      // 最终级别
  userFeedback: "positive"       // 用户反馈(可选)
}
```

### UserResponseAnalytics（用户分析数据）

```typescript
{
  userId: "user_123",
  totalReminders: 150,
  totalResponses: 120,
  responseRate: 0.8,             // 80%
  averageResponseTimeMs: 25000,  // 25秒
  ignoreRate: 0.13,              // 13%
  escalationRate: 0.25,          // 25%
  preferredLevel: "popup",       // AI推荐的最佳级别
  levelDistribution: {           // 各级别详细统计
    popup: { count: 140, responses: 120, avgResponseTimeMs: 30000 },
    phone_call: { count: 10, responses: 10, avgResponseTimeMs: 5000 }
  },
  hourlyResponsePattern: {       // 24小时活跃模式
    0: 2, 1: 0, ..., 9: 15, 10: 25, ...  // 每小时被提醒次数
  },
  lastResponseAt: "2026-05-27T..."
}
```

---

## 🚀 下一步建议

### 立即可做：
1. ✅ 在 `create-app-services.ts` 中添加初始化代码
2. ✅ 测试基础弹窗功能
3. ✅ 测试电话呼叫功能（需要在线WebSocket连接）

### 后续优化：
4. 🔄 接入本地Whisper模型（降低延迟和成本）
5. 🔄 实现真实ASR输入（当前为模拟等待）
6. 🔄 添加前端UI展示用户统计数据
7. 🔄 实现A/B测试不同提醒策略的效果
8. 🔄 添加多语言支持（基于ASR语言检测）

---

## ⚠️ 注意事项

1. **actorId必填**：电话提醒必须在metadata中提供actorId（用于VirtualPhoneService）
2. **API Key依赖**：默认使用OpenAI API，需确保环境变量已配置
3. **数据隐私**：用户响应数据存储在本地JSON文件，生产环境建议加密
4. **并发控制**：同一用户同时最多3个活跃提醒（可在IntelligentReminderService中调整）
5. **成本控制**：每次电话对话会多次调用LLM+TTS，注意监控API用量

---

## 📚 相关文件索引

- [VoiceDialogue统一接口](file:///e:/W-Project/Private%20AI%20Agent/server/src/services/voice-dialogue/types.ts)
- [VoiceDialogue服务管理器](file:///e:/W-Project/Private%20AI%20Agent/server/src/services/voice-dialogue/voice-dialogue-service.ts)
- [OpenAI TTS适配器](file:///e:/W-Project/Private%20AI%20Agent/server/src/services/voice-dialogue/adapters/openai-tts-adapter.ts)
- [OpenAI LLM适配器](file:///e:/W-Project/Private%20AI%20Agent/server/src/services/voice-dialogue/adapters/openai-llm-adapter.ts)
- [OpenAI ASR适配器](file:///e:/W/Project/Private%20AI%20Agent/server/src/services/voice-dialogue/adapters/openai-asr-adapter.ts)
- [用户响应持久化服务](file:///e:/W-Project/Private%20AI%20Agent/server/src/services/intelligent-reminder/user-response-persistence.ts)
- [更新后的电话处理器](file:///e:/W-Project/Private%20AI%20Agent/server/src/services/intelligent-reminder/phone-call-handler.ts)
- [系统入口文件](file:///e:/W-Project/Private%20AI%20Agent/server/src/services/intelligent-reminder/index.ts)
