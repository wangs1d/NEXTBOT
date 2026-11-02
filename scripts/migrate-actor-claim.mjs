#!/usr/bin/env node
/**
 * 存量数据认领：把「无主 / 占位身份 / 同一邮箱的旧拼写」下的数据归属改到指定 actor。
 *
 *   npm run migrate:actor -- --actor=you@example.com --dry   # 只统计，不写盘
 *   npm run migrate:actor -- --actor=you@example.com        # 实际认领
 *
 * 认领来源（固定口径，不会碰其它真实账号）：
 *   session-mvp-001 / default_user / local_user / anonymous / default / "" / _unassigned
 *   以及目标 actor 自己的历史拼写（旧净化规则把 @ 换成 _、文件系统安全化把点也换成 _、
 *   URI 编码形式 %40）——多形式并存在 2026-10-04 记忆里记过根因。
 *
 * 只在目标键不存在时写入；目标已存在则按「数组去重追加 / 对象补缺键 / 标量保留目标」合并，
 * 绝不覆盖既有归属。改写前把原件复制到 <数据根>/.migrate-actor-claim-<时刻>/（sqlite 连 -wal/-shm
 * 一起快照）。写盘前请先停服务，避免与运行中的写入竞争。
 */
import { fileURLToPath } from "node:url";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

/* ── 参数与数据根 ─────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const target = (getFlag("actor") ?? process.env.NEXTBOT_MIGRATE_ACTOR ?? "").trim();
const dry = argv.includes("--dry");
const rootOverride = getFlag("root");

if (!target) {
  console.error("用法: npm run migrate:actor -- --actor=<你的 userId> [--dry] [--root=<数据根>]");
  process.exit(1);
}

/** 从 env 文件里取一个键（与 server 的 loadServerEnv 同口径：export 前缀、引号、注释行忽略） */
function readEnvFileValue(file, key) {
  if (!existsSync(file)) return "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim();
  }
  return "";
}

/** 与 server/src/config/data-dir.ts 同规则：env → server/.env.local → 平台默认 */
function resolveDataDir() {
  if (rootOverride) return resolve(rootOverride);
  const fromEnv = process.env.NEXTBOT_DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  const fromFile = readEnvFileValue(join(REPO_ROOT, "server", ".env.local"), "NEXTBOT_DATA_DIR");
  if (fromFile) return resolve(fromFile);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "Nextbot", "data");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Nextbot", "data");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(xdg, "Nextbot", "data");
}

const ROOT = resolveDataDir();
if (!existsSync(ROOT)) {
  console.error(`[claim] 数据根不存在：${ROOT}`);
  process.exit(1);
}

const sanitizeKey = (id) => String(id ?? "").replace(/[^\w.@-]/g, "_");
const legacyKey = (id) => String(id ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
const strictKey = (id) => String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");

/** 同一 actor 在存量里的全部拼写（现行净化规则 / 2026-10-04 前旧规则 / 文件系统安全化 / URI 编码） */
const SPELLINGS = new Set(
  [target, sanitizeKey(target), legacyKey(target), strictKey(target), encodeURIComponent(target)].filter(Boolean),
);
/** 无主/占位身份 */
const ANON = new Set(["session-mvp-001", "default_user", "local_user", "anonymous", "default", "", "_unassigned"]);
/** 认领来源 = 占位身份 + 目标自己的旧拼写（具体落名见 C 段：以最新写入者为准） */
const CLAIM = new Set([...ANON, ...SPELLINGS]);

const BACKUP_DIR = join(ROOT, `.migrate-actor-claim-${STAMP}`);
const rows = [];
const tally = (store, done, merged, skipped, note = "") => rows.push({ store, done, merged, skipped, note });

/** sqlite 改前快照：主库 + 伴生 -wal/-shm 一并复制（运行前请停服务，此时 wal 已空） */
function snapshotDb(rel) {
  if (dry) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${join(ROOT, rel)}${suffix}`;
    if (!existsSync(src)) continue;
    const dst = join(BACKUP_DIR, `${rel}${suffix}`);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

function backup(relPath) {
  if (dry) return;
  const src = join(ROOT, relPath);
  const dst = join(BACKUP_DIR, relPath);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function writeJson(relPath, value) {
  if (dry) return;
  const abs = join(ROOT, relPath);
  const tmp = `${abs}.claim-${STAMP}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  backup(relPath);
  renameSync(tmp, abs);
}

function readJson(relPath) {
  try {
    return JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
  } catch {
    return null;
  }
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 目标已有值时的合并：数组去重追加，对象补缺键，标量保留目标 */
function mergeInto(existing, incoming) {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const out = existing.slice();
    let added = 0;
    for (const item of incoming) {
      if (out.some((e) => sameJson(e, item))) continue;
      out.push(item);
      added++;
    }
    return { value: out, merged: true, conflicts: incoming.length - added };
  }
  if (existing && incoming && typeof existing === "object" && typeof incoming === "object" &&
      !Array.isArray(existing) && !Array.isArray(incoming)) {
    const out = { ...existing };
    let filled = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (k in out) continue;
      out[k] = v;
      filled++;
    }
    return { value: out, merged: true, conflicts: Object.keys(incoming).length - filled };
  }
  return { value: existing, merged: true, conflicts: 1 };
}

