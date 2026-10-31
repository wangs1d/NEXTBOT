/**
 * 推荐口碑 UGC 聚合测试（P3，不触网，全部注入假端口）。
 *
 * 验证逻辑：
 *   1. parseUgcPosts：mcporter JSON / markdown 链接 / 行式文本三形态宽容解析
 *   2. summarizeUgc：好评/避雷词表分桶、垃圾行不误入
 *   3. aggregateXiaohongshuUgc：空结果/超时/异常 → null（卡片无口碑区）
 *   4. shopping.suggest handler：口碑挂主推（ugc 字段），卡 payload 携带 ugc；
 *      口碑端口失败时不阻断推荐（回执无 ugc 照常出卡）
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRecommendationCatalog,
  parseUgcPosts,
  summarizeUgc,
  aggregateXiaohongshuUgc,
} from "../src/recommendation/index.js";
import { registerLifeTools } from "../src/tools/life-tools.js";
import { tryAttachToolResultCard } from "../src/services/tool-card-registry.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

// ─────────────── 1. 解析 ───────────────

test("parseUgcPosts：JSON 数组（mcporter items 形态）", () => {
  const raw = JSON.stringify({
    items: [
      { title: "XM5 用了一个月，真的值得买", url: "https://xhslink.com/a" },
      { title: "别买！降噪耳机避雷帖", url: "https://xhslink.com/b" },
    ],
  });
  const posts = parseUgcPosts(raw);
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.title, "XM5 用了一个月，真的值得买");
  assert.equal(posts[0]!.url, "https://xhslink.com/a");
});

test("parseUgcPosts：markdown 链接兜底 + 去重；链接命中后不混排行式（防噪声）", () => {
  const raw = [
    "- [耳机真香，越用越香](https://xhslink.com/c)",
    "- [耳机真香，越用越香](https://xhslink.com/c)",
    "- 无链接的纯标题行不算（链接已命中）",
  ].join("\n");
  const posts = parseUgcPosts(raw);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, "https://xhslink.com/c");

  // 无链接文本 → 行式兜底
  const plain = parseUgcPosts("- 纯标题行也算一条，长度足够触发");
  assert.equal(plain.length, 1);
  assert.ok(plain[0]!.title.includes("纯标题行"));
});

// ─────────────── 2. 摘要 ───────────────

test("summarizeUgc：好评/避雷分桶，中性标题只计提及", () => {
  const posts = parseUgcPosts(
    JSON.stringify({
      items: [
        { title: "通勤半年体验：性价比天花板，真心推荐" },
        { title: "戴了一天就后悔，续航拉胯" },
        { title: "开箱：包装挺精致" },
      ],
    }),
  );
  const { mentions, pros, cons } = summarizeUgc(posts);
  assert.equal(mentions, 3);
  assert.equal(pros.length, 1);
  assert.match(pros[0]!, /性价比/);
  assert.equal(cons.length, 1);
  assert.match(cons[0]!, /拉胯/);
});

// ─────────────── 3. 聚合容错 ───────────────

test("aggregateXiaohongshuUgc：空 raw / 搜索异常 / 超时 → null", async () => {
  assert.equal(await aggregateXiaohongshuUgc({ search: async () => ({ raw: "" }) }, "降噪耳机"), null);
  assert.equal(
    await aggregateXiaohongshuUgc(
      {
        search: async () => {
          throw new Error("alias missing");
        },
      },
      "降噪耳机",
    ),
    null,
  );
  // 死线：搜索挂起 3s，死线 200ms → null
  const start = Date.now();
  const hung = await aggregateXiaohongshuUgc(
    { search: () => new Promise(() => {}) as never },
    "降噪耳机",
    { deadlineMs: 200 },
  );
  assert.equal(hung, null);
  assert.ok(Date.now() - start < 3_000);
});

// ─────────────── 4. handler 接入 ───────────────

type ExecResult = { ok: boolean; result: Record<string, unknown> };

function execute(registry: ToolRegistry, input: Record<string, unknown>): Promise<ExecResult> {
  const exec = (
    registry as unknown as {
      execute: (name: string, input: Record<string, unknown>, context: unknown) => Promise<ExecResult>;
    }
  ).execute.bind(registry);
  return exec("shopping.suggest", input, { sessionId: "test-user" });
}

test("shopping.suggest：口碑挂主推，卡 payload 携带 ugc 且帖子条目不挂链接", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rec-ugc-"));
  try {
    const registry = new ToolRegistry();
    registerLifeTools(registry, {} as never, {} as never, {
      catalog: createRecommendationCatalog(dataDir),
      ugcSearch: async () => ({
        platform: "xiaohongshu",
        platformLabel: "小红书",
        mentions: 3,
        pros: ["通勤半年体验：性价比天花板，真心推荐"],
        cons: ["戴了一天就后悔，续航拉胯"],
        posts: [
          { title: "通勤半年体验：性价比天花板", url: "https://xhslink.com/p1" },
          { title: "戴了一天就后悔", url: "https://xhslink.com/p2" },
        ],
      }),
    });
    const res = await execute(registry, { item: "降噪耳机" });
    assert.equal(res.ok, true);
    const rec = res.result.recommendation as {
      ugc?: { mentions: number; platformLabel: string };
      pick?: { productId: string };
      candidates: Array<{ productId: string }>;
    };
    assert.ok(rec.ugc, "回执应带 ugc");
    assert.equal(rec.ugc!.platformLabel, "小红书");
    assert.equal(rec.ugc!.mentions, 3);

    const marked = tryAttachToolResultCard("", "shopping.suggest", res.result);
    assert.ok(marked?.includes("[AGENT_RESULT_CARD_START]"));
    const payload = JSON.parse(
      marked!.slice(marked!.indexOf("{"), marked!.lastIndexOf("}") + 1),
    ) as { ugc?: { posts?: Array<{ title?: string; url?: string }>; pros?: string[] } };
    assert.ok(payload.ugc, "卡 payload 应带 ugc");
    assert.equal(payload.ugc!.posts?.[0]?.title, "通勤半年体验：性价比天花板");
    assert.equal(payload.ugc!.posts?.[0]?.url, undefined, "来源帖条目不承载网页链接");
    assert.ok((payload.ugc!.pros?.length ?? 0) > 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("shopping.suggest：口碑端口失败时不阻断推荐", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "rec-ugc-fail-"));
  try {
    const registry = new ToolRegistry();
    registerLifeTools(registry, {} as never, {} as never, {
      catalog: createRecommendationCatalog(dataDir),
      ugcSearch: async () => {
        throw new Error("mcporter down");
      },
    });
    const res = await execute(registry, { item: "降噪耳机" });
    assert.equal(res.ok, true);
    const rec = res.result.recommendation as { ugc?: unknown; candidates: unknown[] };
    assert.equal(rec.ugc, undefined);
    assert.ok(rec.candidates.length > 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
