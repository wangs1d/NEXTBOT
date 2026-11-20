import assert from "node:assert/strict";
import test from "node:test";

import {
  configureChatSuggestionProfileSource,
  configureChatSuggestionUsageSource,
  getChatSuggestions,
  type SuggestionUsageObservation,
} from "../src/services/chat-suggestions-service.js";

/** 与能力就绪注册表相关的 env 组：设置后 12 条推荐池全部就绪 */
const ALL_READY_ENV: Record<string, string> = {
  SEARCH_API_KEY: "test-key",
  OPENAI_API_KEY: "test-key",
  LUCKIN_MCP_TOKEN: "test-token",
  DIDI_MCP_KEY: "test-key",
  HA_BASE_URL: "http://ha.test",
  HA_TOKEN: "test-token",
  JUHE_TRAIN_KEY: "test-key",
  VARIFLIGHT_APP_ID: "test-id",
  VARIFLIGHT_APP_SECRET: "test-secret",
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 固定「现在」，观察相对它生成 */
const NOW = new Date("2026-09-24T12:00:00");

function daysAgo(n: number, hour = 10): number {
  return new Date(NOW.getTime() - n * 86_400_000).setHours(hour, 0, 0, 0);
}

function obs(tool: string, at: number, actorId = "u1"): SuggestionUsageObservation {
  return { actorId, tool, at };
}

test("早报推荐项标签为「早报」（非「主动提醒」），文案为订阅早报", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    const seen: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      const { suggestions } = getChatSuggestions(NOW);
      for (const s of suggestions) {
        if (s.id === "morning-brief") {
          assert.equal(s.tag, "早报");
          assert.equal(s.prompt, "每天早上八点给我一份早报");
          seen.push(s.tag);
        }
      }
    }
    assert.ok(seen.length > 0, "80 次抽样中早报（核心组）应至少出现一次");
  });
});

test("无使用数据：完全回退默认行为（5 条、核心保底 ≥3、全为介绍版文案）", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    for (let i = 0; i < 40; i += 1) {
      const { suggestions } = getChatSuggestions(NOW);
      assert.equal(suggestions.length, 5);
      const coreCount = suggestions.filter((s) =>
        ["weather-today", "schedule-create", "web-research", "shopping-compare", "memory-save", "morning-brief"].includes(s.id),
      ).length;
      assert.ok(coreCount >= 3, `核心组应 ≥3，实际 ${coreCount}`);
      for (const s of suggestions) {
        assert.equal(s.personalized, false);
      }
    }
  });
});

test("使用习惯个性化：近 14 天 ≥2 天用过的能力保底在场并出回访版文案", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    configureChatSuggestionUsageSource(null);
    // 只统计 u1 自己的观察（u2 的 1 天不计入）：search_web 对 u1 仍是 2 个活跃天
    const usage: SuggestionUsageObservation[] = [
      obs("search_web", daysAgo(1)),
      obs("search_web", daysAgo(2, 15), "u2"),
      obs("search_web", daysAgo(9)),
      obs("weather.get_local", daysAgo(1, 8)),
      obs("weather.get_local", daysAgo(3, 8)),
    ];
    configureChatSuggestionUsageSource(() => usage);
    try {
      for (let i = 0; i < 40; i += 1) {
        const { suggestions } = getChatSuggestions(NOW, "u1");
        const search = suggestions.find((s) => s.id === "web-research");
        assert.ok(search, "在用能力（搜索）应保底在场");
        assert.equal(search.personalized, true);
        assert.equal(search.prompt, "帮我查查这周有什么新动态，挑重点讲给我");
        const personalizedCount = suggestions.filter((s) => s.personalized).length;
        assert.ok(personalizedCount <= 2, `个性化保底位应 ≤2，实际 ${personalizedCount}`);
        const coreCount = suggestions.filter((s) =>
          ["weather-today", "schedule-create", "web-research", "shopping-compare", "memory-save", "morning-brief"].includes(s.id),
        ).length;
        assert.ok(coreCount >= 3, "个性化在场不得挤掉核心保底");
      }
    } finally {
      configureChatSuggestionUsageSource(null);
    }
  });
});

