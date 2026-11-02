/**
 * 唯一人格出口契约测试：
 *   - buildPersonaPrompt = 冻结层（agent/SOUL.md）正文 + 称呼行 + 演化层几条默契；
 *   - 演化层每条一句（超量在标点处截断，截不出整句就整条丢）；
 *   - 文件一改（mtime）即重算；
 *   - 周级门禁：changelog 最近一条不足 7 天 → 反思跳过（不调 LLM）。
 * 数据根与 soul 文档都指到临时目录，绝不碰真实 profile。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// getDataDir() 进程内缓存，必须在任何 persona 调用之前定好临时根
const ROOT = join(tmpdir(), `soul-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env.NEXTBOT_DATA_DIR = ROOT;
const SOUL_DOC = join(ROOT, "SOUL.md");
process.env.AGENT_SOUL_PATH = SOUL_DOC;

const { buildPersonaPrompt, maybeRunSoulReflection } = await import("../src/agent/soul-store.js");

const soulDir = join(ROOT, "profile", "soul");
mkdirSync(soulDir, { recursive: true });
const dispositionPath = join(soulDir, "disposition.md");

function writeSoulDoc(text: string): void {
  writeFileSync(SOUL_DOC, text, "utf8");
  // 与上一秒内连续写入时 mtime 可能相同，显式推后确保缓存失效
  const stamp = new Date(Date.now() + 5000);
  utimesSync(SOUL_DOC, stamp, stamp);
}

function writeDisposition(body: string): void {
  writeFileSync(dispositionPath, body, "utf8");
  const stamp = new Date(Date.now() + 10_000);
  utimesSync(dispositionPath, stamp, stamp);
}

test("buildPersonaPrompt：冻结层正文（剥掉 markdown 标题）+ 称呼 + 默契条目", () => {
  writeSoulDoc("# SOUL\n\n我是 NEXTBOT，球形小机器人。\n\n## 说话\n\n有什么说什么。\n");
  writeDisposition("# 处事层\n\n- 默契度: 处熟了，接得住梗\n- 玩笑尺度: 正常\n");
  const prompt = buildPersonaPrompt({ userAlias: "王哥" });
  assert.ok(prompt.startsWith("【人格】"));
  assert.ok(prompt.includes("我是 NEXTBOT，球形小机器人。"));
  assert.ok(prompt.includes("有什么说什么。"));
  assert.equal(prompt.includes("# SOUL"), false, "markdown 标题不进 prompt");
  assert.ok(prompt.includes("对方是你的用户，称呼「王哥」。"));
  assert.ok(prompt.includes("- 默契度: 处熟了，接得住梗"));
  assert.ok(prompt.includes("处出来的默契（自然内化，别复述这几行）"));
});

test("buildPersonaPrompt：名字自我认知行排最前（覆盖冻结层里的默认名）", () => {
  writeSoulDoc("我是 NEXTBOT，一个球形小机器人。\n");
  const prompt = buildPersonaPrompt({ identityLine: "你现在的名字是「小来包」。" });
  const body = prompt.replace(/^【人格】\n/, "");
  assert.ok(body.startsWith("你现在的名字是「小来包」。"), prompt);
});

test("buildPersonaPrompt：演化层条目在标点处截成一句，残句整条丢掉", () => {
  writeSoulDoc("我是 NEXTBOT。\n");
  writeDisposition(
    [
      "# 处事层",
      "",
      "- 默契度: 处熟了，接得住梗",
      // 生产里真出现过的形态：一条值堆成清单，末尾被硬截在半截括号里
      "- 所在城市: 用户所在城市为兴义（天气按这个城市取数，出差另有目的地时先问一句再切换，别拿默认城市硬套",
      // 40 字内没有任何标点 → 截不出分句，整条丢
      "- 共同梗: 我们俩都管楼下那只橘猫叫肥波而且这个称呼已经从线上蔓延到了线下每次提到都忍不住笑出声",
    ].join("\n"),
  );
  const prompt = buildPersonaPrompt();
  assert.ok(prompt.includes("- 默契度: 处熟了，接得住梗"));
  const cityLine = prompt.split("\n").find((l) => l.startsWith("- 所在城市:"));
  assert.ok(cityLine, "所在城市条目应保留截断后的整句");
  const value = cityLine!.slice("- 所在城市:".length + 1);
  assert.ok(value.length <= 40, `截断超量：${value.length}`);
  assert.ok(!value.includes("（"), `不得留半截括号：${value}`);
  assert.equal(prompt.includes("- 共同梗:"), false, "截不出分句的条目应被丢弃");
});

test("buildPersonaPrompt：disposition 手工编辑后跟随更新（mtime 为缓存键）", () => {
  writeSoulDoc("我是 NEXTBOT。\n");
  writeDisposition("# 处事层\n\n- 默契度: 3/5，接得住黑话\n");
  assert.ok(buildPersonaPrompt().includes("- 默契度: 3/5，接得住黑话"));
});

test("未设 AGENT_SOUL_PATH 时回落仓库 agent/SOUL.md（开发态与随包布局）", () => {
  delete process.env.AGENT_SOUL_PATH;
  writeDisposition("# 处事层\n\n- 默契度: 处熟了\n");
  try {
    const prompt = buildPersonaPrompt();
    assert.ok(prompt.startsWith("【人格】"));
    assert.ok(prompt.includes("我是 NEXTBOT"), `冻结层应来自仓库 SOUL.md：${prompt.slice(0, 80)}`);
    assert.ok(prompt.includes("把话说完就停"));
  } finally {
    process.env.AGENT_SOUL_PATH = SOUL_DOC;
  }
});

test("maybeRunSoulReflection：changelog 最近一条不足 7 天 → 冷却跳过", async () => {
  writeSoulDoc("我是 NEXTBOT。\n");
  writeDisposition("# 处事层\n\n- 默契度: 刚认识，还不知道你的雷区在哪\n");
  writeFileSync(
    join(soulDir, "changelog.md"),
    "# 演化日志\n- 2026-10-13 更新:默契度 | 证据:「测试」\n",
    "utf8",
  );
  // now 显式传入：冷却判定必须相对日志日期，否则日历一走测试就烂
  const outcome = await maybeRunSoulReflection({
    transcript: "用户: 测试\nAgent: 好的",
    now: new Date("2026-10-16T00:00:00Z"),
  });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "cooldown");
  // 冷却路径绝不改写 disposition
  assert.match(readFileSync(dispositionPath, "utf8"), /刚认识/);
  assert.ok(existsSync(dispositionPath));
});
