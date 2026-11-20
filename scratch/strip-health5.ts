import fs from "node:fs";

/** 按行删除：先定位锚点，再删 anchor..anchor+span（保持其它内容不动）。 */
function stripLines(path: string, mut: (lines: string[]) => string[]): void {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const out = mut(lines);
  fs.writeFileSync(path, out.join(eol));
}

// ── bootstrap/create-app-services.ts ──
stripLines("server/src/bootstrap/create-app-services.ts", (lines) => {
  let ls = lines.filter(
    (l) =>
      !/^import \{ HealthFitnessService \} from "\.\.\/services\/health-fitness-service\.js";$/.test(l.trim()) &&
      !/^import \{ PeriodCareService \} from "\.\.\/services\/period-care-service\.js";$/.test(l.trim()) &&
      !/^\s*const healthFitnessService = new HealthFitnessService\(.*\);$/.test(l) &&
      !/^\s*healthFitnessService,$/.test(l) &&
      !/^\s*periodCareService,$/.test(l) &&
      !/^\s*periodCareService\.stop\(\);$/.test(l) &&
      !/^\s*void periodCareService\.flush\(\);$/.test(l) && !/^\s*\/\/ 女性关怀：停经期提醒调度 \+ 加密数据落盘$/.test(l),
  );
  // 删除 periodCareService 构造块（含注释行）
  const at = ls.findIndex((l) => l.includes("const periodCareService = new PeriodCareService("));
  if (at >= 0) {
    let start = at;
    while (start > 0 && ls[start - 1].trim().startsWith("//")) start -= 1;
    let end = at;
    while (end < ls.length && !ls[end].trim().startsWith("};")) end += 1;
    // 继续吃掉 load()/start() 与尾随空行
    end += 1;
    while (end < ls.length && (ls[end].includes("periodCareService.load()") || ls[end].includes("periodCareService.start()") || ls[end].trim() === "")) {
      if (ls[end].trim() === "" && end + 1 < ls.length && !ls[end + 1].trim().startsWith("periodCareService")) break;
      end += 1;
    }
    ls = [...ls.slice(0, start), ...ls.slice(end)];
  }
  return ls;
});

// ── bootstrap/types.ts ──
stripLines("server/src/bootstrap/types.ts", (lines) =>
  lines.filter(
    (l) =>
      !/health-fitness-service\.js";$/.test(l.trim()) &&
      !/period-care-service\.js";$/.test(l.trim()) &&
      !/^\s*healthFitnessService(\??):/.test(l) &&
      !/^\s*periodCareService(\??):/.test(l),
  ),
);

// ── agent-capabilities.ts ──
stripLines("server/src/agent/agent-capabilities.ts", (lines) => {
  const ls = lines.filter(
    (l) =>
      !/^\s*"health_fitness",$/.test(l) &&
      !/^\s*"period_care",$/.test(l) &&
      !/^\s*health_fitness: "健康/.test(l) &&
      !/^\s*period_care: "生理/.test(l),
  );
  // 删掉 health_fitness 的能力描述块（以 domain: "health_fitness" 起始的对象）
  const at = ls.findIndex((l) => l.includes('domain: "health_fitness"'));
  if (at >= 0) {
    let start = at;
    while (start > 0 && ls[start].trim() !== "{") start -= 1;
    let end = at, depth = 0;
    for (; end < ls.length; end++) {
      depth += (ls[end].match(/\{/g) ?? []).length - (ls[end].match(/\}/g) ?? []).length;
      if (depth <= 0) break;
    }
    ls.splice(start, end - start + 1);
  }
  return ls;
});

// ── brain/capability-cortex.ts ──
stripLines("server/src/brain/capability-cortex.ts", (lines) =>
  lines.filter((l) => !/^\s*health_fitness: \["health\."\],$/.test(l)),
);

// ── skill-bundles.ts：删 health 包 ──
stripLines("server/src/tools/exposure/skill-bundles.ts", (lines) => {
  const at = lines.findIndex((l) => l.includes('id: "health"'));
  if (at < 0) return lines;
  let start = at;
  while (start > 0 && lines[start].trim() !== "{") start -= 1;
  let end = at;
  while (end < lines.length && lines[end].trim() !== "},") end += 1;
  lines.splice(start, end - start + 1);
  return lines;
});
console.log("stripped");
