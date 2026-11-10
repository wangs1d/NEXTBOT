/**
 * 手机端「语音叫醒闹钟」端到端验收（App 在线 / 不杀进程场景）
 *
 * 用法：node scripts/verify-alarm-voice.mjs [fireDelaySec]
 * 依赖：本机 dev server 在 127.0.0.1:3000（加载最新 src）。
 *
 * 验证链路：
 *   session.init（模拟手机在线）
 *   → POST /api/alarms（wakeMode=voice_talk）
 *   → alarm.sync #1（先把本地精确闹钟排上）
 *   → SpeechHub 生成话术 + TTS 预合成
 *   → alarm.sync #2（带 voiceText；有账户时另带 ttsBase64）
 *   → 到点 alarm.trigger（复用同一份话术，不重新生成）
 *   → REST 对账列表 / voice 缓存带 voiceText
 * 最后 DELETE 清理测试数据。
 *
 * 验收分两类：
 *  - check()：链路必过项，不依赖外部 TTS 账户（话术/排程/触发/对账/一致性）。
 *  - note() ：环境项，真实 mp3 需要有效 TTS 账户。默认中文出口是硅基流动
 *    CosyVoice2（SILICONFLOW_API_KEY + SILICONFLOW_TTS_MODEL，见 tts-service.ts），
 *    MiniMax 优先、OpenAI-compatible 网关兜底。全部不可用时只记 NOTE 不判失败，
 *    此时端侧由 Android 系统 TextToSpeech 念 voiceText（离线降级），仍由 agent 开口。
 */
import WebSocket from "ws";

const BASE = process.env.ALARM_E2E_BASE || "http://127.0.0.1:3000";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const ACTOR = "alarm-voice-e2e";
const FIRE_DELAY_MS = Math.max(20, Number(process.argv[2] || 45)) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const syncEvents = [];
const triggerEvents = [];
const errors = [];

const ws = new WebSocket(WS_URL);
ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "session.init",
      payload: {
        sessionId: ACTOR,
        deviceId: "mobile-android-e2e",
        userAlias: "owner",
        platform: "mobile",
        userId: ACTOR,
      },
    }),
  );
});
ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.type === "alarm.sync") syncEvents.push(msg.payload ?? {});
  if (msg.type === "alarm.trigger") triggerEvents.push(msg.payload ?? {});
  if (msg.type === "error.frame" || msg.type === "error") errors.push(msg.payload);
});
ws.on("error", (e) => errors.push({ ws: String(e) }));

const connected = new Promise((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});

async function api(path, options = {}) {
  const r = await fetch(BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(300);
  }
  console.log(`  [timeout] ${label}`);
  return false;
}

const hasScript = (e) => typeof e?.alarm?.voiceText === "string" && e.alarm.voiceText.trim().length > 0;
const hasMp3 = (e) => typeof e?.alarm?.ttsBase64 === "string" && e.alarm.ttsBase64.length > 100;

