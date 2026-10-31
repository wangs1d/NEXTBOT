/**
 * 视频抓取服务 - 国内平台适配层
 *
 * 设计目标：
 *   - 适配器模式：每个平台独立适配器，统一接口，按需扩展
 *   - 优先支持抖音、小红书、B站等国内平台；不绑定单一平台
 *   - 不依赖 youtube-dl/yt-dlp 等外部下载器
 *   - 抓取链路：mcporter MCP → 平台公开接口/网页解析（兜底）
 *   - 返回标准化信息：标题、作者、时长、描述、播放页、封面
 *
 * 说明：各平台均有反爬机制，抓取为尽力而为（best-effort）：
 *   能解析出视频流/封面就返回可播放地址，否则返回播放页链接引导跳转。
 */

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { serverRoot } from "../config/paths.js";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** 项目根目录（mcporter 需在此目录执行才能发现 config/mcporter.json 中的 MCP server） */
const PROJECT_ROOT_DIR = serverRoot();

/** 标准化视频信息 */
export type VideoInfo = {
  provider: string;
  platform: "douyin" | "xiaohongshu" | "bilibili" | "other";
  title: string;
  author: string;
  durationSeconds?: number;
  description: string;
  /** 可直接播放的视频流地址（尽力而为，可能为空） */
  videoUrl?: string;
  /** 封面图地址（尽力而为，可能为空） */
  thumbnailUrl?: string;
  /** 原始播放页链接 */
  playPageUrl: string;
  notes: string[];
};

/** 视频抓取适配器接口 */
export interface VideoGrabAdapter {
  /** 该适配器负责的平台名 */
  readonly platform: VideoInfo["platform"];
  /** 是否匹配该平台的 URL */
  match(url: string): boolean;
  /** 抓取视频信息 */
  grab(url: string): Promise<VideoInfo>;
}

/** 命令执行结果 */
type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** 浏览器 UA（供平台网页/接口请求使用） */
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class VideoGrabService {
  private readonly adapters: VideoGrabAdapter[] = [];

  constructor() {
    // 按优先级注册适配器（国内平台优先）
    this.adapters.push(new DouyinAdapter());
    this.adapters.push(new XiaohongshuAdapter());
    this.adapters.push(new BilibiliAdapter());
    this.adapters.push(new GenericPlatformAdapter());
  }

  /** 列出已注册平台适配器 */
  listPlatforms(): VideoInfo["platform"][] {
    return this.adapters.filter((a) => a.platform !== "other").map((a) => a.platform);
  }

  /** 根据URL自动选择适配器抓取 */
  async grab(url: string): Promise<VideoInfo> {
    const cleanUrl = String(url ?? "").trim();
    if (!cleanUrl) {
      return emptyVideo("none", "other", "url 不能为空");
    }
    for (const adapter of this.adapters) {
      if (adapter.match(cleanUrl)) {
        try {
          return await adapter.grab(cleanUrl);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return {
            ...emptyVideo(adapter.platform, adapter.platform, `抓取失败: ${errMsg}`),
            playPageUrl: cleanUrl,
          };
        }
      }
    }
    return {
      ...emptyVideo("generic", "other", "暂不支持该平台视频抓取，请使用原链接打开播放"),
      playPageUrl: cleanUrl,
    };
  }

  /** 检查服务健康状态（mcporter 是否可用） */
  async checkHealth(): Promise<{
    ok: boolean;
    platforms: string[];
    mcporterAvailable: boolean;
    notes: string[];
  }> {
    const notes: string[] = [];
    let mcporterOk = false;
    try {
      const run = await this.runMcporter(["--version"], 5000);
      if (run.ok) {
        mcporterOk = true;
        notes.push(`mcporter 可用: ${(run.stdout || run.stderr || "ok").split(/\r?\n/)[0]}`);
      } else {
        notes.push(`mcporter 不可用: ${run.stderr || run.stdout}`);
      }
    } catch {
      notes.push("mcporter 未安装或不在 PATH");
    }
    return {
      ok: mcporterOk,
      platforms: this.listPlatforms(),
      mcporterAvailable: mcporterOk,
      notes,
    };
  }

  // ---- 共享底层工具（供各适配器使用）----

  private async runMcporter(args: string[], timeoutMs: number): Promise<CommandResult> {
    const { bin, argsPrefix } = resolveMcporterBin();
    try {
      const { stdout, stderr } = await execFileAsync(bin, [...argsPrefix, ...args], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
        cwd: PROJECT_ROOT_DIR,
      });
      return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
      const code = typeof err.code === "number" ? err.code : 1;
      if (err.code === "ENOENT") {
        return { ok: false, stdout: "", stderr: `${bin} 未安装或不在 PATH 中`, code };
      }
      return {
        ok: false,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? "命令执行失败"),
        code,
      };
    }
  }

  async fetchText(url: string, timeoutMs = 12_000, referer?: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "user-agent": WEB_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      };
      if (referer) headers.referer = referer;
      const response = await fetch(url, { signal: controller.signal, headers, redirect: "follow" });
      if (!response.ok) return "";
      return await response.text();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
}

