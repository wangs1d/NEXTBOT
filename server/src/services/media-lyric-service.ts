import { searchNeteaseSongs } from "./media-music-service.js";
import type { MediaTrack } from "./media-music-service.js";

/**
 * 按本地播放器上报的曲目元数据，去网易云匹配歌词（LRC 逐行时间轴）。
 *
 * 匹配规矩（宁可没歌词，也不拿别人的歌词硬套）：
 *   - 标题必须归一化后一致（去括号、全半角、空白与标点）
 *   - 歌手任一分段一致才算同一版本；歌手对不上直接判未命中
 *   - 同名同歌手多版本时用时长挑最接近的
 *   - 标题带 Inst/伴奏/纯音乐 等标记时直接判「无歌词」，不发搜索
 *
 * 上游通道与 media 搜索共用 {@link searchNeteaseSongs}，歌词接口走
 * /api/song/lyric/v1（匿名可拿到绝大多数曲目的 LRC/TLYRIC/YRC 逐字歌词）。
 */

const NETEASE_LYRIC_ENDPOINT = "https://music.163.com/api/song/lyric/v1";

/** 逐字时间轴上的一个唱段（字/词/音节，取决于歌曲的逐字歌词粒度）。 */
export interface LyricChar {
  /** 相对曲目开始的毫秒数。 */
  t: number;
  /** 持续时长（毫秒），<=0 表示无时长信息。 */
  d: number;
  text: string;
}

/** 歌词行：t 为相对曲目开始的毫秒数。 */
export interface LyricLine {
  t: number;
  text: string;
  /** 同时间轴的翻译（网易云 tlyric 存在时合并）。 */
  tr?: string;
  /** 逐字时间轴；没有逐字歌词的歌不填，客户端按行内插值兜底。 */
  chars?: LyricChar[];
}

export interface LyricLookupInput {
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
}

export interface LyricLookupResult {
  matched: boolean;
  /** 未命中 / 无歌词时的如实原因；命中时无此字段。 */
  reason?: string;
  track?: MediaTrack;
  lines: LyricLine[];
  translated: boolean;
  /** 命中且拿到了逐字时间轴（lines[].chars）时为 true。 */
  wordTimed?: boolean;
  source: "netease";
}

const LYRICS_CACHE_MAX = 300;
const LYRICS_CACHE_TTL_MS = 30 * 60_000;

interface LyricsCacheEntry {
  result: LyricLookupResult;
  cachedAt: number;
}

const lyricsCache = new Map<string, LyricsCacheEntry>();

function getCachedLyrics(key: string): LyricLookupResult | null {
  const entry = lyricsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LYRICS_CACHE_TTL_MS) {
    lyricsCache.delete(key);
    return null;
  }
  // LRU：命中后挪到队尾
  lyricsCache.delete(key);
  lyricsCache.set(key, entry);
  return entry.result;
}

function setCachedLyrics(key: string, result: LyricLookupResult): void {
  lyricsCache.set(key, { result, cachedAt: Date.now() });
  while (lyricsCache.size > LYRICS_CACHE_MAX) {
    const oldest = lyricsCache.keys().next().value;
    if (oldest === undefined) break;
    lyricsCache.delete(oldest);
  }
}

const BRACKET_GROUP = /[（(\[【][^）)\]】]*[）)\]】]/g;
const MATCH_NOISE = /[\s\-_·・.,，。!！?？:：;；'"“”‘’()（）[\]【】《》<>]/g;
const INSTRUMENTAL_MARKER =
  /\b(inst|instrumental|karaoke)\b|伴奏|纯音乐|off ?vocal|无人声|无词/i;

/** 歌词开头的署名行（作词/作曲/制作人等），不能当歌词显示。 */
const CREDIT_LINE =
  /^(作词|作曲|编曲|制作|监制|出品|录音|混音|母带|吉他|贝斯|鼓|和声|弦乐|发行|策划|统筹|美术|设计|OP|SP)[^:：]{0,8}[:：]/i;

function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(MATCH_NOISE, "");
}

