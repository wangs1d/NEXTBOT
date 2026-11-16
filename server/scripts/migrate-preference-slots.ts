/**
 * 偏好在 KV 槽位的存量迁移（2026-11-12）
 *
 * 背景：`memory_preferences` / `memory_facts` 已无写入者（权威源是 structured_facts），
 * 但历史内容还在，且读取侧会无条件注入。本脚本把它们搬进 structured_facts，
 * 再清空槽位——先搬后删，不丢信息。
 *
 * 映射（确定性，不做语义猜测）：
 *   - 档案字段副本（称呼/职业/居住地/技术栈/生日/公司/学历）→ 跳过（权威库已有）
 *   - 含 老婆/妻子/丈夫/对象/女友/男友 → field=配偶（relations 类）
 *   - 含 喜欢/讨厌/偏好/爱喝/兴趣 → field=偏好（preference 类）
 *   - 其它 → field=备注（note 类）
 *
 * 运行：cd server && npx tsx scripts/migrate-preference-slots.ts [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const DATA_DIR = path.resolve(process.cwd(), "data");
const KV_FILE = path.join(DATA_DIR, "agent-memory-sync.json");
const DB_FILE = path.join(DATA_DIR, "agentic_memory", "agentic-memory.db").replace(/\\/g, "/");
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "");

const PROFILE_FIELDS = ["称呼", "职业", "居住地", "技术栈", "生日", "公司", "学历"];
const DECORATION_RE = /^\s*\[[^\]]{1,40}\]\s*/;

type Row = { actorId: string; field: string; value: string; sourceKey: string };

function stripDecorations(text: string): string {
  let t = text;
  for (let i = 0; i < 4; i++) {
    const next = t.replace(DECORATION_RE, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

function classify(text: string): { field: string; value: string } | null {
  const body = stripDecorations(text);
  if (!body) return null;
  // 助手自述不进画像（权威侧本就不收）
  if (/Agent|助手/.test(body)) return null;
  if (PROFILE_FIELDS.some((f) => body.includes(`${f}：`) || body.includes(`${f}:`))) return null;

  const rel = body.match(/(?:老婆|妻子|丈夫|对象|正主|女朋友|男友|女友)(?:是|叫|为)\s*([^，。,;；\s]+)/);
  if (rel?.[1]) return { field: "配偶", value: rel[1] };

  if (/(所在城市|住在|居住在|定居)/.test(body)) {
    const m = body.match(/(?:所在城市为|住在|居住在|定居在?)\s*([^，。,;；\s]+)/);
    return { field: "居住地", value: m?.[1] ?? body };
  }
  if (/(在做|从事|职业是)(独立开发|程序员|产品|设计|运营|销售)/.test(body)) {
    return {
      field: "职业",
      value: body.replace(/^(?:用户|我)\s*/, "").replace(/^(?:在做|从事|职业是)\s*/, "").trim(),
    };
  }
  if (/(喜欢|讨厌|偏好|爱喝|爱吃|兴趣|爱用|常用|不吃|别提)/.test(body)) {
    return { field: "偏好", value: body.replace(/^(?:用户|我)\s*/, "").trim() };
  }
  return { field: "备注", value: body.replace(/^(?:用户|我)\s*/, "").trim() };
}

const kv = JSON.parse(fs.readFileSync(KV_FILE, "utf8")) as {
  sessions: Record<string, { revision: number; entries: Record<string, unknown> }>;
};

const plan: Row[] = [];
for (const [actorId, session] of Object.entries(kv.sessions ?? {})) {
  for (const key of ["memory_preferences", "memory_facts"]) {
    const raw = session.entries?.[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    for (const line of raw.split("\n").filter(Boolean)) {
      const mapped = classify(line);
      if (!mapped) continue;
      plan.push({ actorId, ...mapped, sourceKey: key });
    }
  }
}

console.log(`模式：${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`待迁移条目：${plan.length} 条，涉及 actor：${new Set(plan.map((p) => p.actorId)).size}`);
const byField: Record<string, number> = {};
for (const p of plan) byField[p.field] = (byField[p.field] ?? 0) + 1;
console.log("字段分布：", byField);
for (const p of plan.slice(0, 12)) {
  console.log(`  ${p.actorId} | ${p.field} = ${p.value.slice(0, 50)}  (来自 ${p.sourceKey})`);
}

if (!APPLY) {
  console.log("\n加 --apply 执行写盘（会先备份 KV 与数据库）。");
  process.exit(0);
}

// 备份
const kvBackup = `${KV_FILE}.bak-pref-${STAMP}`;
if (!fs.existsSync(kvBackup)) fs.copyFileSync(KV_FILE, kvBackup);
const dbBackup = path.join(path.dirname(DB_FILE), `agentic-memory.backup-pref-${STAMP}.db`);
if (!fs.existsSync(dbBackup)) {
  try {
    execFileSync("python", ["-c", `import sqlite3,sys
src=sqlite3.connect(${JSON.stringify(DB_FILE)}); dst=sqlite3.connect(${JSON.stringify(dbBackup)})
src.backup(dst); dst.close(); src.close()`]);
  } catch (err) {
    console.error("数据库备份失败，已中止：", err);
    process.exit(1);
  }
}

const now = new Date().toISOString();
const payload = JSON.stringify(plan.map((p, i) => ({ ...p, id: `mig_pref_${Date.now().toString(36)}_${i}` })));
const script = `
import json, sqlite3
rows = json.loads(sys.stdin.read()) if False else json.loads(${JSON.stringify(payload)})
db = sqlite3.connect(${JSON.stringify(DB_FILE)})
cur = db.cursor()
inserted = 0; skipped = 0
for r in rows:
    cur.execute(
        "SELECT 1 FROM structured_facts WHERE actor_id=? AND entity='user' AND field=? AND value=? AND status='active'",
        (r["actorId"], r["field"], r["value"]),
    )
    if cur.fetchone():
        skipped += 1
        continue
    cur.execute(
        """INSERT INTO structured_facts
           (id, actor_id, entity, field, value, confidence, source_ref, status, created_at, updated_at, temporal, confirm_count)
           VALUES (?, ?, 'user', ?, ?, 0.7, ?, 'active', ?, ?, 'current', 1)""",
        (r["id"], r["actorId"], r["field"], r["value"], "migration:kv-preference-" + ${JSON.stringify(STAMP)}, ${JSON.stringify(now)}, ${JSON.stringify(now)}),
    )
    inserted += 1
db.commit()
print(json.dumps({"inserted": inserted, "skipped": skipped}))
`;
const out = execFileSync("python", ["-c", script], { encoding: "utf8" });
console.log("结构化事实库：", out.trim());

// 清空槽位
for (const session of Object.values(kv.sessions ?? {})) {
  let touched = false;
  for (const key of ["memory_preferences", "memory_facts"]) {
    if (typeof session.entries?.[key] === "string" && String(session.entries[key]).trim()) {
      delete session.entries[key];
      touched = true;
    }
  }
  if (touched) session.revision += 1;
}
fs.writeFileSync(KV_FILE, JSON.stringify(kv), "utf8");
console.log(`已清空 KV 槽位；备份：${kvBackup}`);
console.log(`数据库备份：${dbBackup}`);