// ===================== 抖音适配器 =====================

class DouyinAdapter implements VideoGrabAdapter {
  readonly platform = "douyin" as const;

  match(url: string): boolean {
    return /(?:^|\.)douyin\.com|iesdouyin\.com/i.test(url);
  }

  async grab(url: string): Promise<VideoInfo> {
    // 1) 优先 McpClientService（yby6 stdio 直连，生产可用通道）→ mcporter CLI 兜底（yby6 单工具适配所有平台）
    const mcpRun = await callMcpClientParser(url);
    const run = mcpRun.ok ? mcpRun : await callMcporter(["yby6-video.share_url_parse_tool_wrapper"], url);
    if (run.ok) {
      const parsed = parseVideoJson(run.stdout);
      if (parsed && (parsed.title || parsed.video_url)) {
        return {
          provider: "douyin-mcporter",
          platform: "douyin",
          title: parsed.title ?? "",
          author: parsed.author ?? "",
          durationSeconds: parsed.duration,
          description: parsed.description ?? "",
          videoUrl: parsed.video_url,
          thumbnailUrl: parsed.cover_url ?? parsed.thumbnail_url,
          playPageUrl: url,
          notes: [],
        };
      }
    }

    // 2) 网页解析（best-effort）：window._ROUTER_DATA 中的视频信息
    const html = await fetchHtmlFor(this, url);
    if (html) {
      const info = parseDouyinRouterData(html);
      if (info) {
        return {
          provider: "douyin-web",
          platform: "douyin",
          title: info.title ?? "",
          author: info.author ?? "",
          description: "",
          videoUrl: info.videoUrl,
          thumbnailUrl: info.coverUrl,
          playPageUrl: url,
          notes: ["已从网页解析出视频信息；若无法播放请点击播放页链接"],
        };
      }
    }

    return {
      ...emptyVideo("douyin", "douyin", run.ok ? "抖音网页解析未命中视频数据" : "MCP/网页解析均失败，请点击原链接播放"),
      playPageUrl: url,
    };
  }
}

// ===================== 小红书适配器 =====================

class XiaohongshuAdapter implements VideoGrabAdapter {
  readonly platform = "xiaohongshu" as const;

  match(url: string): boolean {
    return /(?:^|\.)xiaohongshu\.com|xhslink\.com/i.test(url);
  }

  async grab(url: string): Promise<VideoInfo> {
    // 1) 优先 McpClientService（yby6 stdio 直连，生产可用通道）→ mcporter CLI 兜底（yby6 单工具适配所有平台）
    const mcpRun = await callMcpClientParser(url);
    const run = mcpRun.ok ? mcpRun : await callMcporter(["yby6-video.share_url_parse_tool_wrapper"], url);
    if (run.ok) {
      const parsed = parseVideoJson(run.stdout);
      if (parsed && (parsed.title || parsed.video_url)) {
        return {
          provider: "xiaohongshu-mcporter",
          platform: "xiaohongshu",
          title: parsed.title ?? "",
          author: parsed.author ?? "",
          durationSeconds: parsed.duration,
          description: parsed.description ?? parsed.desc ?? "",
          videoUrl: parsed.video_url,
          thumbnailUrl: parsed.cover_url ?? parsed.thumbnail_url,
          playPageUrl: url,
          notes: [],
        };
      }
    }

    // 2) 网页解析（best-effort）：window.__INITIAL_STATE__ 中的 note 视频数据
    const html = await fetchHtmlFor(this, url);
    if (html) {
      const info = parseXiaohongshuInitialState(html);
      if (info) {
        return {
          provider: "xiaohongshu-web",
          platform: "xiaohongshu",
          title: info.title ?? "",
          author: info.author ?? "",
          description: "",
          videoUrl: info.videoUrl,
          thumbnailUrl: info.coverUrl,
          playPageUrl: url,
          notes: ["已从网页解析出笔记视频；若无法播放请点击播放页链接"],
        };
      }
    }

    return {
      ...emptyVideo("xiaohongshu", "xiaohongshu", run.ok ? "小红书网页解析未命中视频数据" : "MCP/网页解析均失败，请点击原链接播放"),
      playPageUrl: url,
    };
  }
}