/** 标题用于匹配/搜索的形态：去掉括号段（版本标记、影视副标题等）后归一化。 */
function titleCore(title: string): string {
  return title.replace(BRACKET_GROUP, "").trim();
}

function artistTokens(artist: string): string[] {
  return artist
    .split(/[/&,，、;；]|\bfeat\.?|\bft\.?|\bvs\.?/i)
    .map((part) => normalizeForMatch(part))
    .filter((part) => part.length > 0);
}

function titleMatches(candidate: string, target: string): boolean {
  const a = normalizeForMatch(candidate.replace(BRACKET_GROUP, ""));
  const b = normalizeForMatch(target.replace(BRACKET_GROUP, ""));
  if (!a || !b) return false;
  if (a === b) return true;
  // 允许一方是另一方的前后缀扩展（如「歌名」vs「歌名Live」），但拒绝过于宽泛的短标题
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 3 && longer.includes(shorter);
}

function artistsOverlap(local: string, candidate: string): boolean {
  const left = artistTokens(local);
  const right = artistTokens(candidate);
  if (left.length === 0 || right.length === 0) return false;
  return left.some((a) =>
    right.some((b) => a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)))),
  );
}

/**
 * 解析标准 LRC。支持一行多时间戳、[offset:±ms]、`[mm:ss.xx]` 与 `[mm:ss:xx]`；
 * 元信息行（[ti:]/[ar:] 等）与非歌词行自动丢弃。
 */
export function parseLrc(raw: string): LyricLine[] {
  if (!raw) return [];
  let offsetMs = 0;
  const offsetMatch = raw.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  if (offsetMatch) offsetMs = Number(offsetMatch[1]) || 0;

  const lines: LyricLine[] = [];
  const stampPattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of raw.split(/\r?\n/)) {
    stampPattern.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = stampPattern.exec(rawLine)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ?? "0";
      // 两位是厘秒、三位是毫秒（网易云用两位）
      const ms =
        fraction.length === 3
          ? Number(fraction)
          : fraction.length === 2
            ? Number(fraction) * 10
            : Number(fraction) * 100;
      stamps.push(minutes * 60_000 + seconds * 1000 + ms);
    }
    if (stamps.length === 0) continue;

    const text = rawLine
      .replace(stampPattern, "")
      .replace(/<[^>]*>/g, "")
      .trim();
    if (!text || CREDIT_LINE.test(text)) continue;

    for (const t of stamps) {
      lines.push({ t: t + offsetMs, text });
    }
  }

  lines.sort((a, b) => a.t - b.t);
  return lines;
}

/**
 * 解析网易云 YRC 逐字歌词。每行形如：
 *   `[行起点ms,行长ms](字起点ms,字时长ms,0)字(字起点ms,字时长ms,0)字…`
 * 字起点为绝对毫秒。文件里混在前面的「作词/作曲」JSON 行没有方括号时间戳，
 * 自然跳过。
 */
export function parseYrc(raw: string): Array<{ t: number; chars: LyricChar[] }> {
  if (!raw) return [];
  const result: Array<{ t: number; chars: LyricChar[] }> = [];
  const marker = /\((\d+),(\d+),\d+\)/g;

  for (const rawLine of raw.split(/\r?\n/)) {
    const head = rawLine.match(/^\[(\d+),\d+\]/);
    if (!head) continue;
    const lineStart = Number(head[1]);
    const body = rawLine.slice(head[0].length);

    const chars: LyricChar[] = [];
    let pending: { t: number; d: number } | null = null;
    let textStart = 0;
    marker.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = marker.exec(body)) !== null) {
      if (pending) {
        const text = body.slice(textStart, match.index);
        if (text) chars.push({ t: pending.t, d: pending.d, text });
      }
      pending = { t: Number(match[1]), d: Number(match[2]) };
      textStart = match.index + match[0].length;
    }
    if (pending) {
      const text = body.slice(textStart);
      if (text) chars.push({ t: pending.t, d: pending.d, text });
    }

    trimCharText(chars);
    if (chars.length > 0) result.push({ t: lineStart, chars });
  }

  return result;
}

