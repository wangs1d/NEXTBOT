#!/usr/bin/env node
/**
 * scrape-article-media.mjs — 「搜索引擎只给文章链接」场景的兜底抓取器
 *
 * 背景：以人物/主题为查询词时，搜索引擎返回的往往不是图片直链，而是一堆文章页。
 * 本脚本：文章页拉下来 -> 从 HTML 抠出 <img> 的真实图片地址 -> 用 curl（带 Referer）
 * 逐个下载到本地目录（绕开防盗链）；顺带把文章正文抽成 .md（信息也一起兜底）。
 *
 * 用法：
 *   node scripts/scrape-article-media.mjs --out liuhaocun --urls scripts/urls-liuhaocun.txt
 *   node scripts/scrape-article-media.mjs --out liuhaocun --url https://a --url https://b
 * 可选：--min-bytes 20000   --min-width 500   --min-height 350
 *
 * 产出（在 --out 目录下）：
 *   images/            下载成功的图片（已过 content-type + 分辨率双重校验，按来源分目录）
 *   articles/*.md      每篇文章：标题 + 元信息 + 清洗后的正文（人读）
 *   info/*.json        每篇文章的结构化字段：标题/站点/发布时间/作者/正文段落（程序用）
 *   digest.md          跨源聚合摘要：来源清单 + 时间线 + 去重要点 + 多源同事件 + 配图索引
 *   digest.json        摘要的结构化版本
 *   manifest.json      来源 -> 标题 / 图片 映射
 *   _log.txt           逐条日志
 *
 * 三种独占模式：
 *   --text-only            只抽信息不下图（图片已抓过时用，快很多）
 *   --browser-info <file>  JS 站点（头条等）用 agent-browser 取回正文后回填（每行 {"url","title","text"}）
 *   --digest --topic <名>  把 info/*.json 聚合成带来源标注的信息摘要，不联网
 *   --prune                按 manifest 清掉 images/ 里的残留
 *
 * 实战踩过的坑（已内置）：
 *   1) 网易：src 是 https://nimg.ws.126.net/?url=...jpg&thumbnail=660x... —— 无路径后缀，
 *      需去掉 thumbnail= 参数才是原图；扩展名过滤会误杀。
 *   2) 腾讯新闻：src 是 https://inews.gtimg.com/news_bt/<id>/641 —— 无后缀，末尾数字是宽度，
 *      换 /0 取原图。
 *   3) 新浪图集是 GBK，UTF-8 直接读会乱码 —— 需按 charset 解码。
 *   4) 论坛(discuz)：原图在 zoomfile=（data/attachment/...），src 只是缩略图。
 *   5) WordPress：-300x207 / -150x103 是缩略图变体，要归一化去重，只留原图。
 *   6) 抓取放宽（content-type 才是真闸门），否则上面 1)/2) 全丢。
 *   7) 站点装饰图（/deco/、/f2e/、bg/mob/logo/arrow…）靠关键字 + 最小分辨率过滤。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile, readFile, unlink, rmdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BAD =
  /(logo|avatar|qrcode|qr_|icon|iconfont|sprite|smile|emot|face\/|placeholder|loading|blank\.|spacer|watermark|share|weixin|weibo|btn_|button|_ad|advert|\/ad[s_]\d|\/deco\/|\/f2e\/|common_nav|favicon|dianzan|default_|noimage|none\.gif|online_admin|star_level|star_|vip\.|grade\/|theme\/images|assets\/images|\/static\/images)/i;
const BAD_BASENAME = /^(bg|background|mob|mobile|logo|logotype|icon|menu|arrow|close|tab_|tab|btn|spacer|blank|loading|placeholder|vote|top|header|footer|nav)/i;

const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const getAll = (k) => args.reduce((a, v, i) => (v === k && args[i + 1] ? [...a, args[i + 1]] : a), []);
const hasFlag = (k) => args.includes(k);

const OUT = path.resolve(getArg('--out') || 'scraped');
const MIN_BYTES = Number(getArg('--min-bytes') || 20 * 1024);
const MIN_W = Number(getArg('--min-width') || 500);
const MIN_H = Number(getArg('--min-height') || 350);
const MAX_PER_PAGE = Number(getArg('--max-per-page') || 40);
const textOnly = hasFlag('--text-only'); // 只要信息，不下图（图片已抓过时用，快很多）

let urlList = getAll('--url');
const urlsFile = getArg('--urls');
if (urlsFile) {
  const txt = await readFile(path.resolve(urlsFile), 'utf8');
  urlList.push(...txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
}
urlList = [...new Set(urlList)];

await mkdir(path.join(OUT, 'images'), { recursive: true });
await mkdir(path.join(OUT, 'articles'), { recursive: true });
await mkdir(path.join(OUT, 'info'), { recursive: true });
const logPath = path.join(OUT, '_log.txt');
const log = async (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); await appendFile(logPath, l + '\n').catch(() => {}); };

const hash = (s, n = 12) => createHash('sha1').update(s).digest('hex').slice(0, n);

// 正文清洗用：站点模板噪声行（导航/分享/免责/推荐/责任编辑）+ 中日韩字符判定
const BOILER = /(扫码|二维码|分享至|分享到|点击关注|关注我们|关注「|责任编辑|免责声明|免责|版权归|未经(授权|允许)|禁止转载|原标题|本文来源|阅读此文之前|麻烦您点击|微信公众号|微信扫一扫|下载客户端|客户端下载|热门推荐|相关推荐|猜你喜欢|推荐阅读|延伸阅读|上一篇|下一篇|返回顶部|广告|通讯员|举报|长按识别|声明[:：]|下载次数|附件|小黑屋|ICP备|我的收藏|查看所有收藏|版权所有|站点统计|All Rights Reserved|编辑[:：]|评论\s*\d)/;
const CJK = /[\u4e00-\u9fa5]/;
// 附件清单行（discuz：`xxx.jpg (206.52 KB, 下载次数: 1)`）、表格碎片、纯图名行 —— 都不是正文
const NOISE_LINE = /(\.(jpe?g|png|webp|gif|bmp)\s*\([^)]*(KB|MB|下载次数)|^\s*\||^\s*[\w-]{20,}\.(jpe?g|png)\s*$)/i;

/* --prune 独占模式：只按已有 manifest 清掉 images/ 里的残留（含上次跑剩的图与 .tmp），不抓取 */
if (hasFlag('--prune') && !urlList.length && !getArg('--images')) {
  const keep = new Set();
  for (const mf of ['manifest.json', 'manifest-direct.json']) {
    try {
      const m = JSON.parse(await readFile(path.join(OUT, mf), 'utf8'));
      for (const s of m.sources || []) for (const i of s.images || []) if (i.file) keep.add(path.normalize(i.file));
      for (const i of m.images || []) if (i.file) keep.add(path.normalize(i.file));
    } catch { /* 缺文件跳过 */ }
  }
  let removed = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); await rmdir(p).catch(() => {}); continue; }
      const rel = path.normalize(path.relative(OUT, p));
      if (e.name.endsWith('.tmp') || !keep.has(rel)) { await rmTmp(p); removed++; }
    }
  };
  await walk(path.join(OUT, 'images'));
  await log(`prune 完成：保留 ${keep.size} 个文件，清理 ${removed} 个残留`);
  process.exit(0);
}

