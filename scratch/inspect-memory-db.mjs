import { createRequire } from "node:module";
const require = createRequire("/opt/nextbot/server/package.json");
const Database = require("better-sqlite3");

const db = new Database("/root/.local/share/Nextbot/data/human-memory.sqlite", { readonly: true });
const rows = db.prepare("SELECT json FROM hm_nodes").all();
const byDay = {};
let min = null, max = null;
let actors = {};
for (const r of rows) {
  const j = JSON.parse(r.json);
  const t = j.createdAt || j.created_at || j.timestamp || j.updatedAt || "?";
  actors[j.actorId] = (actors[j.actorId] || 0) + 1;
  if (typeof t === "string") {
    const day = t.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    if (min === null || t < min) min = t;
    if (max === null || t > max) max = t;
  }
}
console.log("actors:", JSON.stringify(actors));
console.log("byDay:", JSON.stringify(byDay));
console.log("min:", min, "max:", max);
db.close();
