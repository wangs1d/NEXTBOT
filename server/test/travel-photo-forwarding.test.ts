/**
 * 补图前移（照片链路提速）单测：
 * ① 必应图片 murl 解析（bing-photos.parseBingMurls）
 * ② 行程读取时媒体库带图（travel-plan.decoratePlanWithMedia）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBingMurls } from '../src/skills/travel-planning/bing-photos.js';
import { decoratePlanWithMedia } from '../src/routes/http/travel-plan.js';

// ─── ① 必应 murl 解析 ───

test('parseBingMurls: 提取 &quot; 转义的 murl 直链', () => {
  const html =
    `{"murl":"https://img.example.com/a.jpg","purl":"x"}`.replace(/"/g, '&quot;') +
    `,` +
    `{"murl":"https://img.example.com/b.png","purl":"y"}`.replace(/"/g, '&quot;');
  assert.deepEqual(parseBingMurls(html), [
    'https://img.example.com/a.jpg',
    'https://img.example.com/b.png',
  ]);
});

test('parseBingMurls: 去重 + limit 截断 + 丢弃非 http', () => {
  const raw = [
    'https://x.com/1.jpg',
    'https://x.com/1.jpg', // 重复
    'https://x.com/2.jpg',
    'https://x.com/3.jpg',
  ];
  const html = raw.map((u) => `&quot;murl&quot;:&quot;${u}&quot;`).join(',') + `,&quot;murl&quot;:&quot;ftp://bad&quot;`;
  assert.deepEqual(parseBingMurls(html, 2), ['https://x.com/1.jpg', 'https://x.com/2.jpg']);
});

test('parseBingMurls: 空输入返回空数组', () => {
  assert.deepEqual(parseBingMurls('<html></html>'), []);
});

// ─── ② 读取路径媒体库带图 ───

function planFixture() {
  return {
    planId: 'p1',
    days: [
      {
        index: 1,
        items: [
          { type: 'hotel', name: '同兴山庄' }, // 无图 → 库里有 → 带出
          { type: 'attraction', name: '万峰林', images: ['/travel/media/assets/baked.jpg'] }, // 已有图 → 不动
          { type: 'restaurant', name: '无名小馆' }, // 无图 → 库里也没有 → 保持
        ],
      },
      {
        index: 2,
        items: [{ type: 'attraction', name: '马岭河峡谷' }], // 第二天也要带出
      },
    ],
  };
}

test('decoratePlanWithMedia: 缺图条目从媒体库带图，已有图/库空的条目不动', () => {
  const lib = new Map<string, string[]>([
    ['hotel|同兴山庄', ['/travel/media/assets/poi-x/abc.jpg']],
    ['attraction|马岭河峡谷', ['/travel/media/assets/poi-y/def.jpg']],
  ]);
  const plan = planFixture();
  const out = decoratePlanWithMedia(plan, (type, name) => lib.get(`${type}|${name}`) ?? []);

  assert.deepEqual(out.days[0]!.items[0]!.images, ['/travel/media/assets/poi-x/abc.jpg']);
  assert.deepEqual(out.days[0]!.items[1]!.images, ['/travel/media/assets/baked.jpg']);
  assert.equal(out.days[0]!.items[2]!.images, undefined);
  assert.deepEqual(out.days[1]!.items[0]!.images, ['/travel/media/assets/poi-y/def.jpg']);
});

test('decoratePlanWithMedia: 库全空时原对象原样返回（零拷贝）', () => {
  const plan = planFixture();
  const out = decoratePlanWithMedia(plan, () => []);
  assert.equal(out, plan);
});

test('decoratePlanWithMedia: 不改写传入的 plan（响应级装饰，非落盘）', () => {
  const lib = new Map([['hotel|同兴山庄', ['/travel/media/assets/poi-x/abc.jpg']]]);
  const plan = planFixture();
  decoratePlanWithMedia(plan, (type, name) => lib.get(`${type}|${name}`) ?? []);
  assert.equal(plan.days[0]!.items[0]!.images, undefined);
});