/* --browser-info 独占模式：把 agent-browser 渲染后取回的正文回填成 info/*.json + articles/*.md
   文件格式：每行一个 JSON —— {"url":"原始文章URL","title":"...","text":"正文纯文本","date":"YYYY-MM-DD?"} */
if (getArg('--browser-info') && !urlList.length && !getArg('--images') && !hasFlag('--digest')) {
  const raw = await readFile(path.resolve(getArg('--browser-info')), 'utf8');
  let n = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.url || !e.text) continue;
    const slug = hash(e.url, 10);
    const paragraphs = dedupeLines(cleanLines(e.text));
    const info = {
      url: e.url, site: new URL(e.url).origin, title: e.title || null, summary: '',
      publishedAt: e.date || null, author: null, paragraphs, source: 'agent-browser(JS渲染)',
    };
    await writeFile(path.join(OUT, 'info', `${slug}.json`), JSON.stringify(info, null, 2));
    await writeFile(path.join(OUT, 'articles', `${slug}.md`),
      `# ${e.title || '(无标题)'}\n\n- 来源: ${e.url}\n- 站点: ${info.site}\n- 发布: ${info.publishedAt || '未知'}\n- 抓取方式: agent-browser 渲染后取正文（curl 只能拿到 JS 壳）\n\n---\n\n${paragraphs.join('\n\n')}\n`);
    await log(`回填浏览器正文：${(e.title || '').slice(0, 34)} → ${slug}.json（${paragraphs.length} 段）`);
    n++;
  }
  await log(`browser-info 完成：回填 ${n} 篇`);
  process.exit(0);
}

