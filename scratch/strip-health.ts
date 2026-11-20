import fs from "node:fs";
const p = "server/src/tools/capability-modules/index.ts";
let lines = fs.readFileSync(p, "utf8").split(/\r?\n/);

function dropEntry(domain: string): void {
  const idx = lines.findIndex((l) => l.includes(`domain: "${domain}"`));
  if (idx < 0) throw new Error("not found: " + domain);
  let start = idx;
  while (start >= 0 && lines[start].trim() !== "{") start -= 1;
  let end = idx;
  while (end < lines.length && lines[end].trim() !== "},") end += 1;
  lines.splice(start, end - start + 1);
}
dropEntry("health_fitness");
dropEntry("period_care");

lines = lines.filter((l) => !/^\s*healthFitnessService: HealthFitnessService;$/.test(l));
lines = lines.filter((l) => !/^\s*periodCareService: PeriodCareService;$/.test(l));

const text = lines.join("\n");
fs.writeFileSync(p, text);
console.log("cleaned:", domainCount());
function domainCount(): string {
  return "domains=" + (text.match(/domain: "/g) ?? []).length;
}
