// SpeechHub 统一出口架构闸（源码级防回归，2026-10-26）。
//
// 背景：away_return 曾绕开统一通路把「提示词材料」直投给用户；SpeechPolisher
// 退役后若有人再开旁路（散装 system prompt / 直接 streamCompletion 写主动话术），
// 表达层就会重新漂移。本测试用源码扫描把三条不变量钉死：
//   ① 旧表达层标识符清零（SpeechPolisher / speech-polisher / PROACTIVE_SYSTEM_PROMPT /
//      散装 soulPrompt dep）——注释除外（新模块的历史沿革注释允许提及）。
//   ② SpeechHub 在 bootstrap 唯一实例化，且 outreach executor 经 `speech` 依赖取
//      system 装配（full 档不自带人格）。
//   ③ 主动开口的 LLM 出口仅两处：light = speech-express（auditStage proactive_phrase，
//      ephemeral 不落线程）；full = proactive-outreach-executor（thread 前缀 proactive:，
//      写回线程供记忆召回）。出现第三个出口即架构漂移。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SERVER_ROOT = process.cwd();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listTsFiles(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

// 只剥行注释（不做块注释剥离：bootstrap 里字符串/注释里的 `/*` 会伪造块注释
// 吞掉大段代码，导致守卫误报；行注释足够覆盖本闸的断言需求）
const stripLineComments = (src: string): string =>
  src
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'])\/\/.*$/, "$1"))
    .join("\n");

test("架构闸①：旧表达层标识符清零（代码内，注释豁免）", () => {
  const files = listTsFiles(join(SERVER_ROOT, "src"));
  const offenders: string[] = [];
  for (const f of files) {
    const code = stripLineComments(readFileSync(f, "utf8"));
    if (/SpeechPolisher|speech-polisher|PROACTIVE_SYSTEM_PROMPT|soulPrompt/.test(code)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `旧表达层残留: ${offenders.join(", ")}`);
});

test("架构闸②：SpeechHub 唯一实例化 + executor 经依赖取装配", () => {
  const bootstrap = readFileSync(join(SERVER_ROOT, "src/bootstrap/create-app-services.ts"), "utf8");
  const code = stripLineComments(bootstrap);
  const instantiations = code.match(/new SpeechHub\(/g)?.length ?? 0;
  assert.equal(instantiations, 1, "bootstrap 只装配一个 SpeechHub");
  assert.ok(code.includes("speech: speechHub"), "executor 的 full 档经依赖注入取装配");

  const executor = readFileSync(join(SERVER_ROOT, "src/proactivity/proactive-outreach-executor.ts"), "utf8");
  const execCode = stripLineComments(executor);
  assert.ok(execCode.includes("deps.speech.buildSystemPrompt"), "executor system 装配走 SpeechHub");
  assert.ok(!/你是用户的私人助理/.test(execCode), "executor 不再自带硬编码人设提示词");
});

test("架构闸③：主动开口 LLM 出口仅两处（light / full）", () => {
  const speechExpress = readFileSync(join(SERVER_ROOT, "src/proactivity/speech-express.ts"), "utf8");
  assert.equal(
    stripLineComments(speechExpress).match(/auditStage: "proactive_phrase"/g)?.length ?? 0,
    1,
    "light 档唯一出口（proactive_phrase 记账）",
  );
  assert.ok(speechExpress.includes("ephemeralTurn: true"), "light 档不落线程");

  // 全 src 扫描：auditStage proactive_phrase 只许出现在 speech-express.ts
  const files = listTsFiles(join(SERVER_ROOT, "src"));
  const leaked: string[] = [];
  for (const f of files) {
    if (f.endsWith("speech-express.ts")) continue;
    if (readFileSync(f, "utf8").includes('auditStage: "proactive_phrase"')) leaked.push(f);
  }
  assert.deepEqual(leaked, [], `proactive_phrase 记账外泄: ${leaked.join(", ")}`);

  const executor = readFileSync(join(SERVER_ROOT, "src/proactivity/proactive-outreach-executor.ts"), "utf8");
  assert.ok(executor.includes("`proactive:${signal.actorId}`") || executor.includes("`proactive:"), "full 档写回线程（executor 专属）");
});
