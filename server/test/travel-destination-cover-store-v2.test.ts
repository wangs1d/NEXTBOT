/**
 * 封面库 v2 单测（无外部网络）：
 *
 * 覆盖 2026-09-28 选图升级的存储层：
 *   - v1 平铺形状兼容读取（存量 destination-covers.json 不丢数据）；
 *   - v2 写出形状（version/covers/superseded/coverDirs）与 roundtrip；
 *   - markSuperseded/registerCoverDir → resolveSuperseded 的映射语义
 *     （远程 URL 命中、封面对象目录级命中、当前封面自身不命中、未登记不命中）。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const coverDir = mkdtempSync(join(tmpdir(), "dest-cover-v2-test-"));
process.env.TRAVEL_MEDIA_STORE_DIR = coverDir;

const { destinationCoverStore } = await import(
  "../src/skills/travel-planning/travel-destination-cover-store.js"
);
const { scoreCoverCandidate } = await import(
  "../src/skills/travel-planning/travel-planning-service.js"
);

after(() => {
  rmSync(coverDir, { recursive: true, force: true });
});

describe("destinationCoverStore v2 (升级映射)", () => {
  it("set → 落盘为 v2 形状，重新读取（新实例）后数据完整", async () => {
    destinationCoverStore.set("测试地甲", { url: "/travel/media/assets/destcovera-111/a.jpg", source: "vlm-pick" });
    const file = join(coverDir, "destination-covers.json");
    assert.ok(existsSync(file));
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { version: number };
    assert.equal(raw.version, 2);

    // 动态重载一个新实例（模拟重启），确认 roundtrip
    delete process.env.TRAVEL_MEDIA_STORE_DIR;
    process.env.TRAVEL_MEDIA_STORE_DIR = coverDir;
    const mod = await import(`../src/skills/travel-planning/travel-destination-cover-store.js?v=${Date.now()}`);
    const reloaded = (mod as { destinationCoverStore: { get(d: string): { url: string } | null } }).destinationCoverStore;
    assert.equal(reloaded.get("测试地甲")?.url, "/travel/media/assets/destcovera-111/a.jpg");
  });

  it("markSuperseded：旧远程 URL 命中升级映射，返回当前封面；当前封面自身不命中", () => {
    destinationCoverStore.set("测试地乙", { url: "/travel/media/assets/destcoverb-222/new.jpg", source: "vlm-pick" });
    destinationCoverStore.markSuperseded("测试地乙", "https://upload.wikimedia.org/old-street.jpg");
    const hit = destinationCoverStore.resolveSuperseded("https://upload.wikimedia.org/old-street.jpg");
    assert.ok(hit);
    assert.equal(hit.url, "/travel/media/assets/destcoverb-222/new.jpg");
    // 未登记的 URL 不命中
    assert.equal(destinationCoverStore.resolveSuperseded("https://upload.wikimedia.org/other.jpg"), null);
  });

  it("registerCoverDir：封面对象目录内任何历史文件都路由到当前封面", () => {
    destinationCoverStore.set("测试地丙", { url: "/travel/media/assets/destcoverc-333/cur.jpg", source: "vlm-pick" });
    destinationCoverStore.registerCoverDir("测试地丙", "/travel/media/assets/destcoverc-333/cur.jpg");
    // 目录内历史文件（时间戳不同名）命中
    const hit = destinationCoverStore.resolveSuperseded("/travel/media/assets/destcoverc-333/1790000000000-old.jpg");
    assert.ok(hit);
    assert.equal(hit.url, "/travel/media/assets/destcoverc-333/cur.jpg");
    // 当前封面自身不命中（避免自重定向）
    assert.equal(
      destinationCoverStore.resolveSuperseded("/travel/media/assets/destcoverc-333/cur.jpg"),
      null,
    );
    // 非封面目录不命中
    assert.equal(
      destinationCoverStore.resolveSuperseded("/travel/media/assets/somepoi-999/photo.jpg"),
      null,
    );
  });

  it("evict：移除并返回旧记录（无视 TTL），get 立即落空；升级映射保留可继续改发新封面", () => {
    destinationCoverStore.set("测试地丁", { url: "/travel/media/assets/destcoverd-444/old.jpg", source: "vlm-pick" });
    destinationCoverStore.registerCoverDir("测试地丁", "/travel/media/assets/destcoverd-444/old.jpg");
    const removed = destinationCoverStore.evict("测试地丁");
    assert.ok(removed);
    assert.equal(removed.url, "/travel/media/assets/destcoverd-444/old.jpg");
    // 驱逐后读取落空（refresh 链路据此强制重解析）
    assert.equal(destinationCoverStore.get("测试地丁"), null);
    assert.equal(destinationCoverStore.evict("测试地丁"), null);
    assert.equal(destinationCoverStore.evict("从未规划过的地方"), null);

    // 刷新换新图后：目录级升级映射仍在，旧资产请求改发当前封面
    destinationCoverStore.set("测试地丁", { url: "/travel/media/assets/destcoverd-444/new.jpg", source: "vlm-pick" });
    const hit = destinationCoverStore.resolveSuperseded("/travel/media/assets/destcoverd-444/old.jpg");
    assert.ok(hit);
    assert.equal(hit.url, "/travel/media/assets/destcoverd-444/new.jpg");
  });
});

describe("scoreCoverCandidate (封面关键词预排序)", () => {
  it("湖景/地标照片排在街道/行政区照片前面（用户反馈的核心场景）", () => {
    const lake = scoreCoverCandidate("https://upload.wikimedia.org/Erhai_Lake_panorama.jpg");
    const street = scoreCoverCandidate("https://upload.wikimedia.org/%E5%A4%AA%E5%92%8C%E8%A1%97%E9%81%93%E5%85%A8%E6%99%AF%E5%9B%BE.jpg");
    assert.ok(lake > street, `lake(${lake}) should outrank street(${street})`);
  });

  it("普通山景高于室内/人像", () => {
    const mountain = scoreCoverCandidate("Cangshan_Mountain_view.jpg");
    const interior = scoreCoverCandidate("Hotel_lobby_interior.jpg");
    const portrait = scoreCoverCandidate("Portrait_of_a_woman.jpg");
    assert.ok(mountain > interior, `mountain(${mountain}) > interior(${interior})`);
    assert.ok(mountain > portrait, `mountain(${mountain}) > portrait(${portrait})`);
  });

  it("URL 编码的中文文件名可正确解码打分", () => {
    const encoded = scoreCoverCandidate(
      "https://upload.wikimedia.org/thumb/" + encodeURIComponent("洱海日落全景.jpg") + "/1280px-x.jpg",
    );
    assert.ok(encoded >= 4, `encoded lake+sunrise should score >=4, got ${encoded}`);
  });
});