/** 沿 holder 路径（"" = 顶层）取容器 */
function holderOf(doc, holder) {
  if (!holder) return doc;
  let cur = doc;
  for (const seg of holder.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[seg];
  }
  return cur && typeof cur === "object" ? cur : null;
}

/* ── A. JSON 里的 actor 键位 ─────────────────────────────────── */

const JSON_MAPS = [
  ["agent-memory-sync.json", ["sessions"]],
  ["user-preferences.json", ["sessions"]],
  ["short-term-task-stack.json", ["sessions", "episodic", "loopFirstSeen"]],
  ["life-signals.json", ["history", "evidenceWindows"]],
  ["dream-rehearsal-state.json", ["actors"]],
  ["memory-score-cache.json", ["actors"]],
  ["profile-extract-checkpoint.json", ["actors"]],
  ["sleep-agent-state.json", ["actors"]],
  ["body/rhythm-core-state.json", ["actors"]],
  ["proactivity/awareness-sleep-samples.json", ["actors"]],
  ["rhythm/presence-footprint.json", ["actors"]],
  ["proactivity/hub-initiatives.json", [""]],
  ["task-plane/task-outbox.json", [""]],
  ["tool-promotion-state.json", [""]],
  ["turn-wal/cleared-at.json", [""]],
];

for (const [rel, holders] of JSON_MAPS) {
  if (!existsSync(join(ROOT, rel))) continue;
  const doc = readJson(rel);
  if (!doc) continue;
  let moved = 0;
  let merged = 0;
  for (const holder of holders) {
    const map = holderOf(doc, holder);
    if (!map) continue;
    for (const key of Object.keys(map)) {
      if (!CLAIM.has(key)) continue;
      const incoming = map[key];
      if (key === target) continue;
      delete map[key];
      if (target in map) {
        const r = mergeInto(map[target], incoming);
        map[target] = r.value;
        merged++;
      } else {
        map[target] = incoming;
        moved++;
      }
    }
  }
  if (moved + merged > 0) writeJson(rel, doc);
  tally(`A/keys ${rel}`, moved, merged, 0, holders.join(","));
}

/* ── B. 行内归属字段（jsonl / 大数组） ───────────────────────── */

