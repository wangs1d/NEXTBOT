import {
  recordThinkingLatency, resetThinkingStatsForTest,
  describeThinkingBudgetForStartup, buildThinkingBudgetHealth,
} from "../server/src/external-model/thinking-policy.js";

resetThinkingStatsForTest();
// 模拟实际运行几轮后的样本：GLM 曾经历过「不下发」阶段（历史遗留样本）
for (const t of [14807, 18432, 15200]) recordThinkingLatency({ providerId: "zhipu", model: "glm-5.3-flash", effortSent: "none", ttftMs: t });
for (const t of [2568, 765, 1200, 980]) recordThinkingLatency({ providerId: "zhipu", model: "glm-5.3-flash", effortSent: "high", ttftMs: t });
for (const t of [600, 720]) recordThinkingLatency({ providerId: "openai-compatible", model: "deepseek-flash", effortSent: "high", ttftMs: t });

const s = describeThinkingBudgetForStartup();
console.log("=== 启动日志 ===");
console.log(s.line);
for (const t of s.traps) {
  console.warn(`[thinking-budget] 隐性档位陷阱：${t.model} 不下发档位时首字 ${t.noneP50}ms，显式档位仅 ${t.explicitP50}ms（${t.ratio}x）。已强制显式下发，勿回退为「不传」。`);
}
console.log("\n=== GET /health 返回片段 ===");
console.log(JSON.stringify({ ok: true, ready: true, pid: 1234, thinkingBudget: buildThinkingBudgetHealth(4) }, null, 2));
