/**
 * Muse 对标三能力真链探针（2026-09-24）。
 *
 * 沙箱内起真实装配（createAppServices + HTTP 监听），验证：
 *   1. 计划推进敏感闸：外部步骤（签约付定金）推进到门口转「等你确认」，零 LLM 派发
 *   2. memory.forget 多库联动：兴趣/降价监控/计划三库按关键词清除并如实计数
 *   3. 行为审计时间线：activity.timeline 工具 + GET /agent/audit-timeline 端点
 *
 * 运行：node --import tsx scripts/probe-muse-parity.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "pa-probe-muse-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);
process.env.PROACTIVITY_QUIET_START = "0";
process.env.PROACTIVITY_QUIET_END = "0";

const log = (s: string): void => console.log(`[probe-muse] ${s}`);
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    log(`PASS ${name}`);
  } else {
    failures += 1;
    log(`FAIL ${name}${detail !== undefined ? ` → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}

const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
const services = await createAppServices();
await services.app.listen({ port: 3102, host: "127.0.0.1" });
log("服务端已监听 3102（沙箱）");

const CTX = { sessionId: "probe_user", userId: "probe_user" };
type ToolResult = { ok: boolean; result: Record<string, unknown> };
async function tool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = (await services.toolRegistry.execute(name, input, CTX)) as ToolResult;
  return { __toolOk: r.ok, ...(r.result ?? {}) };
}

// ── 1. 计划推进敏感闸（外部步骤 → awaiting_confirm，零派发） ──
const plan = (await tool("goal.plan.create", {
  title: "三个月搬家计划",
  steps: ["签约付定金", "查房源并整理候选"],
})) as { __toolOk: boolean; goalId?: string; steps?: Array<{ sensitivity?: string }> };
check("① 计划建档", plan.__toolOk === true && !!plan.goalId, plan);
check("① 步骤敏感分级 external", plan.steps?.[0]?.sensitivity === "act_external", plan.steps);
const adv1 = (await tool("goal.plan.advance", { goalId: plan.goalId })) as {
  __toolOk: boolean;
  action?: string;
  reason?: string;
};
check("① 外部步骤转等待确认", adv1.action === "awaiting_confirm", adv1);
check("① 理由说明需用户同意", String(adv1.reason ?? "").includes("同意"), adv1.reason);

// ── 2. memory.forget 多库联动 ──
await tool("interest.manage", { action: "add", name: "戴森吹风机", type: "brand" });
await tool("shopping.compare.watch", { action: "add", query: "戴森吹风机", platform: "taobao", targetPrice: 300 });
const plan2 = (await tool("goal.plan.create", {
  title: "戴森吹风机采购计划",
  steps: ["查价格走势"],
})) as { __toolOk: boolean; goalId?: string };

const forget = (await tool("memory.forget", { target: "戴森吹风机" })) as {
  __toolOk: boolean;
  cleared?: Record<string, number>;
  skipped?: string[];
};
check(
  "② forget 三库联动清除",
  forget.__toolOk === true &&
    (forget.cleared?.interests ?? 0) === 1 &&
    (forget.cleared?.watches ?? 0) === 1 &&
    (forget.cleared?.goals ?? 0) === 1,
  forget,
);
const left = (await tool("goal.plan.list", {})) as { plans?: Array<{ title?: string }> };
check("② 无关计划不受影响", (left.plans ?? []).some((p) => p.title === "三个月搬家计划"), left.plans);

// ── 3. 行为审计时间线 ──
await fetch("http://127.0.0.1:3102/agent/activities", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ actorId: "probe_user", kind: "action.purchase", title: "已为你订购牛奶", summary: "探针取证条目" }),
});
const timelineTool = (await tool("activity.timeline", { limit: 30 })) as {
  __toolOk: boolean;
  count?: number;
  entries?: Array<{ bucket?: string; title?: string }>;
};
check("③ activity.timeline 有台账", timelineTool.__toolOk === true && (timelineTool.count ?? 0) >= 2, timelineTool);
check("③ 时间线含计划条目", (timelineTool.entries ?? []).some((e) => String(e.title ?? "").includes("搬家计划")), timelineTool.entries);

const res = await fetch("http://127.0.0.1:3102/agent/audit-timeline?actorId=probe_user&limit=50");
const tl = (await res.json()) as {
  ok: boolean;
  count?: number;
  entries?: Array<{ bucket?: string; source?: string }>;
  summary?: string;
};
check("③ HTTP audit-timeline 200 + 聚合多源", res.status === 200 && tl.ok === true && (tl.count ?? 0) >= 3, tl);
check(
  "③ 三桶齐备（done/planned/awaiting）",
  ["done", "planned", "awaiting"].every((b) => (tl.entries ?? []).some((e) => e.bucket === b)),
  tl.entries?.map((e) => e.bucket),
);
check("③ summary 三段式", String(tl.summary ?? "").includes("等你确认") && String(tl.summary ?? "").includes("最近办结"), tl.summary);

// ── 收尾 ──
log(failures === 0 ? "ALL PASS" : `FAILED ×${failures}`);
try {
  await services.app.close();
} catch {
  /* 沙箱收尾 */
}
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* Windows 下服务端句柄未全释放时留目录，不影响结论 */
}
process.exit(failures === 0 ? 0 : 1);
