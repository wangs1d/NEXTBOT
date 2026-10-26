// 规划会话回放服务（证据测试专用）：
// 读取 test/fixtures/travel_planning_session_turns.json（2026-10-25 真实跑通的
// LLM 编排 + 实时报价快照），按真实接口顺序回放，给
// test/travel_planning_flow_evidence_test.dart 提供确定性数据。
//
// create 步已按新版协议换成「同行人卡 + 节奏推断」：快照里那张独立节奏卡
// 正是这次要下线的问法（同行人已知就不再单问节奏），其余步骤仍是原始快照。
//
// 档案栏（dossier）：快照落盘时还没有这套协议，这里按服务端 buildDossier
// 同口径，用回放过程中真实点选的答案（同行人/预算档/勾选/补充）补出
// dossier 字段，让取证截图覆盖档案栏的真实内容而不是空栏。
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

// ── 会话已知量（服务端会话状态的复刻）────────────────────────────
// create 视为开新会话：整块重置，避免上一条用例答过的选项漏进下一条的档案。
const emptyKnown = () => ({
  destination: "成都",
  days: 3,
  origin: "北京",
  party: null,
  pace: null,
  budgetTier: null,
  view: [],
  stay: [],
  food: [],
});
let known = emptyKnown();

// 同行人 → 节奏默认档（与服务端 paceForParty + PACE_INFER_TEXT 同口径）
const PACE_BY_PARTY = {
  和伴侣: "松弛",
  情侣: "松弛",
  带爸妈: "松弛",
  带孩子: "松弛",
  和朋友: "紧凑",
  一个人: "均衡",
};

/** 地名串展示：最多列 3 个，其余折成「等 N 处」（同服务端 briefNames）。 */
function briefNames(names) {
  const unique = [...new Set(names.map((n) => `${n}`.trim()).filter(Boolean))];
  if (unique.length === 0) return "";
  const head = unique.slice(0, 3).join("、");
  return unique.length > 3 ? `${head} 等 ${unique.length} 处` : head;
}

/** 只收非空字符串（客户端提交的勾选/补充数组）。 */
function stringList(value) {
  return Array.isArray(value) ? value.map((v) => `${v}`).filter(Boolean) : [];
}

const STEPS = [
  ["gather", "问答"],
  ["guide", "挑想去"],
  ["extras", "补心愿"],
  ["budget", "核预算"],
  ["plan", "出方案"],
];
const ACTIVE_INDEX = {
  gathering: 0,
  guide_ready: 1,
  wishlist_ready: 2,
  ready: 3,
  budget_ready: 3,
  generated: 5,
};

