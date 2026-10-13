import test from "node:test";
import assert from "node:assert/strict";

import {
  boundsOf,
  collectTileUrlsForBounds,
  packSlugOf,
  pickPrimaryTemplates,
} from "../src/services/travel-tile-cache.js";

/**
 * 目的地离线包（P3）的纯函数契约。
 *
 * 这几条钉住的是本次实测踩出来的两个真 bug：
 *  ① 样式里有 tiles-a/b/c/d 四个**同内容镜像**，全用会让每个格子被请求 4 次；
 *  ② 带 {z}/{x}/{y} 的模板必须实例化后再请求，直接请求只会 404。
 * 以及防回退：超高缩放级（>z14，Carto 免费底图上限）不该再下载。
 */

const TEMPLATE = "https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt";

test("镜像去重：四个同内容 host 只保留一个", () => {
  const picked = pickPrimaryTemplates([
    "https://tiles-a.basemaps.cartocdn.com/v1/{z}/{x}/{y}.mvt",
    "https://tiles-b.basemaps.cartocdn.com/v1/{z}/{x}/{y}.mvt",
    "https://tiles-c.basemaps.cartocdn.com/v1/{z}/{x}/{y}.mvt",
    "https://tiles-d.basemaps.cartocdn.com/v1/{z}/{x}/{y}.mvt",
  ]);
  assert.equal(picked.length, 1, "四份镜像＝同一份数据，只该请求一份");
  assert.match(picked[0]!, /tiles-a\./);
});

test("镜像去重：单模板与空输入都原样返回", () => {
  assert.deepEqual(pickPrimaryTemplates([TEMPLATE]), [TEMPLATE]);
  assert.deepEqual(pickPrimaryTemplates([]), []);
});

test("bounds 含余量：单点也要有可覆盖的范围", () => {
  const b = boundsOf([{ latitude: 30.25, longitude: 120.15 }]);
  assert.ok(b, "单点不应返回 null");
  assert.ok(b!.north > 30.25 && b!.south < 30.25, "南北都应外扩");
  assert.ok(b!.east > 120.15 && b!.west < 120.15, "东西都应外扩");
  assert.equal(boundsOf([]), null, "无坐标点应返回 null（调用方跳过概览层）");
});

test("bounds 收集：模板变量必须被实例化（直接请求模板只会 404）", () => {
  const out = new Set<string>();
  collectTileUrlsForBounds(
    [TEMPLATE],
    { north: 30.26, south: 30.24, east: 120.16, west: 120.14 },
    11,
    out,
  );
  assert.ok(out.size > 0, "小范围低缩放应有瓦片");
  for (const u of out) {
    assert.ok(!u.includes("{"), `模板变量没替换干净: ${u}`);
    assert.match(u, /\/11\/\d+\/\d+\.mvt$/);
  }
});

test("超大 bbox 在高缩放级跳过（宁可少一层概览也不打满外网）", () => {
  const out = new Set<string>();
  collectTileUrlsForBounds(
    [TEMPLATE],
    { north: 45, south: 20, east: 130, west: 100 }, // 跨省
    14,
    out,
  );
  assert.equal(out.size, 0, "超过格数上限应整级跳过");
});

test("清单文件名由目的地名确定性派生（同名同键，不同名不同键）", () => {
  assert.equal(packSlugOf("杭州"), packSlugOf("  杭州  "), "应忽略首尾空白");
  assert.equal(packSlugOf("Hangzhou"), packSlugOf("hangzhou"), "应忽略大小写");
  assert.notEqual(packSlugOf("杭州"), packSlugOf("苏州"));
  assert.match(packSlugOf("杭州"), /^[0-9a-f]{16}$/);
});
