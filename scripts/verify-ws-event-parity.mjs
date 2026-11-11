#!/usr/bin/env node
/**
 * WS 事件跨端对账守护（2026-11-10，单连接 + 事件总线架构配套）。
 *
 * 三方对账：
 *   ① server/src 实际会向客户端 WS 连接下发的事件名
 *      （字面量 `type: "x.y"` + 常量 `ServerEventType.X` / `UnifiedServerEventType.X`）
 *   ② 客户端归属表 ws_event_router.dart 的 routes 登记项
 *   ③ 客户端 lib 下全部 .dart 文件里的消费点（事件名字符串字面量）
 *
 * 报警两类结构性破坏：
 *   - STALE_ROUTE：归属表登记了但服务端从不发送（改名/拼写错——事件永远到不了）
 *   - ORPHAN_EMIT：服务端发送但客户端无任何消费点（信令发了没人接，
 *     2026-09-12 假成功事故形态）
 *
 * 用法：npm run ws:parity（或 node scripts/verify-ws-event-parity.mjs）
 * 退出码：0 = 干净；1 = 存在报警（Allowlist 外）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 已知例外（有意不在客户端消费 / 非聊天主连接协议）────────────────
const SERVER_PATH_EXCLUDES = [
  // 语音双工：独立 socket 协议（/ws/voice-duplex），事件不经聊天主连接
  join("server", "src", "services", "voice-duplex") + sep,
  // MiniMax realtime 上游（server → MiniMax，非客户端下发）
  join("server", "src", "services", "voice-dialogue") + sep,
  // synapse 内部总线
  join("server", "src", "brain", "synapse-bus.ts"),
];
const EVENT_ALLOWLIST = new Set([
  // 协议级（客户端连接层统一处理 / ack 回执）
  "session.ready", "session.ended", "session.update", "error", "pong",
  "ws.keepalive", "ws.keepalive_ack", "session.init", "chat.user_message",
  // 设备总线独立通道（ws-device-handler，客户端另有消费面）
  // 桌面桥/手机桥独立连接协议
  "desktop.bridge.invoke", "desktop.bridge.result", "desktop.bridge.register",
  "phone.bridge.invoke", "phone.bridge.register", "phone.bridge.register_ack",
  "phone.msg.report", "phone.msg.report_ack", "phone.loc.report",
  // web 端 / 控制面专属
  "quota.state", "memory.snapshot", "human.directive_ack",
]);

// 客户端自合成事件：WsChatService 在连接状态变化时注入自身事件流，
// 服务端从不发送（归属表合法登记，STALE_ROUTE 不适用）。
const CLIENT_SYNTHESIZED = new Set([
  "ws_connected", "ws_disconnected", "connection_error",
  // 连接层自产：本机 access token 被服务端判废（error.event TOKEN_INVALID
  // 的客户端侧转录），由根分发器收起会话回登录门禁。
  "ws_auth_expired",
  // 旧版兼容保留（归属表注释注明）：服务端已不再发送
  "chat.error", "chat.assistant_interim",
  // 客户端自产的投递失败（重投次数用尽，WsChatService._requeueChatInFlight）：
  // 服务端不产生该事件，只由连接层发给本端聊天控制器做「如实告知」。
  "chat_delivery_failed",
  // HTTP popup 渠道下发（payload 内嵌 type 字段，非 WS 信封），WS 扫描不可见
  "reminder_popup",
]);

// 已知未消费（历史遗留 / 待跟进）：先登记放行，新增 ORPHAN 仍会报警。
// 跟进建议：①mood.inferred/weather.brief/rhythm.profile_updated/agent.activity_new
// （主连接下发但客户端无消费——确认是规划中特性还是该删）②homepage_updated
// （改名/首页字段更新推送，手机端疑似应接）。
const KNOWN_UNCONSUMED = new Set([
  // 独立通道：设备总线 / 桌面控制面（不走路由器归属表）
  "device.online", "device.offline", "device.list_changed", "device.register_ack",
  "protocol.unified.capabilities", "protocol.unified.quota.state",
  "protocol.unified.memory.snapshot", "protocol.unified.human.directive.ack",
  "protocol.unified.governance.ack",
  // 纯 ack 回执（发送方不需要消费）
  "companion.contact_feedback_ack", "desktop.bridge.register_ack",
  // 待跟进（见上注释）
  "agent.activity_new", "weather.brief", "rhythm.profile_updated",
  "mood.inferred", "phone_call.status_update", "homepage_updated",
  "shared.browser.sync",
]);

function listFiles(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/** 解析 `export const X = { Member: "value", ... } as const;` → { Member: value } */
function parseConstObject(file, exportName) {
  const src = readFileSync(file, "utf8");
  const idx = src.indexOf(`export const ${exportName}`);
  if (idx < 0) return {};
  const open = src.indexOf("{", idx);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open, end);
  const map = {};
  for (const m of body.matchAll(/([A-Za-z_]\w*)\s*:\s*"([^"]+)"/g)) {
    map[m[1]] = m[2];
  }
  return map;
}

