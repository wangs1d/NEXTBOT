/**
 * 统一渲染出口协议验收（P1/P2，2026-11-07）。
 *
 * 四道机器门，把「新增形态能不能正常返回」从人工检查变成 CI 判定：
 *   1. 可逆门：projectToText(decodeLegacyText(t)) === t（历史载荷逐字节不变）；
 *   2. 差分门：信封投影的 done 字段与升级前手工展开逐字段一致；
 *   3. 单入口门：decideRender / applyBodyForm / applyCards 只经 renderTurn；
 *   4. 恒返回门：任意畸形输入都至少一个 text 块、finalText 不丢、降级可诊断。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRenderEnvelope,
  decodeLegacyText,
  projectToText,
  projectToSpeech,
  encodeCardBlock,
  encodeFormBlock,
  expandEnvelopeToDoneFields,
  compactEnvelopeForWire,
} from "../src/render/protocol.js";
import { renderTurn } from "../src/render/turn.js";
import { collectCardPayloads } from "../src/render/cards.js";
import { buildReplyBlocks } from "../src/services/reply-envelope.js";

/** 与 cwd 无关：测试可从仓库根或 server/ 目录任一位置运行 */
const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 剥掉行注释与块注释，避免文档里的伪代码被单入口门误计 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CARD = (cardType: string) =>
  `[AGENT_RESULT_CARD_START]\n{"cardType":"${cardType}","title":"示例","items":[{"type":"num","text":"一条"}]}\n[AGENT_RESULT_CARD_END]`;

/** 1. 可逆门：任意文本都能无损往返 */
test("可逆门：projectToText(decodeLegacyText(t)) 逐字节还原任意文本", () => {
  const samples = [
    "",
    "一句很普通的话。",
    "第一段。\n\n第二段，带 *markdown* 和 [链接](https://x.y)。\n",
    `[RENDER_AS:structured]\n## 标题\n\n- 一条\n- 二条\n`,
    `前导\n\n${CARD("weather")}\n\n收尾`,
    `${CARD("a")}\n${CARD("b")}`,
    `[RENDER_AS:brief]\n${CARD("schedule")}`,
    "[AGENT_RESULT_CARD_START]\n{broken json\n[AGENT_RESULT_CARD_END]",
    "[AGENT_RESULT_CARD_START]\n{坏块",
    "正文里写了个字面的 [RENDER_AS:structured] 不该被吃掉",
    "[CONTENT_SUMMARY_V2_START]\n{\"title\":\"摘要\",\"detailContent\":\"全文\"}\n[CONTENT_SUMMARY_V2_END]\n尾巴",
    "[DATA_BRIEF_START]\n{\"title\":\"快报\"}\n[DATA_BRIEF_END]",
    "  前后空格  \n\n",
    "[IMAGE_RESULT_START]\n{\"items\":[{\"caption\":\"一张照片\"}]}\n[IMAGE_RESULT_END]",
    "\n\n\n",
  ];
  for (const sample of samples) {
    const blocks = decodeLegacyText(sample);
    assert.equal(projectToText(blocks), sample, `往返失败: ${JSON.stringify(sample.slice(0, 60))}`);
    assert.ok(blocks.length > 0, "恒至少一个块");
  }
});

/** 新建路径：由结构化数据直接造块，也能确定性投影 */
test("新建路径：encodeCardBlock / encodeFormBlock 可独立产出信封", () => {
  const blocks = [
    ...encodeFormBlock("structured", "## 标题\n\n正文"),
    encodeCardBlock({ cardType: "schedule", title: "日程", items: [{ text: "一项" }] }),
  ];
  const text = projectToText(blocks);
  assert.match(text, /^\[RENDER_AS:structured\]\n/);
  assert.match(text, /\[AGENT_RESULT_CARD_START\]/);
  assert.equal(projectToText(decodeLegacyText(text)), text);
  assert.equal(projectToSpeech(decodeLegacyText(text)), "## 标题\n\n正文");
});

/** 2. 差分门：done 字段与升级前手工展开一致 */
test("差分门：信封展开与旧字段手工派生逐字段一致（输出零变更）", () => {
  const cases = [
    {
      name: "纯文本轮",
      finalText: "好的，已经记下了。",
      mediaCards: [],
      renderBlocks: [],
      followups: [],
    },
    {
      name: "带卡轮",
      finalText: `定好了。\n\n${CARD("reminder_confirm")}\n\n到点叫你。`,
      mediaCards: [],
      renderBlocks: [],
      followups: ["改个时间"],
    },
    {
      name: "结构化形态轮",
      finalText: "[RENDER_AS:structured]\n## 一行一个对象\n\n| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |",
      mediaCards: [],
      renderBlocks: [],
      followups: [],
    },
    {
      name: "带媒体轮",
      finalText: "照片给你。",
      mediaCards: [{ type: "image", title: "一张", thumbnailUrl: "/m/1.png" }],
      renderBlocks: [{ type: "text", text: "照片给你。" }],
      followups: [],
    },
    {
      name: "坏 JSON 卡轮",
      finalText: "前导\n\n[AGENT_RESULT_CARD_START]\n{坏\n[AGENT_RESULT_CARD_END]",
      mediaCards: [],
      renderBlocks: [],
      followups: [],
    },
  ];

  for (const c of cases) {
    const envelope = buildRenderEnvelope({
      finalText: c.finalText,
      mediaCards: c.mediaCards as never,
      renderBlocks: c.renderBlocks,
      followups: c.followups,
      legacyBlocks: buildReplyBlocks(c.finalText, c.renderBlocks as never),
    });

    assert.equal(envelope.finalText, c.finalText, `${c.name}: finalText 必须逐字节不变`);

    // 旧实现的手工展开
    const oldCards = collectCardPayloads(c.finalText);
    const oldBlocks = buildReplyBlocks(c.finalText, c.renderBlocks as never);
    const expected: Record<string, unknown> = {
      finalText: c.finalText,
      ...(c.mediaCards.length > 0 ? { mediaCards: c.mediaCards } : {}),
      ...(c.renderBlocks.length > 0 ? { renderBlocks: c.renderBlocks } : {}),
      ...(oldCards.length > 0 ? { cards: oldCards } : {}),
      ...(oldBlocks && oldBlocks.length > 0 ? { blocks: oldBlocks } : {}),
      ...(c.followups.length > 0 ? { followups: c.followups } : {}),
    };
    assert.deepEqual(expandEnvelopeToDoneFields(envelope), expected, `${c.name}: done 字段漂移`);
    assert.equal(envelope.version, 2);
    assert.ok(envelope.blocks.length > 0);
    assert.equal((compactEnvelopeForWire(envelope) as { version: number }).version, 2);
    // 线格式不带 raw（不重复传正文）
    const wireBlocks = (compactEnvelopeForWire(envelope) as { blocks: Array<Record<string, unknown>> }).blocks;
    assert.ok(wireBlocks.every((b) => !("raw" in b)));
  }
});