function rewriteRows(rel, fields, holder) {
  if (!existsSync(join(ROOT, rel))) return;
  const doc = holder ? readJson(rel) : null;
  if (holder && !Array.isArray(doc?.[holder])) return;
  const list = holder ? doc[holder] : null;
  let changed = 0;
  const apply = (r) => {
    if (!r || typeof r !== "object") return false;
    let hit = false;
    for (const f of fields) {
      if (typeof r[f] === "string" && CLAIM.has(r[f]) && r[f] !== target) {
        r[f] = target;
        hit = true;
      }
    }
    if (hit) changed++;
    return hit;
  };
  if (holder) {
    list.forEach(apply);
    if (changed) writeJson(rel, doc);
  } else {
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    const out = lines.map((line) => {
      if (!line.trim()) return line;
      let r;
      try { r = JSON.parse(line); } catch { return line; }
      return apply(r) ? JSON.stringify(r) : line;
    });
    if (changed) {
      if (!dry) {
        const tmp = `${join(ROOT, rel)}.claim-${STAMP}.tmp`;
        writeFileSync(tmp, out.join("\n"), "utf8");
        backup(rel);
        renameSync(tmp, join(ROOT, rel));
      }
    }
  }
  tally(`B/rows ${rel}`, changed, 0, 0, fields.join(","));
}

rewriteRows("mood-inferences.jsonl", ["sessionId", "actorId"]);
rewriteRows("habit-loop/observations.json", ["actorId"], "observations");
{
  const dir = join(ROOT, "turn-wal");
  let changed = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      const rel = join("turn-wal", name);
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      let hit = 0;
      const out = lines.map((line) => {
        if (!line.trim()) return line;
        let r;
        try { r = JSON.parse(line); } catch { return line; }
        if (typeof r.actorId === "string" && CLAIM.has(r.actorId) && r.actorId !== target) {
          r.actorId = target;
          hit++;
          return JSON.stringify(r);
        }
        if (r.context && typeof r.context === "object" && CLAIM.has(String(r.context.sessionId ?? ""))) {
          r.context.sessionId = target;
          hit++;
          return JSON.stringify(r);
        }
        return line;
      });
      changed += hit;
      if (hit && !dry) {
        const tmp = `${join(ROOT, rel)}.claim-${STAMP}.tmp`;
        writeFileSync(tmp, out.join("\n"), "utf8");
        backup(rel);
        renameSync(tmp, join(ROOT, rel));
      }
    }
  }
  tally("B/rows turn-wal/*.jsonl", changed, 0, 0, "actorId,context.sessionId");
}

/* ── C. 一 actor 一目录/一文件的存量存储 ──────────────────────── */

/** form: 该存储当前的落名规则（仅在目标一种拼写都不存在时用来建新名） */
const DIR_STORES = [
  ["user_profiles", "legacy", "", "dir"],
  ["avatars", "raw", "", "dir"],
  ["journal", "raw", "", "dir"],
  ["images", "strict", "", "dir"],
  ["user-facts", "strict", ".json", "file"],
  ["health", "raw", ".json", "file"],
  ["long-term-memory", "raw", ".json", "file"],
  ["rhythm_profiles", "legacy", ".json", "file"],
  ["inbox", "legacy", ".json", "file"],
];

const FORM = {
  raw: (id) => String(id),
  sanitize: sanitizeKey,
  legacy: legacyKey,
  strict: strictKey,
  uri: (id) => encodeURIComponent(id),
};

function copyMissing(srcDir, dstDir) {
  let moved = 0;
  let skipped = 0;
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const from = join(srcDir, name);
    const to = join(dstDir, name);
    if (existsSync(to)) {
      if (statSync(from).isDirectory() && statSync(to).isDirectory()) {
        const sub = copyMissing(from, to);
        moved += sub.moved;
        skipped += sub.skipped;
        if (readdirSync(from).length === 0 && !dry) rmSync(from, { recursive: true, force: true });
        continue;
      }
      skipped++;
      continue;
    }
    if (!dry) renameSync(from, to);
    moved++;
  }
  return { moved, skipped };
}