// ── ① 服务端出站事件 ──────────────────────────────────────────────
const serverEventType = parseConstObject(
  join(ROOT, "packages", "agent-protocol", "src", "events.ts"), "ServerEventType");
const unifiedEventType = parseConstObject(
  join(ROOT, "agent-world", "protocol-unified.ts"), "UnifiedServerEventType");

const serverFiles = listFiles(join(ROOT, "server", "src"), ".ts");
const emitted = new Set();
// 信封形态约束：只认 `type: "x.y", payload`（WS 下发信封恒带 payload），
// 避免把 response_format `type:"json_object"` 之类普通对象字段误当事件。
const literalRe = /type:\s*"([A-Za-z][\w.]*)"\s*,\s*payload\b/g;
// 位置参数发送器：pushToActor(deps, actorId, "event.name", {...})
const positionalRe = /pushToActor\(\s*[^,()]+,\s*[^,()]+,\s*"([A-Za-z][\w.]*)"/g;
// 枚举引用（含经变量中转，如 const t = mode==="x" ? ServerEventType.A : ...B;
// 随后 type: t）：凡在 server/src 引用过的枚举成员值都视为「可能下发」。
const enumRefRe = /(?:ServerEventType|UnifiedServerEventType)\.([A-Za-z_]\w*)/g;
for (const f of serverFiles) {
  if (SERVER_PATH_EXCLUDES.some((ex) => f.includes(ex))) continue;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(literalRe)) emitted.add(m[1]);
  for (const m of src.matchAll(positionalRe)) emitted.add(m[1]);
  for (const m of src.matchAll(enumRefRe)) {
    const v = serverEventType[m[1]] ?? unifiedEventType[m[1]];
    if (v) emitted.add(v);
  }
}

// ── ② 客户端归属表 ────────────────────────────────────────────────
const routerSrc = readFileSync(
  join(ROOT, "client", "flutter_app", "lib", "core", "services", "ws_event_router.dart"), "utf8");
const routed = new Set();
for (const m of routerSrc.matchAll(/"([A-Za-z][\w.]*)":\s*WsEventRoute\./g)) routed.add(m[1]);

// ── ③ 客户端消费点 ────────────────────────────────────────────────
const clientFiles = listFiles(join(ROOT, "client", "flutter_app", "lib"), ".dart");
let clientHaystack = "";
for (const f of clientFiles) clientHaystack += readFileSync(f, "utf8");

// ── 对账 ─────────────────────────────────────────────────────────
let bad = 0;
console.log("== WS 事件跨端对账 ==");
console.log(`server 出站事件: ${emitted.size} · 客户端归属表: ${routed.size}`);

const stale = [...routed]
  .filter((t) => !emitted.has(t))
  .filter((t) => !CLIENT_SYNTHESIZED.has(t));
if (stale.length) {
  for (const t of stale) {
    console.error(`STALE_ROUTE  归属表登记 "${t}" 但 server/src 无任何发送点（改名/拼写错?）`);
    bad++;
  }
}

const orphan = [...emitted]
  .filter((t) => !routed.has(t))
  .filter((t) => !clientHaystack.includes(`"${t}"`))
  .filter((t) => !EVENT_ALLOWLIST.has(t))
  .filter((t) => !KNOWN_UNCONSUMED.has(t));
if (orphan.length) {
  for (const t of orphan) {
    console.error(`ORPHAN_EMIT  server 下发 "${t}" 但客户端无消费点（信令发了没人接?）`);
    bad++;
  }
}

if (bad === 0) console.log("对账干净：无 STALE_ROUTE / ORPHAN_EMIT。");
else console.error(`共 ${bad} 条报警。`);
process.exit(bad === 0 ? 0 : 1);