// ===================== Bilibili 适配器 =====================

class BilibiliAdapter implements VideoGrabAdapter {
  readonly platform = "bilibili" as const;

  match(url: string): boolean {
    return /(?:^|\.)bilibili\.com|b23\.tv/i.test(url);
  }

  async grab(url: string): Promise<VideoInfo> {
    // 1) 优先 mcporter MCP
    const run = await callMcporter(["bilibili.get_video", "bilibili.get_video_info"], url);
    if (run.ok) {
      const parsed = parseVideoJson(run.stdout);
      if (parsed && (parsed.title || parsed.video_url)) {
        return {
          provider: "bilibili-mcporter",
          platform: "bilibili",
          title: parsed.title ?? "",
          author: parsed.author ?? "",
          durationSeconds: parsed.duration,
          description: parsed.description ?? "",
          videoUrl: parsed.video_url,
          thumbnailUrl: parsed.cover_url ?? parsed.thumbnail_url,
          playPageUrl: url,
          notes: [],
        };
      }
    }

    // 2) 公开接口兜底：api.bilibili.com 视频信息接口（无需登录，较可靠）
    //    搜索源返回的 B 站链接多为 av 号格式（/video/avxxxx），view 接口 aid= 同样可用。
    const { bvid, aid } = extractBilibiliId(url);
    if (bvid || aid) {
      const idQuery = bvid ? `bvid=${bvid}` : `aid=${aid}`;
      const apiUrl = `https://api.bilibili.com/x/web-interface/view?${idQuery}`;
      const text = await this.fetchViaService(apiUrl, 12_000);
      const json = tryParseJson<BilibiliViewResponse>(text);
      const data = json?.data;
      if (data) {
        // 免登录播放流解析：playurl platform=html5 直出 mp4 durl（无需登录，清晰度
        // 受限但可内联播放）。这是 video.find 内容搜索的主力可播源——搜索候选大头
        // 是 B 站页，此前只回信息不出流，整条「按内容找视频」链路会 playable=0。
        // 流 CDN 校验 Referer（须 bilibili.com 来源）：代理回传时带 playPageUrl 作 referer。
        let videoUrl: string | undefined;
        const cid = typeof data.cid === "number" ? data.cid : 0;
        // playurl 接口不认 aid=（-400），一律用 view 响应回传的 bvid 调用
        const playBvid = typeof data.bvid === "string" && data.bvid ? data.bvid : bvid;
        if (cid > 0 && playBvid) {
          videoUrl = await this.resolveBilibiliStream(playBvid, cid);
        }
        return {
          provider: "bilibili-api",
          platform: "bilibili",
          title: data.title ?? "",
          author: data.owner?.name ?? "",
          durationSeconds: typeof data.duration === "number" ? data.duration : undefined,
          description: String(data.desc ?? "").slice(0, 5000),
          videoUrl,
          thumbnailUrl: data.pic ?? undefined,
          playPageUrl: url,
          notes: videoUrl
            ? []
            : ["已从 B站公开接口获取视频信息；视频流解析未命中（可能受限），已保留播放页链接"],
        };
      }
    }

    return {
      ...emptyVideo("bilibili", "bilibili", run.ok ? "B站接口解析失败" : "mcporter/接口均失败，请点击原链接播放"),
      playPageUrl: url,
    };
  }