for (const [store, form, ext, kind] of DIR_STORES) {
  const base = join(ROOT, store);
  if (!existsSync(base)) continue;
  const entries = readdirSync(base).filter((n) => !/\.bak|\.tmp$|\.unclaimed-|\.claim-/.test(n));
  const stemOf = (n) => (ext && n.endsWith(ext) ? n.slice(0, -ext.length) : n);
  const claimed = entries.filter((n) => CLAIM.has(stemOf(n)));
  if (claimed.length === 0) {
    tally(`C/store ${store}`, 0, 0, 0, "无占位/旧拼写条目");
    continue;
  }
  // 承接方 = 目标已有拼写里最新被写的那一份（那正是现行代码在读写的名字）
  const own = claimed.filter((n) => SPELLINGS.has(stemOf(n)));
  const anon = claimed.filter((n) => !SPELLINGS.has(stemOf(n)));
  const newest = (list) =>
    list.slice().sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs)[0];
  const receiver = own.length ? newest(own) : `${FORM[form](target)}${ext}`;
  const sources = [...own.filter((n) => n !== receiver), ...anon];
  let moved = 0;
  let merged = 0;
  let skipped = 0;
  for (const entry of sources) {
    const from = join(base, entry);
    const to = join(base, receiver);
    if (kind === "dir") {
      if (!existsSync(to)) {
        if (!dry) renameSync(from, to);
        moved++;
        continue;
      }
      const r = copyMissing(from, to);
      moved += r.moved;
      skipped += r.skipped;
      if (r.moved) merged++;
      if (!dry && existsSync(from) && readdirSync(from).length === 0) rmSync(from, { recursive: true, force: true });
      continue;
    }
    if (!existsSync(to)) {
      // 承接方不存在：直接改名过去（占位身份 → 现行名）
      if (!dry) renameSync(from, to);
      moved++;
      continue;
    }
    const a = readJson(join(store, entry));
    const b = readJson(join(store, receiver));
    let folded = false;
    if (a && b) {
      if (!dry) writeJson(join(store, receiver), mergeInto(b, a).value);
      merged++;
      folded = true;
    } else {
      skipped++;
    }
    // 合并过的源件不删除，改名保留在现场（内容已进承接方）
    if (folded && !dry) renameSync(from, join(base, `${entry}.unclaimed-${STAMP}`));
  }
  tally(`C/store ${store}`, moved, merged, skipped, `→ ${receiver}`);
}

/* ── D. 旅游计划/会话：扁平无主 → actor 子目录 + 注入 actorId ── */

for (const store of ["travel-plans", "travel-plan-sessions"]) {
  const base = join(ROOT, store);
  if (!existsSync(base)) continue;
  const bucket = sanitizeKey(target);
  let moved = 0;
  let skipped = 0;
  const claimDir = (dir, relDir) => {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const from = join(dir, name);
      if (!statSync(from).isFile()) continue;
      const doc = readJson(join(relDir, name));
      if (!doc || typeof doc !== "object") continue;
      const owner = typeof doc.actorId === "string" ? doc.actorId : "";
      if (owner && !CLAIM.has(owner)) continue; // 别人的行程不动
      const to = join(base, bucket, name);
      if (existsSync(to)) { skipped++; continue; }
      doc.actorId = target;
      if (!dry) {
        mkdirSync(join(base, bucket), { recursive: true });
        writeFileSync(to, JSON.stringify(doc), "utf8");
        backup(join(relDir, name));
        rmSync(from);
        if (relDir === store && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
      }
      moved++;
    }
  };
  claimDir(base, store);
  const unassigned = join(base, "_unassigned");
  if (existsSync(unassigned)) claimDir(unassigned, join(store, "_unassigned"));
  tally(`D/${store}`, moved, 0, skipped, `→ ${bucket}/`);
}

/* ── D2. 图库：全局 pictures/ 根 → actor 分区目录 ───────────── */

