// 财务账单后台自动拉取单测：
// 1) runNow：拉到明细 → 与账本按确定性 id 幂等去重 → 仅新增入账；
// 2) 重复运行（同一批数据再拉）：全部命中已有 id，零新增零重复入账；
// 3) Cookie 未导入/未授权：如实失败（错误信息可指导用户），不动账本；
// 4) fetcher 失败（如登录态失效）：如实失败并记录在 status；
// 5) 调度闸门：未到 hour 不执行；当日已同步不重复执行（持久化跨实例生效）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FinanceBillAutoFetchService,
  readFinanceBillAutoFetchConfig,
} from "../src/services/finance-bill-auto-fetch-service.js";
import type { BillTransaction } from "../src/services/finance-bill-file-parser.js";

function tx(id: string, amount = 10, dayOffset = 0): BillTransaction {
  const d = new Date(Date.now() - dayOffset * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    id,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 12:00:00`,
    amount,
    type: "expense",
    category: "其他",
    merchant: "测试商户",
    source: "alipay",
  };
}

function makeLedger() {
  // 保存完整交易（签名级去重要按 日+金额+方向 比对，只有 id 不够）
  const store = new Map<string, Array<{ id: string; date: string; amount: number; type: string }>>();
  const imported: Array<{ actorId: string; items: BillTransaction[] }> = [];
  return {
    getTransactions: (actorId: string) => store.get(actorId) ?? [],
    importTransactions: async (actorId: string, items: BillTransaction[]) => {
      const list = store.get(actorId) ?? [];
      for (const it of items)
        list.push({ id: it.id, date: it.date, amount: it.amount, type: it.type });
      store.set(actorId, list);
      imported.push({ actorId, items });
      return items.length;
    },
    imported,
    store,
  };
}

const cookieOk = { getCookiesForAgent: async () => [{ name: "session", value: "x", domain: ".alipay.com" }] };
const cookieMissing = {
  getCookiesForAgent: async () => {
    throw new Error("未导入支付宝 Cookie");
  },
};

function makeService(opts: {
  cookies?: typeof cookieOk | typeof cookieMissing;
  fetcherOutcome?: { ok: true; transactions: BillTransaction[] } | { ok: false; error: string };
  env?: Record<string, string>;
  persistPath?: string;
  ledger?: ReturnType<typeof makeLedger>;
}) {
  const ledger = opts.ledger ?? makeLedger();
  const svc = new FinanceBillAutoFetchService({
    browserSessions: opts.cookies ?? cookieOk,
    financeDeepService: ledger,
    fetcher: async () => {
      if (opts.fetcherOutcome && !opts.fetcherOutcome.ok) return opts.fetcherOutcome;
      return opts.fetcherOutcome ?? { ok: true, transactions: [] };
    },
    env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "1", ...(opts.env ?? {}) },
    ...(opts.persistPath ? { persistPath: opts.persistPath } : {}),
  });
  return { svc, ledger };
}

test("runNow：仅新增入账，已有 id 去重", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc, ledger } = makeService({
      fetcherOutcome: { ok: true, transactions: [tx("alipay:1001", 25), tx("alipay:1002", 8)] },
      persistPath: join(dir, "state.json"),
    });
    const r1 = await svc.runNow("user-a");
    assert.equal(r1.ok, true);
    assert.equal((r1 as { added: number }).added, 2);

    // 第二次拉到同一批 + 一笔新的：只入新的
    const svc2 = new FinanceBillAutoFetchService({
      browserSessions: cookieOk,
      financeDeepService: ledger,
      fetcher: async () => ({
        ok: true,
        transactions: [tx("alipay:1001", 25), tx("alipay:1002", 8), tx("alipay:1003", 99)],
      }),
      env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "1" },
      persistPath: join(dir, "state.json"),
    });
    const r2 = await svc2.runNow("user-a");
    assert.equal(r2.ok, true);
    assert.equal((r2 as { added: number }).added, 1);
    assert.equal((r2 as { duplicates: number }).duplicates, 2);
    assert.equal(ledger.imported.length, 2); // 总共两次入账调用
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cookie 未导入：如实失败，不动账本", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc, ledger } = makeService({
      cookies: cookieMissing,
      fetcherOutcome: { ok: true, transactions: [tx("alipay:1")] },
      env: { FINANCE_BILL_AUTO_FETCH_ACTORS: "user-b" },
      persistPath: join(dir, "state.json"),
    });
    const r = await svc.runNow("user-b");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Cookie 不可用/);
    assert.equal(ledger.imported.length, 0);
    const st = svc.status().actors.find((a) => a.actorId === "user-b")!;
    assert.equal(st.lastOk, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetcher 失败（登录态失效）：如实记录在 status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc } = makeService({
      fetcherOutcome: { ok: false, error: "支付宝 Cookie 已过期（被重定向到登录页），请重新导入 Cookie" },
      env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "1", FINANCE_BILL_AUTO_FETCH_ACTORS: "user-c" },
      persistPath: join(dir, "state.json"),
    });
    const r = await svc.runNow("user-c");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Cookie 已过期/);
    const st = svc.status().actors.find((a) => a.actorId === "user-c")!;
    assert.equal(st.lastOk, false);
    assert.match(st.lastError ?? "", /Cookie 已过期/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("调度闸门：未到 hour 不执行；当日已同步不重复执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    let fetchCount = 0;
    const ledger = makeLedger();
    const svc = new FinanceBillAutoFetchService({
      browserSessions: cookieOk,
      financeDeepService: ledger,
      fetcher: async () => {
        fetchCount += 1;
        return { ok: true, transactions: [tx(`alipay:${fetchCount}`)] };
      },
      env: {
        FINANCE_BILL_AUTO_FETCH_ENABLED: "1",
        FINANCE_BILL_AUTO_FETCH_HOUR: "21",
        FINANCE_BILL_AUTO_FETCH_ACTORS: "user-d",
      },
      persistPath: join(dir, "state.json"),
    });

    // 20:59 —— 未到点，不执行
    await svc.runDue(new Date(2026, 8, 18, 20, 59));
    assert.equal(fetchCount, 0);
    // 21:00 —— 执行
    await svc.runDue(new Date(2026, 8, 18, 21, 0));
    assert.equal(fetchCount, 1);
    // 同日 21:01 —— 已同步过，跳过
    await svc.runDue(new Date(2026, 8, 18, 21, 1));
    assert.equal(fetchCount, 1);
    // 次日 21:00 —— 新的一天，再执行
    await svc.runDue(new Date(2026, 8, 19, 21, 0));
    assert.equal(fetchCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未启用（ENABLED=0）：runDue 直接 no-op", async () => {
  let fetchCount = 0;
  const svc = new FinanceBillAutoFetchService({
    browserSessions: cookieOk,
    financeDeepService: makeLedger(),
    fetcher: async () => {
      fetchCount += 1;
      return { ok: true, transactions: [] };
    },
    env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "0", FINANCE_BILL_AUTO_FETCH_HOUR: "21" },
    persistPath: join(tmpdir(), "never-read.json"),
  });
  await svc.runDue(new Date(2026, 8, 18, 21, 0));
  assert.equal(fetchCount, 0);
});

test("准实时模式（INTERVAL_MIN>0）：按间隔轮询增量，不受定点小时约束", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    let fetchCount = 0;
    const svc = new FinanceBillAutoFetchService({
      browserSessions: cookieOk,
      financeDeepService: makeLedger(),
      fetcher: async () => {
        fetchCount += 1;
        return { ok: true, transactions: [tx(`alipay:int-${fetchCount}`)] };
      },
      env: {
        FINANCE_BILL_AUTO_FETCH_ENABLED: "1",
        FINANCE_BILL_AUTO_FETCH_INTERVAL_MIN: "30",
        FINANCE_BILL_AUTO_FETCH_ACTORS: "user-e",
      },
      persistPath: join(dir, "state.json"),
    });

    // T0：从未跑过 → 立即拉基线
    const t0 = new Date(2026, 8, 18, 10, 0);
    await svc.runDue(t0);
    assert.equal(fetchCount, 1);
    // T0+29min —— 未到间隔，不执行
    await svc.runDue(new Date(t0.getTime() + 29 * 60_000));
    assert.equal(fetchCount, 1);
    // T0+31min —— 到间隔，执行（lastRun 更新为 T0+31）
    await svc.runDue(new Date(t0.getTime() + 31 * 60_000));
    assert.equal(fetchCount, 2);
    // T0+40min —— 距上次仅 9min，不执行（间隔从"上次运行"起算）
    await svc.runDue(new Date(t0.getTime() + 40 * 60_000));
    assert.equal(fetchCount, 2);
    // 服务重启（新实例同状态文件）：间隔语义跨实例保持
    const svc2 = new FinanceBillAutoFetchService({
      browserSessions: cookieOk,
      financeDeepService: makeLedger(),
      fetcher: async () => {
        fetchCount += 1;
        return { ok: true, transactions: [] };
      },
      env: {
        FINANCE_BILL_AUTO_FETCH_ENABLED: "1",
        FINANCE_BILL_AUTO_FETCH_INTERVAL_MIN: "30",
        FINANCE_BILL_AUTO_FETCH_ACTORS: "user-e",
      },
      persistPath: join(dir, "state.json"),
    });
    // 距上次 14min —— 不执行
    await svc2.runDue(new Date(t0.getTime() + 45 * 60_000));
    assert.equal(fetchCount, 2);
    // 距上次 31min —— 执行
    await svc2.runDue(new Date(t0.getTime() + 62 * 60_000));
    assert.equal(fetchCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("间隔下限：INTERVAL_MIN<10 收敛到 10 分钟（防支付宝风控）", async () => {
  const svc = new FinanceBillAutoFetchService({
    browserSessions: cookieOk,
    financeDeepService: makeLedger(),
    env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "1", FINANCE_BILL_AUTO_FETCH_INTERVAL_MIN: "1" },
  });
  assert.equal(svc.status().mode, "interval");
  assert.equal(svc.status().intervalMin, 10);
});

test("跨通道签名去重：通知通道已入账的交易（同日同额同向）Cookie 拉取不重复入账", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const ledger = makeLedger();
    // 通知通道先记了一笔（id 是 ingest-aly-* 前缀，与 Cookie 拉取的 alipay:<tradeNo> 不同）
    const noticeTx = tx("ingest-aly-abc", 25.8);
    await ledger.importTransactions("user-f", [noticeTx]);

    const svc = new FinanceBillAutoFetchService({
      browserSessions: cookieOk,
      financeDeepService: ledger,
      fetcher: async () => ({
        ok: true,
        // Cookie 拉到同一笔交易：交易号不同（alipay:9001），但同日同额同向
        transactions: [tx("alipay:9001", 25.8), tx("alipay:9002", 66)],
      }),
      env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "1" },
      persistPath: join(dir, "state.json"),
    });
    const r = await svc.runNow("user-f");
    assert.equal(r.ok, true);
    // 25.8 签名命中被跳过（通知通道已记），只有 66 的新交易入账
    assert.equal((r as { added: number }).added, 1);
    assert.equal((r as { duplicates: number }).duplicates, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------- //
// 账号级开关（2026-11-01）：后台拉的是用户自己的支付宝登录态，开不开由于他本人决定
// ---------------------------------------------------------------------- //

function makeScheduled(dir: string, opts?: { env?: Record<string, string> }) {
  let fetchCount = 0;
  const svc = new FinanceBillAutoFetchService({
    browserSessions: cookieOk,
    financeDeepService: makeLedger(),
    fetcher: async () => {
      fetchCount += 1;
      return { ok: true, transactions: [tx(`alipay:auto-${fetchCount}`)] };
    },
    env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "1", ...(opts?.env ?? {}) },
    persistPath: join(dir, "state.json"),
  });
  return { svc, count: () => fetchCount };
}

test("没开启的账号不会被后台拉：enroll 后才进调度，跨实例仍生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc, count } = makeScheduled(dir, { env: { FINANCE_BILL_AUTO_FETCH_HOUR: "21" } });
    await svc.runDue(new Date(2026, 8, 18, 21, 0));
    assert.equal(count(), 0, "没人开启 → 到点也不该动用户的登录态");

    const r = svc.enroll("alice");
    assert.equal(r.ok, true);
    assert.equal(svc.status("alice").actors.length, 1);
    assert.equal(svc.status("alice").actors[0]!.enrolled, true);
    await svc.runDue(new Date(2026, 8, 18, 21, 1));
    assert.equal(count(), 1);
    assert.equal(svc.listEnrolled().join(), "alice");

    // 重启（新实例读同一状态文件）：开启状态不丢
    const after = makeScheduled(dir, { env: { FINANCE_BILL_AUTO_FETCH_HOUR: "21" } });
    assert.equal(after.svc.isEnrolled("alice"), true);
    assert.equal(after.svc.isEnrolled("bob"), false);
    // 别人的开关看不见：status(bob) 不返回 alice 的行
    assert.equal(after.svc.status("bob").actors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关掉之后不再跑，且显式关闭压过部署方 env 种子", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc, count } = makeScheduled(dir, {
      env: { FINANCE_BILL_AUTO_FETCH_HOUR: "21", FINANCE_BILL_AUTO_FETCH_ACTORS: "user-seed" },
    });
    await svc.runDue(new Date(2026, 8, 18, 21, 0));
    assert.equal(count(), 1, "env 点名的账号等价于已开启（老配置语义不变）");

    assert.equal(svc.unenroll("user-seed").ok, true);
    await svc.runDue(new Date(2026, 8, 19, 21, 0));
    assert.equal(count(), 1, "用户自己关了，env 种子也拦不住他");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("个人节奏各自生效：全局 21 点的人与准实时 30 分钟的人互不影响", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc } = makeScheduled(dir, { env: { FINANCE_BILL_AUTO_FETCH_HOUR: "21" } });
    svc.enroll("alice"); // 跟全局：每天 21 点
    svc.enroll("bob", { intervalMin: 30 }); // 自己：每 30 分钟

    const t0 = new Date(2026, 8, 18, 10, 0);
    await svc.runDue(t0);
    // 10:00 只有准实时模式的 bob 该跑（alice 的定点是 21 点）
    const st = svc.status();
    assert.equal(st.actors.find((a) => a.actorId === "bob")?.intervalMin, 30);
    assert.equal(st.actors.find((a) => a.actorId === "alice")?.intervalMin, 0);
    assert.equal(st.actors.find((a) => a.actorId === "alice")?.hour, 21);
    assert.equal(st.actors.find((a) => a.actorId === "bob")?.lastOk, true, "bob 到点即拉基线");
    assert.equal(st.actors.find((a) => a.actorId === "alice")?.lastRunAt, undefined);

    await svc.runDue(new Date(2026, 8, 18, 21, 0));
    const after = svc.status();
    assert.equal(after.actors.find((a) => a.actorId === "alice")?.lastOk, true, "21 点 alice 也跑了");
    assert.equal(after.actors.find((a) => a.actorId === "alice")?.enrolled, true, "落运行结果不能擦掉开关");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("部署级 =0 是一键停摆：账号开着也不会动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc, count } = makeScheduled(dir, {
      env: { FINANCE_BILL_AUTO_FETCH_ENABLED: "0", FINANCE_BILL_AUTO_FETCH_HOUR: "21" },
    });
    assert.equal(svc.enroll("alice").ok, true);
    await svc.runDue(new Date(2026, 8, 18, 21, 0));
    assert.equal(count(), 0);
    assert.equal(svc.status().enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没带身份的请求不能替别人开关；env 默认值不再是占位账号", () => {
  const dir = mkdtempSync(join(tmpdir(), "finfetch-"));
  try {
    const { svc } = makeScheduled(dir);
    assert.equal(svc.enroll("anonymous").ok, false);
    assert.equal(svc.enroll("  ").ok, false);
    assert.equal(svc.unenroll("anonymous").ok, false);
    assert.equal(svc.listEnrolled().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const cfg = readFinanceBillAutoFetchConfig({} as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.actors, [], "默认不再把占位账号当成部署方点名的人");
  assert.equal(cfg.enabled, true, "默认开：进不进调度由账号级开关决定");
  assert.equal(readFinanceBillAutoFetchConfig({ FINANCE_BILL_AUTO_FETCH_ENABLED: "0" } as NodeJS.ProcessEnv).enabled, false);
});
