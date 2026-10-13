/**
 * MiniMax 缓存模式受控探针（2026-10-12）。
 *
 * 背景：实盘审计（近3天）显示 MiniMax 主链路命中率仅 22.1%、hit p50=133 tok
 * （≈最小计量粒度，等于全 miss）。prefix-cache.ts 的 explicit-breakpoint 模式
 * 是把 cache_control 经 OpenAI 兼容端点透传的，但官方文档只承诺显式缓存在
 * Anthropic 兼容端点（/anthropic）上生效（5min TTL + 命中续期）。「请求被接受
 * （200）」≠「断点被执行」。本探针实测三种模式在同一稳定前缀下的命中表现：
 *
 *   A. OpenAI /v1 被动缓存（无 cache_control）×4 次同请求
 *   B. OpenAI /v1 + cache_control system 断点 ×4 次（现行生产模式）
 *   C. Anthropic 兼容端点 + cache_control ×4 次（官方承诺模式）
 *
 * 判读：
 *   - A/B 若 cached_tokens 随机（忽大忽小）→ 多副本路由实锤
 *   - B 若与 A 无差异 → OpenAI 端点忽略 cache_control（现行显式断点白打）
 *   - C 若 cache_read 稳定全量命中 → 根治方向 = MiniMax 走 Anthropic 端点
 *
 * 用法：DOTENV_CONFIG_PATH=.env.local npx tsx scripts/probe-minimax-cache-modes.ts
 * 花费：约 12 次请求 × ~2.4K 输入 + 少量输出，可忽略。
 */
import "dotenv/config";

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  // 显式模式可能透传 anthropic 风格字段
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

const MODEL = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M3";
const OPENAI_BASE = (process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1").trim();
const KEY = process.env.MINIMAX_API_KEY ?? "";
if (!KEY) {
  console.error("MINIMAX_API_KEY 未配置，退出");
  process.exit(1);
}

/** 构造 ≥1500 tok 的稳定 system 前缀（重复段落保字节级一致）。 */
function buildStableSystem(): string {
  const section =
    "你是用户的私人助理，负责日程、检索、任务派发与生活服务。" +
    "回答风格：先结论后解释，简体中文，不堆砌客套话。" +
    "涉及数据时必须来自工具结果，禁止编造；不确定时明确说不确定。" +
    "工具调用前先向用户用一句话确认意图；结果返回后只输出最终结论。" +
    "日期时间一律以系统注入为准，不得自行推测当前时间。\n";
  // ~40 段 × ~90 字 ≈ 3600 字 ≈ 5400 tok，远超 512 门槛
  return section.repeat(40);
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_web",
      description: "联网搜索，返回网页结果摘要列表",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索词" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory.recall",
      description: "按语义检索用户长期记忆",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "检索词" } },
        required: ["query"],
      },
    },
  },
];

const USER_MSG = "今天天气怎么样？";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callOpenAI(withBreakpoint: boolean): Promise<OpenAIUsage | null> {
  const systemContent = withBreakpoint
    ? [
        {
          type: "text",
          text: buildStableSystem(),
          cache_control: { type: "ephemeral" },
        },
      ]
    : buildStableSystem();
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: USER_MSG },
    ],
    tools: TOOLS,
    max_tokens: 64,
    thinking: { type: "disabled" },
  };
  const resp = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`  HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return null;
  }
  const json = (await resp.json()) as { usage?: OpenAIUsage };
  return json.usage ?? null;
}

async function callAnthropic(base: string): Promise<Record<string, unknown> | null> {
  const body = {
    model: MODEL,
    max_tokens: 64,
    system: [
      {
        type: "text",
        text: buildStableSystem(),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: USER_MSG }],
  };
  const resp = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEY,
      Authorization: `Bearer ${KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`  HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return null;
  }
  const json = (await resp.json()) as { usage?: Record<string, unknown> };
  return json.usage ?? null;
}

function describeUsage(u: OpenAIUsage | null): string {
  if (!u) return "(no usage)";
  const cached =
    u.prompt_tokens_details?.cached_tokens ??
    u.prompt_cache_hit_tokens ??
    u.cache_read_input_tokens;
  return `prompt=${u.prompt_tokens} cached=${cached ?? "?"} ` +
    `raw_keys=[${Object.keys(u).join(",")}]`;
}

async function run(label: string, times: number, fn: () => Promise<OpenAIUsage | null>) {
  console.log(`\n── ${label} ──`);
  for (let i = 1; i <= times; i++) {
    const u = await fn();
    console.log(`  #${i}: ${describeUsage(u)}`);
    await sleep(1500);
  }
}

async function main() {
  console.log(`model=${MODEL} openai_base=${OPENAI_BASE}`);
  const N = 4;

  await run(`A. OpenAI /v1 被动缓存（无 cache_control）×${N}`, N, () => callOpenAI(false));
  await run(`B. OpenAI /v1 + cache_control 断点（现行生产模式）×${N}`, N, () => callOpenAI(true));

  // C. Anthropic 兼容端点：国内域名与海外域名各试一次首轮
  for (const base of ["https://api.minimaxi.com/anthropic", "https://api.minimax.io/anthropic"]) {
    console.log(`\n── C. Anthropic 兼容端点 ${base} ──`);
    for (let i = 1; i <= N; i++) {
      const u = await callAnthropic(base);
      console.log(`  #${i}: ${u ? JSON.stringify(u) : "(failed)"}`);
      await sleep(1500);
    }
  }
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
