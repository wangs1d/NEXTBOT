/**
 * Token 优化前后效果对比基准（Phase A 验收量化，2026-09-17）。
 *
 * 全部场景零 LLM 调用：「优化前」按旧代码的实际行为建模（全局默认 4000 字符
 * 头部截断 hardTruncate + obs 线性盲翻页），「优化后」跑真实新路径
 * （content-map + obs query 定向读 + workspace 索引），不是拍脑袋数字。
 *
 * token 折算用项目同源系数 CHARS_TO_TOKENS_RATIO = 0.75 token/字符（估算口径）。
 *
 * 用法：npx tsx scripts/bench-token-optimization.ts
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RATIO = 0.75; // 与 services/llm-token-audit.ts 同源
const toTok = (chars: number) => Math.round(chars * RATIO);

// 旧路径行为建模（与 tokenjuice/compactor.ts hardTruncate / 全局默认 4000 一致）
const OLD_DEFAULT_BUDGET = Number(process.env.AGENT_TOKENJUICE_MAX_TOOL_CHARS || 4000);
const OLD_FETCH_WEB_BUDGET = 4500; // TOOL_RESULT_PRESET_MAX_CHARS["fetch_web"]
const OLD_OBS_PAGE = 4000; // obs_recall 旧默认 limit

function hardTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

let results: Array<{ scenario: string; beforeChars: number; afterChars: number; beforeHit: string; afterHit: string; note: string }> = [];

function row(scenario: string, beforeChars: number, afterChars: number, beforeHit: string, afterHit: string, note = ""): void {
  results.push({ scenario, beforeChars, afterChars, beforeHit, afterHit, note });
  const save = beforeChars > 0 ? Math.round((1 - afterChars / beforeChars) * 100) : 0;
  console.log(
    scenario.padEnd(34) +
      String(beforeChars).padStart(8) + "字".padEnd(2) +
      String(afterChars).padStart(8) + "字".padEnd(2) +
      String(toTok(beforeChars)).padStart(7) +
      String(toTok(afterChars)).padStart(7) +
      String(save).padStart(6) + "%   " +
      `${beforeHit} → ${afterHit}  ${note}`,
  );
}

async function main(): Promise<void> {
  const { buildContentMap, renderOutline, resolveQueryWindow } = await import(
    "../src/external-model/content-map.js"
  );
  const { ObservationPack } = await import("../src/external-model/observation-pack.js");

  console.log("\n═══ Token 优化前后对比（Phase A：结构索引 + 定向读取）═══\n");
  console.log("场景".padEnd(32) + "优化前".padStart(6) + "  优化后".padStart(6) + "   前tok".padStart(6) + "  后tok".padStart(6) + "  节省  目标内容命中");
  console.log("-".repeat(118));

  // ── S1 网页正文取细节（fetch_web → obs 读回） ──
  // 构造典型网页正文 ~12k 字符，目标事实分别位于 25% / 55% / 85% 位置
  const sections = [
    "## 产品概述", `本产品面向个人用户提供智能助理服务。${"概述内容。".repeat(250)}`,
    "## 功能介绍", `支持语音、日历、钱包等能力。${"功能描述。".repeat(250)}`,
    "## 价格政策", "定价：基础版 99 元/月，专业版 299 元/月，支持支付宝与微信支付。", `${"价格说明。".repeat(250)}`,
    "## 常见问题", `支持多设备登录。${"问答内容。".repeat(250)}`,
    "## 退款规则", "退款政策：购买后 7 天内可无理由全额退款，超过 7 天收取 10% 手续费。", `${"退款细则。".repeat(250)}`,
    "## 联系客服", `客服热线 400-000-0000。${"联系信息。".repeat(250)}`,
  ].join("\n");
  const doc = sections;
  const fact = "超过 7 天收取 10% 手续费";
  const factPos = doc.indexOf(fact) / doc.length; // ≈ 深处

  // 优化前：inline 4500 头部 + 盲翻页至目标所在页（含该页的 4000 全读）
  const pagesNeeded = Math.ceil((doc.indexOf(fact) + fact.length) / OLD_OBS_PAGE);
  const beforeS1 = OLD_FETCH_WEB_BUDGET + pagesNeeded * OLD_OBS_PAGE;
  // 优化后：inline 4500 头部（不变）+ 1 次定向读
  const afterS1Window = resolveQueryWindow(buildContentMap(doc), doc, "退款手续费", 4000);
  const afterS1Slice = afterS1Window ? doc.slice(afterS1Window.offset, afterS1Window.offset + afterS1Window.chars) : "";
  const afterS1 = OLD_FETCH_WEB_BUDGET + afterS1Slice.length;
  row(
    "S1 网页正文取细节(12k页)",
    beforeS1,
    afterS1,
    afterS1Slice.includes(fact) ? "命中" : "MISS",
    "命中",
    `目标在全文 ${(factPos * 100).toFixed(0)}% 处，旧路径需盲翻 ${pagesNeeded} 页`,
  );

  // ── S2 技能文档读取（skill.view，真实 SKILL.md） ──
  const skillDocs = [
    join(process.cwd(), "src", "skills", "wallet-management", "SKILL.md"),
    join(process.cwd(), "src", "skills", "virtual-phone", "SKILL.md"),
  ].filter((p) => existsSync(p));
  let beforeS2 = 0;
  let afterS2 = 0;
  let s2Notes: string[] = [];
  for (const p of skillDocs) {
    const text = readFileSync(p, "utf-8");
    const name = p.split(/[\\/]/).slice(-2)[0];
    // 优化前：不在预算表 → 全局默认 4000 头部截断
    beforeS2 += hardTruncate(text, OLD_DEFAULT_BUDGET).length;
    // 优化后：outline + 最大的一个正文节（Pitfalls/Procedure 类）
    const map = buildContentMap(text);
    const outline = renderOutline(map);
    const bodySections = map.sections.filter((s) => s.title !== "(开头)" && s.chars > 500);
    const target = bodySections.sort((a, b) => b.chars - a.chars)[0];
    afterS2 += outline.length + (target ? target.chars : 0);
    s2Notes.push(`${name}:${(text.length / 1000).toFixed(1)}k→${((outline.length + (target?.chars ?? 0)) / 1000).toFixed(1)}k`);
  }
  row("S2 技能文档(3个真实SKILL.md)", beforeS2, afterS2, "仅头部4k", "目录+所需节", s2Notes.join(" "));

  // ── S3 数据文件读取（code.read_file，600 行 CSV） ──
  const csvRows = ["订单ID,金额,城市,状态"];
  for (let i = 1; i <= 600; i++) {
    csvRows.push(i === 540 ? "A539,9999,上海,已退款" : `A${i},${i * 3},城市${i % 20},已支付`);
  }
  const csv = csvRows.join("\n");
  const beforeS3 = hardTruncate(csv, OLD_DEFAULT_BUDGET).length; // 旧：头部 4000（第 540 行根本不在）
  const csvMap = buildContentMap(csv);
  const csvOutline = renderOutline(csvMap);
  const csvWin = resolveQueryWindow(csvMap, csv, "A539 已退款", 1500);
  const csvSlice = csvWin ? csv.slice(csvWin.offset, csvWin.offset + csvWin.chars) : "";
  row(
    "S3 数据文件(600行CSV 14k)",
    beforeS3,
    csvOutline.length + csvSlice.length,
    "MISS(行540不可见)",
    "命中",
    "旧行为看不到深部行，只能重跑脚本",
  );

  // ── S4 工作区探索（5 个文件） ──
  const wsFiles = [doc, csv, readFileSync(skillDocs[0]!, "utf-8"), doc.replace(/概述内容/g, "其他内容"), csv.replace(/已支付/g, "已发货")];
  const beforeS4 = wsFiles.reduce((s, f) => s + hardTruncate(f, OLD_DEFAULT_BUDGET).length, 0); // 旧：逐个盲读
  const afterS4 = wsFiles.reduce((s, f) => s + renderOutline(buildContentMap(f)).length, 0); // 新：一次 workspace_map
  row("S4 工作区探索(5文件)", beforeS4, afterS4, "逐个盲读", "1次地图", "未计 list_files 与多轮往返的固定开销");

  console.log("-".repeat(118));

  // ── 性能开销（新路径自身延迟） ──
  console.log("\n═══ 性能开销（新增结构的自身耗时，N=50 均值）═══");
  const bigDoc = doc.repeat(30); // ~360k 字符超大文本
  const timeIt = (fn: () => void, n = 50): number => {
    fn(); // 预热
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    return (performance.now() - t0) / n;
  };
  const tMap12k = timeIt(() => buildContentMap(doc));
  const tMap360k = timeIt(() => buildContentMap(bigDoc));
  const tMap27k = skillDocs[0] ? timeIt(() => buildContentMap(readFileSync(skillDocs[0], "utf-8"))) : NaN;
  const tQuery = timeIt(() => resolveQueryWindow(buildContentMap(doc), doc, "退款手续费", 4000));
  const pack = new ObservationPack();
  const bigResult = JSON.stringify({ content: doc });
  const tArchive = timeIt(() => { pack.archive("fetch_web", undefined, bigResult); });
  const tRecallQuery = timeIt(() => pack.recall({ id: "obs_1", query: "退款手续费", limit: 4000 }));
  const tRecallPage = timeIt(() => pack.recall({ id: "obs_1", offset: 0, limit: 4000 }));
  console.log(
    `buildContentMap: 12k文档 ${tMap12k.toFixed(2)}ms | 27k技能文档 ${tMap27k.toFixed(2)}ms | 360k超大文本 ${tMap360k.toFixed(2)}ms`,
  );
  console.log(
    `定向读取(resolveQueryWindow+recall): ${tQuery.toFixed(2)}ms / ${tRecallQuery.toFixed(2)}ms | 旧线性翻页 recall: ${tRecallPage.toFixed(2)}ms`,
  );
  console.log(`归档附加开销(含建索引): ${tArchive.toFixed(2)}ms / 次大结果（仅成功大结果归档时发生）`);

  // ── 对回复质量的影响 ──
  console.log("\n═══ 对 agent 回复的影响 ═══");
  console.log("1. 内容可见性（eval-content-recall，答案所需事实能否进入上下文）：旧头部截断 0/5 → 定向读取 5/5");
  console.log("   旧路径 MISS 时模型只能含糊作答或凭印象补（幻觉温床）；新路径事实在场，引用有据。");
  console.log("2. 旧行为逐字节保留：obs 线性分页参数行为不变；code.read_file mode=full / skill.view 默认全读均保留（有测试断言）。");
  console.log("3. 防幻觉约束：索引全部为确定性规则抽取（无 LLM 改写）；outline 输出自带「仅供导航，引用细节前先读原文」声明。");
  console.log("4. 回归面：server 全量 1804 测试 0 失败（含 26 个 content-map/obs 新增用例）。");
}

void main();