  /**
   * 免登录播放流解析：playurl(platform=html5) 直出 mp4 durl。
   *
   * video.find 的主力可播源（搜索候选大头是 B 站页），出流失败整条「按内容找视频」
   * 链路就退化成只回链接——所以这里做两级韧性：
   *   1) 清晰度档位降级：qn=32(480P) → 16(360P)，低档位 Availability 更高；
   *   2) 每档一次退避重试（并发批里偶发 -412/超时会白掉一批候选）。
   */
  private async resolveBilibiliStream(bvid: string, cid: number): Promise<string | undefined> {
    for (const qn of [32, 16]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
        const playApi =
          `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}` +
          `&platform=html5&high_quality=1`;
        const playText = await this.fetchViaService(playApi, 10_000);
        const playJson = tryParseJson<{ code?: number; data?: { durl?: Array<{ url?: string }> } }>(playText);
        if (playJson?.code !== 0) continue;
        const firstUrl = playJson.data?.durl?.[0]?.url;
        if (typeof firstUrl === "string" && firstUrl) return firstUrl;
      }
    }
    return undefined;
  }

  private async fetchViaService(url: string, timeoutMs: number): Promise<string> {
    // 通过外层服务实例的 fetchText 复用（由服务构造时注入 this）
    // 这里直接调用共享实现，避免重复
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": WEB_USER_AGENT,
          referer: "https://www.bilibili.com",
          accept: "application/json,text/plain,*/*",
        },
        redirect: "follow",
      });
      if (!response.ok) return "";
      return await response.text();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
}

// ===================== 通用适配器（任意网页视频） =====================

/**
 * 通用兜底适配器：抓取「任意网页」中可播放的视频。
 *
 * 这是适配层的通用能力——不绑定任何平台，agent 从网络上得到的任何含视频的页面，
 * 都能尽力解析出可播放的视频流地址：
 *   1. <meta property="og:video"> / og:video:url / og:video:secure_url
 *   2. <video> 标签内的 <source src> 与 video[src]
 *   3. <meta name="twitter:player:stream">
 *   4. 页面内 JSON-LD (VideoObject contentUrl / embedUrl)
 * 抖音/小红书/B站等平台只是"高质量视频来源"，通用解析兜底保证覆盖面。
 */
class GenericPlatformAdapter implements VideoGrabAdapter {
  readonly platform = "other" as const;

  match(_url: string): boolean {
    return true; // 兜底匹配任何 URL
  }

  async grab(url: string): Promise<VideoInfo> {
    const html = await fetchHtmlFor(this, url);
    if (!html) {
      return {
        ...emptyVideo("generic", "other", "无法读取该网页，可能被反爬拦截，请点击原链接播放"),
        playPageUrl: url,
      };
    }

    const title =
      extractMeta(html, "og:title") ??
      extractMeta(html, "twitter:title") ??
      extractTitleTag(html);
    const videoUrl =
      extractMeta(html, "og:video") ??
      extractMeta(html, "og:video:url") ??
      extractMeta(html, "og:video:secure_url") ??
      extractTwitterPlayerStream(html) ??
      extractVideoTagSrc(html) ??
      extractJsonLdVideoUrl(html);
    const thumbnailUrl =
      extractMeta(html, "og:image") ??
      extractMeta(html, "twitter:image");

    if (!videoUrl) {
      return {
        provider: "generic",
        platform: "other",
        title: title ?? "",
        author: "",
        description: "",
        playPageUrl: url,
        notes: ["未在该网页中找到可提取的视频流（可能需登录/播放器加密），请点击原链接播放"],
      };
    }

    return {
      provider: "generic-web",
      platform: "other",
      title: title ?? "",
      author: "",
      description: "",
      videoUrl: absolutizeUrl(videoUrl, url),
      thumbnailUrl: thumbnailUrl ? absolutizeUrl(thumbnailUrl, url) : undefined,
      playPageUrl: url,
      notes: ["已从网页提取到视频流地址，可在前端直接播放"],
    };
  }
}

// ===================== 共享工具函数 =====================

function emptyVideo(
  provider: string,
  platform: VideoInfo["platform"],
  note: string,
): VideoInfo {
  return {
    provider,
    platform,
    title: "",
    author: "",
    description: "",
    playPageUrl: "",
    notes: [note],
  };
}

