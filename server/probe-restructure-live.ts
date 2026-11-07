/**
 * 架构收敛前后对比实测（2026-11-05）。
 *
 * 同一份模拟搜索结果，分别用【旧指令】（质量分档编号结构 + 修辞导演词）与
 * 【新指令】（数据事实 + 一句底线）调用真实模型，比较回复形态。
 * 只比 prompt 的差异，其余链路（人格/出口净化）两边一致。
 */
import "./src/config/load-server-env.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n===== ${s} =====`);

const SYSTEM = (() => {
  try {
    const soul = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "SOUL.md"), "utf8");
    return `【人格】\n${soul.trim()}`;
  } catch {
    return `你是用户的私人助理。`;
  }
})();

const USER_SAID = "刘浩存最近有什么新动态？";

// 模拟 search_web 富结果（两条来源、含日期数字，足以触发 high 档）
const SEARCH_RESULT = {
  ok: true,
  items: [
    {
      title: "刘浩存新片《想飞的女孩》定档 2026 年 12 月 12 日",
      snippet: "由文晏执导，刘浩存、文淇主演的《想飞的女孩》宣布定档 12 月 12 日全国上映，两人饰演一对表姐妹，影片曾入围本届柏林电影节主竞赛单元。",
    },
    {
      title: "刘浩存出席品牌活动 谈新角色 preparation",
      snippet: "11 月 3 日刘浩存现身上海某品牌活动，受访时表示为新片学了三个月现代舞，每天训练 5 小时，「杀青那天哭了」。",
    },
  ],
};

// 旧口径：旧 baseDirective（修辞导演词）+ 旧 layered_progressive/digest 指令
const OLD_BASE =
  `刚才调用工具拿到了以下结果，请基于这些结果回答用户的问题：语气自然像朋友，但内容要充分、结构清晰。` +
  `不要重复工具调用过程，直接给出结论。如果结果不完整，就给出能确定的部分。` +
  `同一事实不要换个说法再总结第二遍；把检索到的信息组织充分：按主题分节，用 Markdown 小标题/加粗/表格排版，` +
  `保留日期、数字、来源等细节，不要为了简短丢掉用户想看的内容。`;
const OLD_STRATEGY =
  `你已通过工具收集到充分的数据（2个来源，2种工具）。请按以下策略组织回复：\n` +
  `1. 直接给出核心信息，不要铺垫\n` +
  `2. 如有必要，补充关键细节（数据/时间/人物/地点等），不要罗列来源与网址\n` +
  `3. 合并多源冗余信息，只保留最有价值的部分\n` +
  `4. 用自然的口语表述，不要罗列工具调用过程\n` +
  `5. 信息用足、组织充分（可按主题分节），同一事实不要换句话重复第二遍`;

// 新口径：收敛后的最小指令
const NEW_BASE = `工具结果已返回，直接回答用户的问题。`;
const NEW_STRATEGY = `（工具结果：2个来源成功） 结果够了，直接回答；数据不足以确定的部分直说，不要编。`;

async function callModel(base: string, strategy: string) {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL?.trim() || "deepseek-chat";
  const res = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER_SAID },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: USER_SAID }) } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: JSON.stringify(SEARCH_RESULT) },
        { role: "user", content: base + `\n\n【回复策略】${strategy}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "(空)";
}

async function main() {
  h("prompt 体量对比（注入给模型的字符数）");
  const oldLen = OLD_BASE.length + OLD_STRATEGY.length;
  const newLen = NEW_BASE.length + NEW_STRATEGY.length;
  line(`旧（base+策略）：${oldLen} 字`);
  line(`新（base+策略）：${newLen} 字（约 ${Math.round((1 - newLen / oldLen) * 100)}% 削减）`);

  h("真实模型对比（deepseek，同一份搜索结果，同一人格）");
  const oldOut = await callModel(OLD_BASE, OLD_STRATEGY);
  line("--- 旧口径 ---");
  line(oldOut);
  const newOut1 = await callModel(NEW_BASE, NEW_STRATEGY);
  line("--- 新口径（第 1 次） ---");
  line(newOut1);
  const newOut2 = await callModel(NEW_BASE, NEW_STRATEGY);
  line("--- 新口径（第 2 次） ---");
  line(newOut2);

  h("形态量化");
  const stats = (t: string) => ({
    字数: t.length,
    markdown标题数: (t.match(/^#{1,3}\s/m) ?? []).length,
    列表行数: (t.match(/^\s*[-*•]\s/m) ?? []).length,
    加粗片段数: (t.match(/\*\*[^*]+\*\*/g) ?? []).length,
  });
  line(`旧口径: ${JSON.stringify(stats(oldOut))}`);
  line(`新口径1: ${JSON.stringify(stats(newOut1))}`);
  line(`新口径2: ${JSON.stringify(stats(newOut2))}`);
  line(`新口径两次是否完全相同: ${newOut1 === newOut2 ? "相同（疑似模板）" : "不同（自主组织）"}`);
}

main().catch((e) => {
  console.error(`跳过或失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
