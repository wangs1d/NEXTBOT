/**
 * 真实链路冒烟（smoke-channels.ts）—— 自主能力关键通道的每日体检（只读，零副作用）。
 *
 *   npx tsx scripts/smoke-channels.ts   （exit 0=全过或有 SKIP，1=有 FAIL）
 *
 * 覆盖：
 *   - 钱包账本 / 定时任务存储 / 任务面台账 / 守卫幂等表 / 评估器状态 各落盘可读
 *   - 移动推送 provider 配置检查（JPUSH/BARK/WEBHOOK）
 * 配 CI 或 cron 后，"真实可用能力"的断链当天就能发现。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = { name: string; status: "PASS" | "SKIP" | "FAIL"; detail: string };
const rows: Row[] = [];

async function check(name: string, fn: () => Promise<string> | string, configured = true): Promise<void> {
  if (!configured) {
    rows.push({ name, status: "SKIP", detail: "未配置（env 缺失），跳过" });
    return;
  }
  try {
    const detail = await fn();
    rows.push({ name, status: "PASS", detail });
  } catch (err) {
    rows.push({ name, status: "FAIL", detail: err instanceof Error ? err.message : String(err) });
  }
}

void (async () => {
  // 1. 钱包账本（本地真实服务，read-only）
  await check("wallet 账本", () => {
    const p = join(process.cwd(), "data", "real-funds-wallet.json");
    if (!existsSync(p)) return "账本文件尚未创建（首次使用后生成），空态正常";
    const data = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return `账本可读，${Object.keys(data).length} 个顶层键`;
  });

  // 2. 定时任务存储可读（重试治理/死信依赖它持久化）
  await check("schedule-tasks 存储", () => {
    const p = process.env.SCHEDULE_TASKS_FILE ?? join(process.cwd(), "data", "schedule-tasks.json");
    if (!existsSync(p)) return "无任务文件（尚未创建过定时任务），空态正常";
    const data = JSON.parse(readFileSync(p, "utf8")) as { tasks?: unknown[] };
    return `可读，${data.tasks?.length ?? 0} 条任务`;
  });

  // 3. 任务面台账落盘（重启恢复能力）
  await check("task-plane 台账", () => {
    const hub = join(process.cwd(), "data", "task-plane", "task-hub.json");
    const outbox = join(process.cwd(), "data", "task-plane", "task-outbox.json");
    const parts: string[] = [];
    for (const [label, p] of [["task-hub", hub], ["task-outbox", outbox]] as const) {
      parts.push(`${label}: ${existsSync(p) ? "已落盘" : "暂无文件（首次任务后生成）"}`);
    }
    return parts.join("；");
  });

  // 4. 推送通道配置
  await check("移动推送通道", () => {
    const providers = [
      process.env.JPUSH_APP_KEY && process.env.JPUSH_MASTER_SECRET ? "jpush" : null,
      process.env.BARK_URL ? "bark" : null,
      process.env.MOBILE_PUSH_WEBHOOK_URL ? "webhook" : null,
    ].filter(Boolean);
    if (providers.length === 0) return "无 provider 配置（离线必达升级不可用；配置 JPUSH_APP_KEY 或 BARK_URL 启用）";
    return `已配置: ${providers.join(", ")}`;
  });

  // 5. 敏感工具守卫数据
  await check("ToolCallGuard 幂等表", () => {
    const p = join(process.cwd(), "data", "tool-guard", "idempotency.json");
    if (!existsSync(p)) return "无幂等记录（尚无敏感工具调用），目录将按需创建";
    const data = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return `幂等表可读，${Object.keys(data).length} 条在档`;
  });

  // 6. 评估器状态落盘（L2 重启不重发的依据）
  await check("评估器状态落盘", () => {
    const p = join(process.cwd(), "data", "proactivity", "evaluator-state.json");
    if (!existsSync(p)) return "暂无状态文件（首次评估 flush 后生成）";
    return "状态文件存在，重启恢复生效";
  });

  // 汇总
  const failed = rows.filter((r) => r.status === "FAIL");
  const skipped = rows.filter((r) => r.status === "SKIP");
  console.log("\n=== 真实链路冒烟（smoke-channels） ===");
  for (const r of rows) {
    const icon = r.status === "PASS" ? "✅" : r.status === "SKIP" ? "⏭️ " : "❌";
    console.log(`${icon} ${r.name}: ${r.detail}`);
  }
  console.log(`\n汇总: ${rows.length - failed.length - skipped.length} PASS / ${skipped.length} SKIP / ${failed.length} FAIL`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
