/**
 * 图片搜索闸门回归测试（2026-11-08 根修）。
 *
 * 事故背景：长 query「卢昱晓 红毯礼服 时尚大片 写真」在 cn.bing.com 中文图片页
 * 整页跑偏，返回「红军长征路线图 / 林业局 / 灯塔壁纸」，被当成人物照片转存展示。
 * 修复：核心实体词重试 + 多端点择优 + 文本相关性软闸 + 独立 VLM 复核重排。
 * 本测试锁定两件事：跑偏图被剔除；任何情况下结果不因为闸门被清空。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  imageBatchGuardRatio,
  imageRelevanceRatio,
  isBlockedImageSource,
  parseBingImageResults,
  rankImageCandidates,
  type MediaSearchItem,
} from "../src/services/upstream-search-service.js";
import { rerankImagesByVlm } from "../src/services/image-relevance-vlm.js";

function mk(title: string, url: string): MediaSearchItem {
  return { type: "image", title, pageUrl: `https://news.example.com/${encodeURIComponent(title)}`, mediaUrl: url, source: "Bing Images" };
}

test("Bing 图片页解析：HTML 实体 + 去重 + 跳过无直链项", () => {
  const html = [
    `<a class="iusc" m="{&quot;murl&quot;:&quot;https://img.example.com/a.jpg&quot;,&quot;turl&quot;:&quot;https://img.example.com/a_t.jpg&quot;,&quot;purl&quot;:&quot;https://news.example.com/a&quot;,&quot;t&quot;:&quot;卢昱晓 头像&quot;,&quot;w&quot;:1080,&quot;h&quot;:1080}"></a>`,
    `<a class="iusc" m="{&quot;murl&quot;:&quot;https://img.example.com/a.jpg&quot;,&quot;t&quot;:&quot;重复项&quot;}"></a>`,
    `<a class="iusc" m="{&quot;t&quot;:&quot;无直链项&quot;}"></a>`,
    `<a class="iusc" m="{&quot;murl&quot;:&quot;https://img.example.com/b.jpg&quot;,&quot;t&quot;:&quot;卢昱晓 胶片感&quot;}"></a>`,
  ].join("\n");
  const items = parseBingImageResults(html, 10);
  assert.equal(items.length, 2, "重复直链去掉、无直链跳过");
  assert.equal(items[0]?.mediaUrl, "https://img.example.com/a.jpg");
  assert.equal(items[0]?.title, "卢昱晓 头像");
  assert.equal(items[0]?.width, 1080);
  assert.equal(parseBingImageResults("", 10).length, 0);
});

test("相关性软闸：跑偏批被剔除，真实人物照保留", () => {
  const items = [
    mk("红军长征路线图简笔画全部（高清10张）", "https://img.example.com/1.jpg"),
    mk("卢昱晓头像 氛围感拉满了_新浪新闻", "https://img.example.com/2.jpg"),
    mk("卢昱晓 胶片女孩", "https://img.example.com/3.jpg"),
    mk("县林草局组织各林场工作人员多措并举加大林区管护力度", "https://img.example.com/4.jpg"),
  ];
  const ranked = rankImageCandidates(items, "卢昱晓 写真");
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((i) => i.title.includes("卢昱晓")));
  assert.ok(imageRelevanceRatio(items, "卢昱晓 写真") >= 0.5);
});

test("相关性软闸：零命中时保底原序返回，绝不返回空", () => {
  const items = [
    mk("灯塔摄影图__建筑摄影", "https://img.example.com/1.jpg"),
    mk("长征从这里出发", "https://img.example.com/2.jpg"),
    mk("学习强国平台截图", "https://img.example.com/3.jpg"),
  ];
  const ranked = rankImageCandidates(items, "卢昱晓 写真");
  assert.equal(ranked.length, items.length, "相关性全灭时必须保底交付");
  assert.equal(imageRelevanceRatio(items, "卢昱晓 写真"), 0);
  assert.deepEqual(rankImageCandidates([items[0]!], "卢昱晓"), [items[0]!]);
});

test("来源闸：水印站 / 迷你图 / 装饰图被拦，正常人物照放行", () => {
  assert.equal(isBlockedImageSource(mk("灯塔摄影图", "https://pic.nximg.cn/file/20230531/a.jpg")), true);
  assert.equal(isBlockedImageSource(mk("壁纸", "https://www.picoriline.com/cn/16564-927.jpg")), true);
  assert.equal(isBlockedImageSource({ ...mk("小图", "https://img.example.com/s.jpg"), width: 100, height: 80 }), true);
  assert.equal(isBlockedImageSource(mk("站点图标", "https://img.example.com/logo_1.png")), true);
  assert.equal(isBlockedImageSource({ ...mk("卢昱晓 头像", "https://n.sinaimg.cn/abc.jpg"), width: 1080, height: 1080 }), false);
});

test("来源闸软降级：水印站可保底放行，地图/装饰图硬闸仍拦截", () => {
  const stock = mk("灯塔摄影图", "https://pic.nximg.cn/file/20230531/a.jpg");
  assert.equal(isBlockedImageSource(stock), true, "候选充足时水印站降权");
  assert.equal(isBlockedImageSource(stock, { allowWatermarkStock: true }), false, "无干净候选时保底放行");
  assert.equal(
    isBlockedImageSource(mk("位置示意图", "https://map.baidu.com/a.png"), { allowWatermarkStock: true }),
    true,
  );
  assert.equal(
    isBlockedImageSource(mk("站点图标", "https://img.example.com/logo_1.png"), { allowWatermarkStock: true }),
    true,
  );
});

test("分级交付阈值：多词组合要求 ≥50% 命中，单实体词保持零相关守卫", () => {
  assert.equal(imageBatchGuardRatio(1), 0, "单实体词：零相关即拒");
  assert.equal(imageBatchGuardRatio(2), 0.5, "2 词组合：≥50% 命中才交付（普通名词组合实测 100%，人名+修饰实测 0%）");
  assert.equal(imageBatchGuardRatio(3), 0.5);
});

test("VLM 复核：关闭时原序返回且长度不变（保证一定能拿到图片）", async () => {
  const prev = process.env.IMAGE_VLM_RERANK_ENABLED;
  process.env.IMAGE_VLM_RERANK_ENABLED = "0";
  try {
    const items = [mk("甲", "https://img.example.com/1.jpg"), mk("乙", "https://img.example.com/2.jpg")];
    const res = await rerankImagesByVlm(items, "卢昱晓");
    assert.equal(res.applied, false);
    assert.equal(res.items.length, items.length);
    assert.deepEqual(res.items, items);
  } finally {
    if (prev === undefined) delete process.env.IMAGE_VLM_RERANK_ENABLED;
    else process.env.IMAGE_VLM_RERANK_ENABLED = prev;
  }
});
