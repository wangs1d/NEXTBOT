import fs from "node:fs";
import { execSync } from "node:child_process";

const files = execSync('grep -rl "selectRelevantTools\\|ALWAYS_INCLUDED_TOOLS\\|CORE_TOOL_LIBRARY" server/src --include=*.ts', { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const out = raw
    .split("\r\n").join("\n")
    // 过时注释：把"不进 CORE_TOOL_LIBRARY"统一改口径
    .replace(/不进 CORE_TOOL_LIBRARY[：:]?/g, "走 deferred（延迟目录）：")
    .replace(/走 deferred（BM25 索引），走 deferred（延迟目录）：/g, "走 deferred（延迟目录）：")
    .replace(/（STATE_MACHINE_TOOL_ALLOWLIST \/ ALWAYS_INCLUDED_TOOLS \/ TOOL_RESULT_PRESET_MAX_CHARS）/g, "（STATE_MACHINE_TOOL_ALLOWLIST / TOOL_RESULT_PRESET_MAX_CHARS）")
    .replace(/^ \*   - \{@link selectRelevantTools\} 会把能力模块的 category mappings 合并到关键词分类\n/m, "")
    .replace(/selectRelevantTools 基于用户文本做关键词匹配 \+ 分类映射，微秒级。/g, "可视面装配（residency 名单 ∩ 候选）是 O(n) 过滤，微秒级。")
    .split("\n").join(eol);
  if (out !== raw) fs.writeFileSync(f, out);
}
console.log("comments updated:", files.length);
