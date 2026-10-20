import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("d:/ws-project/Private-Agent/server/data/agentic_memory/agentic-memory.db", { readOnly: true });
console.log("=== structured_facts (all) ===");
for (const r of db.prepare("select actor_id,entity,field,value,status,source_ref,confidence from structured_facts order by actor_id,field").all()) {
  console.log(`${r.actor_id} | ${r.entity} | ${r.field} = ${r.value} | ${r.status} | ${r.source_ref} | ${r.confidence}`);
}
console.log("\n=== user_understanding (all) ===");
for (const r of db.prepare("select actor_id,topic,kind,note,status from user_understanding").all()) {
  console.log(`${r.actor_id} | ${r.topic} | ${r.kind} | ${r.note} | ${r.status}`);
}
console.log("\n=== ledger_records distinct actors ===");
console.log(db.prepare("select distinct actor_id from ledger_records").all().map((r) => r.actor_id).join(", "));