/* --digest 独占模式：把 info/*.json 聚合成一份「带来源标注」的信息摘要，不联网 */
if (hasFlag('--digest') && !urlList.length && !getArg('--images')) {
  const infoDir = path.join(OUT, 'info');
  const arts = [];
  for (const f of (await readdir(infoDir).catch(() => [])).filter((f) => f.endsWith('.json')).sort()) {
    try { arts.push(JSON.parse(await readFile(path.join(infoDir, f), 'utf8'))); } catch { /* skip */ }
  }
  if (!arts.length) { await log('info/ 为空：先跑一次抓取（可用 --text-only）再 --digest'); process.exit(0); }

  // 配图张数（来源 -> 数量），供摘要里标注
  const imgBy = {};
  for (const mf of ['manifest.json', 'manifest-direct.json']) {
    try {
      const m = JSON.parse(await readFile(path.join(OUT, mf), 'utf8'));
      for (const s of m.sources || []) if (s.url) imgBy[s.url] = s.images?.length || 0;
      if (m.images?.length) imgBy['(toutiao direct)'] = m.images.length;
    } catch { /* skip */ }
  }

  // 同一件事被多家报道：中文改写稿字面相似度极低（实测最高 0.06），改用「共享关键实体」归组
  // —— 标题/正文里的《书名号》实体（杂志、作品、品牌）是最稳的事件锚点
  const keysOf = (a) => new Set([...(String(a.title || '') + (a.paragraphs || []).join('').slice(0, 800))
    .matchAll(/《([^》]{2,20})》/g)].map((m) => m[1]));
  const groups = [];
  for (const a of arts) {
    const k = keysOf(a);
    if (!k.size) { groups.push({ keys: k, items: [a] }); continue; }
    const hit = groups.find((x) => [...k].some((t) => x.keys.has(t)));
    if (hit) { hit.items.push(a); for (const t of k) hit.keys.add(t); }
    else groups.push({ keys: k, items: [a] });
  }

  // 主题闸门：多源里常混进同页的其他人物/话题（如红毯稿里的其他明星），只保留命中的句子
  const topics = (getArg('--topic') || '').split(/[,，、|]/).map((s) => s.trim()).filter(Boolean);
  const onTopic = (s) => !topics.length || topics.some((t) => s.includes(t));

  // 跨源去重后的要点：取各篇正文句子，含数字/书名号/引号的优先（信息量高）
  const seen = []; const points = [];
  for (const a of arts) for (const para of a.paragraphs || []) {
    for (const s of para.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter((x) => x.length >= 18)) {
      if (!onTopic(s)) continue;
      const n = norm(s); if (n.length < 12) continue;
      const gr = ngrams(n, 4);
      if (seen.some((k) => jaccard(k, gr) >= 0.6)) continue;
      seen.push(gr);
      const score = (/[0-9０-９]/.test(s) ? 2 : 0) + (/[《》「」“”]/.test(s) ? 2 : 0) + (/（|\(/.test(s) ? 1 : 0) + Math.min(s.length / 60, 1);
      points.push({ s, src: a.url, title: a.title, score });
    }
  }
  points.sort((a, b) => b.score - a.score);
  const topPoints = points.slice(0, 40);
  const idx = new Map(arts.map((a, i) => [a.url, i + 1]));

  const timeline = arts
    .filter((a) => a.publishedAt)
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
  const noDate = arts.filter((a) => !a.publishedAt);
  const dates = timeline.map((a) => a.publishedAt);

  const L = [];
  L.push(`# 信息汇总：${getArg('--topic') || '（未命名主题）'}`, '');
  L.push(`> 由 ${arts.length} 篇文章跨源聚合而成（每 {n} 标注来源序号）。图片另行存放于 images/。`, '');
  L.push(`- 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  L.push(`- 来源站点：${[...new Set(arts.map((a) => new URL(a.url).hostname))].length} 个｜文章：${arts.length} 篇｜配图：${Object.values(imgBy).reduce((a, b) => a + b, 0)} 张`);
  if (dates.length) L.push(`- 可考时间跨度：${dates[0]} ~ ${dates[dates.length - 1]}（${dates.length} 篇有明确时间，${noDate.length} 篇无）`);
  L.push('', '## 一、来源清单', '', '| # | 标题 | 站点 | 发布 | 配图 |', '|---|---|---|---|---|');
  arts.forEach((a, i) => L.push(`| ${i + 1} | ${(a.title || '(无标题)').slice(0, 44)} | ${new URL(a.url).hostname.replace(/^www\./, '')} | ${a.publishedAt || '—'} | ${imgBy[a.url] ?? '—'} |`));

  if (timeline.length) {
    L.push('', '## 二、时间线', '');
    for (const a of timeline) {
      const pick = (a.paragraphs || []).find(onTopic) || a.paragraphs?.[0] || a.summary || '';
      L.push(`- **${a.publishedAt}** · ${a.title}（来源 {${idx.get(a.url)}}）`, `  ${pick.slice(0, 110)}`);
    }
  }
  L.push('', '## 三、核心要点（跨源去重，按信息量排序）', '');
  topPoints.forEach((p, i) => L.push(`${i + 1}. ${p.s} —— 来源 {${idx.get(p.src)}}`));

  if (groups.some((g) => g.items.length > 1)) {
    L.push('', '## 四、同一事件的多源报道（按共享实体归组）', '');
    for (const g of groups.filter((x) => x.items.length > 1)) {
      const tag = [...g.keys].filter((t) => g.items.every((a) => keysOf(a).has(t))).slice(0, 2).join(' / ') || '同源事件';
      L.push(`- **${tag}** — ${g.items.length} 源：${g.items.map((a) => `{${idx.get(a.url)}}`).join(' ')}`);
    }
  }
  L.push('', '## 五、配图索引', '');
  try {
    const m = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
    for (const s of m.sources) if (s.images?.length) L.push(`- \`${s.dir}\` — ${s.images.length} 张（来源 {${idx.get(s.url) ?? '—'}}）`);
  } catch { /* skip */ }
  try {
    const d = JSON.parse(await readFile(path.join(OUT, 'manifest-direct.json'), 'utf8'));
    if (d.images?.length) L.push(`- \`images/toutiao\` — ${d.images.length} 张（agent-browser 渲染后取正文图）`);
  } catch { /* skip */ }
  L.push('');

  await writeFile(path.join(OUT, 'digest.md'), L.join('\n'));
  await writeFile(path.join(OUT, 'digest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), topic: getArg('--topic') || null,
    articleCount: arts.length, imageTotal: Object.values(imgBy).reduce((a, b) => a + b, 0),
    timeline: timeline.map((a) => ({ date: a.publishedAt, title: a.title, url: a.url })),
    points: topPoints.map((p) => ({ text: p.s, source: p.src })),
    duplicateGroups: groups.filter((x) => x.items.length > 1).map((x) => x.items.map((a) => a.url)),
  }, null, 2));
  await log(`digest 完成：${arts.length} 篇 -> ${OUT}/digest.md（要点 ${topPoints.length} 条，时间线 ${timeline.length} 条）`);
  process.exit(0);
}