/** 定位 mcporter 可执行入口（Windows 上优先 node + cli.js，避免 PATH/.cmd 解析问题） */
function resolveMcporterBin(): { bin: string; argsPrefix: string[] } {
  // 1) 显式配置优先
  const explicit = process.env.MCPORTER_BIN?.trim();
  if (explicit) {
    if (explicit.endsWith(".js")) {
      return { bin: "node", argsPrefix: [explicit] };
    }
    return { bin: explicit, argsPrefix: [] };
  }
  // 2) npm 全局安装探测（Windows 常见路径）
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const npmCli = `${home}/AppData/Roaming/npm/node_modules/mcporter/dist/cli.js`;
  const fallbackCli = `${home}/.npm-global/lib/node_modules/mcporter/dist/cli.js`;
  if (home) {
    return { bin: "node", argsPrefix: [npmCli] };
  }
  if (fallbackCli) {
    return { bin: "node", argsPrefix: [fallbackCli] };
  }
  // 3) 兜底走 PATH
  return { bin: "mcporter", argsPrefix: [] };
}

/** 依次尝试 mcporter 调用 selector（格式：call <server.tool> url=<url>），命中返回 stdout */
async function callMcporter(
  toolNames: string[],
  url: string,
): Promise<{ ok: true; stdout: string } | { ok: false; note: string }> {
  const { bin, argsPrefix } = resolveMcporterBin();
  for (const toolName of toolNames) {
    try {
      const { stdout } = await execFileAsync(bin, [...argsPrefix, "call", toolName, `url=${url}`], {
        timeout: 20_000,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
        cwd: PROJECT_ROOT_DIR,
      });
      const out = String(stdout ?? "").trim();
      if (out) return { ok: true, stdout: out };
    } catch {
      // 尝试下一个工具名
    }
  }
  return { ok: false, note: "mcporter 调用失败，请确认已配置对应平台 MCP server" };
}

/** 让适配器复用服务的 fetchText（通过服务引用调用） */
async function fetchHtmlFor(adapter: VideoGrabAdapter, url: string): Promise<string> {
  const service = currentServiceRef;
  if (!service) return "";
  return service.fetchText(url, 12_000);
}

// 简单引用传递：VideoGrabService 构造时把自身暴露给共享函数
let currentServiceRef: VideoGrabService | null = null;

/** 由 create-app-services 在构造后调用一次，让适配器可复用服务的 HTTP 能力 */
export function setVideoGrabServiceRef(service: VideoGrabService): void {
  currentServiceRef = service;
}

// ---- McpClientService 直连通道（2026-10-02 根修）----
// 此前适配器只走 mcporter CLI，但生产机未装 mcporter → yby6 MCP 通道恒空转，
// 网页兜底又被反爬挡 → video.grab 恒失败。McpClientService（stdio 直连
// tools/mcp/yby6-video venv）才是项目内真正可用的 MCP 通道，优先走它。