/** 去掉逐字时间轴首尾的空白唱段，避免整行测量宽度被空格撑大。 */
function trimCharText(chars: LyricChar[]): void {
  while (chars.length > 0 && chars[0]!.text.trim() === "") chars.shift();
  while (chars.length > 0 && chars[chars.length - 1]!.text.trim() === "") chars.pop();
  if (chars.length > 0) chars[0]!.text = chars[0]!.text.replace(/^\s+/, "");
  if (chars.length > 0) {
    const last = chars[chars.length - 1]!;
    last.text = last.text.replace(/\s+$/, "");
  }
}

/**
 * 把逐字时间轴按行起点挂到 LRC 行上（网易云 LRC 与 YRC 的同一行起点常有
 * 几十毫秒差，取 600ms 内最近的一行）。挂上后行文本改用逐字文本，保证
 * 客户端按字测量宽度时与显示文本完全一致。
 */
function attachYrc(lines: LyricLine[], yrcRaw: string): boolean {
  const yrcLines = parseYrc(yrcRaw);
  if (yrcLines.length === 0) return false;

  const used = new Set<number>();
  let attached = 0;
  for (const line of lines) {
    let best = -1;
    let bestDiff = 600;
    for (let i = 0; i < yrcLines.length; i++) {
      if (used.has(i)) continue;
      const diff = Math.abs(yrcLines[i]!.t - line.t);
      if (diff <= bestDiff) {
        best = i;
        bestDiff = diff;
      }
    }
    if (best < 0) continue;

    const yrc = yrcLines[best]!;
    const joined = yrc.chars.map((c) => c.text).join("");
    if (!joined) continue;

    used.add(best);
    line.chars = yrc.chars;
    line.text = joined;
    attached++;
  }
  return attached > 0;
}

function mergeTranslation(lines: LyricLine[], translationRaw: string): boolean {
  const translated = parseLrc(translationRaw);
  if (translated.length === 0) return false;
  const byTime = new Map<number, string>();
  for (const line of translated) byTime.set(line.t, line.text);
  let merged = false;
  for (const line of lines) {
    const tr = byTime.get(line.t);
    if (tr && tr !== line.text) {
      line.tr = tr;
      merged = true;
    }
  }
  return merged;
}

interface NeteaseLyricPayload {
  code?: number;
  nolyric?: boolean;
  uncollected?: boolean;
  lrc?: { lyric?: string };
  klyric?: { lyric?: string };
  tlyric?: { lyric?: string };
  yrc?: { lyric?: string };
}

/** v1 接口参数：cp=true 返回富文本；lv/kv/tv/rv/yv/ytv/yrv 全 0 才带 yrc。 */
const LYRIC_V1_QUERY = "cp=true&lv=0&kv=0&tv=0&rv=0&yv=0&ytv=0&yrv=0";

async function fetchLyricById(
  id: string,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; lyric: string; translation: string; yrc: string }
  | { ok: false; reason: string }
> {
  const url = `${NETEASE_LYRIC_ENDPOINT}?id=${encodeURIComponent(id)}&${LYRIC_V1_QUERY}`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Nextbot/1.0)",
        Accept: "application/json",
        Referer: "https://music.163.com",
      },
    });
    if (!res.ok) {
      return { ok: false, reason: `歌词请求失败：HTTP ${res.status}` };
    }
    const data = (await res.json()) as NeteaseLyricPayload;
    if (data.code !== 200) {
      return { ok: false, reason: `歌词返回异常：code=${data.code ?? "unknown"}` };
    }
    if (data.nolyric || data.uncollected) {
      return { ok: false, reason: "这首歌没有收录歌词" };
    }
    const lyric = data.lrc?.lyric?.trim() ?? "";
    if (!lyric) {
      return { ok: false, reason: "这首歌没有收录歌词" };
    }
    return {
      ok: true,
      lyric,
      translation: data.tlyric?.lyric?.trim() ?? "",
      yrc: data.yrc?.lyric?.trim() ?? "",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `歌词调用异常：${msg}` };
  }
}