if (!urlList.length && !getArg('--images')) {
  console.error('用法: node scripts/scrape-article-media.mjs --out <dir> --urls <file> | --url <u>... | --images <file>');
  process.exit(2);
}

await mkdir(path.join(OUT, 'images'), { recursive: true });
await mkdir(path.join(OUT, 'articles'), { recursive: true });

/* ---------------- 字符集解码（新浪 GBK 等） ---------------- */
function decodeBody(buf, contentType) {
  let ct = (contentType || '').match(/charset=([\w-]+)/i)?.[1];
  const head = buf.subarray(0, 4096).toString('latin1');
  const meta = head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const cs = (meta || ct || 'utf-8').toLowerCase();
  const enc = /gb2312|gbk|gb18030/.test(cs) ? 'gb18030' : /big5/.test(cs) ? 'big5' : 'utf-8';
  try { return new TextDecoder(enc).decode(buf); } catch { return buf.toString('utf8'); }
}

/* ---------------- 页面抓取（含 discuz 一次性 JS 挑战） ---------------- */
async function fetchPage(url) {
  const jar = new Map();
  const jarH = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const go = async (u, ref) => {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*;q=0.8' };
    if (ref) headers.Referer = ref;
    if (jar.size) headers.Cookie = jarH();
    if (!go.origin) go.origin = new URL(u).origin;
    const res = await fetch(u, { headers, redirect: 'follow' });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const kv = sc.split(';')[0]; const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  };
  let { res, buf } = await go(url, undefined);
  let html = decodeBody(buf, res.headers.get('content-type'));
  if (/window\.location\.href\s*=/.test(html) && html.length < 5000) {
    const m = html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
    ({ res, buf } = await go(m ? new URL(m[1], url).href : url, url));
    html = decodeBody(buf, res.headers.get('content-type'));
  }
  return { status: res.status, finalUrl: res.url, origin: new URL(res.url).origin, html };
}

