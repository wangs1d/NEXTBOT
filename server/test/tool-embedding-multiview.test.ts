import assert from "node:assert/strict";
import test from "node:test";

import {
  preNormalizeVector,
  rankAllByEmbedding,
  ToolEmbeddingIndex,
} from "../src/tools/tool-search/tool-embedding-index.js";
import { buildEmbeddingViews } from "../src/tools/tool-search/tool-embedding.js";

test("多视图 embedding 按工具取 max-sim，并忽略维度不匹配视图", () => {
  const query = preNormalizeVector([1, 0, 0]);
  const docs = new Map([
    ["definition_only", [preNormalizeVector([0.8, 0.6, 0])] as Float32Array[]],
    [
      "exemplar_wins",
      [
        preNormalizeVector([0, 1, 0]),
        preNormalizeVector([0.9, Math.sqrt(0.19), 0]),
        preNormalizeVector([1, 0]),
      ],
    ],
  ]);

  const ranked = rankAllByEmbedding(query, docs);
  assert.deepEqual(ranked.map((hit) => hit.id), ["exemplar_wins", "definition_only"]);
  assert.ok(Math.abs(ranked[0]!.score - 0.9) < 1e-6);
  assert.ok(Math.abs(ranked[1]!.score - 0.8) < 1e-6);
});

test("ToolEmbeddingIndex 保留单工具多视图并在子集排序中取最大值", () => {
  const index = new ToolEmbeddingIndex();
  index.ingest("a", [[0, 1, 0], [1, 0, 0]]);
  index.ingest("b", [0.8, 0.6, 0]);
  assert.equal(index.size, 2);
  assert.equal(index.dim, 3);

  const within = index.rankAllWithin(new Set(["a", "b"]), [1, 0, 0]);
  assert.deepEqual(within.map((hit) => hit.id), ["a", "b"]);
  assert.ok(Math.abs(within[0]!.score - 1) < 1e-6);
});

test("工具语义输入包含定义、参数和口语例句独立视图", () => {
  const views = buildEmbeddingViews({
    type: "function",
    function: {
      name: "geofence",
      description: "位置围栏提醒",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "要执行的围栏动作", enum: ["create", "list", "delete"] },
        },
      },
    },
  });

  assert.equal(views[0]?.kind, "definition");
  assert.ok(views.some((view) => view.kind === "parameters" && view.text.includes("create")));
  assert.ok(views.some((view) => view.kind === "exemplar" && view.text.includes("到家的时候提醒我拿快递")));
  assert.equal(new Set(views.map((view) => view.key)).size, views.length);
});