{
  const base = join(ROOT, "pictures");
  if (existsSync(base)) {
    const bucket = sanitizeKey(target);
    const dstBase = join(base, bucket);
    const LEGACY = ["index.json", "assets", "thumbs", "generated", "trash", "wall-owners.json"];
    const present = LEGACY.filter((n) => existsSync(join(base, n)));
    const blocked = present.filter((n) => existsSync(join(dstBase, n)));
    const movable = present.filter((n) => !blocked.includes(n));
    if (present.length === 0) {
      tally("D2/pictures 全局根", 0, 0, 0, "已是分区布局（无全局根条目）");
    } else {
      // index.json 与回收站台账存的是绝对路径：先把 <pictures>/ 前缀改写成 <pictures>/<actor>/，再搬目录
      // JSON 文本里反斜杠是转义形态，用裸路径当前缀匹配不到，替换要用转义后的字面量
      const fromLit = JSON.stringify(`${base}${sep}`).slice(1, -1);
      const toLit = JSON.stringify(`${dstBase}${sep}`).slice(1, -1);
      for (const [rel, top] of [["index.json", "index.json"], [join("trash", "trash.json"), "trash"]]) {
        if (!movable.includes(top)) continue;
        const abs = join(base, rel);
        if (!existsSync(abs)) continue;
        const raw = readFileSync(abs, "utf8");
        if (!raw.includes(fromLit)) continue;
        if (!dry) {
          const tmp = `${abs}.claim-${STAMP}.tmp`;
          writeFileSync(tmp, raw.split(fromLit).join(toLit), "utf8");
          backup(join("pictures", rel));
          renameSync(tmp, abs);
        }
      }
      if (movable.length && !dry) mkdirSync(dstBase, { recursive: true });
      for (const name of movable) {
        if (!dry) renameSync(join(base, name), join(dstBase, name));
      }
      tally(
        "D2/pictures 全局根",
        movable.length,
        0,
        blocked.length,
        `→ ${bucket}/${blocked.length ? `；分区已有同名未搬：${blocked.join(",")}（人工核对）` : ""}`,
      );
    }
  }
}

/* ── D3. ics 日历订阅：全局源与物化状态认领给目标账号 ──────── */

{
  const bucketOwner = sanitizeKey(target);
  const feedsRel = "ics-sub/feeds.json";
  const feedsDoc = readJson(feedsRel);
  if (feedsDoc && Array.isArray(feedsDoc.feeds)) {
    let claimed = 0;
    for (const feed of feedsDoc.feeds) {
      if (!feed || typeof feed !== "object") continue;
      const owner = typeof feed.actorId === "string" ? feed.actorId.trim() : "";
      if (owner && !CLAIM.has(owner)) continue; // 已经认到真账号名下的源不动
      if (owner === target) continue;
      feed.actorId = target;
      claimed++;
    }
    if (claimed > 0 && !dry) writeJson(feedsRel, feedsDoc);
    tally("D3/ics-sub 订阅源", claimed, 0, feedsDoc.feeds.length - claimed, `actorId → ${target}`);
  }

  // state.json 的键：分区前是裸源名，分区后是「归属::源名」，两种形态都挂到目标账号下
  const stateRel = "ics-sub/state.json";
  const stateDoc = readJson(stateRel);
  if (stateDoc && stateDoc.feeds && typeof stateDoc.feeds === "object") {
    const out = {};
    let moved = 0;
    let skipped = 0;
    for (const [key, value] of Object.entries(stateDoc.feeds)) {
      const sep = key.indexOf("::");
      const owner = sep < 0 ? "" : key.slice(0, sep);
      const name = sep < 0 ? key : key.slice(sep + 2);
      if (owner && owner !== bucketOwner && !CLAIM.has(owner)) {
        out[key] = value; // 别人的物化映射不动
        continue;
      }
      const to = `${bucketOwner}::${name}`;
      if (out[to]) {
        // 同名撞车（目标已有该源的状态）：合并 materialized，别把任一侧的日程判成孤儿
        const mine = (out[to].materialized ??= {});
        for (const [k, v] of Object.entries(value?.materialized ?? {})) {
          if (k in mine) continue;
          mine[k] = v;
          skipped++;
        }
        continue;
      }
      out[to] = value;
      if (to !== key) moved++;
    }
    if ((moved > 0 || skipped > 0) && !dry) writeJson(stateRel, { ...stateDoc, feeds: out });
    tally("D3/ics-sub 物化状态", moved, 0, skipped, `→ ${bucketOwner}::`);
  }
}

/* ── D4. 账单后台自动拉取：占位账号的运行行认领给目标账号 ───── */

