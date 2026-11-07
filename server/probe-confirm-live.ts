/**
 * 实测：确认轮「系统自己配了三级提醒」是否已根治。
 *
 * 真代码路径：registry.execute("calendar.create") → evaluateAndSelectStrategy
 * → stripMetaSentences。模型那一步只有拿到可用模型时才跑（网关无 channel 会跳过）。
 */
// 必须置于最前：走项目统一的 env 加载链（.env → .env.{region} → .env.local，后者
// override）。否则裸 node 进程会直接吃 User 级环境变量里的 OPENAI_BASE_URL，
// 绕过 server/.env.local 里真正在用的 provider 配置。
import "./src/config/load-server-env.js";

import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ScheduleIntentService } from "./src/services/schedule-intent-service.js";
import { ScheduleTaskService } from "./src/services/schedule-task-service.js";
import { registerCalendarTools } from "./src/tools/calendar-tools.js";
import { ToolRegistry } from "./src/tools/tool-registry.js";
import { evaluateAndSelectStrategy } from "./src/agent/synthesis-strategy.js";
import { describeRemindPlan } from "./src/services/schedule-reminder-policy.js";
import { stripMetaSentences } from "./src/external-model/stream-chat-helpers.js";

const USER_SAID = "明天 11:00 提醒我看牙医";
const OLD_INSTRUCTION =
  `提醒/日程已写入成功，这是一次办妥确认，一两句话收尾：办成了什么、何时生效（用回执的 nextRunAtLocal）。` +
  `回执带 remindPlan 分级计划时，用一句话把已排好的预告段转告用户，不要自己另建议提前量。` +
  `严禁复述用户原话，严禁罗列「已确定」类信息清单；用户没说清且确实影响这件事的信息（如地点、诊所要求）最多问一句，问完就收。` +
  `不预告到点会交付什么内容，不解释执行机制。`;
const OLD_BASE =
  `刚才调用工具拿到了以下结果，请基于这些结果回答用户的问题：语气自然像朋友，但内容要充分、结构清晰。` +
  `不要重复工具调用过程，直接给出结论。如果结果不完整，就给出能确定的部分。` +
  `同一事实不要换个说法再总结第二遍；把检索到的信息组织充分：按主题分节，用 Markdown 小标题/加粗/表格排版，` +
  `保留日期、数字、来源等细节，不要为了简短丢掉用户想看的内容。`;
const NEW_BASE = `刚才的提醒/日程已经办好了，请按【回复策略】接话，不要汇报后台是怎么排的。`;
// 用真实人格正文（agent/SOUL.md）当 system —— 生产里就是它在管语气。
// 只给一句「简短自然」会让实测失真：模型没有性格可依，只能套指令里的句式。
const SYSTEM = (() => {
  try {
    const soul = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "SOUL.md"), "utf8");
    return `【人格】\n${soul.trim()}`;
  } catch {
    return `你是用户的私人助理，说话像朋友，简短自然。`;
  }
})();

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n===== ${s} =====`);

async function createReply() {
  const dir = await mkdtemp(join(tmpdir(), "probe-confirm-"));
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, new ScheduleIntentService(null));
    const reply = await registry.execute(
      "calendar.create",
      { text: USER_SAID, timezone: "Asia/Shanghai" },
      { sessionId: "probe", userId: "probe" },
    );
    return { result: reply.result as Record<string, unknown>, task: tasks.listTasksBySession("probe")[0] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callModel(instruction: string, base: string, receipt: unknown) {
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
            { id: "call_1", type: "function", function: { name: "calendar.create", arguments: JSON.stringify({ text: USER_SAID }) } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: JSON.stringify(receipt) },
        { role: "user", content: base + `\n\n【回复策略】${instruction}` },
      ],
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`.trim());
  return String(json.choices?.[0]?.message?.content ?? "");
}

const { result, task } = await createReply();
const directive = evaluateAndSelectStrategy([{ toolName: "calendar.create", ok: true, result }], USER_SAID);

h("1. 模型能看到的回执（修复后，全部字段）");
line(JSON.stringify(result, null, 2));
line();
line(`remindPlan 存在: ${"remindPlan" in result}  |  remindBeforeMinutes 存在: ${"remindBeforeMinutes" in result}`);
const flat = JSON.stringify(result);
for (const k of ["睡前备忘", "起床闹钟", "该出门了", "stages", "fireAtLocal", "840", "120"]) {
  line(`  泄漏检测 ${k}: ${flat.includes(k) ? "命中" : "无"}`);
}

h("2. 对照：修复前的回执（同一任务，含分级计划）");
line(JSON.stringify(describeRemindPlan(task), null, 2));

h("3. 确认轮指令（真实产出）");
line(`策略 = ${directive.strategy}`);
line(`preamble = ${directive.preamblePolicy}`);
line(directive.instruction);

h("4. 指令对照（旧 → 新）");
const has = (s: string, k: string) => (s.includes(k) ? "有" : "无");
for (const k of ["何时生效", "把已排好的预告段转告用户", "remindPlan"]) {
  line(`旧: ${k} → ${has(OLD_INSTRUCTION, k)}    新: ${k} → ${has(directive.instruction, k)}`);
}
line(`旧 base: 「内容要充分、按主题分节」 → 有    新 base(confirm 分支): → ${has(NEW_BASE, "内容要充分")}`);
line(`新 base 全文: ${NEW_BASE}`);

h("5. 出口净化现场跑（截图原句）");
const realWorld =
  "系统自己配了三级提醒：今晚 21:00 睡前备忘、明早 9:00 起床闹钟、10:00 提醒你该出门了。" +
  "诊所地址你还没跟我说，要是离得远，明天 10 点那声提醒可能有点赶。";
line("输入:");
line(realWorld);
line("用户实际看到:");
line(stripMetaSentences(realWorld) || "（空）");

h("6. 真实模型输出对比");
try {
  const oldOut = await callModel(OLD_INSTRUCTION, OLD_BASE, { ...result, remindPlan: describeRemindPlan(task) });
  line("旧口径:");
  line(oldOut);
  const newOut = await callModel(directive.instruction, NEW_BASE, result);
  line("\n新口径:");
  line(newOut);
  line("\n新口径过出口净化:");
  line(stripMetaSentences(newOut) || "（空）");
  // 同输入再跑两遍：如果回复一字不差，说明模型在照抄指令里的模板；
  // 有差异才是它按当时语境自己组织的。
  const variants: string[] = [];
  for (let i = 0; i < 2; i++) {
    const again = await callModel(directive.instruction, NEW_BASE, result);
    variants.push(again);
    line(`\n新口径（第 ${i + 2} 次）:`);
    line(again);
  }
  const all = [newOut, ...variants];
  line(`\n三次是否完全相同: ${new Set(all).size === 1 ? "相同（疑似模板）" : `不同（${new Set(all).size} 种说法）`}`);
  const leaks = ["睡前备忘", "起床闹钟", "该出门了", "三级提醒", "系统", "后台", "生效"];
  line("\n泄漏检测: " + leaks.map((k) => `${k}=${newOut.includes(k) ? "命中" : "无"}`).join(" "));
} catch (e) {
  line(`跳过（当前环境无可用模型）：${e instanceof Error ? e.message : String(e)}`);
}
