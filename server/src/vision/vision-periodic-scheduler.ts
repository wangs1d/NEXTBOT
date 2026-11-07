import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import type { DesktopVisualPort } from "../services/desktop-visual-port.js";
import { getToolResultProcessor } from "../services/tool-result-processor.js";
import { extractNextUpSuggestions } from "../services/reply-envelope.js";
import { createStreamMarkerGuard } from "../utils/stream-marker-guard.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import { ServerEventType } from "../protocol.js";
import { chunkText, dedupeAdjacentLines } from "../utils/text.js";
import { fetchHttpVisionFrame } from "./fetch-http-vision-frame.js";

export type VisionPeriodicSchedulerDeps = {
  runtime: RuntimeFacade;
  wsRegistry: WsConnectionRegistry;
  /** 桌面视觉端口懒引用（source="desktop" 时截图用；缺省/未就绪时桌面源不可启动） */
  getVisualPort?: () => DesktopVisualPort | null;
};

/** 视觉源类型：http 快照 URL 拉帧 / desktop 本机屏幕截图（2026-09-19 P0-1） */
export type VisionPeriodicSource = "http" | "desktop";

type InternalJob = {
  jobId: string;
  actorId: string;
  source: VisionPeriodicSource;
  url: string;
  intervalMs: number;
  prompt: string;
  timer: NodeJS.Timeout;
  /** 上一帧内容哈希（完全相同的帧跳过推理，省一次 VLM 调用） */
  lastFrameHash?: string;
};

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 服务端定时从 HTTP(S) 快照 URL 拉帧并触发一轮带视觉的 Agent 推理（需客户端 WebSocket 在线以接收流式回复）。
 */
export class VisionPeriodicScheduler {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly runningFire = new Set<string>();

  constructor(private readonly deps: VisionPeriodicSchedulerDeps) {}

  startJob(
    actorId: string,
    params: {
      url: string;
      intervalSeconds: number;
      prompt?: string;
      /** 视觉源：缺省 http（URL 拉帧）；desktop = 本机屏幕截图（url 可空） */
      source?: VisionPeriodicSource;
    },
  ): { ok: true; jobId: string } | { ok: false; error: string } {
    const source: VisionPeriodicSource = params.source === "desktop" ? "desktop" : "http";
    const url = params.url.trim();
    if (source === "http" && !url) {
      return { ok: false, error: "需要 url" };
    }
    if (source === "desktop" && !this.deps.getVisualPort?.()?.screenshot) {
      return { ok: false, error: "桌面视觉端口不可用（desktop-visual 未就绪）" };
    }
    const minSec = Math.min(3600, envInt("AGENT_VISION_PERIODIC_MIN_INTERVAL_SEC", 30));
    const maxSec = Math.min(86400, envInt("AGENT_VISION_PERIODIC_MAX_INTERVAL_SEC", 3600));
    let sec = Number(params.intervalSeconds);
    if (!Number.isFinite(sec)) {
      sec = minSec;
    }
    sec = Math.round(sec);
    if (sec < minSec) {
      return { ok: false, error: `intervalSeconds 过小，最小 ${minSec}s` };
    }
    if (sec > maxSec) {
      return { ok: false, error: `intervalSeconds 过大，最大 ${maxSec}s` };
    }
    const maxJobs = Math.min(32, envInt("AGENT_VISION_PERIODIC_MAX_JOBS_PER_ACTOR", 4));
    const actorJobCount = [...this.jobs.values()].filter((j) => j.actorId === actorId).length;
    if (actorJobCount >= maxJobs) {
      return { ok: false, error: `每位用户最多 ${maxJobs} 个定时视觉任务` };
    }

    const jobId = randomUUID();
    const intervalMs = sec * 1000;
    const prompt =
      params.prompt?.trim() ||
      "（定时视觉巡检）请根据图像简述可见内容与异常点；若无异常则说明「无明显变化」。";

    const job: InternalJob = {
      jobId,
      actorId,
      source,
      url,
      intervalMs,
      prompt,
      timer: setInterval(() => {
        void this.fire(job);
      }, intervalMs),
    };
    this.jobs.set(jobId, job);
    void this.fire(job);
    return { ok: true, jobId };
  }

  stopJob(actorId: string, jobId: string): { ok: boolean; reason?: string } {
    const j = this.jobs.get(jobId);
    if (!j) {
      return { ok: false, reason: "任务不存在" };
    }
    if (j.actorId !== actorId) {
      return { ok: false, reason: "无权停止该任务" };
    }
    clearInterval(j.timer);
    this.jobs.delete(jobId);
    return { ok: true };
  }

