/**
 * 规划会话路由冒烟（v3 旅游界面 Agent 驱动规划流，2026-10-17）。
 *
 * 最小 Fastify 实例挂 registerTravelPlanSessionRoutes：路由接线 / 会话状态机 /
 * 卡片载荷（天气面板走真实 Open-Meteo，LLM 缺席时走确定性兜底解析）。
 * generate 用 stub PlanningService 验证落盘 + 草案映射（不外呼 POI 搜索）。
 *
 * 运行：npx tsx scripts/smoke-travel-plan-session.ts   （需要外网：open-meteo 地理编码）
 */
import Fastify from "fastify";

await import("../src/config/load-server-env.js");

import { registerTravelPlanSessionRoutes } from "../src/skills/travel-planning/travel-plan-session.js";
import { travelPlanStore } from "../src/skills/travel-planning/travel-plan-store.js";

const app = Fastify({ logger: false });

/** stub 规划服务：generateItinerary 返回两份真实结构的假结果 */
const stubService = {
  async generateItinerary(request: { input: string; destination?: string; days?: number }) {
    const dest = request.destination ?? "成都";
    const dayCount = request.days ?? 3;
    return {
      id: `plan-smoke-${Date.now()}`,
      title: `${dest}慢游${["", "一", "两", "三"][dayCount] ?? dayCount}日`,
      description: "stub",
      startDate: "2026-10-20",
      endDate: "2026-10-22",
      destination: dest,
      center: { latitude: 30.66, longitude: 104.06 },
      dataQuality: "real",
      weather: "多云 18°C",
      coverImage: "",
      days: Array.from({ length: dayCount }, (_, i) => ({
        date: `2026-10-${20 + i}`,
        items: [
          { type: "attraction", name: `${dest}宽窄巷子`, startTime: "09:00", latitude: 30.66, longitude: 104.06, address: "", priceInfo: "", description: "" },
          { type: "restaurant", name: "老码头火锅", startTime: "12:00", latitude: 30.65, longitude: 104.07, address: "", priceInfo: "", description: "" },
        ],
      })),
      pois: [],
      preferences: { raw: [], sources: {} as Record<string, string> },
      travelInfo: { intro: "stub intro", packing: ["充电宝"] },
      pricingSummary: { totalFinal: 3600 },
      fromCache: false,
    } as never;
  },
};

registerTravelPlanSessionRoutes(app, {
  travelPlanningService: stubService as never,
});

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

async function main(): Promise<void> {
  await app.ready();

  // ① meta
  const meta = await app.inject({ method: "GET", url: "/travel/plan-session/_meta" });
  check("GET _meta 200", meta.statusCode === 200);

  // ② 发起（LLM 缺席 → 确定性兜底解析「去成都玩三天」）
  const start = await app.inject({
    method: "POST",
    url: "/travel/plan-session",
    payload: { message: "我想去成都玩三天" },
  });
  const startBody = start.json() as {
    ok: boolean; sessionId: string; state: string; say: string;
    cards: Array<{ type: string; id?: string; title?: string; days?: unknown[] }>;
  };
  check("POST start 200", start.statusCode === 200 && startBody.ok);
  check("sessionId 生成", /^ps-/.test(startBody.sessionId));
  check(
    "天气面板卡出现（真实 Open-Meteo）",
    startBody.cards.some((c) => c.type === "weather"),
    JSON.stringify(startBody.cards.map((c) => c.type)),
  );
  const wx = startBody.cards.find((c) => c.type === "weather");
  check(
    "天气卡有逐日数据与提示",
    !!wx && Array.isArray(wx.days) && wx.days!.length > 0,
  );
  // 口径（2026-11-12 对齐「缺什么问什么」）：交互卡按信息完整度条件出现，
  // 不再死磕 choice——首轮只要有一张可操作的卡（choice/guide/booking）即算过。
  check(
    "交互卡出现（choice/guide/booking 其一）",
    startBody.cards.some((c) => ["choice", "guide", "booking"].includes(c.type)),
    JSON.stringify(startBody.cards.map((c) => c.type)),
  );

  const sid = startBody.sessionId;

  // ③ 逐张点选 → 答完进入 ready/booking/guide 等推进态
  const choiceIds = startBody.cards
    .filter((c) => c.type === "choice")
    .map((c) => c.id!);
  let lastState = startBody.state;
  for (const id of choiceIds) {
    const turn = await app.inject({
      method: "POST",
      url: `/travel/plan-session/${sid}/turn`,
      payload: {
        cardId: id,
        values: ["特色民宿"],
      },
    });
    const body = turn.json() as { ok: boolean; state: string };
    check(`点选 ${id} 200`, turn.statusCode === 200 && body.ok);
    lastState = body.state;
  }
  check(
    "答完进入推进态（ready/guide_ready/gathering 均为合法流转）",
    ["ready", "guide_ready", "gathering"].includes(lastState),
    lastState,
  );

  // ④ generate：真实合同（2026-11-07 预算闸）= 先出预算（budget_ready），
  //    用户 approve 后才下发最终草案（generated + draft）
  const gen = await app.inject({
    method: "POST",
    url: `/travel/plan-session/${sid}/generate`,
    payload: {},
  });
  const genBody = gen.json() as {
    ok: boolean; state: string;
    budget: { total: number } | null;
  };
  check("generate 200", gen.statusCode === 200 && genBody.ok, genBody);
  check("state=budget_ready 且预算合计 > 0", genBody.state === "budget_ready" && (genBody.budget?.total ?? 0) > 0, genBody);

  const approve = await app.inject({
    method: "POST",
    url: `/travel/plan-session/${sid}/approve`,
    payload: {},
  });
  const approveBody = approve.json() as {
    ok: boolean; state: string;
    draft: { planId: string; days: Array<{ label: string; stops: string }> } | null;
  };
  check("approve 200", approve.statusCode === 200 && approveBody.ok, approveBody);
  check("state=generated", approveBody.state === "generated", approveBody.state);
  check(
    "草案含逐日站点",
    !!approveBody.draft && approveBody.draft.days.length === 3 &&
      approveBody.draft.days[0]!.stops.includes("宽窄巷子"),
  );
  check(
    "travelPlanStore 已落盘（与归档页同一冷层）",
    travelPlanStore.get(approveBody.draft?.planId ?? "") != null,
  );

  // ⑤ 会话不存在 → 404
  const missing = await app.inject({
    method: "POST",
    url: "/travel/plan-session/ps-none/turn",
    payload: { message: "在吗" },
  });
  check("过期会话 404", missing.statusCode === 404);

  await app.close();
  console.log(failures === 0 ? "\n[smoke] 全部通过" : `\n[smoke] ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke] 异常退出:", e);
  process.exit(1);
});