const results = [];
const envResults = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function note(name, ok, detail = "") {
  envResults.push({ name, ok });
  console.log(`${ok ? "NOTE(ok)  " : "NOTE(skip)"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  await connected;
  await sleep(600);
  console.log(`WS 已连接（模拟手机端在线）：${WS_URL}`);

  const fireAt = new Date(Date.now() + FIRE_DELAY_MS).toISOString();
  const created = await api("/api/alarms", {
    method: "POST",
    body: JSON.stringify({
      actorId: ACTOR,
      label: "语音叫醒验收",
      kind: "alarm",
      fireAt,
      wakeMode: { level: "voice_talk", volumeRamp: true },
      source: "agent",
    }),
  });
  check("创建 voice_talk 闹钟", created.status === 201 || created.status === 200, `HTTP ${created.status}`);
  const alarmId = created.body?.alarm?.id;
  if (!alarmId) {
    console.log("  响应：", JSON.stringify(created.body).slice(0, 400));
    throw new Error("未拿到 alarmId");
  }
  console.log(`  alarmId=${alarmId} fireAt=${fireAt}`);

  await waitFor(() => syncEvents.length >= 1, 6_000, "首次 alarm.sync");
  check("首次 alarm.sync 立即下发（先排本地调度）", syncEvents.length >= 1, `${syncEvents.length} 条`);

  const gotScript = await waitFor(
    () => syncEvents.some(hasScript),
    25_000,
    "带话术的 alarm.sync",
  );
  const scriptSync = syncEvents.find(hasScript);
  const scriptText = scriptSync?.alarm?.voiceText ?? "";
  check("SpeechHub 话术随 alarm.sync 下发", gotScript, `voiceText="${scriptText}"`);
  check("话术是可用于朗读的非空短句", scriptText.trim().length >= 4 && scriptText.length <= 120,
    `${scriptText.length} 字`);

  const voiceSync = syncEvents.find(hasMp3);
  note("预合成 mp3 随 alarm.sync 下发（需有效 TTS 账户）", !!voiceSync,
    voiceSync ? `mp3Base64=${voiceSync.alarm.ttsBase64.length} 字符 voiceReady=${voiceSync.alarm.voiceReady}` : "无 mp3，走端侧系统 TTS 降级");

  const listed = await api(`/api/alarms?actorId=${ACTOR}&status=active`);
  const inList = listed.body?.alarms?.find((a) => a.id === alarmId);
  check("REST 对账列表带话术（离线重连可补齐）",
    typeof inList?.voiceText === "string" && inList.voiceText.length > 0,
    `voiceText="${inList?.voiceText ?? ""}"`);
  note("REST 对账列表带 mp3（voiceReady）", !!inList?.voiceReady,
    `voiceReady=${inList?.voiceReady} ttsBase64=${inList?.ttsBase64?.length ?? 0}`);

  const clip = await api(`/api/alarms/${alarmId}/voice`);
  check("语音缓存持久化：话术文本落盘（重启不丢）", !!clip.body?.voice?.text,
    `text="${clip.body?.voice?.text ?? ""}"`);
  note("语音缓存含 mp3", !!clip.body?.voice?.tts,
    clip.body?.voice?.tts ? "yes" : "no");

  const triggerAt = Date.now() + FIRE_DELAY_MS + 20_000;
  console.log(`  等待到点触发（最长 ${Math.ceil((triggerAt - Date.now()) / 1000)}s）…`);
  await waitFor(() => triggerEvents.length >= 1, triggerAt - Date.now(), "alarm.trigger");
  const trig = triggerEvents[0];
  check("到点 alarm.trigger 带 agent 话术（系统 TTS 降级的输入）",
    typeof trig?.voiceText === "string" && trig.voiceText.length > 0,
    `voiceText="${trig?.voiceText ?? ""}"`);
  check("到点话术与建钟时预生成的一致（不重新生成、不联网）",
    !!trig?.voiceText && trig.voiceText === scriptText,
    `trigger="${trig?.voiceText ?? ""}"`);
  note("alarm.trigger 复用预合成 mp3", !!trig?.tts?.base64,
    `tts=${trig?.tts?.base64?.length ?? 0} 字符`);

  // Fastify 带 Content-Type: application/json 时不允许空 body，DELETE 也要给 {}
  await api(`/api/alarms/${alarmId}`, { method: "DELETE", body: "{}" });
  console.log("  已清理测试闹钟");

  check("无 WS 错误帧", errors.length === 0, errors.length ? JSON.stringify(errors).slice(0, 200) : "");
  ws.close();

  const passed = results.filter((r) => r.ok).length;
  const envOk = envResults.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 必过项通过`);
  console.log(`环境项：${envOk}/${envResults.length} 可用（真实 mp3，不影响必过结论）`);
  if (!envOk) {
    console.log("  → 无 mp3 时端侧应打印：system TTS speaking agent script …（实机 logcat 验证）");
  }
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("验收异常：", e);
  ws.close();
  process.exitCode = 1;
});
