/**
 * 盘点清单「数据面直供」真实模型实测（2026-11-05 二次根改）。
 *
 * 要证明的命题：**版式不再依赖模型配合**。
 *   - 真实模型两次自然输出（prompt 里没有任何盘点格式契约）→ 过真实渲染出口；
 *   - 再人为构造四种极端写法（不写结构 / 自写加粗分组 / 甩裸 JSON / markdown 表格）；
 *   - 六份输入的清单主体必须逐字节一致。
 *
 * 旧口径（编号结构模板）作为对照跑两次，展示「靠 prompt 教版式」的漂移。
 *
 * 用法：cd server && node --import tsx probe-roundup-data-live.ts
 */
import "./src/config/load-server-env.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideRender } from "./src/render/decide.js";
import { getToolResultProcessor } from "./src/services/tool-result-processor.js";
import { RENDER_PROTOCOL_PROMPT } from "./src/services/render-protocol-prompt.js";

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n===== ${s} =====`);

const SYSTEM = (() => {
  try {
    const soul = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "SOUL.md"),
      "utf8",
    );
    return `【人格】\n${soul.trim()}`;
  } catch {
    return "你是用户的私人助理。";
  }
})();

const USER_SAID = "刘浩存最近有什么新动态？";

/** 与生产同形的 search_web 回执；结构数据的唯一来源 */
const SEARCH_RESULT = {
  ok: true,
  items: [
    {
      title: "刘浩存新片《想飞的女孩》定档 12 月 12 日",
      snippet: "由文晏执导，刘浩存、文淇主演，两人饰演一对表姐妹，影片曾入围本届柏林电影节主竞赛单元。",
      source: "SearchApi",
    },
    {
      title: "刘浩存出席品牌活动 谈新角色准备",
      snippet: "11 月 3 日现身上海某品牌活动，受访表示为新片学了三个月现代舞，每天训练 5 小时，「杀青那天哭了」。",
      source: "SearchApi",
    },
    {
      title: "工作室通报维权进展：5 个侵权账号已公开道歉",
      snippet: "10 月 28 日发布维权进展说明，已对 12 个侵权账号取证，其中 5 个已公开道歉并删除内容。",
      source: "SearchApi",
    },
  ],
};

const EFFECTS = [{ tool: "search_web", status: "ok" as const, result: SEARCH_RESULT }];

const OLD_STRATEGY =
  `你已拿到多来源检索结果（3个来源，共1200字符），用户要的是「动态/近况盘点」类汇总。请组织一份信息充分的回答：\n` +
  `1. 按主题分组展开（如：事件进展 / 新作品 / 日常动态），每组用小标题或自然分段\n` +
  `2. 保留具体细节：日期、数字、人名、作品名、原话——这些是用户最想看的\n` +
  `3. 多条结果讲同一件事时合并为一个条目；不同事件不要遗漏\n` +
  `4. 结尾一句话自然收束；篇幅与信息量匹配，信息多就写充分，不要人为压缩成几句话`;
const NEW_STRATEGY = `（工具结果：3个成功，共1200字符）数据够了，直接答。`;
const BASE = `工具结果已返回，直接回答用户的问题。`;

async function callModel(strategy: string, extraSystem = "") {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL?.trim() || "deepseek-chat";
  const res = await fetch(
    `${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        messages: [
          { role: "system", content: extraSystem ? `${SYSTEM}\n\n${extraSystem}` : SYSTEM },
          { role: "user", content: USER_SAID },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search_web", arguments: JSON.stringify({ query: USER_SAID }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: JSON.stringify(SEARCH_RESULT) },
          { role: "user", content: `${BASE}\n\n【本轮数据】${strategy}` },
        ],
      }),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "(空)";
}