/** 3. 降级门：v1 不认识的形态绝不下发 blocks（防新客户端优先 blocks 丢内容） */
test("降级门：含 v1 不支持形态时 blocks 整体不下发，finalText 仍完整", () => {
  const withVideo = buildRenderEnvelope({
    finalText: "[RENDER_AS:video]\n[VIDEO_MEDIA_START]\n{\"mediaType\":\"video\"}\n[VIDEO_MEDIA_END]",
    legacyBlocks: [{ type: "text", text: "会丢内容的旧块" }],
  });
  assert.equal(withVideo.meta.v1Compatible, false);
  assert.equal(withVideo.legacy.blocks, null);
  assert.equal(withVideo.finalText.includes("[RENDER_AS:video]"), true);
  assert.deepEqual(withVideo.meta.forms, ["video"]);

  const plain = buildRenderEnvelope({
    finalText: "正常一句话",
    legacyBlocks: [{ type: "text", text: "正常一句话" }],
  });
  assert.equal(plain.meta.v1Compatible, true);
  assert.equal(plain.legacy.blocks?.length, 1);
});

/** 4. 单入口门：全项目只有 renderTurn 调用三件套 */
test("单入口门：decideRender / applyBodyForm / applyCards 生产调用点唯一", () => {
  const calls: Record<string, string[]> = {
    decideRender: [],
    applyBodyForm: [],
    applyCards: [],
  };
  for (const file of listTsFiles(SRC_ROOT)) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const fn of Object.keys(calls)) {
      const re = new RegExp(`(?<![\\w.])${fn}\\s*\\(`, "g");
      const hits = src.match(re);
      if (!hits) continue;
      for (let i = 0; i < hits.length; i++) calls[fn].push(file);
    }
  }
  for (const [fn, files] of Object.entries(calls)) {
    // 定义处 1 次 + turn.ts 内调用（applyCards 在两处 mode 分支各 1 次）
    const definitionHits = files.filter((f) => f.endsWith(`${fn === "decideRender" ? "decide" : fn === "applyBodyForm" ? "body" : "cards"}.ts`)).length;
    const turnHits = files.filter((f) => f.endsWith(join("render", "turn.ts"))).length;
    assert.equal(files.length, definitionHits + turnHits, `${fn} 出现新调用点: ${files.join(",")}`);
    assert.ok(turnHits > 0, `${fn} 必须经 renderTurn`);
  }
});

/** 5. 恒返回门：畸形输入 × 两种模式都给落点 */
test("恒返回门：renderTurn 在畸形输入下不抛异常且恒有正文落点", () => {
  const malformed: Array<Record<string, unknown>> = [
    { text: "" },
    { text: "   " },
    { text: "[AGENT_RESULT_CARD_START]\n{bad\n[AGENT_RESULT_CARD_END]" },
    { text: "正文", effects: undefined, payloads: null },
    { text: "正文", modelHint: "不存在的形态", userText: undefined },
  ];
  for (const input of malformed) {
    for (const mode of ["full", "cards-only"] as const) {
      const result = renderTurn(input as never, mode);
      assert.equal(typeof result.text, "string");
      assert.ok(result.envelope.blocks.some((b) => b.type === "text"), "必须至少一个 text 块");
      assert.equal(result.envelope.finalText, result.text);
      assert.ok(Array.isArray(result.envelope.meta.failures));
    }
  }
});

/** 6. 两种模式语义：cards-only 不重跑正文形态、不整体换稿 */
test("renderTurn 模式门：cards-only 只补卡，正文形态由 full 模式决定", () => {
  const base = { text: "一句话结论。", userText: "随便聊聊" };
  const full = renderTurn(base, "full");
  const cardsOnly = renderTurn(base, "cards-only");
  assert.equal(cardsOnly.text, base.text, "cards-only 不得改写已定稿正文");
  assert.equal(full.text, base.text, "闲聊轮 full 也不得平白加标记");
  assert.equal(full.mode, "full");
  assert.equal(cardsOnly.mode, "cards-only");
});
