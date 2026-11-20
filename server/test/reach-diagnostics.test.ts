// 决策留痕与诊断快照的单测。
import assert from "node:assert/strict";
import { test } from "node:test";

import { ReachDecisionService } from "../src/proactivity/reach-decision-service.js";
import { registerReachDiagnosticsRoutes } from "../src/routes/http/reach-diagnostics.js";
import type { HttpRouteDeps } from "../src/routes/http/types.js";
import {
  clearReachDecisionLog,
  getReachDecisionStats,
  listReachDecisions,
} from "../src/proactivity/reach-decision-log.js";

const NOW = () => new Date(2026, 10, 19, 10, 0, 0);

test.beforeEach(() => clearReachDecisionLog());

function service(feedback?: (a: string, k: string) => { positive: number; negative: number }) {
  return new ReachDecisionService({
    ...(feedback ? { feedback } : {}),
    contextCost: () => 0,
    nowFn: NOW,
  });
}

test("每次 decide 都留痕（含被抑制的决策），并显示逐通道效用", () => {
  const svc = service((_a, k) => (k === "good" ? { positive: 12, negative: 0 } : { positive: 0, negative: 12 }));
  svc.decide({ actorId: "u1", kind: "good", importance: "high", requestedChannel: "voice.speak" });
  svc.decide({ actorId: "u2", kind: "bad", importance: "low", requestedChannel: "phone" });

  const all = listReachDecisions();
  assert.equal(all.length, 2);
  assert.equal(all[0].actorId, "u2"); // 时间倒序
  assert.equal(all[0].reason.includes("net_utility_negative") || all[0].action === "drop", true);
  assert.equal(all[0].perChannel.length, 4);
  assert.ok(all[0].perChannel.some((c) => c.channel === "phone"));
  assert.equal(all[1].action, "send_now");
});

test("按 actorId / kind / action 过滤 + limit", () => {
  const svc = service();
  for (let i = 0; i < 5; i++) {
    svc.decide({ actorId: i % 2 ? "a" : "b", kind: i % 2 ? "k1" : "k2", importance: "medium" });
  }
  assert.equal(listReachDecisions({ actorId: "a" }).length, 2);
  assert.equal(listReachDecisions({ kind: "k2" }).length, 3);
  assert.equal(listReachDecisions({ action: "send_now" }).length + listReachDecisions({ action: "batch" }).length, 5);
  assert.equal(listReachDecisions({ limit: 2 }).length, 2);
});

test("stats 按 action / channel / reason 聚合，并算平均效用", () => {
  const svc = service();
  svc.decide({ actorId: "a", kind: "k", importance: "medium" });
  svc.decide({ actorId: "a", kind: "k", importance: "medium" });
  const stats = getReachDecisionStats();
  assert.equal(stats.total, 2);
  assert.equal(Object.values(stats.byAction).reduce((a, b) => a + b, 0), 2);
  assert.equal(Object.values(stats.byChannel).reduce((a, b) => a + b, 0), 2);
  assert.ok(Object.keys(stats.byReason).length >= 1);
  assert.equal(typeof stats.avgUtility, "number");
});

test("diagnostics: 配置快照 + 反馈后验 + 决策列表", () => {
  const svc = service(() => ({ positive: 3, negative: 1 }));
  svc.decide({ actorId: "u1", kind: "k", importance: "high" });

  const d = svc.diagnostics({ actorId: "u1", kind: "k" });
  assert.equal(d.ok, true);
  assert.ok(d.config.channels);
  assert.ok(d.config.valueModulators);
  assert.ok(d.config.thresholds);
  assert.equal((d.config.prior as { alpha: number }).alpha, 1);
  assert.equal(d.feedback?.positive, 3);
  assert.equal(d.feedback?.negative, 1);
  assert.ok(Math.abs((d.feedback?.p ?? 0) - 0.667) < 0.01);
  assert.equal(d.decisions.length, 1);
  assert.equal(d.stats.total, 1);
});

test("显式请求绕过时也会留痕（explicit=true），便于审计谁绕过了闸门", () => {
  const svc = service();
  svc.decide({ actorId: "u1", kind: "k", importance: "low", explicit: true, requestedChannel: "phone" });
  const entry = listReachDecisions()[0];
  assert.equal(entry.explicit, true);
  assert.equal(entry.requestedChannel, "phone");
  assert.match(entry.reason, /explicit_request_bypass/);
});

test("HTTP 诊断路由: 挂载两个端点，未装配服务时不挂载", async () => {
  type Handler = (req: { query: Record<string, string> }, reply: { send: (v: unknown) => unknown }) => unknown;
  const routes = new Map<string, Handler>();
  const fakeApp = {
    get: (path: string, ...args: unknown[]) => {
      const handler = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
      routes.set(path, handler);
    },
  };
  const svc = service(() => ({ positive: 2, negative: 0 }));
  svc.decide({ actorId: "u1", kind: "k", importance: "medium" });
  registerReachDiagnosticsRoutes(fakeApp as never, { reachDecisionService: svc } as HttpRouteDeps);

  assert.ok(routes.has("/api/reach/config"));
  assert.ok(routes.has("/api/admin/reach/diagnostics"));

  const configResult = (await routes.get("/api/reach/config")!({ query: {} }, { send: (v) => v })) as {
    ok: boolean;
    config: Record<string, unknown>;
  };
  assert.equal(configResult.ok, true);
  assert.ok(configResult.config.channels);
  for (const key of ["valueModulators", "importanceStakes", "defaults", "contextCost", "thresholds", "prior"]) {
    assert.ok(configResult.config[key], `config.${key} 应存在`);
  }

  const diagResult = (await routes.get("/api/admin/reach/diagnostics")!(
    { query: { actorId: "u1", kind: "k", limit: "10" } },
    { send: (v) => v },
  )) as { ok: boolean; decisions: unknown[]; stats: { total: number } };
  assert.equal(diagResult.ok, true);
  assert.equal(diagResult.stats.total, 1);
  assert.equal(diagResult.decisions.length, 1);

  const emptyRoutes = new Map<string, Handler>();
  registerReachDiagnosticsRoutes(
    { get: (p: string) => emptyRoutes.set(p, (() => undefined) as Handler) } as never,
    {} as HttpRouteDeps,
  );
  assert.equal(emptyRoutes.size, 0);
});