/**
 * 按本地曲目元数据解析网易云歌词。
 *
 * @param fetchImpl 可注入 fetch（测试 mock 用）；默认全局 fetch。
 */
export async function resolveLyricByMeta(
  input: LyricLookupInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LyricLookupResult> {
  const title = input.title.trim();
  if (!title) {
    return { matched: false, reason: "标题不能为空", lines: [], translated: false, source: "netease" };
  }

  const artist = (input.artist ?? "").trim();
  const cacheKey = `${normalizeForMatch(title)}|${normalizeForMatch(artist)}`;
  const cached = getCachedLyrics(cacheKey);
  if (cached) return cached;

  const fail = (reason: string): LyricLookupResult => {
    const result: LyricLookupResult = {
      matched: false,
      reason,
      lines: [],
      translated: false,
      source: "netease",
    };
    setCachedLyrics(cacheKey, result);
    return result;
  };

  if (INSTRUMENTAL_MARKER.test(title)) {
    return fail("纯音乐/伴奏版本，没有歌词");
  }

  const query = titleCore(title) || title;
  const searchRes = await searchNeteaseSongs(query, 20, fetchImpl);
  if (!searchRes.ok) {
    return fail(searchRes.error);
  }

  const sameTitle = searchRes.tracks.filter((track) => titleMatches(track.name, title));
  if (sameTitle.length === 0) {
    return fail("未找到同名曲目");
  }

  const sameArtist = artist ? sameTitle.filter((track) => artistsOverlap(artist, track.artist)) : sameTitle;
  if (sameArtist.length === 0) {
    return fail("未找到同一歌手的版本");
  }

  const durationSec = Number(input.durationSec ?? 0);
  // 时长差太多说明是另一个版本（加速版/剪辑版/现场版），歌词时间轴套上去
  // 只会全程错位；宁可如实报未命中，也不硬套（LRCLIB / NeriPlayer 同样做法）。
  const MAX_MATCH_DURATION_DIFF_SEC = 10;
  const eligible =
    durationSec > 0
      ? sameArtist.filter(
          (track) =>
            Math.abs(track.durationSec - durationSec) <= MAX_MATCH_DURATION_DIFF_SEC,
        )
      : sameArtist;
  if (eligible.length === 0) {
    return fail("未找到时长匹配的版本");
  }
  const ranked = [...eligible].sort((a, b) => {
    if (!durationSec) return a.durationSec - b.durationSec;
    return Math.abs(a.durationSec - durationSec) - Math.abs(b.durationSec - durationSec);
  });
  const track = ranked[0]!;

  const lyricRes = await fetchLyricById(track.id, fetchImpl);
  if (!lyricRes.ok) {
    return fail(lyricRes.reason);
  }

  const lines = parseLrc(lyricRes.lyric);
  if (lines.length === 0) {
    return fail("这首的歌词没有逐句时间轴，无法同步滚动");
  }

  // 有 YRC 逐字歌词就把词级时间轴挂到对应行上；没有的歌保持行级时间轴，
  // 客户端回退到按行内插值，而不是拿别人的节奏硬套。
  const wordTimed = attachYrc(lines, lyricRes.yrc);

  const translated = lyricRes.translation ? mergeTranslation(lines, lyricRes.translation) : false;
  const result: LyricLookupResult = {
    matched: true,
    track,
    lines,
    translated,
    wordTimed,
    source: "netease",
  };
  setCachedLyrics(cacheKey, result);
  return result;
}
