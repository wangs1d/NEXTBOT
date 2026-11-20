import fs from "node:fs";
const p = "server/src/tools/capability-modules/index.ts";
let lines = fs.readFileSync(p, "utf8").split(/\r?\n/);

function dropImportBlock(marker: string, fromSuffix: string): void {
  const idx = lines.findIndex((l) => l.includes(marker));
  if (idx < 0) throw new Error("marker not found: " + marker);
  let start = idx;
  while (start >= 0 && lines[start].trim() !== "import {") start -= 1;
  let end = idx;
  while (end < lines.length && !lines[end].includes(fromSuffix)) end += 1;
  lines.splice(start, end - start + 1);
}
dropImportBlock("HEALTH_FITNESS_CHAT_TOOLS", "./health-fitness/index.js");
dropImportBlock("PERIOD_CARE_CHAT_TOOLS", "./period-care/index.js");

fs.writeFileSync(p, lines.join("\n"));
console.log("imports removed");
