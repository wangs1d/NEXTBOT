import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import type { Readable } from "node:stream";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { dirname, extname, join } from "path";

import type { WsConnectionRegistryLike } from "../host-types.js";
import { AgentWorldServerEventType } from "../protocol-world.js";
import { getDataDir } from "../config/data-dir.js";
import type { WorldService } from "./world-service.js";

export type SocialMediaType = "none" | "image" | "video";

export type SocialPostRow = {
  id: string;
  authorSessionId: string;
  text: string;
  mediaType: SocialMediaType;
  mediaUrl: string | null;
  createdAt: string;
};

export type SocialCommentRow = {
  id: string;
  postId: string;
  authorSessionId: string;
  text: string;
  createdAt: string;
};

export type SocialReportRow = {
  id: string;
  postId: string;
  reporterSessionId: string;
  reason: string;
  createdAt: string;
};

const MAX_POSTS = 400;
const MAX_COMMENTS_PER_POST = 80;
const MAX_REPORTS = 3000;
const PERSIST_DEBOUNCE_MS = 400;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const ALLOWED_IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const ALLOWED_VIDEO = new Set(["video/mp4", "video/webm"]);

type PersistedShape = {
  version: 2;
  posts: SocialPostRow[];
  comments: SocialCommentRow[];
  likes: Record<string, string[]>;
  reports: SocialReportRow[];
};

type RawPersisted = {
  version?: number;
  posts?: unknown;
  comments?: unknown;
  likes?: Record<string, unknown>;
  reports?: unknown;
};

function defaultPersistPath(): string {
  return join(getDataDir(), "agent-world-social-feed.json");
}

export function defaultSocialMediaRoot(): string {
  return join(getDataDir(), "social-media");
}

function isSafeHttpsMediaUrl(url: string): boolean {
  const u = url.trim();
  if (u.length < 12 || u.length > 2048) return false;
  if (!/^https:\/\//i.test(u)) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return false;
    if (!parsed.hostname || parsed.hostname === "localhost") return false;
    return true;
  } catch {
    return false;
  }
}

/** 本服务托管的媒体路径：`/world/social/media/<filename>` */
export function isServerSocialMediaUrl(url: string): boolean {
  const u = url.trim();
  if (u.length < 24 || u.length > 240) return false;
  if (!u.startsWith("/world/social/media/")) return false;
  const name = u.slice("/world/social/media/".length);
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{2,8}$/.test(name);
}

function safeMediaFilename(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{2,8}$/.test(name);
}

export class SocialFeedService {
  private posts: SocialPostRow[] = [];
  private comments: SocialCommentRow[] = [];
  private reports: SocialReportRow[] = [];
  /** postId -> liker sessionIds */
  private likes = new Map<string, Set<string>>();
  /** O(1) 帖子存在性校验，与 [posts] 同步维护 */
  private readonly postIds = new Set<string>();
  /** postId -> 该帖评论（与 [comments] 同步，避免序列化时全表扫描） */
  private readonly commentsByPostId = new Map<string, SocialCommentRow[]>();
  private readonly subscribers = new Set<string>();
  private wsRegistry: WsConnectionRegistryLike | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(
    private readonly worldService: WorldService,
    private readonly persistPath: string = defaultPersistPath(),
    private readonly mediaRoot: string = defaultSocialMediaRoot(),
  ) {}

  attachWebSocketRegistry(registry: WsConnectionRegistryLike): void {
    this.wsRegistry = registry;
  }

  assertAgentWorldEntry(sessionId: string): void {
    this.worldService.assertAgentWorldRegistered(sessionId);
  }

  getMediaRoot(): string {
    return this.mediaRoot;
  }

  /** 磁盘绝对路径；[fileName] 须已通过 [safeMediaFilename]。 */
  resolveMediaPath(fileName: string): string {
    return join(this.mediaRoot, fileName);
  }