test("按用户隔离：他人的使用习惯不进自己的推荐；无身份完全不个性化", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    // u2 有 3 个活跃天的搜索使用；u1 自己一条观察都没有
    const usage: SuggestionUsageObservation[] = [
      obs("search_web", daysAgo(1), "u2"),
      obs("search_web", daysAgo(2), "u2"),
      obs("search_web", daysAgo(3), "u2"),
    ];
    configureChatSuggestionUsageSource(() => usage);
    try {
      for (let i = 0; i < 40; i += 1) {
        const forU1 = getChatSuggestions(NOW, "u1").suggestions;
        for (const s of forU1) {
          assert.equal(s.personalized, false, "u2 的习惯不得让 u1 出回访文案");
          if (s.id === "web-research") {
            assert.equal(s.prompt, "帮我查一下这周末有什么展，挑个值得去的");
          }
        }
        const anonymous = getChatSuggestions(NOW).suggestions;
        for (const s of anonymous) {
          assert.equal(s.personalized, false, "无身份调用绝不回退全局混算");
        }
      }
    } finally {
      configureChatSuggestionUsageSource(null);
    }
  });
});

test("画像加权：购物兴趣高的用户更常看到购物比价项，但不改文案与标记", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    configureChatSuggestionProfileSource((actorId) =>
      actorId === "shopper"
        ? { shoppingInterest: 40, planningInterest: 0, companionNeed: 0, privacyConcern: 0 }
        : null,
    );
    try {
      const hits = (actorId: string): number => {
        let n = 0;
        for (let i = 0; i < 400; i += 1) {
          const { suggestions } = getChatSuggestions(NOW, actorId);
          if (suggestions.some((s) => s.id === "shopping-compare")) n += 1;
        }
        return n;
      };
      const withProfile = hits("shopper");
      const without = hits("anonymous");
      // 画像满权重（boost≈1.2）期望命中 ~67%，无画像轮换 ~42%
      assert.ok(
        withProfile > without + 50,
        `画像加权命中率(${withProfile}/400) 应显著高于无画像(${without}/400)`,
      );
      // 加权只改出场率：文案与 personalized 标记不变（那是使用习惯层的职责）
      const { suggestions } = getChatSuggestions(NOW, "shopper");
      const shopping = suggestions.find((s) => s.id === "shopping-compare");
      if (shopping) {
        assert.equal(shopping.personalized, false);
        assert.equal(shopping.prompt, "帮我比比价，选台性价比高的空气炸锅");
      }
    } finally {
      configureChatSuggestionProfileSource(null);
    }
  });
});

test("画像门槛：行为信号总量不足时不加权（与无画像同分布）", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    configureChatSuggestionProfileSource(() => ({
      shoppingInterest: 3,
      planningInterest: 1,
      companionNeed: 0,
      privacyConcern: 0,
    }));
    try {
      // 总量 4 < PROFILE_MIN_SIGNALS(6)：不得因这点信号显著放大购物项
      const hits = (actorId: string): number => {
        let n = 0;
        for (let i = 0; i < 400; i += 1) {
          const { suggestions } = getChatSuggestions(NOW, actorId);
          if (suggestions.some((s) => s.id === "shopping-compare")) n += 1;
        }
        return n;
      };
      const weak = hits("shopper");
      const none = hits("anonymous");
      assert.ok(
        Math.abs(weak - none) <= 60,
        `弱画像(${weak}/400) 与无画像(${none}/400) 命中率应同水平`,
      );
    } finally {
      configureChatSuggestionProfileSource(null);
    }
  });
});

test("窗口外与单天使用不触发个性化", () => {
  withEnv({ ...ALL_READY_ENV }, () => {
    // 20 天前的使用超出 14 天窗口；luckin 仅 1 天 → 均不算「在用」（u1 自己的观察）
    const usage: SuggestionUsageObservation[] = [
      obs("search_web", daysAgo(20)),
      obs("search_web", daysAgo(25)),
      obs("luckin_order", daysAgo(1)),
    ];
    configureChatSuggestionUsageSource(() => usage);
    try {
      for (let i = 0; i < 40; i += 1) {
        const { suggestions } = getChatSuggestions(NOW, "u1");
        for (const s of suggestions) {
          assert.equal(s.personalized, false);
          if (s.id === "luckin-order") {
            assert.equal(s.prompt, "帮我点一杯冰美式，到店自取");
          }
        }
      }
    } finally {
      configureChatSuggestionUsageSource(null);
    }
  });
});

test("推荐项结构：capabilityId / experimental 透传不回归", () => {
  withEnv({ ...ALL_READY_ENV, LUCKIN_MCP_TOKEN: undefined }, () => {
    // 删除 LUCKIN_MCP_TOKEN 后 luckin_coffee 未就绪，任何抽样不得出现点咖啡项
    for (let i = 0; i < 40; i += 1) {
      const { suggestions } = getChatSuggestions(NOW);
      assert.ok(!suggestions.some((s) => s.id === "luckin-order"), "未就绪能力不得入推荐");
      for (const s of suggestions) {
        assert.equal(typeof s.tag, "string");
        assert.ok(s.prompt.length > 0);
        assert.equal(typeof s.experimental, "boolean");
      }
    }
  });
});
