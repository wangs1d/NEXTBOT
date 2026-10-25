/**
 * 建议结果的文本投影：给 LLM 的紧凑摘要（工具回执正文明语），让模型口头
 * 回复能落到具体数据上。结构化卡片不经此——卡片由 tool-card-registry 从
 * 结构化字段确定性构建。
 */

import type { SuggestResult } from "./suggest-engine.js";

export function buildAdvisorSuggestionText(result: SuggestResult): string {
  const lines: string[] = [];
  const pick = result.pick;
  const first = result.candidates[0];
  // 立场先行：主推 + 为什么是它（让模型口头回复第一句就给结论，而不是罗列）
  if (pick && first && pick.productId === first.productId && pick.headline) {
    lines.push(`主推：${[first.brand, first.name].filter(Boolean).join(" ")}｜${first.priceLabel}`);
    lines.push(`  为什么：${pick.headline}`);
  }
  for (const c of result.candidates) {
    lines.push(`【${c.brand} ${c.name}｜${c.priceLabel}】`);
    for (const r of c.reasons) lines.push(`  + ${r}`);
    for (const t of c.cautions) lines.push(`  - ${t}`);
    const alt = result.alternatives?.find((a) => a.productId === c.productId);
    if (alt) lines.push(`  ▸ 什么时候选它：${alt.whenChoose}`);
    if (c.image) lines.push(`  图：${c.image}`);
    for (const v of c.videos) {
      lines.push(`  视频：${v.title}${v.url ? `（${v.url}）` : ""}`);
    }
  }
  if (result.compare && result.compare.rows.length > 0) {
    lines.push("对比：");
    for (const row of result.compare.rows) {
      lines.push(`  ${row.label}：${row.values.join(" vs ")}`);
    }
  }
  return lines.join("\n");
}
