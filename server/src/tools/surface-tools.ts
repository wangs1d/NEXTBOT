import { randomUUID } from "node:crypto";

import { resolveActorId } from "../agent/actor-id.js";
import { ServerEventType } from "../protocol.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * 桌面浮层控制工具：让 LLM 能收起客户端上已展示的信息面板。
 *
 * 历史注记（2026-10-22）：本文件曾注册 `surface.show`（语音模式"念+显"双通道，
 * 召唤今日安排悬浮卡）。用户拍板删除——召唤面板不应以 LLM 工具实现，悬浮卡
 * 展示由客户端自身的数据流驱动；本文件只保留对称的收起动作。
 *
 * 通道约定：
 *   工具 → WS `surface.dismiss` 事件（ServerEventType.SurfaceDismiss）→ 客户端
 *   main.dart 按 surface 名执行（media → 中央媒体展示页）。
 *   客户端不支持的面板静默忽略。
 *
 * 沙箱可用：仅 WS 推送指令，无写操作，无需「完全访问」。
 */

export type SurfaceToolsDeps = {
  /** 按 actorId 直推 WS 消息（与 delivery-service 同一通道语义） */
  trySend: (actorId: string, data: string) => boolean;
};

export function registerSurfaceTools(
  registry: ToolRegistry,
  deps: SurfaceToolsDeps,
): void {
  // 对话移除：用户说"把图片收了/关掉这个页面"→ LLM 调用，客户端收起对应面板。
  // media = 中央媒体展示页（不会自动消失，靠本工具或用户手动 ✕ 关闭），
  // all = 全部浮层。
  registry.register("surface.dismiss", async (input, context) => {
    const actorId = resolveActorId(context);
    const surface = String(input.surface ?? "").trim().toLowerCase();

    const pushed = deps.trySend(
      actorId,
      JSON.stringify({
        type: ServerEventType.SurfaceDismiss,
        payload: { surface, jobId: randomUUID() },
      }),
    );

    const target = surface === "all" ? "全部浮层面板" : `「${surface || "media"}」`;
    return {
      ok: true,
      surface,
      pushed,
      summary: pushed
        ? `已通知客户端收起${target}。`
        : `指令已生成，但用户当前不在线（未连接 WebSocket），未生效。`,
    };
  });
}
