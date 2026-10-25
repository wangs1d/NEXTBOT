// 规划会话回放服务（证据测试专用）：
// 读取 test/fixtures/travel_planning_session_turns.json（2026-10-25 真实跑通的
// LLM 编排 + 实时报价快照），按真实接口顺序回放，给
// test/travel_planning_flow_evidence_test.dart 提供确定性数据。
//
// create 步已按新版协议换成「同行人卡 + 节奏推断」：快照里那张独立节奏卡
// 正是这次要下线的问法（同行人已知就不再单问节奏），其余步骤仍是原始快照。
//
// 运行：node tool/replay_travel_planning_session.mjs [port]   （默认 3101）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "..", "test", "fixtures", "travel_planning_session_turns.json");
const turns = JSON.parse(fs.readFileSync(fixture, "utf8"));
const port = Number(process.argv[2] ?? 3101);

const pick = (name) => {
  const step = turns.steps.find((s) => s.name === name);
  if (!step) throw new Error(`fixture 缺少步骤: ${name}`);
  const json = structuredClone(step.json);
  json.sessionId = "replay-session";
  return json;
};

const create = pick("create");
const turn1 = pick("turn1");
const turn2 = pick("turn2");
const guide = pick("guide");
const extras = pick("extras");
const generate = pick("generate");
const approve = pick("approve");

let turnCount = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const send = (obj, code = 200) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /travel/plans") return send({ ok: true, plans: [] });
  if (route === "POST /travel/plan-session") return send(create);
  if (route === "POST /travel/plan-session/replay-session/turn") {
    turnCount += 1;
    return send(turnCount === 1 ? turn1 : turn2);
  }
  if (route === "POST /travel/plan-session/replay-session/guide") return send(guide);
  if (route === "POST /travel/plan-session/replay-session/extras") return send(extras);
  if (route === "POST /travel/plan-session/replay-session/generate") return send(generate);
  if (route === "POST /travel/plan-session/replay-session/approve") return send(approve);
  // 图片等资源：证据测试不依赖真实图片，缺图走占位即可
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[replay] http://127.0.0.1:${port} (fixture: ${fixture})`);
});