/* ---------------- URL 归一化：把「缩略图/带参数」还原成原图 ---------------- */
function normalizeImageUrl(raw, baseUrl) {
  if (typeof raw !== 'string' || !raw) return null;
  let s = raw.trim().replace(/^["']|["']$/g, '').replace(/&amp;/g, '&');
  if (!s || /^(data:|javascript:|about:)/i.test(s)) return null;
  let u; try { u = new URL(s, baseUrl); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const url = u.href;

  // 网易：nimg.ws.126.net/?url=<原图>&thumbnail=660x... —— 去掉 thumbnail 得原图
  if (/nimg\.ws\.126\.net|dingyue\.ws\.126\.net/.test(u.hostname + url)) {
    u.searchParams.delete('thumbnail');
    return { url: u.href, key: u.searchParams.get('url') || u.href, host: '163' };
  }
  // 腾讯：inews.gtimg.com/news_bt/<id>/641 —— 末尾数字=宽度，换 /0 取原图
  const gt = url.match(/^(https?:\/\/[\w.-]*gtimg\.com\/(?:news_bt|om_ls)\/[^/]+)\/\d+(\?.*)?$/);
  if (gt) return { url: gt[1] + '/0', key: gt[1], host: 'qq' };
  // 新浪：k.sinaimg.cn/...jpg/w160h120hdp.jpg 是尺寸变体 —— 去掉尾缀；n/k 之间用 upload 后路径归一
  if (/sinaimg\.cn/.test(u.hostname)) {
    const clean = url.replace(/\.(jpe?g|png|gif|webp)\/[^/]*\.(?:jpe?g|png|gif|webp)$/i, '.$1');
    const k = clean.match(/\/upload\/(.+)$/)?.[1] || clean;
    return { url: clean, key: 'sina:' + k, host: 'sina' };
  }
  // 阿里 OSS / 励淘等：image_process= 是处理参数，去掉才能拿到原图（且不触发热链拦截）
  if (/[?&]image_process=/.test(url)) {
    u.searchParams.delete('image_process');
    return { url: u.href, key: u.href, host: u.hostname.replace(/^www\./, '') };
  }

  // WordPress 缩略图变体 -300x207 之类：去掉后作为 key，优先留原图
  const wpThumb = url.match(/^(.*?)-(\d{2,4})x(\d{2,4})(\.(?:jpe?g|png|webp|gif))(\?.*)?$/i);
  const key = wpThumb ? wpThumb[1] + wpThumb[4] : url;
  return { url, key, host: u.hostname.replace(/^www\./, ''), isThumb: !!wpThumb };
}

/* ---------------- 正文容器切片：把全页 HTML 收敛到正文，避免推荐流/侧栏配图混入 ---------------- */
function matchTagEnd(html, tagName, from) {
  const re = new RegExp(`<${tagName}\\b|</${tagName}>`, 'gi');
  re.lastIndex = from;
  let depth = 1; let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') { depth--; if (depth === 0) return m.index + m[0].length; }
    else depth++;
  }
  return html.length;
}
function sliceMainContainer(html) {
  const patterns = [
    /<div[^>]+class=["'][^"']*post_body[^"']*["'][^>]*>/i,
    /<div[^>]+class=["'][^"']*(?:article-content|article_content|post-content|entry-content|tt-article-content|syl-article-base|artical-content|post_text|rich_media_content)[^"']*["'][^>]*>/i,
    /<article\b[^>]*>/i,
    /<div[^>]+id=["'][^"']*(?:content|article|detail|post)[^"']*["'][^>]*>/i,
  ];
  for (const p of patterns) {
    const m = p.exec(html);
    if (!m) continue;
    const tag = /^<(article)\b/i.test(m[0]) ? 'article' : 'div';
    const end = matchTagEnd(html, tag, m.index + m[0].length);
    const slice = html.slice(m.index, end);
    if (slice.length > 500) return slice;
  }
  return html;
}

function collectCandidates(html, baseUrl) {
  const map = new Map(); // key -> {url, weight}
  const add = (raw, weight) => {
    const n = normalizeImageUrl(raw, baseUrl);
    if (!n || BAD.test(n.url) || BAD_BASENAME.test(n.url.split('/').pop() || '')) return;
    if (n.isThumb) weight -= 4;
    const prev = map.get(n.key);
    if (!prev || weight > prev.weight) map.set(n.key, { ...n, weight });
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name) => tag.match(new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']', 'i'))?.[1];
    add(attr('zoomfile'), 12);          // discuz 原图
    add(attr('file'), 10);              // discuz 大图
    add(attr('data-original'), 11);     // 懒加载原图
    add(attr('data-src'), 10);
    add(attr('data-lazy-src'), 10);
    add(attr('data-echo'), 10);
    const w = Number(attr('width') || 0);
    add(attr('src'), w && w < 300 ? 2 : 8);
    for (const p of (attr('srcset') || '').split(',')) add(p.trim().split(/\s+/)[0], 7);
  }
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(m[1], 6);
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1], 5);
  // 兜底全页扫：直链、查询参数里内嵌的图链（新浪图集 iframe?p=...jpg）、JS 数组里的图链
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp|gif|bmp)(?:\/[^\s"'<>()\\]*)?/gi)) add(m[0], 7);
  for (const m of html.matchAll(/[?&](?:p|pic|url|src|img|image)=(https?%3A%2F%2F[^&"'\s]+)/gi)) {
    try { add(decodeURIComponent(m[1]), 7); } catch { /* ignore */ }
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_PER_PAGE);
}

/** 先只在正文容器里找；容器太窄(候选<4)才回退全页——既保精度又不至于颗粒无收。 */
function extractCandidates(html, baseUrl) {
  const sliced = sliceMainContainer(html);
  if (sliced !== html) {
    const inMain = collectCandidates(sliced, baseUrl);
    if (inMain.length >= 4) return inMain;
  }
  return collectCandidates(html, baseUrl);
}

/* ---------------- 正文抽取（信息兜底：清洗 + 结构化） ---------------- */
function cleanLines(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 12)            // 太短的多半是按钮/标签
    .filter((l) => !BOILER.test(l))
    .filter((l) => !NOISE_LINE.test(l))
    .filter((l) => CJK.test(l) || /[a-zA-Z]{3}/.test(l))
    .filter((l) => !/^[\w\s\d.,:;!?%()（）「」【】\-—…·、。，]+$/.test(l) || l.length > 30);
}

/** 句级近重复判定（4-gram Jaccard），用于跨段/跨源去重 */
function norm(s) { return s.replace(/[\s\p{P}]/gu, ''); }
function ngrams(s, n = 4) {
  const set = new Set();
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}
function dedupeLines(lines, threshold = 0.62) {
  const kept = []; const grams = [];
  for (const l of lines) {
    const n = norm(l);
    if (n.length < 8) continue;
    const g = ngrams(n, 4);
    if (grams.some((k) => jaccard(k, g) >= threshold)) continue; // 近似重复丢弃
    kept.push(l); grams.push(g);
  }
  return kept;
}

function extractArticle(html) {
  // 标题：og:title 优先；论坛/门户的模板标题（含站点口号、超长）降级到 <h1>
  const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const raw = (og || h1 || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const looksBoiler = (t) => !t || t.length > 60 || /(门户网站|传播网|www\.|- 今日头条$|_[^_]{0,10}新闻$)/.test(t);
  const title = looksBoiler(raw) && h1 && h1.length <= 60 ? h1 : raw;

  const summary = (html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i)?.[1] || '').trim();

  // 发布时间：优先结构化字段，兜底正文里的日期字面量
  const dateRaw = html.match(/"(?:datePublished|publishTime|published_time|pubDate|createTime)"\s*:\s*"([^"]+)"/i)?.[1]
    || html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|og:release_date|pubdate|publishdate|date)["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1]
    || (html.match(/(20\d{2})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/) || []).slice(1).join('-');
  let publishedAt = null;
  if (dateRaw) {
    const m = String(dateRaw).match(/(20\d{2})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/);
    if (m) publishedAt = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  const author = (html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i)?.[1]
    || html.match(/作者[:：]\s*([^\s<，,。]{2,12})/)?.[1] || null);

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|aside|footer|header|form|iframe|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = body.match(/<article[\s\S]*?<\/article>/i)?.[0]
    || body.match(/<div[^>]+(?:id|class)=["'][^"']*(?:post_body|article-content|article_content|post-content|entry-content|syl-article-base|artical-content|post_text|rich_media_content)[^"']*["'][^>]*>[\s\S]{200,}/i)?.[0]
    || body.match(/<div[^>]+(?:id|class)=["'][^"']*(?:article|content|detail|main)[^"']*["'][^>]*>[\s\S]{200,}/i)?.[0]
    || body;

  const rawLines = (main.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [main]).join('\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;|&[a-z]+;/g, ' ');
  const paragraphs = dedupeLines(cleanLines(rawLines));
  const text = paragraphs.join('\n\n');
  return { title, summary, publishedAt, author, paragraphs, text };
}

/* ---------------- 分辨率探测（真图校验） ---------------- */
function imageSize(buf) {
  if (buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png' };
  if (buf[0] === 0x47 && buf[1] === 0x49) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), ext: 'gif' };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) { o++; continue; }
      const mk = buf[o + 1];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc)
        return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7), ext: 'jpg' };
      o += 2 + buf.readUInt16BE(o + 2);
    }
    return { w: 0, h: 0, ext: 'jpg' };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return { w: 0, h: 0, ext: 'webp' };
  return null;
}

/* ---------------- curl 下载（带 Referer 绕防盗链） ---------------- */
function curlDownload(imgUrl, referer, outFile) {
  const r = spawnSync('curl', [
    '-sL', '--max-time', '40', '-A', UA, '-e', referer,
    '-H', 'Accept: image/avif,image/webp,image/*,*/*;q=0.8',
    '-o', outFile, '-w', '%{http_code} %{content_type} %{size_download}', imgUrl,
  ], { encoding: 'utf8' });
  if (r.error) return { ok: false, reason: 'curl 不可用: ' + r.error.message };
  const [code, ct, size] = (r.stdout || '').trim().split(' ');
  if (code !== '200') return { ok: false, reason: `http ${code}` };
  if (!/^image\//.test(ct || '')) return { ok: false, reason: `not image (${ct})` };
  return { ok: true, bytes: Number(size), type: ct };
}

/* Windows 上 curl 刚写完的文件可能短暂被占用，unlink 会 EBUSY —— 重试几次 */
async function rmTmp(p) {
  for (let i = 0; i < 4; i++) {
    try { await unlink(p); return; } catch (e) {
      if (e?.code === 'ENOENT') return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/* ---------------- 单张图落盘：curl 下载 -> content-type/尺寸双重校验 ---------------- */
async function saveImage(imgUrl, referer, outDir, relPrefix = '') {
  const host = new URL(imgUrl).hostname.replace(/^www\./, '').replace(/[^a-z0-9.]/gi, '_');
  const base = `${host}-${hash(imgUrl)}`;
  const tmp = path.join(outDir, base + '.tmp');
  const r = curlDownload(imgUrl, referer, tmp);
  if (!r.ok) { await rmTmp(tmp); return { ok: false, reason: r.reason }; }
  const buf = Buffer.from(await readFile(tmp));
  if (buf.length < MIN_BYTES) { await rmTmp(tmp); return { ok: false, reason: `too small (${buf.length}B)` }; }
  const dim = imageSize(buf);
  if (!dim) { await rmTmp(tmp); return { ok: false, reason: '非图片格式' }; }
  if (dim.w && (dim.w < MIN_W || dim.h < MIN_H)) { await rmTmp(tmp); return { ok: false, reason: `尺寸过小 ${dim.w}x${dim.h}` }; }
  if (dim.w && (dim.w / dim.h > 3.2 || dim.h / dim.w > 3.2)) { await rmTmp(tmp); return { ok: false, reason: `比例异常 ${dim.w}x${dim.h}` }; }
  const file = `${base}.${dim.ext}`;
  await writeFile(path.join(outDir, file), buf);
  await rmTmp(tmp);
  return { ok: true, file: relPrefix + file, bytes: buf.length, w: dim.w, h: dim.h };
}

/* ---------------- 直链模式：--images <file>（每行 "图片URL" 或 "图片URL<TAB>Referer"）---------------- */
const imagesFile = getArg('--images');
if (imagesFile) {
  const dir = path.join(OUT, 'images', getArg('--as') || 'direct');
  await mkdir(dir, { recursive: true });
  const lines = (await readFile(path.resolve(imagesFile), 'utf8')).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const saved = [];
  for (const line of lines) {
    const [imgUrl, referer] = line.split('\t');
    const c = normalizeImageUrl(imgUrl, referer || imgUrl);
    if (!c) { await log(`  ✘ 无效地址 ${imgUrl}`); continue; }
    const r = await saveImage(c.url, referer || new URL(c.url).origin + '/', dir, `images/${path.basename(dir)}/`);
    if (r.ok) { saved.push(r); await log(`  ✔ ${r.file} (${Math.round(r.bytes / 1024)}KB ${r.w}x${r.h})  <- ${c.url}`); }
    else await log(`  ✘ ${r.reason}  <- ${c.url}`);
  }
  for (const f of await readdir(dir).catch(() => [])) if (f.endsWith('.tmp')) await rmTmp(path.join(dir, f));
  await writeFile(path.join(OUT, 'manifest-direct.json'), JSON.stringify({ generatedAt: new Date().toISOString(), images: saved }, null, 2));
  await log(`\n直链模式完成：${saved.length}/${lines.length} 张 -> ${dir}`);
  process.exit(0);
}

const manifest = [];
for (const url of urlList) {
  await log(`--- 抓取文章: ${url}`);
  let page;
  try { page = await fetchPage(url); }
  catch (e) { await log(`  页面抓取失败: ${e?.message || e}`); manifest.push({ url, error: String(e?.message || e) }); continue; }
  if (page.status !== 200) { await log(`  HTTP ${page.status}，跳过`); manifest.push({ url, error: `http ${page.status}` }); continue; }

  const { title, summary, publishedAt, author, paragraphs, text } = extractArticle(page.html);
  const cands = textOnly ? [] : extractCandidates(page.html, page.finalUrl);
  await log(`  标题: ${title || '(无)'} | 发布: ${publishedAt || '?'} | 正文 ${paragraphs.length} 段 | 候选图: ${cands.length}`);

  const slug = hash(url, 10);
  await writeFile(path.join(OUT, 'articles', `${slug}.md`),
    `# ${title || '(无标题)'}\n\n- 来源: ${url}\n- 站点: ${page.origin}\n- 发布: ${publishedAt || '未知'}\n- 作者: ${author || '未知'}\n- 摘要: ${summary}\n\n---\n\n${text}\n`);
  // 结构化信息（供跨源聚合/检索用，md 是给人看的、json 是给程序用的）
  await writeFile(path.join(OUT, 'info', `${slug}.json`),
    JSON.stringify({ url, site: page.origin, title, summary, publishedAt, author, paragraphs, imageCount: cands.length }, null, 2));

  // 每个来源单独一个子目录，便于按来源挑图（有的文章是多人合影/无关配图）
  const srcDir = path.join(OUT, 'images', `${page.origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9.]/gi, '_')}-${slug}`);

  const saved = [];
  if (cands.length) {
    await mkdir(srcDir, { recursive: true });
    for (const c of cands) {
      const r = await saveImage(c.url, url, srcDir, `images/${path.basename(srcDir)}/`);
      if (r.ok) { saved.push({ url: c.url, ...r }); await log(`  ✔ ${r.file} (${Math.round(r.bytes / 1024)}KB ${r.w}x${r.h})  <- ${c.url}`); }
      else await log(`  ✘ ${r.reason}  <- ${c.url}`);
    }
  }
  // 0 张的目录不留空壳
  if (!saved.length) await rmdir(srcDir).catch(() => {});
  manifest.push({ url, title, summary, article: `articles/${slug}.md`, dir: saved.length ? `images/${path.basename(srcDir)}` : null, images: saved });
  await log(`  小计: ${saved.length}/${cands.length} 张成功`);
}
// 收尾：清掉可能残留的 .tmp
for (const d of [...(await readdir(path.join(OUT, 'images'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(OUT, 'images', e.name)), path.join(OUT, 'images')]) {
  const files = await readdir(d).catch(() => []);
  for (const f of files) if (f.endsWith('.tmp')) await rmTmp(path.join(d, f));
}

await writeFile(path.join(OUT, textOnly ? 'manifest-text.json' : 'manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), out: OUT, textOnly, sources: manifest }, null, 2));
const total = manifest.reduce((n, s) => n + (s.images?.length || 0), 0);
await log(`\n完成：${manifest.length} 篇文章，${textOnly ? '仅抽取信息' : `下载 ${total} 张图`} -> ${OUT}`);
if (textOnly) { await log('提示：跑 `--digest` 可把这些 info/*.json 聚合成一份信息摘要'); process.exit(0); }
