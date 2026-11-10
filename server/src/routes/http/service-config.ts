// HTTP 路由：服务接入（内测 byok）
//
// 用户在客户端「服务接入」页自行填模型 / TTS 等服务的 API Key（内测期服务端
// 不代充额度）。密钥经本路由持久化（非密钥字段进 data/service-config.json，密钥进
// 加密仓）并写入 process.env 热生效（主对话 provider 由 MutableExternalChatProvider
// 热替换，TtsService 按密钥变化惰性重建，旁路 LLM 每次调用动态读 env）。
// 与桌面端 byok 的 config.env 同键同义：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL。
//
// 安全约定：keyTail 只回脱敏尾号供状态角标；任何分支都不下发完整密钥（曾经经 keyValue
// 全文回显供输入框回填——那等于把数据根里的凭据摊给每一次轮询这个接口的调用方）。
// 已接入的服务在页面上显示「已配置 ****尾号」，要换密钥就重新填一次，不回填旧值。
//
// 邮箱授权码不走这条链：它按 actor 加密存在邮箱注册表里（POST /api/mail-watch/pass），
// 本路由只回这个人自己那份状态。
//
// 多租户云端（ACCESS_AUTH_REQUIRED=1）：本路由是「单用户自配 = 全局生效」的老形态，
// 写进来会把某个用户的 key 变成全站 provider 并落盘，因此整条写入链关闭——
// 用户自有密钥改走 session.init 的 modelProvider 三元组（按 actor 加密落盘，
// 见 external-model/actor-model-bindings.ts）。

import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { isAccessAuthRequired } from "../../config/env.js";
import { createExternalChatProviderFromEnv } from "../../external-model/index.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type { MailboxAccountInput } from "../../services/mail-watch-registry.js";
import {
  maskServiceKey,
  readServiceConfigFile,
  saveServiceConfigPatch,
  serviceSecretsEncryptedAtRest,
  type ServiceConfigPatch,
} from "../../config/service-config-store.js";
import { resolvePrimaryExternalModelBinding } from "../../external-model/resolve-provider.js";
import type { TtsService } from "../../services/tts-service.js";

export type ServiceConfigRouteDeps = {
  ttsService: TtsService;
  /** 热替换主对话 provider（create-app-services 注入 MutableExternalChatProvider.swap） */
  externalChatSwapper?: (next: ExternalChatProvider | null) => void;
  /** 邮箱接入热生效：授权码保存后当场启动该账号的 IMAP 轮询（按 actor 加密落盘） */
  mailWatchApplyPass?: (input: MailboxAccountInput) => unknown;
  /** 这一个用户的邮箱盯梢状态（授权码按人存，不看整机那一份） */
  mailWatchStatus?: (actorId: string) => unknown;
  /** 多租户云端：该 actor 当前是否有内存 BYOK 绑定（不回密钥，只回模型/网关） */
  actorByokStatus?: (actorId: string) => { configured: boolean; model: string; baseUrl: string } | null;
};

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 请求者身份：授权码/状态都要绑到人，云端缺身份会被周界钉死，单机形态由注册表按唯一账号认账。 */
function requestActor(request: { query: unknown; body: unknown }): string {
  const q = (request.query ?? {}) as { userId?: string; sessionId?: string };
  const b = (request.body ?? {}) as { userId?: string; sessionId?: string };
  return resolveActorId({
    userId: q.userId ?? b.userId,
    sessionId: q.sessionId ?? b.sessionId ?? "",
  });
}

