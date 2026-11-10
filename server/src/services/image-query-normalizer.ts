/**
 * 图片搜索词净化 —— **只用于「爬必应图片页」这一层**（2026-11-09 用户定稿）：
 * 「纯人名约束只针对走必应的时候，之后接入其他搜索 API 就正常」。
 *
 * 调用点唯一：`UpstreamSearchService.searchImages()` 的必应兜底分支（搜索 API
 * 未接入 / 缺 key / 无图片能力 / 返回空时才落到这里）。真正的图片搜索 API
 * 拿到的是模型原词，不做任何裁剪——接入后不需要也不会被这条规则影响。
 *
 * 复现证据（本地真链，q 走 cn.bing.com/images/search，取前 6 张看是否含本人）：
 *   q=「鞠婧祎」          → 6/6 命中
 *   q=「鞠婧祎 壁纸」     → 6/6 命中（具体图片类型词，有效）
 *   q=「鞠婧祎 写真」     → 6/6 命中（同上）
 *   q=「鞠婧祎 照片」     → 0/6（返回国画设计图）
 *   q=「鞠婧祎 图片」     → 0/6（返回消防安全黑板报）
 *   q=「鞠婧祎 图集/美图」→ 0/6（返回设计图库/博物馆）
 *   q=「鞠婧祎 高清」     → 0/6（返回包养网广告）
 *   q=「刘亦菲 最近」     → 0/6（返回刘姓起源科普，话题被带偏）
 * 即「泛化载体词 + 画质词 + 时间词」对图库检索不是增量而是噪声——必应对多词
 * 中文人像查询会降级到兜底结果集。人物照片的正确召回词就是纯人名（+ 具体
 * 图片类型词）。
 *
 * 契约：本模块是**代码层**的兜底，不依赖模型自觉——工具 schema 已经把口径
 * 写给模型（primary），必应分支执行前再收敛一次（secondary），两层同源。
 * 只剔「对图片检索无区分度」的载体词/画质词/命令词；带语义的限定（云海、
 * 日出、水屋、舞台等）一律保留，风景/商品查询不受影响。
 */

/** 载体词 + 画质词 + 数量/命令词：对图库检索没有区分度，命中即剔。 */
const IMAGE_QUERY_NOISE: ReadonlySet<string> = new Set([
  // 泛化载体词（实测必应会把「人名 + 照片/图片/图集/美图」降级成完全无关的
  // 通用图库结果：q=「鞠婧祎 照片」→ 国画设计图；q=「鞠婧祎 图片」→ 黑板报）
  "照片", "图片", "相片", "图像", "美图", "图集", "组图", "合集", "素材", "大图", "高清图",
  // 画质/规格词（q=「鞠婧祎 高清」→ 包养网广告）
  "高清", "超清", "蓝光", "原图", "无水印", "免费", "免费下载", "大全", "精选",
  // 数量/口语（模型常把用户的命令词照抄进 query）
  "几张", "来几张", "一些", "一点", "点", "张", "个",
  // 时间/近况（q=「刘亦菲 最近」→ 刘姓起源科普，话题直接被带偏）
  "最新", "最近", "近期", "近照", "新图", "近况",
  // 结构助词（剥掉「刘亦菲的照片」里的「的」）
  "的",
  // 命令动词
  "搜索", "搜一下", "搜搜", "搜", "找一下", "找一找", "找找", "找",
  "给我", "帮我", "帮忙", "麻烦", "看看", "看一下", "看下", "请",
]);
// 注意：**壁纸/头像/表情包/写真 不剔**——它们是「具体图片类型」，实测
// 「鞠婧祎 壁纸」「鞠婧祎 头像」「鞠婧祎 写真」仍 6/6 命中本人，属有效检索词
// （与 composeMediaSearchQuery「图片类型词保留」的旧口径一致）。

const IMAGE_QUERY_NOISE_SORTED = [...IMAGE_QUERY_NOISE].sort((a, b) => b.length - a.length);

/** 命令前缀（连续剥离，如「帮我搜索几张」）。 */
const LEADING_COMMAND_RE =
  /^(?:麻烦|请|帮我|帮忙|给我|搜索|搜一下|搜搜|搜|找一下|找一找|找找|找|来几张|来点|看看|看一下|看下|几张|张|个|点)+\s*/;

function stripTrailingNoise(query: string): string {
  let out = query;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of IMAGE_QUERY_NOISE_SORTED) {
      if (out.length > word.length && out.endsWith(word)) {
        out = out.slice(0, out.length - word.length).trim();
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * 净化图片搜索词。
 *
 * - 「鞠婧祎 照片 高清」→「鞠婧祎」
 * - 「鞠婧祎 壁纸」→ 原样保留（具体图片类型词）
 * - 「帮我搜几张刘亦菲最近的照片」→「刘亦菲」
 * - 「黄山 云海 日出」→ 原样保留（语义限定词不动）
 * - 剔完不剩主体（「来点图」/「照片」）→ 回退原词，绝不返回空串
 */
export function normalizeImageSearchQuery(raw: string): string {
  const original = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!original) return original;

  let q = original.replace(LEADING_COMMAND_RE, "").trim();

  // 1) 空格分词查询：逐 token 剔除噪声词 + 粘在主体后的噪声（「刘亦菲的照片」）
  if (q.includes(" ")) {
    const kept = q
      .split(" ")
      .filter((t) => t && !IMAGE_QUERY_NOISE.has(t))
      .map((t) => stripTrailingNoise(t))
      .filter((t) => t.length > 0);
    q = kept.length > 0 ? kept.join(" ") : q;
  } else {
    // 2) 无空格整串（「鞠婧祎写真照片」）：尾部逐词剥离
    q = stripTrailingNoise(q);
  }

  const cleaned = q.trim();
  // 主体被吃光 → 原词兜底（宁可多一个噪声词，也不发空 query）
  return cleaned.length >= 2 ? cleaned : original;
}