/** 生产出口：finalText（已净化）→ 渲染层（effects 造清单）→ 用户可见 */
function throughPipeline(
  text: string,
  effects: typeof EFFECTS | undefined = EFFECTS,
): { visible: string; scene: string; shape: string; list: string } {
  const out = getToolResultProcessor()
    .processAssistantText(text, { userText: USER_SAID, effects })
    .trim();
  const decision = decideRender({ text, userText: USER_SAID, effects });
  const shape = out
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (!t) return "";
      if (/^\*\*[^*]+\*\*$/.test(t)) return "H";
      if (/^[-*•]\s/.test(t)) return "L";
      return "P";
    })
    .filter(Boolean)
    .join("");
  const i = out.indexOf("**要点**");
  // 只比清单主体（到下一个空行段为止），尾部的语气句不属于版式
  const rest = i >= 0 ? out.slice(i) : "";
  const list = rest.split(/\n\s*\n/)[0];
  return { visible: out, scene: decision.scene?.id ?? "none", shape, list };
}

async function main() {
  h("注入量（同口径：base + 策略 + 展示协议）");
  line(`旧口径（编号结构模板）：${BASE.length + OLD_STRATEGY.length} 字`);
  line(`上一版（槽位契约）：${BASE.length + NEW_STRATEGY.length + RENDER_PROTOCOL_PROMPT.length + 473} 字`);
  line(`现在（数据面直供）：${BASE.length + NEW_STRATEGY.length + RENDER_PROTOCOL_PROMPT.length} 字`);
  line(`展示协议含盘点格式契约：${/AGENT_DIGEST|groups|盘点分组/.test(RENDER_PROTOCOL_PROMPT)}`);

  h("A 旧口径：真实模型两次（靠 prompt 教版式）");
  const a1 = await callModel(OLD_STRATEGY);
  const a2 = await callModel(OLD_STRATEGY);
  const a1p = throughPipeline(a1, undefined);
  const a2p = throughPipeline(a2, undefined);
  line(`A1 结构签名 ${a1p.shape} / A2 ${a2p.shape} → ${a1p.shape === a2p.shape ? "一致" : "不一致"}`);

  h("B 新口径：真实模型两次（prompt 里没有任何盘点契约）");
  const b1 = await callModel(NEW_STRATEGY, RENDER_PROTOCOL_PROMPT);
  const b2 = await callModel(NEW_STRATEGY, RENDER_PROTOCOL_PROMPT);
  const b1p = throughPipeline(b1);
  const b2p = throughPipeline(b2);
  line("--- B 第 1 次 · 模型原稿（前 260 字）---");
  line(b1.slice(0, 260));
  line("--- B 第 1 次 · 出口 finalText（含形态声明，客户端解析）---");
  line(b1p.visible);
  line("--- B 第 2 次 · 出口 finalText ---");
  line(b2p.visible);
  line(`B1/B2 场景：${b1p.scene} / ${b2p.scene}`);
  line(`B1/B2 结构签名：${b1p.shape} / ${b2p.shape} → ${b1p.shape === b2p.shape ? "一致" : "不一致"}`);

  h("关键证据：六种模型写法 → 清单主体逐字节一致");
  const variants: Array<[string, string]> = [
    ["B1 真实输出", b1],
    ["B2 真实输出", b2],
    ["只写语气", "她最近重心明显在电影上。"],
    ["自写加粗分组", "**新片**\n- 定档 12 月 12 日\n\n**维权**\n- 5 个账号道歉"],
    ["甩裸 JSON", '{"summary":"两件事","groups":[{"title":"新片","items":["a"]}]}'],
    ["markdown 表格", "## 汇总\n| 项目 | 值 |\n| --- | --- |\n最值得盯的是那部片子。"],
  ];
  const lists: string[] = [];
  for (const [label, text] of variants) {
    const p = throughPipeline(text);
    lists.push(p.list);
    line(
      `   ${label.padEnd(16, " ")} 场景=${p.scene.padEnd(15, " ")} ` +
        `裸JSON=${p.visible.includes('"groups"')} 自写标题=${p.visible.includes("**新片**") || p.visible.includes("## 汇总")} ` +
        `清单长度=${p.list.length}`,
    );
  }
  line(`六种写法的清单版式种类数：${new Set(lists).size}（1 = 完全不依赖模型配合）`);
  line(`清单是否全部非空：${lists.every((s) => s.startsWith("**要点**"))}`);
}

main().catch((e) => {
  console.error(`跳过或失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
