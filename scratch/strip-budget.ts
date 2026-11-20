import fs from "node:fs";
const p = "server/src/external-model/resolve-chat-tools.ts";
const raw = fs.readFileSync(p, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let s = raw.split("\r\n").join("\n");
// 删除 resolveExposureTokenBudget（30-49）与 trimToolsToTokenBudget（51-108 区间到其闭合）
const a = s.indexOf("function resolveExposureTokenBudget(");
const b = s.indexOf("function trimToolsToTokenBudget(");
if (a < 0 || b < 0) throw new Error("anchors missing");
// 找 trim 函数闭合（从 b 起括号平衡）
let i = s.indexOf("{", b), depth = 0;
for (; i < s.length; i++) {
  if (s[i] === "{") depth++;
  else if (s[i] === "}") { depth--; if (depth === 0) break; }
}
// 向前吃掉紧邻的文档注释
let startA = a;
while (startA > 0 && (s[startA - 1] === "*" || s[startA - 1] === "/" || s[startA - 1] === "\n" || s[startA - 1] === " ")) startA--;
s = s.slice(0, startA) + "\n" + s.slice(i + 1).replace(/^\n+/, "\n");
// 清掉 estimateToolsSchemaTokens 导入（若已无使用）
if (!s.includes("estimateToolsSchemaTokens(")) {
  s = s.replace(/import \{ estimateToolsSchemaTokens \} from "\.\.\/tools\/tool-search\/catalog\.js";\n/, "");
}
fs.writeFileSync(p, s.split("\n").join(eol));
console.log("budget helpers removed");
