import { applyVisibleToolBudget, resolveVisibleToolCap } from "../server/src/external-model/visible-tool-stabilizer.js";
import { CHAT_LANE_CORE_NAMES } from "../server/src/external-model/lane-tool-sets.js";

const mk = (n: string) => ({ type: "function", function: { name: n, description: "x", parameters: { type: "object", properties: {} } } }) as any;
const names = (a: any[]) => a.map((t) => t.function.name);

console.log("cap =", resolveVisibleToolCap(), " core 数 =", CHAT_LANE_CORE_NAMES.length);

// 25 个：前 3 个是 core，其余普通，验证 core 全部保留且顺序不变
const core = CHAT_LANE_CORE_NAMES.slice(0, 3);
const input = [...core.map(mk), ...Array.from({ length: 22 }, (_, i) => mk("extra_" + i))];
const out = applyVisibleToolBudget(input);
console.log("25 →", out.length, "| core 全保留:", core.every((c) => names(out).includes(c)));
console.log("顺序未变:", names(out).every((n, i) => n === names(input)[i]));
console.log("尾部被裁:", names(input).slice(-3).every((n) => !names(out).includes(n)));

// core 排在最后也要保留
const input2 = [...Array.from({ length: 20 }, (_, i) => mk("extra_" + i)), ...core.map(mk)];
const out2 = applyVisibleToolBudget(input2);
console.log("core 排尾部仍保留:", core.every((c) => names(out2).includes(c)), "| 数量", out2.length);

// 小于 cap 不动
const small = [mk("a"), mk("b")];
console.log("小集合原样返回:", applyVisibleToolBudget(small) === small);
