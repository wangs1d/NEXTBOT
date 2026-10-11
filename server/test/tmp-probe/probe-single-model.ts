/**
 * 单模型配置实测探针：不搞双模型，各自只配一把密钥，路由跟随主模型。
 *
 *   场景 A｜纯 DeepSeek：只留 OPENAI_API_KEY（指向 DeepSeek）→
 *     主模型=deepseek-flash，路由同模型（快档案 192/3s）。
 *   场景 B｜纯 MiniMax：只留 MINIMAX_API_KEY →
 *     主模型=MiniMax-M3，路由同模型（思考档案 1024/5s）。
 *
 * 每场景测两件事：① 路由判定（闲聊/实时/个人数据）；② 主模型直答（活人感）。
 * 用法（server 目录下）：node --import tsx test/tmp-probe/probe-single-model.ts
 * 零宽后缀区分场景缓存键，防路由缓存串场。
 */
import "../../src/config/load-server-env.js";
import { createExternalChatProviderFromEnv } from "../../src/external-model/resolve-provider.js";
import { routeTurnByLlm } from "../../src/agent/llm-task-router.js";
import type { ExternalChatProvider } from "../../src/external-model/types.js";

const ROUTE_CASES = [
  "你知道我的老婆是谁吧",
  "在吗",
  "今天真的好累啊不想动",
  "今天天气怎么样",
  "帮我看看我的快递到哪了",
  "比特币现在什么价",
] as const;

const CHAT_CASES = ["你知道我的老婆是谁吧", "今天真的好累啊不想动"] as const;

/** 在 env 沙箱内构造"只配一把密钥"的 provider（用后恢复）。
 *  EXTERNAL_MODEL_PROVIDER 必须一并覆盖：.env.local 显式 pin 的主模型在被删密钥
 *  后会整体禁用（显式模式不落 auto 链），单模型场景需显式指定存活的 provider。 */
function withSingleKey(
  mode: "openai" | "minimax",
  removedKey: "OPENAI_API_KEY" | "MINIMAX_API_KEY",
  fn: (main: ExternalChatProvider | null) => Promise<void>,
): Promise<void> {
  const savedMode = process.env.EXTERNAL_MODEL_PROVIDER;
  const saved = process.env[removedKey];
  process.env.EXTERNAL_MODEL_PROVIDER = mode;
  delete process.env[removedKey];
  return fn(createExternalChatProviderFromEnv()).finally(() => {
    if (savedMode !== undefined) process.env.EXTERNAL_MODEL_PROVIDER = savedMode;
    else delete process.env.EXTERNAL_MODEL_PROVIDER;
    if (saved !== undefined) process.env[removedKey] = saved;
  });
}

async function runRoutes(
  label: string,
  route: ExternalChatProvider | null,
  bust: string,
): Promise<void> {
  for (const c of ROUTE_CASES) {
    const t0 = Date.now();
    const d = await routeTurnByLlm(route as ExternalChatProvider, "probe-single", c + bust);
    const ok = d.plane === "chat" || d.intent ? "" : " <?>";
    console.log(
      `[${label}] "${c}" → plane=${d.plane} intent=${d.intent ?? "-"} conf=${d.confidence?.toFixed(2) ?? "-"}（${Date.now() - t0}ms）${ok}${d.plane === "task" && !d.intent ? " ⚠️降级" : ""}`,
    );
  }
}

async function runChat(
  label: string,
  main: ExternalChatProvider | null,
  bust: string,
): Promise<void> {
  for (const c of CHAT_CASES) {
    const t0 = Date.now();
    const reply = await (main as ExternalChatProvider).streamCompletion(
      `probe-single-chat${bust}`,
      { text: c + bust },
      () => {},
      undefined,
      { ephemeralTurn: true, toolExposureProfile: "none", maxOutputTokens: 800 },
    );
    const text = (reply ?? "").trim();
    console.log(
      `[${label}] "${c}"（${Date.now() - t0}ms）\n       → ${text.slice(0, 90)}${text.length > 90 ? "…" : ""}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("═══ 场景 A｜纯 DeepSeek（只配 OPENAI_API_KEY）═══");
  await withSingleKey("openai", "MINIMAX_API_KEY", async (mainProvider) => {
    if (!mainProvider?.isEnabled()) throw new Error("DeepSeek 主模型未启用");
    console.log(`主模型=路由=${mainProvider.id}（单模型）\n`);
    await runRoutes("A·路由", mainProvider, "\u200B");
    console.log("");
    await runChat("A·直答", mainProvider, "\u200B");
  });

  console.log("\n═══ 场景 B｜纯 MiniMax（只配 MINIMAX_API_KEY）═══");
  await withSingleKey("minimax", "OPENAI_API_KEY", async (mainProvider) => {
    if (!mainProvider?.isEnabled()) throw new Error("MiniMax 主模型未启用");
    console.log(`主模型=路由=${mainProvider.id}（单模型）\n`);
    await runRoutes("B·路由", mainProvider, "\u200B\u200B");
    console.log("");
    await runChat("B·直答", mainProvider, "\u200B\u200B");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
