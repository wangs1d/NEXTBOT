/**
 * 声纹身份区分真链探针：证明声纹闸做的是「真实说话人身份验证」而非摆设。
 *
 * 方法：用 MiniMax T2A 合成三个不同音色模拟三个不同说话人（真实声学差异，
 * wespeaker 按声纹而非文本区分）——
 *   A（female-shaonv）注册 3 段样本 → 用【不同内容的】新句验证：应放行
 *   B（male-qn-qingse 男声）用不同内容验证：应拒绝
 *   C（presenter_female 另一女声）验证：应拒绝（排除只靠男女声区分的可能）
 * 并验证 duplex 声纹闸端到端：speakerToken 一次性 + 错误令牌被拒（close 4003）。
 *
 * 运行：node scripts/probe-voiceprint-identity.mjs（需 runtime 在 127.0.0.1:3000）
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("E:/ws-project/NextBot/server/package.json");
const WebSocket = require("ws");

const BASE = "http://127.0.0.1:3000";
const WS_URL = "ws://127.0.0.1:3000/ws/voice-duplex";
const ACTOR_A = "probe-vp-user-a";
const ACTOR_B = "probe-vp-user-b";

// ── .env 里抓 MINIMAX_API_KEY（探针自给自足，不污染进程环境） ──
function loadApiKey() {
  const env = readFileSync("E:/ws-project/NextBot/server/.env", "utf8");
  const m = env.match(/^MINIMAX_API_KEY=(.+)$/m);
  if (!m) throw new Error("server/.env 缺少 MINIMAX_API_KEY");
  return m[1].trim();
}

/** T2A 合成 16k wav（RIFF PCM16，声纹服务可直接解析） */
async function ttsWav(apiKey, voiceId, text) {
  const res = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "speech-2.5-turbo-preview",
      text,
      stream: false,
      voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 16000, bitrate: 128000, format: "wav", channel: 1 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await res.json();
  if (payload.base_resp?.status_code !== 0) {
    throw new Error(`TTS 失败(${payload.base_resp?.status_code}): ${payload.base_resp?.status_msg}`);
  }
  return Buffer.from(payload.data.audio, "hex");
}

async function register(actorId, samples) {
  const res = await fetch(`${BASE}/api/voice/voiceprint/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId, samples: samples.map((b) => b.toString("base64")) }),
  });
  return res.json();
}

async function verify(actorId, audio) {
  const res = await fetch(`${BASE}/api/voice/voiceprint/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId, audioBase64: audio.toString("base64") }),
  });
  return res.json();
}

async function unregister(actorId) {
  await fetch(`${BASE}/api/voice/voiceprint?actorId=${encodeURIComponent(actorId)}`, { method: "DELETE" });
}

/** 开一条 voice-duplex WS：session.start(actorId) → 等 ready → speaker.verify(token)。
 *  speak=true 时再发 text.turn，以 turn.completed 证明端到端放行；
 *  否则以「声纹验证失败 error / close 4003」判定拒绝。 */
function probeGate(actorId, token, { speak = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let settled = false;
    let verifySent = false;
    let audioBytes = 0;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(verdict);
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.start", actorId }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "error") {
        done({ accepted: false, reason: m.message });
        return;
      }
      if (m.type === "session.ready" && !verifySent) {
        verifySent = true;
        setTimeout(() => {
          if (!settled) ws.send(JSON.stringify({ type: "speaker.verify", token }));
          if (!settled && speak) {
            setTimeout(() => { if (!settled) ws.send(JSON.stringify({ type: "text.turn", text: "你好" })); }, 600);
          }
        }, 250);
      }
      if (m.type === "tts.chunk") audioBytes += (m.audio ?? "").length / 2;
      if (m.type === "turn.completed") {
        done({ accepted: true, reason: `turn.completed（语音回流 ${Math.round(audioBytes / 1024)}KB）` });
      }
    });
    ws.on("close", (code) => done({ accepted: false, reason: `close ${code}` }));
    ws.on("error", () => done({ accepted: false, reason: "ws error" }));
    setTimeout(() => done({ accepted: false, reason: speak ? "45s 内未完成回合" : "timeout" }), 45000);
  });
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

