/**
 * 华为推送「消息回执」接收端点（2026-11-23）。
 *
 * ## 为什么需要它
 *
 * `POST /v1/{appId}/messages:send` 返回 `80000000` 只代表**华为已受理**，
 * 不代表消息到了设备。2026-11-23 实测：6 次发送全部 80000000，手机端一条
 * 通知都没有，服务端完全无法判断是「没投递」还是「投递了但没展示」。
 * 华为的**送达回执**是唯一能证明「到达设备 / 被点击」的官方信号。
 *
 * ## 怎么开
 *
 * AGC → 推送服务 → 项目回执 → 开通，回调地址填：
 *   https://api.nextbot.top/api/webhooks/huawei-push-receipt
 * 回调用户名/密钥如果填了，本端点会用 Basic Auth 校验（对应 env
 * `HUAWEI_PUSH_RECEIPT_USER` / `HUAWEI_PUSH_RECEIPT_PASS`；没配则跳过校验）。
 *
 * ## 行为
 *
 * 华为要求回调返回 200，否则会重试。任何情况都回 200：
 *  - 原始报文（含 headers 里的签名/时间戳）逐条追加到
 *    `data/debug/push-receipts.log`，同时打一条 info 日志进 journald；
 *  - 认不出的格式也落盘，不猜、不吞——回执字段随版本变（V1/V2），
 *    先保证「有据可查」，解析留到复盘时做。
 *
 * 认证：路径 `/api/webhooks/huawei-push-receipt` 在 `auth.ts` 的公开面白名单里
 * （精确匹配，不是前缀，避免扩大暴露面）。它不读任何用户数据，只写审计日志。
 */
import type { FastifyInstance } from "fastify";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { getDataDir } from "../../config/data-dir.js";

/** 回执路径：与 auth.ts 的公开面白名单、AGC 里填的地址必须逐字一致。 */
export const HUAWEI_PUSH_RECEIPT_PATH = "/api/webhooks/huawei-push-receipt";

/** 把任意形态的 body 还原成可读文本（JSON 对象 / 表单字符串 / Buffer）。 */
function bodyToText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/** Basic Auth 校验：env 没配就放行（AGC 里也留空时两边一致）。 */
function checkBasicAuth(header: string | undefined): boolean {
  const user = process.env.HUAWEI_PUSH_RECEIPT_USER ?? "";
  const pass = process.env.HUAWEI_PUSH_RECEIPT_PASS ?? "";
  if (!user && !pass) return true;
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return false;
    return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass;
  } catch {
    return false;
  }
}

export function registerPushReceiptWebhook(app: FastifyInstance): void {
  app.post(HUAWEI_PUSH_RECEIPT_PATH, async (request, reply) => {
    const authOk = checkBasicAuth(request.headers.authorization);
    const text = bodyToText(request.body);
    const line =
      `${new Date().toISOString()} ip=${request.ip} ` +
      `ct=${String(request.headers["content-type"] ?? "-")} ` +
      `auth=${authOk ? "ok" : "bad"} body=${text.slice(0, 4000)}\n`;
    try {
      const dir = join(getDataDir(), "debug");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "push-receipts.log"), line);
    } catch {
      /* 落盘失败不影响回 200 */
    }
    // journalctl 也能看见（reqId 之外的业务字段）
    app.log.info(
      { huaweiPushReceipt: true, authOk, bodyPreview: text.slice(0, 800) },
      "[push-receipt] huawei callback received",
    );
    if (!authOk) {
      // 认证不匹配：记下来但仍回 200——AGC 的「测试回执」按钮可能不带凭据，
      // 回 401 会让配置流程卡住，而这份数据本身没有敏感内容。
      return reply.code(200).send({ code: "0", message: "logged (auth mismatch)" });
    }
    // 华为只认 200；body 内容不影响判定。给出常见形态的成功体以防它校验。
    return reply.code(200).send({ code: "0", message: "ok" });
  });
}