{
  const rel = "finance-bill-auto-fetch/state.json";
  const doc = readJson(rel);
  if (doc && doc.actors && typeof doc.actors === "object") {
    const out = {};
    let moved = 0;
    let skipped = 0;
    for (const [actor, row] of Object.entries(doc.actors)) {
      if (!CLAIM.has(actor)) {
        if (actor !== target) out[actor] = row; // 别人名下的运行行不动
        continue;
      }
      if (out[target]) {
        // 目标已有行：以目标为准，占位行的历史留档不覆盖
        skipped++;
        continue;
      }
      // 旧形态没有账号级开关（能在表里就说明部署方把他列进了拉取名单），认领后等价于已开启
      out[target] = { ...(row ?? {}), enrolled: true };
      moved++;
    }
    if (moved > 0 || skipped > 0) {
      if (!dry) writeJson(rel, { ...doc, actors: out });
    }
    tally("D4/账单自动拉取运行行", moved, 0, skipped, `→ ${target}（enrolled=true）`);
  }
}

/* ── D5. 邮箱盯梢：全局 UID 基线与授权码密文认领给目标账号 ─── */

{
  const dirRel = "mail-watch";
  if (existsSync(join(ROOT, dirRel))) {
    const targetKey = sanitizeKey(target);
    const moves = [[`${dirRel}/processed-uids.json`, `${dirRel}/uids-${targetKey}.json`]];
    for (const old of [...CLAIM].filter(Boolean)) {
      const k = sanitizeKey(old);
      if (!k || k === targetKey) continue;
      moves.push([`${dirRel}/uids-${k}.json`, `${dirRel}/uids-${targetKey}.json`]);
      moves.push([`${dirRel}/pass/${k}.enc`, `${dirRel}/pass/${targetKey}.enc`]);
    }
    let moved = 0;
    let skipped = 0;
    for (const [from, to] of moves) {
      if (!existsSync(join(ROOT, from))) continue;
      if (existsSync(join(ROOT, to))) {
        skipped++; // 目标名下已有基线/密文：不覆盖，两边不是同一只邮箱时须人工核对
        continue;
      }
      if (!dry) {
        backup(from);
        mkdirSync(dirname(join(ROOT, to)), { recursive: true });
        renameSync(join(ROOT, from), join(ROOT, to));
      }
      moved++;
    }
    tally(
      "D5/mail-watch 邮箱盯梢",
      moved,
      0,
      skipped,
      `UID 基线与密文 → ${targetKey}；账号清单(accounts.json)由服务端自动接入或设置页重建`,
    );
  }
}


