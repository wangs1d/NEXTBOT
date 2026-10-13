import test from "node:test";
import assert from "node:assert/strict";

import { PlanningService } from "../src/skills/travel-planning/travel-planning-service.js";

/**
 * POI 配图源链路（2026-10-12 修复）。
 *
 * 背景：原链路只走 Wikimedia（geosearch + 文本搜索），而 commons/zh.wikipedia
 * 在本机网络下实测 http=000（每次 10~12s 超时）→ POI 配图覆盖率只有 3.4%，
 * 且后台回填是 3 并发 × 2 次重试，等于每个 POI 白烧 ~24s。
 *
 * 现在改为「可达源优先（宿主搜索端口 → 内置必应抓取）+ Wikimedia 兜底（带探测跳过）」。
 * 这几条测试把顺序与降级行为钉住，且全部离线可跑（外网调用被桩替换）。
 */

type ImageProbe = {
  fetchRealImages(name: string, type: string, lat?: number, lon?: number): Promise<string[]>;
  fetchBingImages(query: string, limit?: number): Promise<string[]>;
  fetchReachableImages(name: string): Promise<string[]>;
  wikiImagesReachable(): Promise<boolean>;
};

const asProbe = (svc: PlanningService): ImageProbe => svc as unknown as ImageProbe;

test("配图走注入的搜索端口（不再依赖 Wikimedia）", async () => {
  const queries: string[] = [];
  const svc = new PlanningService(undefined, {
    searchImages: async (query) => {
      queries.push(query);
      return ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"];
    },
  });
  const imgs = await asProbe(svc).fetchRealImages("楼外楼", "restaurant", 30.2553, 120.1388);
  assert.equal(imgs.length, 2);
  assert.match(imgs[0]!, /cdn\.example\.com/);
  assert.deepEqual(queries, ["楼外楼"], "查询词应是地名本身，不带类型后缀");
});

test("端口返回空时降级到内置必应抓取", async () => {
  const svc = new PlanningService(undefined, { searchImages: async () => [] });
  const probe = asProbe(svc);
  probe.fetchBingImages = async () => ["https://cdn.example.com/bing.jpg"];
  const imgs = await probe.fetchRealImages("西湖", "attraction", 30.2489, 120.1492);
  assert.deepEqual(imgs, ["https://cdn.example.com/bing.jpg"]);
});

test("端口抛错不连累配图（降级而非中断）", async () => {
  const svc = new PlanningService(undefined, {
    searchImages: async () => {
      throw new Error("search port down");
    },
  });
  const probe = asProbe(svc);
  let bingCalled = false;
  probe.fetchBingImages = async () => {
    bingCalled = true;
    return ["https://cdn.example.com/fallback.jpg"];
  };
  const imgs = await probe.fetchRealImages("断桥残雪", "attraction", 30.2586, 120.1503);
  assert.equal(imgs.length, 1);
  assert.ok(bingCalled, "端口失败后必须走到内置必应抓取");
});

test("两个可达源都没图 + Wikimedia 不可达 → 返回空数组且不抛错", async () => {
  const svc = new PlanningService(undefined, { searchImages: async () => [] });
  const probe = asProbe(svc);
  probe.fetchBingImages = async () => [];
  let wikimediaTouched = false;
  probe.wikiImagesReachable = async () => {
    wikimediaTouched = true;
    return false;
  };
  const imgs = await probe.fetchRealImages("某冷门地点", "attraction", 1.5, 2.5);
  assert.deepEqual(imgs, []);
  assert.ok(wikimediaTouched, "可达源落空后应问一次 Wikimedia 是否可用");
});

test("Wikimedia 跳过判定带窗口缓存：同一窗口内只探测一次", async () => {
  const svc = new PlanningService();
  const probe = asProbe(svc);
  let probes = 0;
  // 探测走真实网络的站点信息接口在 CI 上不可控，这里只锁「窗口内不重复探测」这一层
  (probe as unknown as { wikimediaJson: unknown }).wikimediaJson = async () => {
    probes++;
    return null;
  };
  const first = await probe.wikiImagesReachable();
  const second = await probe.wikiImagesReachable();
  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(probes, 1, "10 分钟窗口内不应重复探测（否则等于没熔断）");
});