const apiKey = loadApiKey();

// ── 1. 合成音频：A 注册 3 段 + A 新句；B、C 各一句（内容均不同） ──
console.log("合成 TTS 音频（三个音色）…");
const aEnroll = [
  await ttsWav(apiKey, "female-shaonv", "今天天气不错，我打算下午去公园散步，顺便买点水果回来。"),
  await ttsWav(apiKey, "female-shaonv", "明天早上七点叫我起床，我要赶八点半的高铁去上海出差。"),
  await ttsWav(apiKey, "female-shaonv", "帮我订一份宫保鸡丁和米饭，六点半送到家里，谢谢。"),
];
const aFresh = await ttsWav(apiKey, "female-shaonv", "记得提醒我晚上给妈妈打个电话，聊一聊周末回家的事。");
const bVoice = await ttsWav(apiKey, "male-qn-qingse", "你好，我是来检查网络的工作人员，麻烦配合登记一下信息。");
const cVoice = await ttsWav(apiKey, "presenter_female", "本次列车终点站为杭州东站，请旅客们提前整理好随身物品。");
console.log(`音频就绪：A注册×3（${aEnroll.map((b) => Math.round(b.length / 16000) + "s").join("/")}）+ A新句 ${Math.round(aFresh.length / 16000)}s + B ${Math.round(bVoice.length / 16000)}s + C ${Math.round(cVoice.length / 16000)}s`);

// 干净起点
await unregister(ACTOR_A);

// ── 2. 注册 A ──
const reg = await register(ACTOR_A, aEnroll);
check("注册 A（3 段样本）", reg.ok === true, `usedSamples=${reg.usedSamples} dims=${reg.dims}`);
if (reg.ok !== true) { console.log(results.every((r) => r.pass) ? "ALL PASS" : "HAS FAIL"); process.exit(1); }

// ── 3. 本人新句（同音色、不同内容）→ 放行 ──
const vSelf = await verify(ACTOR_A, aFresh);
check("本人新句验证（同音色不同内容）", vSelf.ok === true && vSelf.match === true,
  `score=${vSelf.score} threshold=${vSelf.threshold} token=${vSelf.speakerToken ? "issued" : "MISSING"}`);
const selfToken = vSelf.speakerToken ?? "";

// ── 4. 陌生人男声（verify 目标身份是 A：库里只有 A 的声纹）→ 拒绝 ──
const vStranger = await verify(ACTOR_A, bVoice);
check("陌生人男声验证", vStranger.ok === true && vStranger.match === false,
  `score=${vStranger.score} threshold=${vStranger.threshold}`);

// ── 5. 陌生人另一女声 → 拒绝（排除仅男女声区分） ──
const vStranger2 = await verify(ACTOR_A, cVoice);
check("陌生人另一女声验证", vStranger2.ok === true && vStranger2.match === false,
  `score=${vStranger2.score} threshold=${vStranger2.threshold}`);

// ── 6. duplex 声纹闸端到端：正确 token 放行（真实对话回合完成） ──
if (selfToken) {
  const gateOk = await probeGate(ACTOR_A, selfToken, { speak: true });
  check("duplex 闸：正确令牌放行", gateOk.accepted === true, gateOk.reason);

  // ── 7. 同一 token 复用 → 拒（一次性） ──
  const gateReplay = await probeGate(ACTOR_A, selfToken);
  check("duplex 闸：令牌一次性（复用被拒）", gateReplay.accepted === false, gateReplay.reason);

  // ── 8. 伪造 token → 拒 ──
  const gateFake = await probeGate(ACTOR_A, "spk-forged0000000000000000000000000000");
  check("duplex 闸：伪造令牌被拒", gateFake.accepted === false, gateFake.reason);
} else {
  check("duplex 闸：正确令牌放行", false, "本人验证未签发 token，跳过");
}

// ── 清理探针数据 ──
await unregister(ACTOR_A);
console.log("探针身份已清理。");

const fails = results.filter((r) => !r.pass);
console.log(fails.length === 0 ? "ALL PASS" : `HAS FAIL ×${fails.length}`);
process.exit(fails.length === 0 ? 0 : 1);
