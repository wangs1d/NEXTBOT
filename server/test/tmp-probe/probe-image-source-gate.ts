/**
 * 探针：验证图片来源闸（isBlockedImageSource）对「同兴山庄」类 query 的拦截效果。
 * 背景：图搜住宅小区/山庄名返回百度地图位置截图 + 昵图网水印图，转存后顶着
 * POI 名义展示。根修 = materializeImageResults 入口单点来源闸。
 *
 * 用法：cd server && npx tsx test/tmp-probe/probe-image-source-gate.ts
 * 隔离：setImageStorageService 不注入 → materialize 只过滤不落盘，零脏文件。
 */

const { UpstreamSearchService } = await import('../../src/services/upstream-search-service.js');
const { InfoHubService } = await import('../../src/services/info-hub-service.js');

// InfoHubService 构造依赖未知，给个最简 stub（searchImages 不触 webQueryCache 相关依赖）
const svc = new UpstreamSearchService({} as any);
// 不注入 imageStorageService：materializeImageResults 走「无存储」分支，
// 只验证过滤闸，不产生 shared-travel-img 落盘。

const r = await (svc as any).searchImages('贵阳 同兴山庄', 6, 'probe-image-gate');
console.log(`provider=${r.provider} items=${r.items.length}`);
for (const it of r.items) {
  console.log(`  - [${it.source}] ${(it.title ?? '').slice(0, 40)} | ${(it.mediaUrl ?? '').slice(0, 70)}`);
}
console.log('PROBE_IMAGE_GATE_DONE');
process.exit(0);