/* ── E. 聊天分片：占位会话线程并入目标线程（去重 + 按分片时间定先后） ── */
{
  const shardDirName = "chat-threads.shards";
  const base = join(ROOT, shardDirName);
  if (existsSync(base)) {
    const targetShardRel = `${shardDirName}/${encodeURIComponent(target)}.json`;
    const targetShard = readJson(targetShardRel);
    const keyOf = (m) => JSON.stringify([m?.__ts ?? m?.ts ?? m?.timestamp ?? "", m?.role ?? "", m?.content ?? ""]);
    const stampOf = (m) => m?.__ts ?? m?.ts ?? m?.timestamp ?? "";
    const targetKeys = new Set((targetShard?.messages ?? []).map(keyOf));
    let moved = 0;
    let merged = 0;
    let appended = 0;
    for (const name of readdirSync(base).filter((n) => n.endsWith(".json") && !/\.bak|\.tmp$/.test(n))) {
      const stem = name.slice(0, -5);
      let id;
      try { id = decodeURIComponent(stem); } catch { id = stem; }
      if (!CLAIM.has(id) || id === target) continue;
      const rel = `${shardDirName}/${name}`;
      const doc = readJson(rel);
      if (!doc) continue;
      if (!targetShard) {
        doc.sessionId = target;
        if (!dry) writeJson(rel, doc);
        if (!dry && name !== `${encodeURIComponent(target)}.json`) {
          renameSync(join(base, name), join(base, `${encodeURIComponent(target)}.json`));
        }
        moved++;
        continue;
      }
      const fresh = (doc.messages ?? []).filter((m) => !targetKeys.has(keyOf(m)));
      const freshKeys = new Set(fresh.map(keyOf));
      appended += fresh.length;
      if (!dry && fresh.length) {
        const mergedDoc = readJson(targetShardRel);
        // 顺序按分片级 updatedAt 判：旧线程在前，新线程在后
        const older = String(doc.updatedAt ?? "") <= String(mergedDoc.updatedAt ?? "");
        mergedDoc.messages = older
          ? fresh.concat(mergedDoc.messages ?? [])
          : (mergedDoc.messages ?? []).concat(fresh);
        mergedDoc.sessionId = target;
        const latest = [...(mergedDoc.messages ?? []), { __ts: mergedDoc.updatedAt }]
          .map(stampOf)
          .filter(Boolean)
          .sort()
          .pop();
        if (latest && String(latest) > String(mergedDoc.updatedAt ?? "")) mergedDoc.updatedAt = latest;
        const cur = readJson(rel);
        cur.messages = (cur.messages ?? []).filter((m) => !freshKeys.has(keyOf(m)));
        writeJson(targetShardRel, mergedDoc);
        if (cur.messages.length === 0) {
          backup(rel);
          renameSync(join(base, name), join(base, `${name}.merged-${STAMP}`));
        } else {
          writeJson(rel, cur);
        }
      }
      merged++;
    }
    tally("E/chat-threads.shards", moved, merged, 0, `${appended} 条消息并入 ${encodeURIComponent(target)}.json（按分片时间定先后）`);
  }
}

/* ── F. sqlite 按 actor 列改写 ───────────────────────────────── */

const require = createRequire(import.meta.url);
let Database = null;
try {
  Database = require("better-sqlite3");
} catch {
  Database = null;
}

const DB_STORES = ["agentic_memory/agentic-memory.db", "payment/orders.db", "agent-friends.db", "feedback.db"];