  mimeForFileName(fileName: string): string {
    const ext = extname(fileName).toLowerCase();
    const map: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
    };
    return map[ext] ?? "application/octet-stream";
  }

  /**
   * 将已校验大小的文件写入 `data/social-media/`，返回帖子中应保存的 `mediaUrl`（以 `/world/social/media/` 开头）。
   */
  async saveUploadedMedia(
    buffer: Buffer,
    mime: string,
  ): Promise<{ ok: true; mediaUrl: string } | { ok: false; reason: string }> {
    const m = mime.toLowerCase().split(";")[0]!.trim();
    if (!ALLOWED_IMAGE.has(m) && !ALLOWED_VIDEO.has(m)) {
      return { ok: false, reason: "不支持的媒体类型" };
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
      return { ok: false, reason: `文件过大（>${MAX_MEDIA_BYTES} 字节）` };
    }
    const ext = MIME_EXT[m];
    if (!ext) return { ok: false, reason: "不支持的媒体类型" };
    const fileName = `${randomUUID().replace(/-/g, "")}.${ext}`;
    await mkdir(this.mediaRoot, { recursive: true });
    const abs = join(this.mediaRoot, fileName);
    await writeFile(abs, buffer);
    return { ok: true, mediaUrl: `/world/social/media/${fileName}` };
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as RawPersisted;
      const ver = data.version ?? 1;
      if (!data || (ver !== 1 && ver !== 2) || !Array.isArray(data.posts)) return;
      this.posts = data.posts.filter((p) => p?.id && p?.authorSessionId) as SocialPostRow[];
      this.comments = Array.isArray(data.comments)
        ? (data.comments as SocialCommentRow[]).filter((c) => c?.id && c?.postId && c?.authorSessionId)
        : [];
      this.reports =
        ver === 2 && Array.isArray(data.reports)
          ? (data.reports as SocialReportRow[]).filter((r) => r?.id && r?.postId && r?.reporterSessionId)
          : [];
      this.likes = new Map();
      if (data.likes && typeof data.likes === "object") {
        for (const [pid, arr] of Object.entries(data.likes)) {
          if (!Array.isArray(arr)) continue;
          this.likes.set(pid, new Set(arr.map((s) => String(s))));
        }
      }
      this.postIds.clear();
      for (const p of this.posts) this.postIds.add(p.id);
      this.reindexCommentsByPost();
    } catch {
      /* 首次运行无文件 */
    }
  }

  private reindexCommentsByPost(): void {
    this.commentsByPostId.clear();
    for (const c of this.comments) {
      const arr = this.commentsByPostId.get(c.postId);
      if (arr) arr.push(c);
      else this.commentsByPostId.set(c.postId, [c]);
    }
  }

  subscribe(sessionId: string): void {
    this.worldService.visitSocial(sessionId);
    this.subscribers.add(sessionId);
    this.sendFeedSnapshotToSession(sessionId);
  }

  unsubscribe(sessionId: string): void {
    this.subscribers.delete(sessionId);
  }

  getFeedForViewer(viewerSessionId: string, limit = 80): { ok: true; feed: Record<string, unknown> } {
    const lim = Math.min(200, Math.max(1, Math.floor(limit)));
    const sorted = this.sortedPostsForViewer(viewerSessionId);
    const slice = sorted.slice(0, lim);
    return {
      ok: true,
      feed: {
        viewerSessionId,
        posts: slice.map((p) => this.serializePost(p, viewerSessionId)),
      },
    };
  }

  createPost(
    authorSessionId: string,
    text: string,
    mediaType: SocialMediaType,
    mediaUrl: string | null,
  ): { ok: true; post: SocialPostRow } | { ok: false; reason: string } {
    const t = text.trim();
    if (!t && mediaType === "none") {
      return { ok: false, reason: "正文与媒体不能同时为空" };
    }
    if (t.length > 4000) return { ok: false, reason: "正文过长" };
    if (mediaType !== "none") {
      if (!mediaUrl || !(isSafeHttpsMediaUrl(mediaUrl) || isServerSocialMediaUrl(mediaUrl))) {
        return { ok: false, reason: "媒体须为 https 外链或本服务上传后的 /world/social/media/ 路径" };
      }
    } else if (mediaUrl && mediaUrl.trim().length > 0) {
      return { ok: false, reason: "mediaType 为 none 时不应带 mediaUrl" };
    }
    const post: SocialPostRow = {
      id: `soc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      authorSessionId,
      text: t,
      mediaType,
      mediaUrl: mediaType === "none" ? null : mediaUrl!.trim(),
      createdAt: new Date().toISOString(),
    };
    this.posts.unshift(post);
    this.postIds.add(post.id);
    if (this.posts.length > MAX_POSTS) {
      const drop = this.posts.splice(MAX_POSTS);
      const dropIds = new Set(drop.map((p) => p.id));
      for (const p of drop) {
        this.postIds.delete(p.id);
        this.commentsByPostId.delete(p.id);
        this.likes.delete(p.id);
        void this.unlinkServerMedia(p.mediaUrl);
      }
      this.comments = this.comments.filter((c) => !dropIds.has(c.postId));
      this.reports = this.reports.filter((r) => !dropIds.has(r.postId));
    }
    void this.schedulePersist();
    this.notifySubscribers();
    return { ok: true, post };
  }

  deletePost(
    actorSessionId: string,
    postId: string,
  ): { ok: true } | { ok: false; reason: string } {
    const idx = this.posts.findIndex((p) => p.id === postId);
    if (idx < 0) return { ok: false, reason: "帖子不存在" };
    const post = this.posts[idx]!;
    if (post.authorSessionId !== actorSessionId) {
      return { ok: false, reason: "只能删除本人发布的帖子" };
    }
    this.posts.splice(idx, 1);
    this.postIds.delete(postId);
    this.commentsByPostId.delete(postId);
    this.comments = this.comments.filter((c) => c.postId !== postId);
    this.likes.delete(postId);
    this.reports = this.reports.filter((r) => r.postId !== postId);
    void this.unlinkServerMedia(post.mediaUrl);
    void this.schedulePersist();
    this.notifySubscribers();
    return { ok: true };
  }

  reportPost(
    reporterSessionId: string,
    postId: string,
    reason?: string,
  ): { ok: true; duplicate?: boolean } | { ok: false; reason: string } {
    if (!this.postIds.has(postId)) return { ok: false, reason: "帖子不存在" };
    if (this.reports.some((r) => r.postId === postId && r.reporterSessionId === reporterSessionId)) {
      return { ok: true, duplicate: true };
    }
    const r = (reason ?? "").trim().slice(0, 500);
    const row: SocialReportRow = {
      id: `rpt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      postId,
      reporterSessionId,
      reason: r,
      createdAt: new Date().toISOString(),
    };
    this.reports.push(row);
    if (this.reports.length > MAX_REPORTS) {
      this.reports.splice(0, this.reports.length - MAX_REPORTS);
    }
    void this.schedulePersist();
    this.notifySubscribers();
    return { ok: true };
  }

  addComment(
    authorSessionId: string,
    postId: string,
    text: string,
  ): { ok: true; comment: SocialCommentRow } | { ok: false; reason: string } {
    if (!this.postIds.has(postId)) return { ok: false, reason: "帖子不存在" };
    const t = text.trim();
    if (!t) return { ok: false, reason: "评论不能为空" };
    if (t.length > 2000) return { ok: false, reason: "评论过长" };
    const existing = this.commentsByPostId.get(postId) ?? [];
    if (existing.length >= MAX_COMMENTS_PER_POST) {
      return { ok: false, reason: "该帖评论已达上限" };
    }
    const comment: SocialCommentRow = {
      id: `cmt_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      postId,
      authorSessionId,
      text: t,
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    const bucket = this.commentsByPostId.get(postId);
    if (bucket) bucket.push(comment);
    else this.commentsByPostId.set(postId, [comment]);
    void this.schedulePersist();
    this.notifySubscribers();
    return { ok: true, comment };
  }

  toggleLike(
    sessionId: string,
    postId: string,
  ): { ok: true; liked: boolean; likeCount: number } | { ok: false; reason: string } {
    if (!this.postIds.has(postId)) return { ok: false, reason: "帖子不存在" };
    let set = this.likes.get(postId);
    if (!set) {
      set = new Set();
      this.likes.set(postId, set);
    }
    let liked: boolean;
    if (set.has(sessionId)) {
      set.delete(sessionId);
      liked = false;
    } else {
      set.add(sessionId);
      liked = true;
    }
    const likeCount = set.size;
    void this.schedulePersist();
    this.notifySubscribers();
    return { ok: true, liked, likeCount };
  }

  private async unlinkServerMedia(mediaUrl: string | null): Promise<void> {
    if (!mediaUrl || !isServerSocialMediaUrl(mediaUrl)) return;
    const name = mediaUrl.slice("/world/social/media/".length);
    if (!safeMediaFilename(name)) return;
    try {
      await unlink(join(this.mediaRoot, name));
    } catch {
      /* 已删或不存在 */
    }
  }

  private sortedPostsForViewer(viewerSessionId: string): SocialPostRow[] {
    const mine: SocialPostRow[] = [];
    const rest: SocialPostRow[] = [];
    for (const p of this.posts) {
      if (p.authorSessionId === viewerSessionId) mine.push(p);
      else rest.push(p);
    }
    return [...mine, ...rest];
  }

  private commentsForPost(postId: string): SocialCommentRow[] {
    const rows = this.commentsByPostId.get(postId);
    if (!rows?.length) return [];
    return rows.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private reportStatsForPost(postId: string, viewerSessionId: string): { count: number; viewerReported: boolean } {
    let count = 0;
    let viewerReported = false;
    for (const r of this.reports) {
      if (r.postId !== postId) continue;
      count += 1;
      if (r.reporterSessionId === viewerSessionId) viewerReported = true;
    }
    return { count, viewerReported };
  }

  private serializePost(p: SocialPostRow, viewerSessionId: string): Record<string, unknown> {
    const likeSet = this.likes.get(p.id) ?? new Set<string>();
    const { count: reportCount, viewerReported } = this.reportStatsForPost(p.id, viewerSessionId);
    return {
      id: p.id,
      authorSessionId: p.authorSessionId,
      text: p.text,
      mediaType: p.mediaType,
      mediaUrl: p.mediaUrl,
      createdAt: p.createdAt,
      likeCount: likeSet.size,
      likedByViewer: likeSet.has(viewerSessionId),
      isOwnAgent: p.authorSessionId === viewerSessionId,
      reportCount,
      viewerHasReported: viewerReported,
      comments: this.commentsForPost(p.id).map((c) => ({
        id: c.id,
        authorSessionId: c.authorSessionId,
        text: c.text,
        createdAt: c.createdAt,
      })),
    };
  }

  private sendFeedSnapshotToSession(sessionId: string): void {
    if (!this.wsRegistry) return;
    const { feed } = this.getFeedForViewer(sessionId);
    this.wsRegistry.trySend(
      sessionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldSocialFeedSnapshot,
        payload: feed,
      }),
    );
  }

  private notifySubscribers(): void {
    if (!this.wsRegistry || this.subscribers.size === 0) return;
    for (const sid of this.subscribers) {
      this.sendFeedSnapshotToSession(sid);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistChain = this.persistChain
        .then(() => this.writePersistToDisk())
        .catch((e) => console.error("[SocialFeedService] persist failed", e));
    }, PERSIST_DEBOUNCE_MS);
  }

  /** 与 [WorldService.flushPersist] 一致：等待队列中落盘后再写，避免并发交错丢失更新 */
  async flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistChain;
    this.persistChain = Promise.resolve();
    await this.writePersistToDisk();
  }

  private async writePersistToDisk(): Promise<void> {
    const likesObj: Record<string, string[]> = {};
    for (const [pid, set] of this.likes) {
      likesObj[pid] = [...set];
    }
    const body: PersistedShape = {
      version: 2,
      posts: this.posts,
      comments: this.comments,
      likes: likesObj,
      reports: this.reports,
    };
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(body), "utf8");
    } catch (e) {
      console.error("[SocialFeedService] writePersistToDisk failed", e);
    }
  }
}

/** 供 HTTP GET 流式输出；调用方负责设置 Content-Type。 */
export function createSocialMediaReadStream(mediaRoot: string, fileName: string): Readable | null {
  if (!safeMediaFilename(fileName)) return null;
  return createReadStream(join(mediaRoot, fileName));
}