type McpClientLike = {
  callTool: (
    serverAlias: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
};

let currentMcpClientRef: McpClientLike | null = null;

/** 由 create-app-services 在 McpClientService 装配后注入（MCP 不可用时可传 null） */
export function setVideoGrabMcpClientRef(client: McpClientLike | null): void {
  currentMcpClientRef = client;
}

/** 经 McpClientService 调 yby6 解析工具；命中时把结果对象伪装成 stdout 供 parseVideoJson 复用。
 * 上游拉平台分享页存在间歇性失败（code!==200，如抖音偶发不下发 _ROUTER_DATA），做一次退避重试。 */
async function callMcpClientParser(
  url: string,
): Promise<{ ok: true; stdout: string } | { ok: false; note: string }> {
  if (!currentMcpClientRef) return { ok: false, note: "McpClientService 未注入" };
  const attempt = async (): Promise<{ ok: boolean; result: Record<string, unknown> }> => {
    try {
      return await currentMcpClientRef!.callTool(
        "yby6-video",
        "share_url_parse_tool_wrapper",
        { url },
        30_000,
      );
    } catch (e) {
      return { ok: false, result: { error: e instanceof Error ? e.message : String(e) } };
    }
  };
  const failed = (r: { ok: boolean; result: Record<string, unknown> }): boolean => {
    if (!r.ok) return true;
    const code = (r.result as { code?: unknown }).code;
    return typeof code === "number" && code !== 200;
  };
  let res = await attempt();
  if (failed(res)) {
    await new Promise((r) => setTimeout(r, 1_200));
    res = await attempt();
  }
  if (!res.ok) return { ok: false, note: `MCP 调用失败: ${JSON.stringify(res.result).slice(0, 160)}` };
  return { ok: true, stdout: JSON.stringify(res.result) };
}

/** 解析 mcporter 返回的视频 JSON（容错：尝试多种字段名） */
function parseVideoJson(stdout: string): {
  title?: string;
  author?: string;
  duration?: number;
  description?: string;
  video_url?: string;
  cover_url?: string;
  thumbnail_url?: string;
  desc?: string;
} | null {
  try {
    const parsed = JSON.parse(stdout);
    let obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== "object") return null;
    let r = obj as Record<string, unknown>;
    // yby6 MCP 返回格式: { code: 200, msg: "解析成功", data: { video_url, cover_url, title, author: {...}, ... } }
    // 命中 data 包装时，优先以 data 作为字段来源；code !== 200 视为失败
    if (
      r &&
      typeof r === "object" &&
      "code" in r &&
      r.data &&
      typeof r.data === "object" &&
      !Array.isArray(r.data)
    ) {
      if (Number(r.code) !== 200) return null;
      r = r.data as Record<string, unknown>;
    }
    const num = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const videoUrl =
      str(r.video_url) ??
      str(r.videoUrl) ??
      str(r.play_addr) ??
      str(r.playUrl) ??
      str(r.url);
    const coverUrl =
      str(r.cover_url) ??
      str(r.coverUrl) ??
      str(r.thumbnail_url) ??
      str(r.thumbnailUrl) ??
      str(r.cover);
    if (!videoUrl && !str(r.title)) return null;
    // yby6 的 author 是 { name, uid, avatar } 对象
    const authorObj =
      r.author && typeof r.author === "object"
        ? (r.author as Record<string, unknown>)
        : null;
    return {
      title: str(r.title),
      author:
        str(r.author) ??
        str(authorObj?.name) ??
        str(r.author_name) ??
        str(r.nickname) ??
        str(r.uploader),
      duration: num(r.duration) ?? num(r.durationSeconds) ?? num(r.duration_seconds),
      description: str(r.description) ?? str(r.desc),
      video_url: videoUrl,
      cover_url: coverUrl,
    };
  } catch {
    return null;
  }
}

/** 从 URL 中提取 B 站视频 id：BV 号或 av 号（搜索源返回的多为 av 号链接）。 */
function extractBilibiliId(url: string): { bvid?: string; aid?: string } {
  const bv = url.match(/[bB][vV][0-9A-Za-z]{8,}/);
  if (bv) return { bvid: bv[0] };
  const av = url.match(/\/video\/av(\d{6,})/i) ?? url.match(/[?&]aid=(\d{6,})/i);
  if (av) return { aid: av[1] };
  return {};
}

function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 解析抖音 window._ROUTER_DATA 中的视频信息 */
function parseDouyinRouterData(html: string): {
  title?: string;
  author?: string;
  videoUrl?: string;
  coverUrl?: string;
} | null {
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) return null;
  const data = tryParseJson<{ loaderData?: Record<string, unknown> }>(m[1]);
  if (!data?.loaderData) return null;
  const loader = data.loaderData;
  // 在 loaderData 中递归寻找 item_list（视频列表）
  const itemList = findDeep(loader, (v) =>
    Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] && "video" in (v[0] as object),
  ) as Array<Record<string, unknown>> | null;
  if (!itemList) return null;
  const item = itemList[0] as Record<string, unknown>;
  const video = (item.video ?? {}) as Record<string, unknown>;
  const author = (item.author ?? {}) as Record<string, unknown>;
  const cover = (video.cover ?? {}) as Record<string, unknown>;
  const playAddr = (video.play_addr ?? {}) as Record<string, unknown>;
  const urlList = Array.isArray(playAddr.url_list) ? playAddr.url_list : [];
  const coverList = Array.isArray(cover.url_list) ? cover.url_list : [];
  return {
    title: typeof item.desc === "string" ? item.desc : undefined,
    author: typeof author.nickname === "string" ? author.nickname : undefined,
    videoUrl: urlList[0] ? String(urlList[0]) : undefined,
    coverUrl: coverList[0] ? String(coverList[0]) : undefined,
  };
}

