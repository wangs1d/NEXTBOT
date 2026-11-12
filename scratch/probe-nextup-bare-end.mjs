/**
 * 裸 [END] 事故修复效果探针：把 2026-11-12 真机截图的原文喂给修好的
 * extractNextUpSuggestions，看 followups 提取与正文剥离结果。
 * 运行：node --import tsx scratch/probe-nextup-bare-end.mjs
 */
import { extractNextUpSuggestions } from "../server/src/services/reply-envelope.ts";

const cases = [
  {
    label: "真机截图原文（裸 [END] 结尾）",
    text:
      "其他我自己定。\n[NEXT_UP_START]\n下个月出发，人均一万五\n就按居民岛省钱版排\n[END]",
  },
  {
    label: "裸 [END] 跟在第二条建议同一行",
    text:
      "其他我自己定。\n[NEXT_UP_START]\n下个月出发，人均一万五\n就按居民岛省钱版排 [END]",
  },
  {
    label: "标准写法（对照，应不受影响）",
    text:
      "其他我自己定。\n[NEXT_UP_START]\n下个月出发，人均一万五\n就按居民岛省钱版排\n[NEXT_UP_END]",
  },
  {
    label: "卡片块 + 裸 [END] 混合（防误伤验证）",
    text:
      '比价完成。[AGENT_RESULT_CARD_START]\n{"cardType":"metric","title":"比价卡","items":[{"type":"num","text":"现价 289"}]}\n[AGENT_RESULT_CARD_END]\n[NEXT_UP_START]\n帮我代下单\n换预算再比一轮\n[END]',
  },
];

for (const c of cases) {
  const { text, followups } = extractNextUpSuggestions(c.text);
  console.log("── " + c.label);
  console.log("  followups（手机端会渲染成胶囊的条目）:");
  followups.forEach((f) => console.log("    • " + f));
  console.log("  正文（气泡里显示的文本）: " + JSON.stringify(text));
  console.log(
    "  [END] 是否泄漏: " + (text.includes("[END]") || followups.some((f) => f.includes("END")) ? "❌ 是" : "✅ 否"),
  );
  console.log();
}
