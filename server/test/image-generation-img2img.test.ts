import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GeminiImageProvider, OpenAICompatibleImageProvider } from "../src/services/image-generation-providers.js";
import { ImageGenerationService } from "../src/services/image-generation-service.js";

// 1x1 PNG（透明像素），足够 sharp 转码
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const ENV_KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "IMAGE_GEN_GEMINI_MODEL", "IMAGE_GEN_GEMINI_BASE_URL"] as const;

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
    return;
  } catch (e) {
    restore();
    throw e;
  }
}

type FetchStub = (url: string | URL, init?: Record<string, unknown>) => Promise<{ ok: boolean; status?: number; text?: () => Promise<string>; json?: () => Promise<unknown> }>;

function stubFetch(stub: FetchStub): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function geminiOkResponse() {
  return {
    candidates: [{
      content: {
        parts: [
          { text: "已按风格重绘。" },
          { inlineData: { mimeType: "image/png", data: TINY_PNG_BASE64 } },
        ],
      },
      finishReason: "STOP",
    }],
  };
}

test("GeminiImageProvider 文生图：解析 inlineData base64", async () => {
  await withEnv({ GEMINI_API_KEY: "test-key", OPENAI_API_KEY: undefined }, async () => {
    let capturedUrl = "";
    const restore = stubFetch(async (url) => {
      capturedUrl = String(url);
      return { ok: true, json: async () => geminiOkResponse() };
    });
    try {
      const provider = new GeminiImageProvider();
      assert.equal(provider.isEnabled(), true);
      assert.equal(provider.supportsImageInput?.(), true);

      const result = await provider.generate({ prompt: "一张测试图" });
      assert.equal(result.model, "gemini-2.5-flash-image");
      assert.equal(result.images[0].base64, TINY_PNG_BASE64);
      assert.match(capturedUrl, /models\/gemini-2\.5-flash-image:generateContent$/);
    } finally {
      restore();
    }
  });
});

test("GeminiImageProvider 图生图：参考图作为 inline_data 传入", async () => {
  await withEnv({ GEMINI_API_KEY: "test-key" }, async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const restore = stubFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return { ok: true, json: async () => geminiOkResponse() };
    });
    try {
      const provider = new GeminiImageProvider();
      await provider.generate({
        prompt: "重绘成纸感拼贴",
        image: { mimeType: "image/jpeg", dataBase64: TINY_PNG_BASE64 },
        aspectRatio: "3:4",
      });
      const contents = capturedBody?.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      const parts = contents[0].parts;
      assert.equal(parts.length, 2);
      assert.deepEqual(parts[1].inline_data, { mime_type: "image/jpeg", data: TINY_PNG_BASE64 });
      const gc = capturedBody?.generationConfig as Record<string, unknown>;
      assert.deepEqual(gc.responseModalities, ["TEXT", "IMAGE"]);
      assert.deepEqual((gc.imageConfig as Record<string, unknown>).aspectRatio, "3:4");
    } finally {
      restore();
    }
  });
});

test("OpenAICompatibleImageProvider 收到图生图请求时直接抛错（不发起网络请求）", async () => {
  await withEnv({ OPENAI_API_KEY: "test-key" }, async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: false, status: 500, text: async () => "" };
    });
    try {
      const provider = new OpenAICompatibleImageProvider();
      await assert.rejects(
        () => provider.generate({ prompt: "x", image: { mimeType: "image/png", dataBase64: TINY_PNG_BASE64 } }),
        /不支持图生图/,
      );
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });
});

test("服务链路：openai 不支持图生图时回退 gemini，base64 结果落盘", async () => {
  await withEnv({ OPENAI_API_KEY: "test-key", GEMINI_API_KEY: "test-key" }, async () => {
    const restore = stubFetch(async (url) => {
      // 只有 gemini 端点会被真正打到
      assert.match(String(url), /generativelanguage\.googleapis\.com/);
      return { ok: true, json: async () => geminiOkResponse() };
    });
    const storageRoot = mkdtempSync(join(tmpdir(), "imggen-"));
    try {
      const service = new ImageGenerationService({ storageRoot });
      const result = await service.generateFromImage(
        { mimeType: "image/jpeg", dataBase64: TINY_PNG_BASE64 },
        "重绘成留白手绘风",
        "session-mvp-001",
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.match(result.imageUrl, /^\/agent\/images\/session-mvp-001\/\d+-[a-f0-9]{8}\.png$/);
        assert.equal(result.model, "gemini-2.5-flash-image");
        // imageUrl 相对 storageRoot 解析后文件确实存在
        const fileName = result.imageUrl.split("/").pop()!;
        assert.equal(existsSync(join(storageRoot, "session-mvp-001", fileName)), true);
      }
    } finally {
      restore();
    }
  });
});

test("未配置任何图生图 provider 时返回明确错误", async () => {
  await withEnv({ OPENAI_API_KEY: "test-key", GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined }, async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "imggen-"));
    const service = new ImageGenerationService({ storageRoot });
    const result = await service.generateFromImage(
      { mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
      "重绘",
      "session-mvp-001",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /GEMINI_API_KEY/);
    }
  });
});
