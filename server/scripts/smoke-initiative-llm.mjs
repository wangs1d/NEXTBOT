// 临时冒烟测试（不提交）：真实 LLM 驱动 InitiativeEngine 的决策质量验证。
// 用 .env 的 OPENAI_API_KEY 直连，绕过 provider 栈，但 evaluate/normalize 走真实类。
import { readFileSync } from "node:fs";
import { InitiativeEngine } from "../dist/brain/../proactivity/initiative-engine.js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const apiKey = env.OPENAI_API_KEY;
const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
if (!apiKey) {
  console.error("no OPENAI_API_KEY, abort");
  process.exit(1);
}

async function llmComplete(prompt) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 300,
    }),
  });
  if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

const engine = new InitiativeEngine(llmComplete);

const tools = [
  { name: "calendar.create_task", description: "创建日程或待办任务" },
  { name: "media.play", description: "播放音乐" },
  { name: "weather.get_local", description: "查询本地天气" },
  { name: "voice.speak", description: "语音播报一段文字" },
];

const scenarios = [
  {
    name: "场景1：琐碎观察（应倾向 none）",
    input: {
      actorId: "user-test",
      observations: [
        { type: "user_activity", content: "用户活跃（来源：desktop_ws）", salience: "low", observedAt: Date.now() },
      ],
      profileText: "程序员，工作日 9-19 点常用电脑",
      lastInteractionAt: Date.now() - 40 * 60 * 1000,
      budgetNote: "今日已用 0/3 次",
      availableTools: tools,
    },
  },
  {
    name: "场景2：熬夜赶工+截止压力（应主动关怀，speak/advise）",
    input: {
      actorId: "user-test",
      observations: [
        { type: "conversation_turn", content: "用户说：这个方案周五必须交，我已经连着三天搞到凌晨两点了", salience: "medium", observedAt: Date.now() },
      ],
      recentContext: [
        { type: "conversation_turn", content: "用户说：需求又改了", salience: "low", observedAt: Date.now() - 3600e3 },
      ],
      profileText: "程序员，近期在做交付项目，喜欢深夜听轻音乐放松",
      lastInteractionAt: Date.now() - 5 * 60 * 1000,
      recentInitiatives: [],
      budgetNote: "今日已用 0/3 次",
      availableTools: tools,
    },
  },
  {
    name: "场景3：可代办的日程动作（期望 act 或 advise）",
    input: {
      actorId: "user-test",
      observations: [
        { type: "conversation_turn", content: "用户说：对了，明天上午十点约了牙医，我怕忘", salience: "medium", observedAt: Date.now() },
      ],
      profileText: "上班族，日程较满",
      lastInteractionAt: Date.now() - 2 * 60 * 1000,
      budgetNote: "今日已用 1/3 次",
      availableTools: tools,
    },
  },
];

for (const s of scenarios) {
  try {
    const t0 = Date.now();
    const d = await engine.evaluate(s.input);
    console.log(`\n== ${s.name} (${Date.now() - t0}ms)`);
    console.log(JSON.stringify(d, null, 2));
  } catch (err) {
    console.error(`\n== ${s.name} FAILED:`, err.message);
  }
}
