import test from "node:test";
import assert from "node:assert/strict";

import { filterTextSearchTools, filterMediaModalityTools } from "../src/agent/web-search-consent.js";
import { isMediaOnlyRequest } from "../src/agent/realtime-search-query.js";
import { resolveRouteCallParams } from "../src/external-model/provider-profiles.js";

/**
 * 2026-10-21 根修回归：
 * 1. 媒体轮工具面不得含文字检索族（用户没要求查资料）；
 * 2. 纯媒体请求不发起投机网页检索；
 * 3. 路由可用独立快模型（LLM_ROUTE_MODEL），不再因主模型强制思考而超时降级。
 */

function tool(name: string) {
  return { type: "function" as const, function: { name, description: name, parameters: {} } };
}

test("媒体模态收敛：要照片时视频检索族不可见，要视频时图片检索族不可见", () => {
  const all = [
    tool("search_images"),
    tool("search_images_batch"),
    tool("search_videos"),
    tool("video.find"),
    tool("video.grab"),
    tool("task.dispatch"),
    tool("task.status"),
    tool("task.cancel"),
  ];
  assert.deepEqual(
    filterMediaModalityTools(all, "帮我搜几张刘浩存最近的照片").map((t) => t.function.name),
    ["search_images", "search_images_batch"],
  );
  assert.deepEqual(
    filterMediaModalityTools(all, "来点刘浩存最近的视频").map((t) => t.function.name),
    ["search_videos", "video.find", "video.grab"],
  );
  // 非纯媒体请求不做模态裁剪
  assert.equal(filterMediaModalityTools(all, "刘浩存最近怎么样").length, all.length);
});

test("媒体轮工具面：文字检索族全剥离，图片/视频检索保留", () => {
  const kept = filterTextSearchTools([
    tool("search_web"),
    tool("deep_search"),
    tool("fetch_web"),
    tool("hot_rankings"),
    tool("info.inspect_webpage"),
    tool("internet.research"),
    tool("search_images"),
    tool("search_images_batch"),
    tool("search_videos"),
    tool("video.find"),
  ]).map((t) => t.function.name);
  assert.deepEqual(kept, ["search_images", "search_images_batch", "search_videos", "video.find"]);
});

test("纯媒体请求识别：索图/索视频不投机网页检索，问近况/资料仍走检索", () => {
  assert.equal(isMediaOnlyRequest("我老婆最近的照片"), true);
  assert.equal(isMediaOnlyRequest("帮我搜几张刘浩存的图片"), true);
  assert.equal(isMediaOnlyRequest("来点马尔代夫的水屋视频"), true);
  // 资讯诉求优先：问近况/是谁/资料时不是纯媒体轮
  assert.equal(isMediaOnlyRequest("刘浩存最近怎么样，来几张照片"), false);
  assert.equal(isMediaOnlyRequest("这张照片里的人是谁"), false);
  assert.equal(isMediaOnlyRequest("搜一下最新新闻"), false);
});

test("路由模型覆盖：LLM_ROUTE_MODEL 透传为 modelOverride", () => {
  const params = resolveRouteCallParams({ id: "minimax" }, {
    LLM_ROUTE_MODEL: "MiniMax-M3",
  } as NodeJS.ProcessEnv);
  assert.equal(params.modelOverride, "MiniMax-M3");
});
