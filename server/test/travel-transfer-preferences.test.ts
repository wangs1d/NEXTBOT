/**
 * 旅游规划输入理解测试（travel-upgrade-plan P1/P2）：
 * - extractTransferSegments：车次/航班/混合抽取、假阳性排除、诚实边界（时刻绝不构造）
 * - extractPreferences 的 profileHints 兜底：原文 > 画像，来源标签正确
 * - extractFactCandidates 的 travel 类别规则（出片/体验/躺平/打卡/饮食/交通/同行人）
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractTransferSegments } from "../src/skills/travel-planning/travel-planning-service.js";
import { extractPreferences } from "../src/skills/travel-planning/intent-parser.js";
import { extractFactCandidates } from "../src/services/user-personalization/user-profile-facts.js";

test("extractTransferSegments: 车次抽取（G/D/C/K/T/Z）与去重", () => {
  const segs = extractTransferSegments("坐G1234去北京，回程一起订D2298", "北京");
  assert.deepEqual(
    segs.map((s) => ({ type: s.type, no: s.no, role: s.role })),
    [
      { type: "train", no: "G1234", role: "arrival" },
      { type: "train", no: "D2298", role: "arrival" },
    ],
  );
  // 诚实边界：用户没给的时刻绝不构造
  assert.equal(segs[0].arrTime, undefined);
  assert.equal(segs[0].depTime, undefined);
  assert.equal(segs[0].to, "北京");
  assert.equal(segs[0].from, "出发地");
});

test("extractTransferSegments: 航班抽取（两位航司码+3-4位数字）", () => {
  const segs = extractTransferSegments("订CA1832和MU5137去大理", "大理");
  assert.deepEqual(
    segs.map((s) => ({ type: s.type, no: s.no })),
    [
      { type: "flight", no: "CA1832" },
      { type: "flight", no: "MU5137" },
    ],
  );
});

test("extractTransferSegments: 混合车次+航班不串型", () => {
  const segs = extractTransferSegments("先G1024到上海，再飞CA1832回来", "上海");
  assert.equal(segs.find((s) => s.no === "G1024")?.type, "train");
  assert.equal(segs.find((s) => s.no === "CA1832")?.type, "flight");
  // 车次形态不得被航班正则二次吃掉
  assert.equal(segs.filter((s) => s.no === "G1024").length, 1);
});

test("extractTransferSegments: 小写与空格形态归一", () => {
  const segs = extractTransferSegments("g 87 和 z99", "苏州");
  assert.deepEqual(
    segs.map((s) => s.no),
    ["G87", "Z99"],
  );
});

test("extractTransferSegments: 假阳性排除（字母后缀/单词内数字/航司码形态不足）", () => {
  // img1234：数字前是字母 → 排除；USD100：US 后非数字 → 排除；TV3：数字不足 3 位 → 排除
  assert.deepEqual(extractTransferSegments("img1234.png USD100 TV3", ""), []);
});

test("extractTransferSegments: 去重与上限 4 段", () => {
  const dup = extractTransferSegments("G5 G5 G5", "北京");
  assert.equal(dup.length, 1);
  const many = extractTransferSegments("G1 D2 C3 K4 T5 Z6 CA1832 MU5137", "北京");
  assert.equal(many.length, 4);
});

test("extractPreferences: 原文出片向信号 sources=user", () => {
  const prefs = extractPreferences("想去网红打卡点，吃漂亮的漂亮饭，要出片");
  assert.equal(prefs.photoDriven, true);
  assert.equal(prefs.sources.photoDriven, "user");
});

test("extractPreferences: profileHints 兜底生效且来源标 profile", () => {
  const prefs = extractPreferences("去大理玩3天", [], "大理", { photoDriven: true });
  assert.equal(prefs.photoDriven, true);
  assert.equal(prefs.sources.photoDriven, "profile");
});

test("extractPreferences: 原文优先，画像只补未提及的维度", () => {
  const prefs = extractPreferences("想要出片机位", [], "成都", { experienceDriven: true });
  assert.equal(prefs.photoDriven, true);
  assert.equal(prefs.sources.photoDriven, "user");
  assert.equal(prefs.experienceDriven, true);
  assert.equal(prefs.sources.experienceDriven, "profile");
});

test("extractPreferences: 无信号时保持 default 且不误开", () => {
  const prefs = extractPreferences("去杭州玩2天", [], "杭州");
  assert.equal(prefs.photoDriven, false);
  assert.equal(prefs.experienceDriven, false);
  assert.equal(prefs.sources.photoDriven, "default");
});

test("extractFactCandidates: 出片向/体验向/躺平向/打卡向归入 travel 类别", () => {
  const photo = extractFactCandidates("我就喜欢出片的地方，最好有漂亮饭");
  assert.ok(photo.some((f) => f.category === "travel" && f.key === "travel_style" && f.value === "photo_driven"));
  const exp = extractFactCandidates("我们打算去徒步和露营");
  assert.ok(exp.some((f) => f.category === "travel" && f.value === "experience_driven"));
  const relax = extractFactCandidates("这次就想躺平泡酒店");
  assert.ok(relax.some((f) => f.value === "relax_driven"));
  const checkin = extractFactCandidates("特种兵式打卡，尽量多逛");
  assert.ok(checkin.some((f) => f.value === "checkin_driven"));
});

test("extractFactCandidates: 饮食限制/交通方式/同行人", () => {
  const diet = extractFactCandidates("我不吃辣");
  assert.ok(diet.some((f) => f.category === "travel" && f.key === "diet" && f.value.includes("不吃辣")));
  const noCar = extractFactCandidates("我们坐高铁去，没车");
  assert.ok(noCar.some((f) => f.key === "drives_own_car" && f.value === "no_car"));
  const selfDrive = extractFactCandidates("自驾去比较方便");
  assert.ok(selfDrive.some((f) => f.key === "drives_own_car" && f.value === "self_drive"));
  const companion = extractFactCandidates("和男朋友一起去");
  assert.ok(companion.some((f) => f.key === "travel_companion"));
});

test("extractFactCandidates: 空文本返回空", () => {
  assert.deepEqual(extractFactCandidates(""), []);
  assert.deepEqual(extractFactCandidates("   "), []);
});