export function registerServiceConfigRoutes(app: FastifyInstance, deps: ServiceConfigRouteDeps): void {
  const sharedTenant = isAccessAuthRequired();

  // 状态查询：持久化配置 + 当前生效绑定（含部署机 env 直配的情形），密钥一律只回尾号
  app.get("/api/service-config", async (request) => {
    const persisted = await readServiceConfigFile();
    const binding = resolvePrimaryExternalModelBinding();
    const actorId = requestActor(request);
    const byok = sharedTenant ? deps.actorByokStatus?.(actorId) ?? null : null;
    // 邮箱授权码是"这个人这个邮箱"的凭据：只回他自己那份状态，全文不下发。
    const mailStatus = deps.mailWatchStatus?.(actorId) as
      | Record<string, unknown>
      | null
      | undefined;
    const mail = mailStatus
      ? {
          configured: Boolean(mailStatus.configured),
          // 授权码是密码不是密钥标识：连尾号都不回，配没配看 configured 就够
          keyTail: null,
          account: typeof mailStatus.user === "string" ? mailStatus.user : "",
          running: Boolean(mailStatus.running),
          reason: typeof mailStatus.reason === "string" ? mailStatus.reason : null,
        }
      : {
          // 注册表没接线（老装配/单测）：只看 env 里那份部署方自用授权码，仍只回尾号
          configured: Boolean(process.env.MAIL_WATCH_PASS?.trim()),
          keyTail: maskServiceKey(process.env.MAIL_WATCH_PASS),
          account: process.env.MAIL_WATCH_USER?.trim() ?? "",
          running: false,
          reason: null,
        };
    return {
      ok: true,
      // 多租户云端：全站写入已关闭，用户 key 只在自己的绑定里按 actor 加密保存
      mode: sharedTenant ? "session-byok" : "global",
      // 密钥是否真加密落盘（未配主密钥时单机退回明文文件，如实报出）
      encryptedAtRest: serviceSecretsEncryptedAtRest(),
      model: {
        configured: Boolean(byok?.configured || persisted?.model?.apiKey || binding?.apiKey),
        providerId: persisted?.model?.providerId ?? binding?.providerId ?? null,
        baseUrl: byok?.baseUrl ?? persisted?.model?.baseUrl ?? binding?.baseUrl ?? null,
        model: byok?.model ?? persisted?.model?.model ?? binding?.model ?? null,
        keyTail: sharedTenant
          ? byok?.configured
            ? "****(本机会话)"
            : null
          : maskServiceKey(persisted?.model?.apiKey ?? binding?.apiKey),
        source: byok?.configured ? "session-byok" : persisted?.model ? "service-config" : binding ? "env" : null,
        updatedAt: persisted?.model?.updatedAt ?? null,
      },
      tts: {
        provider: persisted?.tts?.provider ?? null,
        configured: Boolean(persisted?.tts?.apiKey) || Boolean(process.env.MINIMAX_API_KEY?.trim()),
        // 多租户云端：语音由平台 key 提供，用户无需也不应看到运营方密钥尾号
        keyTail: sharedTenant ? null : maskServiceKey(persisted?.tts?.apiKey ?? process.env.MINIMAX_API_KEY),
        updatedAt: persisted?.tts?.updatedAt ?? null,
      },
      mail,
    };
  });

  // 保存并即时生效：env 应用 + 主对话 provider 热替换 + 落盘（重启后由启动重放保持续效）
  app.put("/api/service-config", async (request, reply) => {
    if (sharedTenant) {
      return reply.code(409).send({
        ok: false,
        error:
          "云端多租户模式下不接受全站服务密钥写入（一份 key 会作用于所有用户）。" +
          "模型 Key 请在连接建立时随 session.init 的 modelProvider 上送" +
          "（服务端按用户加密保存，供离线期间的主动轮次使用）；" +
          "邮箱授权码走 POST /api/mail-watch/pass；语音密钥由平台在本机配置。",
      });
    }
    const body = (request.body ?? {}) as ServiceConfigPatch & {
      mail?: { pass?: string };
    };
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

    const legacyMailPass = (body.mail?.pass ?? "").trim();
    if (!patch.model && !patch.tts && !legacyMailPass) {
      return reply.code(400).send({ ok: false, error: "请求体为空：至少提供 model / tts / mail 之一" });
    }

    const saved = patch.model || patch.tts ? await saveServiceConfigPatch(patch) : null;
    // env 已由 saveServiceConfigPatch 应用；重新解析 provider 并热替换进主链路
    if (patch.model && deps.externalChatSwapper) {
      deps.externalChatSwapper(createExternalChatProviderFromEnv());
    }
    // 邮箱授权码热生效：按请求者自己的账号加密落盘并当场起盯（单机装机没带身份时
    // 由注册表按"整机唯一账号"认账）。不再写 data/service-config.json，也不再点亮
    // 机器级 MAIL_WATCH_PASS——一份授权码只管一只邮箱。
    let mailResult: Record<string, unknown> | null = null;
    if (legacyMailPass) {
      if (!deps.mailWatchApplyPass) {
        return reply.code(503).send({ ok: false, error: "邮箱接入未接线：请改用 POST /api/mail-watch/pass" });
      }
      mailResult = deps.mailWatchApplyPass({ actorId: requestActor(request), pass: legacyMailPass }) as Record<
        string,
        unknown
      >;
      if (mailResult?.ok !== true) {
        return reply.code(400).send({
          ok: false,
          error: typeof mailResult?.error === "string" ? mailResult.error : "邮箱授权码保存失败",
        });
      }
    }
    const binding = resolvePrimaryExternalModelBinding();
    const mailStatus = (mailResult?.status ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      applied: {
        model: patch.model
          ? {
              providerId: saved?.model?.providerId,
              baseUrl: saved?.model?.baseUrl,
              model: saved?.model?.model,
              keyTail: maskServiceKey(saved?.model?.apiKey),
            }
          : undefined,
        tts: patch.tts
          ? { provider: saved?.tts?.provider, keyTail: maskServiceKey(saved?.tts?.apiKey) }
          : undefined,
        mail: legacyMailPass
          ? {
              configured: Boolean(mailStatus.configured),
              running: Boolean(mailStatus.running),
              persisted: mailResult?.persisted === true,
            }
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
    // 带上音质门禁结果：连通性「绿」不等于音频能听，采样率偏低/坏音频要当场可见
    return {
      ok: true,
      provider: result.provider,
      bytes: result.base64.length,
      quality: result.quality ?? null,
    };
  });
}
