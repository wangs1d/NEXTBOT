// HTTP 路由：服务接入（内测 byok）
//
// 用户在客户端「服务接入」页自行填模型 / TTS 等服务的 API Key（内测期服务端
// 不代充额度）。密钥经本路由持久化到 data/service-config.json 并写入
// process.env 热生效（主对话 provider 由 MutableExternalChatProvider 热替换，
// TtsService 按密钥变化惰性重建，旁路 LLM 每次调用动态读 env）。
// 与桌面端 byok 的 config.env 同键同义：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL。
//
// 安全约定：所有响应只回脱敏 key 尾号（maskServiceKey），绝不下发完整密钥；
// 路由位于 /api/* 周界鉴权 hook 之后（ACCESS_AUTH_REQUIRED=1 时须设备 token）。

import type { FastifyInstance } from "fastify";

import { createExternalChatProviderFromEnv } from "../../external-model/index.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import {
  applyServiceConfigToEnv,
  maskServiceKey,
  readServiceConfigFile,
  saveServiceConfigPatch,
  type ServiceConfigPatch,
} from "../../config/service-config-store.js";
import { resolvePrimaryExternalModelBinding } from "../../external-model/resolve-provider.js";
import type { TtsService } from "../../services/tts-service.js";

export type ServiceConfigRouteDeps = {
  ttsService: TtsService;
  /** 热替换主对话 provider（create-app-services 注入 MutableExternalChatProvider.swap） */
  externalChatSwapper?: (next: ExternalChatProvider | null) => void;
  /** 邮箱接入热生效（授权码保存后当场启动 IMAP 轮询；未注入时仅落盘+写 env） */
  mailWatchApplyPass?: (pass: string) => unknown;
};

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function registerServiceConfigRoutes(app: FastifyInstance, deps: ServiceConfigRouteDeps): void {
  // 状态查询：持久化配置 + 当前生效绑定（含部署机 env 直配的情形），key 一律脱敏
  app.get("/api/service-config", async () => {
    const persisted = await readServiceConfigFile();
    const binding = resolvePrimaryExternalModelBinding();
    return {
      ok: true,
      model: {
        configured: Boolean(persisted?.model?.apiKey || binding?.apiKey),
        providerId: persisted?.model?.providerId ?? binding?.providerId ?? null,
        baseUrl: persisted?.model?.baseUrl ?? binding?.baseUrl ?? null,
        model: persisted?.model?.model ?? binding?.model ?? null,
        keyTail: maskServiceKey(persisted?.model?.apiKey ?? binding?.apiKey),
        source: persisted?.model ? "service-config" : binding ? "env" : null,
        updatedAt: persisted?.model?.updatedAt ?? null,
      },
      tts: {
        provider: persisted?.tts?.provider ?? null,
        configured: Boolean(persisted?.tts?.apiKey) || Boolean(process.env.MINIMAX_API_KEY?.trim()),
        keyTail: maskServiceKey(persisted?.tts?.apiKey ?? process.env.MINIMAX_API_KEY),
        updatedAt: persisted?.tts?.updatedAt ?? null,
      },
      mail: {
        // 邮箱接入：host/user 由登录邮箱域自动接入（auto-mail-account），这里只管授权码有没有
        configured:
          Boolean(persisted?.mail?.pass) || Boolean(process.env.MAIL_WATCH_PASS?.trim()),
        keyTail: maskServiceKey(persisted?.mail?.pass ?? process.env.MAIL_WATCH_PASS),
        updatedAt: persisted?.mail?.updatedAt ?? null,
      },
    };
  });

  // 保存并即时生效：env 应用 + 主对话 provider 热替换 + 落盘（重启后由启动重放保持续效）
  app.put("/api/service-config", async (request, reply) => {
    const body = (request.body ?? {}) as ServiceConfigPatch;
    const patch: ServiceConfigPatch = {};

    if (body.model != null) {
      // apiKey 留空 = 沿用已存密钥（换模型/网关不必重填 Key；首次接入仍必填）
      const persisted = await readServiceConfigFile();
      const apiKey =
        (body.model.apiKey ?? "").trim() || persisted?.model?.apiKey || "";
      const baseUrl = (body.model.baseUrl ?? "").trim();
      const model = (body.model.model ?? "").trim();
      const providerId = (body.model.providerId ?? "custom").trim() || "custom";
      if (!apiKey) {
        return reply.code(400).send({ ok: false, error: "model.apiKey 不能为空" });
      }
      if (!isValidHttpUrl(baseUrl)) {
        return reply.code(400).send({ ok: false, error: "model.baseUrl 必须是 http(s) 地址" });
      }
      if (!model) {
        return reply.code(400).send({ ok: false, error: "model.model 不能为空" });
      }
      patch.model = { providerId, baseUrl, model, apiKey };
    }

    if (body.tts != null) {
      // minimax：留空沿用已存密钥；openai：复用模型服务密钥，无需单独 Key
      const persisted = await readServiceConfigFile();
      const apiKey =
        (body.tts.apiKey ?? "").trim() || persisted?.tts?.apiKey || "";
      const provider = (body.tts.provider ?? "minimax").trim();
      if (provider !== "minimax" && provider !== "openai") {
        return reply.code(400).send({ ok: false, error: "tts.provider 仅支持 minimax / openai" });
      }
      if (provider === "minimax" && !apiKey) {
        return reply.code(400).send({ ok: false, error: "tts.apiKey 不能为空" });
      }
      patch.tts = { provider, apiKey };
    }

    if (body.mail != null) {
      // pass 留空 = 沿用已存授权码（改完别的服务不必重填邮箱授权码）
      const persisted = await readServiceConfigFile();
      const pass = (body.mail.pass ?? "").trim() || persisted?.mail?.pass || "";
      if (!pass) {
        return reply.code(400).send({ ok: false, error: "mail.pass 不能为空" });
      }
      patch.mail = { pass };
    }

    if (!patch.model && !patch.tts && !patch.mail) {
      return reply.code(400).send({ ok: false, error: "请求体为空：至少提供 model / tts / mail 之一" });
    }

    const saved = await saveServiceConfigPatch(patch);
    // env 已由 saveServiceConfigPatch 应用；重新解析 provider 并热替换进主链路
    if (deps.externalChatSwapper) {
      deps.externalChatSwapper(createExternalChatProviderFromEnv());
    }
    // 邮箱授权码热生效：当场启动 IMAP 轮询（未注入时仅落盘+写 env，重启后重放同样生效）
    if (patch.mail && deps.mailWatchApplyPass) {
      deps.mailWatchApplyPass(patch.mail.pass);
    }
    const binding = resolvePrimaryExternalModelBinding();
    return {
      ok: true,
      applied: {
        model: patch.model
          ? {
              providerId: saved.model?.providerId,
              baseUrl: saved.model?.baseUrl,
              model: saved.model?.model,
              keyTail: maskServiceKey(saved.model?.apiKey),
            }
          : undefined,
        tts: patch.tts
          ? { provider: saved.tts?.provider, keyTail: maskServiceKey(saved.tts?.apiKey) }
          : undefined,
        mail: patch.mail
          ? { keyTail: maskServiceKey(saved.mail?.pass) }
          : undefined,
        runtimeBinding: binding
          ? { providerId: binding.providerId, model: binding.model, baseUrl: binding.baseUrl }
          : null,
      },
    };
  });

  // TTS 连通性测试：用当前（含刚保存热生效的）密钥真实合成一小段语音
  app.post("/api/service-config/tts-test", async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string };
    const text = (body.text ?? "").trim() || "NEXTBOT 语音服务连接测试";
    const result = await deps.ttsService.synthesizeMp3Base64(text.slice(0, 120));
    if (!result.ok) {
      return reply.code(502).send({ ok: false, error: result.reason });
    }
    return { ok: true, provider: result.provider, bytes: result.base64.length };
  });
}

// 保留引用：applyServiceConfigToEnv 由 saveServiceConfigPatch 内部调用，避免被 tree-shake 误删导出
void applyServiceConfigToEnv;