if (!Database) {
  console.error("[claim] 找不到 better-sqlite3，跳过 sqlite 认领（在项目根 npm i 后重跑）");
} else {
  const ownerCols = ["actor_id", "user_id", "session_id", "actorId", "userId"];
  for (const rel of DB_STORES) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    let db;
    try { db = new Database(abs); } catch (e) { tally(`F/db ${rel}`, 0, 0, 0, `打不开: ${e.message}`); continue; }
    let done = 0;
    let snapshotted = false;
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
        .filter((n) => !/_fts_(data|idx|content|docsize|config)$/.test(n) && !/^sqlite_/.test(n));
      for (const t of tables) {
        let cols = [];
        try { cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name); } catch { continue; }
        for (const col of ownerCols.filter((c) => cols.includes(c))) {
          const values = [...CLAIM].filter((v) => v !== target);
          const placeholders = values.map(() => "?").join(",");
          let hits = 0;
          try {
            hits = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE "${col}" IN (${placeholders})`).all(...values)[0].n;
          } catch { continue; }
          if (!hits) continue;
          if (!dry) {
            if (!snapshotted) { snapshotDb(rel); snapshotted = true; }
            db.prepare(`UPDATE "${t}" SET "${col}" = ? WHERE "${col}" IN (${placeholders})`).run(target, ...values);
          }
          done += hits;
          tally(`F/db ${rel} :: ${t}.${col}`, hits, 0, 0, "");
        }
      }
    } catch (e) {
      tally(`F/db ${rel}`, done, 0, 0, `中断: ${e.message}`);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  // 向量库的归属藏在 payload JSON 里（actorId/user_id 两处），按子串整串替换
  const vecDir = join(ROOT, "agentic_memory");
  if (existsSync(vecDir)) {
    for (const name of readdirSync(vecDir).filter((n) => /^vectors.*\.db$/.test(n))) {
      const rel = `agentic_memory/${name}`;
      let db;
      try { db = new Database(join(ROOT, rel)); } catch (e) { tally(`F/db ${rel}`, 0, 0, 0, `打不开: ${e.message}`); continue; }
      let done = 0;
      try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vectors'").get();
        if (!has) continue;
        const pats = [];
        for (const old of [...CLAIM].filter((v) => v !== target)) {
          for (const key of ["actorId", "user_id"]) {
            pats.push({ from: `"${key}":"${old}"`, to: `"${key}":"${target}"` });
          }
        }
        // instr 而非 LIKE：LIKE 会把旧拼写里的 _ 当通配符，已认领的行会被反复判为待认领
        const where = pats.map(() => "instr(payload, ?) > 0").join(" OR ");
        const args = pats.map((p) => p.from);
        const hits = db.prepare(`SELECT COUNT(*) AS n FROM vectors WHERE ${where}`).all(...args)[0].n;
        if (hits) {
          if (!dry) {
            snapshotDb(rel);
            for (const p of pats) {
              db.prepare("UPDATE vectors SET payload = replace(payload, ?, ?) WHERE instr(payload, ?) > 0")
                .run(p.from, p.to, p.from);
            }
          }
          done = hits;
          tally(`F/db ${rel} :: vectors.payload`, hits, 0, 0, "actorId,user_id");
        }
      } catch (e) {
        tally(`F/db ${rel}`, done, 0, 0, `中断: ${e.message}`);
      } finally {
        try { db.close(); } catch { /* already closed */ }
      }
    }
  }
}

/* ── G. 无归属字段、代码侧尚未分区（本命令无法认领） ─────────── */

const UNOWNED = [
  ["proactivity/sensor-fabric/streams", "传感器流按天分区，行内无 actor：需代码侧按 actor 落盘"],
  ["finance", "两种拼写目录并存且现行命名规则未确认：先人工核对再并入"],
  ["service-config.json", "整机服务接入设置（非密钥部分）：平台级，本命令不认领。密钥已改按 actor 加密落盘（model-keys / mail-watch/pass）"],
  ["service-secrets", "运营方/本机主对话与 TTS 密钥：整机一份，开周界鉴权后不再回放进 env；邮箱授权码需本人重新提交"],
];
const unownedFound = UNOWNED
  .filter(([rel]) => existsSync(join(ROOT, rel)))
  .map(([rel, why]) => `  ${rel} —— ${why}`);

/* ── 汇总 ───────────────────────────────────────────────────── */

if (!dry && rows.some((r) => r.done + r.merged > 0)) mkdirSync(BACKUP_DIR, { recursive: true });

const dw = (s) => [...String(s)].reduce((a, ch) => a + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => `${s}${" ".repeat(Math.max(1, n - dw(s)))}`;
const tableWidth = Math.max(28, ...rows.map((r) => dw(r.store)));

console.log(`\n数据根 : ${ROOT}`);
console.log(`目标   : ${target}   （同一身份的旧拼写：${[...SPELLINGS].filter((f) => f !== target).join(", ") || "无"}）`);
console.log(`模式   : ${dry ? "试运行（不写盘）" : "写入"}   备份：${dry ? "—" : BACKUP_DIR}`);
console.log(`\n${pad("存储位点", tableWidth)}${pad("认领", 6)}${pad("合并", 6)}${pad("跳过", 6)}说明`);
for (const r of rows) {
  if (!r.done && !r.merged && !r.skipped && !r.note) continue;
  console.log(`${pad(r.store, tableWidth)}${pad(r.done, 6)}${pad(r.merged, 6)}${pad(r.skipped, 6)}${r.note}`);
}
console.log(`\n合计：认领 ${rows.reduce((a, r) => a + r.done, 0)} 项 / 合并 ${rows.reduce((a, r) => a + r.merged, 0)} 项`);
if (unownedFound.length) {
  console.log("\n无主字段、本命令认领不了（需代码侧分区或账号配置）：");
  console.log(unownedFound.join("\n"));
}
if (dry) console.log("\n以上是试运行。去掉 --dry 才会写盘；写盘前请先停服务。");
else console.log(`\n完成。原件快照在 ${BACKUP_DIR}（sqlite 含 -wal/-shm 伴生文件）。`);
