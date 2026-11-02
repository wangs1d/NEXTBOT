import type { FastifyInstance } from "fastify";
import { AccessAuthService } from "../services/access-auth-service.js";
import { isAccessAuthRequired } from "../config/env.js";
import type { DuplexSocketLike, VoiceDuplexService } from "../services/voice-duplex/voice-duplex-service.js";

/**
 * 全双工语音 WS 路由：/ws/voice-duplex
 *
 * 协议见 services/voice-duplex/protocol.ts（JSON 文本帧，音频 base64 PCM）。
 * 连接建立后交给 VoiceDuplexService.attach 管理生命周期。
 *
 * ACCESS_AUTH_REQUIRED=1 时握手即验设备 token：实时语音直接烧运营方引擎额度，
 * 裸路径不能留成无凭证的计费入口；验过的归属同时钉死会话 actorId。
 */
export function registerVoiceDuplexWsRoute(
  app: FastifyInstance,
  service: VoiceDuplexService,
  deps: { accessAuthService?: AccessAuthService } = {},
): void {
  app.get("/ws/voice-duplex", { websocket: true }, (socket, request) => {
    const ws = socket as unknown as DuplexSocketLike;
    if (!isAccessAuthRequired() || !deps.accessAuthService) {
      service.attach(ws);
      return;
    }
    const query = (request.query ?? {}) as { token?: string };
    const token = AccessAuthService.extractToken({
      authorization: request.headers.authorization,
      queryToken: query.token,
    });
    const verified = token ? deps.accessAuthService.verifyToken(token) : null;
    if (!verified) {
      try {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "服务已开启访问鉴权：/ws/voice-duplex 需在连接 query 携带有效 token（POST /api/auth/bind 获取）",
            recoverable: false,
          }),
        );
        ws.close(1008, "auth_required");
      } catch {
        // 连接已断：忽略
      }
      return;
    }
    service.attach(ws, verified.userId);
  });
}
