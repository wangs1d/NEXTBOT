const TIMESTAMP_PREFIX_RE = /^\[[^\]]+\]\s*/;
const TOPIC_TAG_RE = /^\[[A-Z_:-]+\]\s*/i;

export function stripMemoryLineDecorators(line: string): string {
  return line
    .replace(TIMESTAMP_PREFIX_RE, "")
    .replace(TOPIC_TAG_RE, "")
    .replace(/\[fast-path\]\s*/gi, "")
    .replace(/\[(?:用户要求记住|Agent 承诺\/结论|关系线程)\]\s*/gi, "")
    .trim();
}

export function normalizeMemoryLine(line: string): string {
  return stripMemoryLineDecorators(line)
    .toLowerCase()
    .replace(/[“”"'`]/g, "")
    .replace(/[，。！？、,:;|()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CJK_RE = /[\u4e00-\u9fa5]/;

/**
 * 分词（P2 关键修复）：中文无空格，纯空格切分会让整句中文成一个 token，
 * 词重叠/指纹对中文完全失效。含中文的 token 切 2-gram（bigram），英文子串按词保留；
 * 混合词拆出的单字符（如「记忆A」的 A）保留——它是序号/实体的区分信号。
 *
 * 导出：FTS 关键词第三路（fts-store）用同一分词器建索引与解析 query，
 * 保证词法路与仲裁器 overlapFactor 的 token 粒度一致。
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  for (const token of normalizeMemoryLine(line).split(" ")) {
    if (!token) continue;
    if (!CJK_RE.test(token)) {
      if (token.length >= 2) out.push(token);
      continue;
    }
    for (const part of token.split(/([\u4e00-\u9fa5]+)/).filter(Boolean)) {
      if (!CJK_RE.test(part)) {
        out.push(part); // 混合词内的英文/数字片段（含单字符）保留
        continue;
      }
      for (let i = 0; i + 1 < part.length; i++) out.push(part.slice(i, i + 2));
    }
  }
  return out;
}

/**
 * 语义指纹（P1 优化）：
 * - 全量 token 参与签名（旧实现只取前 10 个，尾部信息完全丢失）；
 * - 排序签名（顺序无关）：同一话题但内容不同的长事件不再因前缀相似被合并，
 *   词集相同的重述仍可合并。中文经 bigram 切分后同样适用。
 */
export function semanticFingerprint(line: string): string {
  const tokens = tokenize(line);
  return tokens.length === 0 ? "" : [...tokens].sort().join(" ");
}

/**
 * 事实值是否出现在文本里（归一匹配，2026-10-19 P1）。
 *
 * 直接 `text.includes(value)` 对「杭州」vs「杭州市」这类颗粒度差异会漏标——
 * LLM 抽取时会把原话改写成不同行政粒度。归一规则：去空白、剥行政区划后缀
 * （省/市/区/县/州/盟），再做 contains。只在"打标签/判定副本"这类
 * 写侧判定用，不做同义词展开（那需要词表，宁漏不猜）。
 */
export function factValueInText(value: string, text: string): boolean {
  const norm = (s: string): string =>
    s.replace(/\s+/g, "").replace(/[省市区县州盟]$/g, "");
  const v = norm(value ?? "");
  const t = norm(text ?? "");
  return v.length >= 2 && t.includes(v);
}

/** 词袋 token 集合（实体一致性/话题重叠计算的原料，中文 bigram 粒度）。 */
export function contentTokenSet(line: string): Set<string> {
  return new Set(tokenize(line));
}

/**
 * 词汇重叠率（min-侧 Jaccard）：query 与记忆的实词重叠程度。
 * 用于防串台——聊 A 话题时 B 话题记忆即使语义分高也会因重叠过低被降权。
 */
export function tokenOverlapRatio(queryTokens: Set<string>, memoryTokens: Set<string>): number {
  if (queryTokens.size === 0 || memoryTokens.size === 0) return 1;
  let hits = 0;
  for (const t of queryTokens) if (memoryTokens.has(t)) hits++;
  return hits / Math.min(queryTokens.size, memoryTokens.size);
}

/** 把 ISO 时间戳转成人类可读的相对时间（注入 prompt 用，程序化计算杜绝 LLM 标签失真）。 */
export function describeMemoryAge(timestamp: string | undefined, now = Date.now()): string {
  const ts = Date.parse(timestamp ?? "");
  if (!Number.isFinite(ts)) return "";
  const minutes = Math.max(0, (now - ts) / 60_000);
  if (minutes < 60) return "刚刚";
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}小时前`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}天前`;
  if (days < 30) return `${Math.round(days / 7)}周前`;
  if (days < 365) return `${Math.round(days / 30)}个月前`;
  return `${Math.round(days / 365)}年前`;
}

/**
 * 亲密关系主题的覆盖键（root fix，2026-09 复盘）：
 * "我的老婆是景甜" 与 "我的老婆是刘浩存"（含「未来老婆」「正主」等变体）是同一
 * 字段的新旧值，必须共享同一个 overwrite key，latest-wins 替换——旧实现按整句
 * 生成 key，新旧值各占一行并存，正是"前脚一个景甜后脚一个刘浩存"的 KV 层根源。
 * key 只取主题类别（不含值），值不同即视为冲突、新值替换旧值。
 */
const RELATIONSHIP_OVERWRITE_CLASSES: Array<{ re: RegExp; cls: string }> = [
  { re: /(?:我的|未来的?|自家的)(?:老婆|媳妇|妻子|夫人|爱人)|(?:老婆|媳妇|妻子|未婚妻|对象|正主)(?:是|叫|才是)/, cls: "spouse" },
  { re: /(?:我的|未来的?)?(?:未婚妻|未婚夫)/, cls: "fiance" },
  { re: /(?:我的)?(?:女朋友|女友|男朋友|男友|对象)(?:是|叫|才是)?/, cls: "partner" },
];

export function extractOverwriteKey(line: string): string | null {
  const plain = stripMemoryLineDecorators(line);
  for (const { re, cls } of RELATIONSHIP_OVERWRITE_CLASSES) {
    if (re.test(plain)) return `relationship:${cls}`;
  }
  const patterns: RegExp[] = [
    /(?:喜欢|不喜欢|讨厌|偏好|习惯|总是|从不|不要|别)\s*([^，。！？\n]{2,24})/,
    /(?:生日|纪念日|住在|住址|城市|学校|公司|职业|工作是)\s*([^，。！？\n]{2,24})/,
    /(?:提醒我|记住|记得)\s*([^，。！？\n]{2,24})/,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    if (match?.[1]) {
      return `${pattern.source}:${normalizeMemoryLine(match[1]).slice(0, 48)}`;
    }
  }
  const normalized = normalizeMemoryLine(plain);
  return normalized ? normalized.slice(0, 48) : null;
}

export function areLinesConflicting(a: string, b: string): boolean {
  const keyA = extractOverwriteKey(a);
  const keyB = extractOverwriteKey(b);
  if (!keyA || !keyB || keyA !== keyB) return false;
  return normalizeMemoryLine(a) !== normalizeMemoryLine(b);
}

export function dedupeMemoryLines(
  lines: string[],
  opts?: { preferLatest?: boolean; keepAtLeast?: number },
): string[] {
  const keepAtLeast = Math.max(0, opts?.keepAtLeast ?? 0);
  const ordered = opts?.preferLatest ? [...lines].reverse() : [...lines];
  const seen = new Set<string>();
  const byOverwriteKey = new Map<string, string>();
  const result: string[] = [];

  for (const line of ordered) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fingerprint = semanticFingerprint(trimmed);
    if (fingerprint && seen.has(fingerprint)) continue;

    const overwriteKey = extractOverwriteKey(trimmed);
    if (overwriteKey && byOverwriteKey.has(overwriteKey)) {
      const existing = byOverwriteKey.get(overwriteKey)!;
      if (areLinesConflicting(existing, trimmed)) {
        continue;
      }
    }

    if (fingerprint) seen.add(fingerprint);
    if (overwriteKey) byOverwriteKey.set(overwriteKey, trimmed);
    result.push(trimmed);
  }

  const restored = opts?.preferLatest ? result.reverse() : result;
  if (keepAtLeast <= 0 || restored.length <= keepAtLeast) return restored;
  return restored.slice(-keepAtLeast);
}

export function limitLinesByChars(
  lines: string[],
  maxChars: number,
  opts?: { preserveTail?: boolean },
): { kept: string[]; evicted: string[] } {
  if (maxChars <= 0) return { kept: [], evicted: [...lines] };
  const kept: string[] = [];
  const evicted: string[] = [];
  const source = opts?.preserveTail ? [...lines].reverse() : [...lines];
  let used = 0;

  for (const line of source) {
    const next = used === 0 ? line.length : used + 1 + line.length;
    if (next <= maxChars) {
      kept.push(line);
      used = next;
    } else {
      evicted.push(line);
    }
  }

  if (opts?.preserveTail) {
    kept.reverse();
    evicted.reverse();
  }
  return { kept, evicted };
}

/**
 * 承诺/未闭环槽位的保鲜期（2026-09-24 僵尸承诺治理）：
 * memory_commitments / memory_open_loops 承接的是"将要去做"的任务型话术（提醒/日程/
 * 汇报类口头应承），闭环靠 doReconcile 的完成词命中，但大量承诺（"我会在00:50睡觉"
 * "16:40参加会议"）此后永远不被提及 → 僵尸承诺长期占行数预算并被相关性闸放行进
 * prompt（实测 9/7 的"00:50睡觉"17 天后仍在场）。超 TTL 未闭环即按僵尸过滤；
 * 无时间戳或解析失败的行保留（证据不足不冤枉）。任务型事实的权威数据源是任务库，
 * 这里只保对话层的新鲜度。
 */
export const COMMITMENT_TTL_MS = 72 * 60 * 60 * 1000;

const LEADING_ISO_TS_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/;

export function dropExpiredCommitmentLines(
  lines: string[],
  now = Date.now(),
  ttlMs = COMMITMENT_TTL_MS,
): string[] {
  const cutoff = now - ttlMs;
  return lines.filter((line) => {
    const m = LEADING_ISO_TS_RE.exec(line);
    if (!m) return true;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) return true;
    return ts >= cutoff;
  });
}
