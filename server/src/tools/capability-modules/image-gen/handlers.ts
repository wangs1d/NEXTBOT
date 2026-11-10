import type { ToolHandler, ToolContext } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { ImageGenerationService } from "../../../services/image-generation-service.js";

/**
 * image.generate 工具 handler。
 *
 * 调用 {@link ImageGenerationService.generate} 合成并落盘，
 * 返回本地静态 URL 给 LLM。
 *
 * 失败时返回 `{ ok: false, error }`，LLM 可告知用户。
 *
 * Phase 2：优先走 worker 线程（故障隔离），失败时 fallback 到主进程。
 */

/** 是否启用 worker 线程隔离（环境变量控制，默认开启）。 */
function isWorkerEnabled(): boolean {
  const v = process.env.IMAGE_GEN_WORKER_ENABLED ?? "1";
  return v === "1" || v === "true" || v === "on";
}

export function createImageGenerateHandler(
  imageGenerationService: ImageGenerationService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) {
      return { ok: false, error: "缺少 prompt（图像描述）" };
    }

    const actorId = resolveActorId(context);
    const model = input.model != null ? String(input.model).trim() : undefined;
    const imageSize = input.imageSize != null ? String(input.imageSize).trim() : undefined;
    const batchSize =
      input.batchSize != null ? Math.max(1, Math.min(4, Number(input.batchSize))) : undefined;

    if (!imageGenerationService.isEnabled()) {
      return {
        ok: false,
        error:
          "图像生成未配置：服务端需 OPENAI_API_KEY（OpenAI 兼容 images 接口）。请告知用户「图像生成能力未启用」。",
      };
    }

    // Phase 2：优先走 worker 线程（故障隔离），失败时 fallback 到主进程
    if (isWorkerEnabled()) {
      try {
        const { workerPool } = await import("../../../services/worker-pool.js");
        const result = await workerPool.submit<{
          ok: boolean;
          imageUrl?: string;
          model?: string;
          seed?: number;
          revisedPrompt?: string;
          error?: string;
        }>("image.generate", {
          prompt,
          actorId,
          options: { model, imageSize, batchSize },
        }, 90_000);

        if (!result.ok) {
          return { ok: false, error: result.error ?? "图像生成失败", retryable: true };
        }

        // worker 直接写盘，主线程补记归属对话（资料库按对话折叠）
        if (result.imageUrl) {
          imageGenerationService.recordImageOwner(actorId, result.imageUrl, context.sessionId);
        }

        return {
          ok: true,
          imageUrl: result.imageUrl,
          model: result.model,
          seed: result.seed,
          revisedPrompt: result.revisedPrompt,
          summary: `已生成图片（${result.model}）[worker]。图片 URL：${result.imageUrl}`,
        };
      } catch (workerErr) {
        console.warn(`[image.generate] worker 线程失败，fallback 到主进程: ${workerErr instanceof Error ? workerErr.message : workerErr}`);
        // 继续走下面的主进程路径
      }
    }

    // 主进程执行路径（fallback）
    const result = await imageGenerationService.generate(prompt, actorId, {
      model,
      imageSize,
      batchSize,
      sessionId: context.sessionId,
    });

    if (!result.ok) {
      return { ok: false, error: result.error, retryable: true };
    }

    return {
      ok: true,
      imageUrl: result.imageUrl,
      model: result.model,
      seed: result.seed,
      revisedPrompt: result.revisedPrompt,
      summary: `已生成图片（${result.model}）。图片 URL：${result.imageUrl}`,
    };
  };
}