/** 解析小红书 window.__INITIAL_STATE__ 中的笔记视频信息 */
function parseXiaohongshuInitialState(html: string): {
  title?: string;
  author?: string;
  videoUrl?: string;
  coverUrl?: string;
} | null {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) return null;
  const data = tryParseJson<{ note?: Record<string, unknown> }>(m[1]);
  if (!data?.note) return null;
  const note = data.note;
  const video = (note.video ?? {}) as Record<string, unknown>;
  const media = (video.media ?? {}) as Record<string, unknown>;
  const stream = (media.stream ?? {}) as Record<string, unknown>;
  const h264 = Array.isArray(stream.h264) ? stream.h264 : [];
  // 取 h264 清晰度列表的第一项 masterUrl / backupUrls
  let videoUrl: string | undefined;
  for (const item of h264) {
    const o = item as Record<string, unknown>;
    const master = o.masterUrl ?? o.master_url;
    if (typeof master === "string" && master) {
      videoUrl = master;
      break;
    }
    const backup = Array.isArray(o.backupUrls) ? o.backupUrls[0] : undefined;
    if (typeof backup === "string" && backup) {
      videoUrl = backup;
      break;
    }
  }
  const cover = (note.cover ?? {}) as Record<string, unknown>;
  const coverInfo = Array.isArray(cover.infoList) ? cover.infoList : [];
  const coverUrl = coverInfo[0] ? String((coverInfo[0] as Record<string, unknown>).url ?? "") : undefined;
  const user = (note.user ?? {}) as Record<string, unknown>;
  return {
    title: typeof note.title === "string" ? note.title : undefined,
    author: typeof user.nickname === "string" ? user.nickname : undefined,
    videoUrl,
    coverUrl,
  };
}

/** 深度优先遍历查找满足条件的值 */
function findDeep(
  root: unknown,
  predicate: (value: unknown) => boolean,
): unknown {
  if (predicate(root)) return root;
  if (root && typeof root === "object") {
    for (const value of Object.values(root)) {
      const hit = findDeep(value, predicate);
      if (hit !== undefined && hit !== null) return hit;
    }
  }
  return null;
}

/** B站接口响应类型 */
type BilibiliViewResponse = {
  code?: number;
  data?: {
    title?: string;
    desc?: string;
    pic?: string;
    duration?: number;
    cid?: number;
    bvid?: string;
    owner?: { name?: string };
  };
};

// ===================== 通用网页视频解析辅助 =====================

/** 读取 <meta property="og:xxx"> 或 <meta name="twitter:xxx"> 的内容 */
function extractMeta(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
    "i",
  );
  let m = re.exec(html);
  if (!m) {
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`,
      "i",
    );
    m = re2.exec(html);
  }
  if (!m) return undefined;
  const value = decodeHtmlEntities(m[1]).trim();
  return value || undefined;
}

/** 提取 <title> 内容 */
function extractTitleTag(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const value = decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
  return value || undefined;
}

/** 提取 twitter:player:stream（HLS/MP4 流地址） */
function extractTwitterPlayerStream(html: string): string | undefined {
  return extractMeta(html, "twitter:player:stream");
}

/** 提取 <video> 标签内 <source src> 或 video[src] */
function extractVideoTagSrc(html: string): string | undefined {
  // 优先 <video><source src="...">
  const sourceRe =
    /<video[\s\S]*?<source[^>]+src=["']([^"']+)["']/i.exec(html);
  if (sourceRe) {
    const value = decodeHtmlEntities(sourceRe[1]).trim();
    if (value) return value;
  }
  // 其次 <video src="...">
  const videoRe = /<video[^>]+src=["']([^"']+)["']/i.exec(html);
  if (videoRe) {
    const value = decodeHtmlEntities(videoRe[1]).trim();
    if (value) return value;
  }
  return undefined;
}

/** 提取 JSON-LD 中的 VideoObject contentUrl / embedUrl */
function extractJsonLdVideoUrl(html: string): string | undefined {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1];
    const json = tryParseJson<unknown>(raw);
    const list = Array.isArray(json) ? json : json ? [json] : [];
    for (const entry of list) {
      const obj = entry as Record<string, unknown>;
      if (String(obj?.["@type"] ?? "").toLowerCase().includes("video")) {
        const contentUrl = obj["contentUrl"];
        const embedUrl = obj["embedUrl"];
        if (typeof contentUrl === "string" && contentUrl.trim()) {
          return contentUrl.trim();
        }
        if (typeof embedUrl === "string" && embedUrl.trim()) {
          return embedUrl.trim();
        }
      }
    }
  }
  return undefined;
}

/** 相对路径转绝对 URL */
function absolutizeUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