  stopAllForActor(actorId: string): number {
    let n = 0;
    for (const [id, j] of [...this.jobs.entries()]) {
      if (j.actorId === actorId) {
        clearInterval(j.timer);
        this.jobs.delete(id);
        n += 1;
      }
    }
    return n;
  }

  listForActor(actorId: string): Array<{
    jobId: string;
    source: VisionPeriodicSource;
    url: string;
    intervalSeconds: number;
    prompt: string;
  }> {
    return [...this.jobs.values()]
      .filter((j) => j.actorId === actorId)
      .map((j) => ({
        jobId: j.jobId,
        source: j.source,
        url: j.url,
        intervalSeconds: Math.round(j.intervalMs / 1000),
        prompt: j.prompt,
      }));
  }

  /** @internal 测试：清理全部定时器 */
  disposeAll(): void {
    for (const j of this.jobs.values()) {
      clearInterval(j.timer);
    }
    this.jobs.clear();
  }

  private async fire(job: InternalJob): Promise<void> {
    if (this.runningFire.has(job.jobId)) {
      return;
    }
    this.runningFire.add(job.jobId);
    const messageId = `vision-periodic-${job.jobId}-${Date.now()}`;
    const assistantMsgId = `assistant-${messageId}`;

    try {
      let frame;
      try {
        frame =
          job.source === "desktop"
            ? await this.captureDesktopFrame(job)
            : await fetchHttpVisionFrame(job.url, "external_stream", `periodic:${job.jobId}`);
        // 完全相同的帧跳过（省一次 VLM 推理与一次对话轮）；哈希碰撞概率可忽略
        const hash = createHash("sha1").update(frame.dataBase64).digest("hex");
        if (hash === job.lastFrameHash) {
          return;
        }
        job.lastFrameHash = hash;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.wsRegistry.trySend(
          job.actorId,
          JSON.stringify({
            type: ServerEventType.ErrorEvent,
            payload: {
              code: "VISION_PERIODIC_FETCH_FAILED",
              message: msg,
              jobId: job.jobId,
            },
          }),
        );
        return;
      }

      // 2026-11-05 文字打字机退役（模型仍流式生成）：视觉播报只由下方 ChatAssistantDone 一次性下发，
      // 不再推打字机 chunk；delta 回调与流式标记 guard 一并移除。
      const reply = await this.deps.runtime.handleUserMessage(job.actorId, job.prompt, {
        chatUserMessageId: messageId,
        visionFrames: [frame],
        onExternalToolExecuted: (info) => {
          this.deps.wsRegistry.trySend(
            job.actorId,
            JSON.stringify({
              type: ServerEventType.ToolCall,
              payload: {
                toolName: info.toolName,
                input: info.input,
                traceId: messageId,
              },
            }),
          );
          const res = { ...info.result };
          delete res._injectVisionUserMessage;
          this.deps.wsRegistry.trySend(
            job.actorId,
            JSON.stringify({
              type: ServerEventType.ToolResult,
              payload: {
                toolName: info.toolName,
                ok: info.ok,
                result: res,
                traceId: messageId,
              },
            }),
          );
        },
      });

      // 定稿文本剥离 NEXT_UP 协议块（视觉任务不出胶囊，透出即噪音）。
      const displayText = extractNextUpSuggestions(
        dedupeAdjacentLines((reply.text ?? "").trim()),
      ).text;

      // 流式切块推送已退役：finalText 即完整正文，done 一次性落屏。
      this.deps.wsRegistry.trySend(
        job.actorId,
        JSON.stringify({
          type: ServerEventType.ChatAssistantDone,
          payload: {
            sessionId: job.actorId,
            messageId: assistantMsgId,
            finalText: getToolResultProcessor().processAssistantText(displayText, {
              userText: job.prompt,
            }),
            toolCalls: reply.toolName ? [reply.toolName] : [],
            visionPeriodicJobId: job.jobId,
          },
        }),
      );
    } finally {
      this.runningFire.delete(job.jobId);
    }
  }

  /** 桌面屏幕截图 → VisionFrame（sourceKind=desktop_screen，走既有 sanitize/VLM 链路）。 */
  private async captureDesktopFrame(job: InternalJob) {
    const shot = await (this.deps.getVisualPort?.()?.screenshot?.({}) ??
      Promise.resolve({ ok: false as const, error: "screenshot_unavailable" }));
    if (!shot.ok || !shot.imageBase64) {
      throw new Error(("error" in shot && shot.error) || "desktop_screenshot_failed");
    }
    return {
      sourceKind: "desktop_screen" as const,
      sourceId: `desktop-periodic:${job.jobId}`,
      mimeType: shot.mimeType ?? "image/png",
      dataBase64: shot.imageBase64,
      capturedAt: new Date().toISOString(),
    };
  }
}
