/**
 * 全局 undici HTTP Agent 配置。
 *
 * 解决问题：对话中频繁出现 undici Parser 抛出 `AssertionError [ERR_ASSERTION]: false == true`，
 * 根因是对端（LLM API 等）在响应未完成时关闭 TLS socket，undici parser 同步抛出断言错误。
 * 默认全局 dispatcher 无法控制连接池超时、keepAlive 时长、strictContentLength 等参数。
 *
 * 本模块创建一个配置化的 Agent 并通过 `setGlobalDispatcher` 设为全局，
 * 影响 Node 内置 `fetch` / OpenAI SDK / 所有裸 fetch 调用。
 *
 * 关键参数说明：
 *  - `strictContentLength: false`：undici 6.x 默认 true，当响应 body 实际字节数与
 *    content-length 不匹配时抛断言错误。设为 false 可避免这类 parser 崩溃。
 *  - `keepAliveTimeout`：空闲连接保持时间，低于对端超时可降低复用已死连接的概率。
 *  - `connect.timeout`：TCP 握手超时，防止对端不可达时无限等待。
 *  - `headersTimeout`：响应 headers 传输超时。
 *  - `bodyTimeout`：响应 body 传输超时；流式 LLM 调用有独立的 idle timeout（30s）兜底，
 *    此处设 300s 仅作非流式请求的全局上限。
 */

import { Agent, setGlobalDispatcher } from "undici";

export function setupGlobalHttpAgent(): void {
  const agent = new Agent({
    // 每个目标 origin 的最大并发连接数（默认 10，对话高峰期 LLM + 各工具并发请求较多）
    connections: process.env.HTTP_AGENT_MAX_CONNECTIONS
      ? Number.parseInt(process.env.HTTP_AGENT_MAX_CONNECTIONS, 10)
      : 64,

    // 空闲连接保持时间（ms）。2026-11-01 提速：原 3000 太短——一轮回复里
    // 「主波 → 工具执行 5s → 第二波」的空档必然超过 3s，每个波次都要重新
    // TCP+TLS 握手（国内到 api.deepseek.com 实测 0.2~1s）。调到 15s 覆盖
    // 常规工具间隔；真正的 stale 连接仍由 keepAliveMaxTimeout 与请求失败重试兜底。
    keepAliveTimeout: 15_000,

    // 空闲连接最大存活时间（ms）。默认 600_000（10min）。
    // 设为 60_000：既避免长连接退化，又不至于每轮都重建连接。
    keepAliveMaxTimeout: 60_000,

    // TCP 连接超时（ms）。默认 10_000。
    connect: {
      timeout: 10_000,
    },

    // 响应 headers 传输超时（ms）。默认 300_000。
    // 设为 60_000，LLM 首字节通常在几秒内返回，60s 足够。
    headersTimeout: 60_000,

    // 响应 body 传输超时（ms）。默认 300_000。
    // 流式 LLM 调用有独立的 StreamIdleTimeoutError（30s）兜底，此处 300s 仅作全局上限。
    bodyTimeout: 300_000,

    // 关键：关闭严格 content-length 校验。
    // undici 6.x 默认 strictContentLength: true，当实际 body 字节数与 Content-Length 头不一致时
    // 会在 Parser.finish 抛出 AssertionError。对端代理/CDN 偶发的 content-length 偏差会导致此错误。
    // 设为 false 后 undici 会容忍不匹配，不再抛断言错误。
    strictContentLength: false,
  });

  setGlobalDispatcher(agent);

  if (process.env.HTTP_AGENT_DEBUG === "1") {
    console.log(
      "[http-agent] 全局 undici Agent 已配置: " +
        `connections=${agent.constructor.name}, ` +
        `keepAliveTimeout=3000ms, strictContentLength=false`,
    );
  }
}