function dossierFor(state) {
  const active = ACTIVE_INDEX[state] ?? 0;
  const facts = [];
  const core = (id, label, value) =>
    facts.push({ id, label, value: value ?? "", state: value ? "set" : "todo" });
  const optional = (id, label, value) => {
    if (value) facts.push({ id, label, value, state: "set" });
  };
  core("destination", "去哪儿", known.destination);
  core("days", "玩几天", known.days ? `${known.days} 天` : null);
  core("origin", "从哪儿走", known.origin ? `${known.origin}出发` : null);
  core(
    "party",
    "和谁去",
    known.party ? [known.party, known.pace].filter(Boolean).join(" · ") : null,
  );
  optional("budget", "预算档", known.budgetTier);
  optional("picks", "想去", briefNames(known.view));
  optional("stay", "住", briefNames(known.stay));
  optional("food", "吃", briefNames(known.food));
  return {
    head: [
      known.destination ?? "目的地待定",
      known.days ? `${known.days} 天` : null,
      known.origin ? `${known.origin}出发` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    steps: STEPS.map(([id, label], i) => ({
      id,
      label,
      state: i < active ? "done" : i === active ? "active" : "todo",
    })),
    facts,
  };
}

/** 回执发出前补上档案栏快照（口径与会话已知量一致）。 */
const withDossier = (json) => ({ ...json, dossier: dossierFor(json.state) });

/** 点选同行人卡 → 同行人 + 节奏（显式覆盖优先于默认档）。 */
function applyChoice(cardId, values) {
  const list = Array.isArray(values) ? values : [];
  if (cardId === "party" && list[0]) {
    known.party = `${list[0]}`;
    known.pace = list[1] ? `${list[1]}` : (PACE_BY_PARTY[known.party] ?? null);
  }
  if (cardId === "budget" && list[0]) known.budgetTier = `${list[0]}`;
}

/** 筛选卡勾选：delegate 时服务端取各类目前几名，这里同规则。 */
function applyGuide(body) {
  // 带 cats 的筛选卡在 turn2 那份回执里（guide 那份是勾选之后的补充卡）。
  const cats = (turn2.cards ?? []).find((c) => c.type === "guide")?.cats ?? [];
  const top = (key, n) =>
    (cats.find((c) => c.key === key)?.items ?? []).slice(0, n).map((i) => i.name);
  if (body?.delegate === true) {
    known.view = top("view", 3);
    known.stay = top("stay", 2);
    known.food = top("food", 2);
    return;
  }
  known.view = stringList(body?.view);
  known.stay = stringList(body?.stay);
  known.food = stringList(body?.food);
}

function applyExtras(body) {
  known.view = [...known.view, ...stringList(body?.view)];
  known.stay = [...known.stay, ...stringList(body?.stay)];
  known.food = [...known.food, ...stringList(body?.food)];
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

let turnCount = 0;

/** 原话里的同行人（镜像服务端 extractParty 的常见说法），create 时即已知。 */
function partyOfMessage(text) {
  const t = `${text ?? ""}`;
  if (/女朋友|男朋友|女友|男友|伴侣|老婆|老公|情侣|对象/.test(t)) return "和伴侣";
  if (/爸妈|父母|带孩子|一家人|家人|老人/.test(t)) return "带爸妈";
  if (/朋友|闺蜜|兄弟|同学/.test(t)) return "和朋友";
  if (/一个人|自己|独自/.test(t)) return "一个人";
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const send = (obj, code = 200) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /travel/plans") return send({ ok: true, plans: [] });
  if (route === "POST /travel/plan-session") {
    // 开新会话：重置已知量与轮次，上一条用例的作答不能漏进来。
    known = emptyKnown();
    turnCount = 0;
    const body = await readBody(req);
    const party = partyOfMessage(body?.message ?? body?.text);
    if (party) {
      known.party = party;
      known.pace = PACE_BY_PARTY[party] ?? null;
    }
    return send(withDossier(create));
  }
  if (route === "POST /travel/plan-session/replay-session/turn") {
    const body = await readBody(req);
    applyChoice(`${body.cardId ?? ""}`, body.values);
    turnCount += 1;
    return send(withDossier(turnCount === 1 ? turn1 : turn2));
  }
  if (route === "POST /travel/plan-session/replay-session/guide") {
    applyGuide(await readBody(req));
    return send(withDossier(guide));
  }
  if (route === "POST /travel/plan-session/replay-session/extras") {
    applyExtras(await readBody(req));
    return send(withDossier(extras));
  }
  if (route === "POST /travel/plan-session/replay-session/generate") {
    return send(withDossier(generate));
  }
  if (route === "POST /travel/plan-session/replay-session/approve") {
    return send(withDossier(approve));
  }
  // 实拍图：从本机 travel-media 缓存直出，让取证截图带真图而不是占位块。
  if (url.pathname.startsWith("/travel/media/")) {
    const dataDir =
      process.env.NEXTBOT_DATA_DIR ?? "D:/AppData/Nextbot/data";
    const root = path.resolve(
      process.env.TRAVEL_MEDIA_DIR ?? path.join(dataDir, "travel-media"),
    );
    const rel = decodeURIComponent(url.pathname.slice("/travel/media".length));
    const file = path.resolve(root, "." + rel);
    const types = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(file));
    return;
  }
  // 其余资源缺图走占位即可
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[replay] http://127.0.0.1:${port} (fixture: ${fixture})`);
});
