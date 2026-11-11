/**
 * 资料库分组单测（2026-11-12「每次对话一张卡」改版）。
 *
 * 主对话是单一会话（sessionId=actorId 恒定），按 sessionId 折叠会把主对话
 * 全部产物挤进一张卡。改版规则：
 *   - 主对话产物带轮次（turnId）→ 每次对话一张卡，标题取用户请求原文；
 *   - 主对话历史产物（无轮次）→ 30 分钟时间间隙聚类；
 *   - 旁聊 → 会话整组 + 注册表标题；
 *   - 无归属 → 「历史记录」组排最后。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGroups } from "../src/routes/http/library.js";

const ACTOR = "actor-001";

function file(name: string, sessionId: string, updatedAt: string, turnId = "", turnTitle = "") {
  return { name, size: 10, updatedAt, sessionId, turnId, turnTitle };
}

function image(name: string, sessionId: string, updatedAt: string, turnId = "", turnTitle = "") {
  return { name, size: 10, updatedAt, url: `/agent/images/${ACTOR}/${name}`, sessionId, turnId, turnTitle };
}

describe("library buildGroups（每次对话一张卡）", () => {
  it("主对话带轮次：每次对话独立成卡，标题=用户请求原文", () => {
    const groups = buildGroups({
      actorId: ACTOR,
      files: [
        file("a.csv", ACTOR, "2026-11-12T02:00:00.000Z", "turn-1", "帮我导出一份账单"),
      ],
      images: [
        image("b.png", ACTOR, "2026-11-12T01:00:00.000Z", "turn-2", "画一只猫"),
        image("c.png", ACTOR, "2026-11-12T01:00:10.000Z", "turn-2", "画一只猫"),
      ],
      notes: [],
      travelPlans: [],
      titles: new Map(),
    });

    assert.equal(groups.length, 2);
    // updatedAt 新→旧：turn-1（02:00）在前
    assert.equal(groups[0].title, "帮我导出一份账单");
    assert.equal(groups[0].counts.files, 1);
    assert.equal(groups[1].title, "画一只猫");
    assert.equal(groups[1].counts.images, 2);
  });

  it("主对话无轮次的历史产物：30 分钟内聚一簇，超过间隙切新卡", () => {
    const groups = buildGroups({
      actorId: ACTOR,
      files: [
        file("old-1.csv", ACTOR, "2026-11-01T03:00:00.000Z"),
        file("old-2.csv", ACTOR, "2026-11-01T03:10:00.000Z"), // 与 old-1 差 10 分钟 → 同簇
        file("old-3.csv", ACTOR, "2026-11-01T06:00:00.000Z"), // 差近 3 小时 → 新簇
      ],
      images: [],
      notes: [],
      travelPlans: [],
      titles: new Map(),
    });

    assert.equal(groups.length, 2);
    assert.equal(groups[0].counts.files, 1); // 06:00 的独一张
    assert.equal(groups[1].counts.files, 2); // 03:00/03:10 一簇
    assert.equal(groups[0].title, ""); // 无请求原文 → 客户端按时间兜底
  });

  it("旁聊会话：整会话一张卡，标题取旁聊注册表", () => {
    const side = `side:${ACTOR}:chat-9`;
    const groups = buildGroups({
      actorId: ACTOR,
      files: [
        file("s1.csv", side, "2026-11-12T02:00:00.000Z", "t1", "不应使用轮次标题"),
        file("s2.csv", side, "2026-11-12T01:00:00.000Z", "t2", "不应使用轮次标题"),
      ],
      images: [],
      notes: [],
      travelPlans: [],
      titles: new Map([[side, "旅行攻略旁聊"]]),
    });

    assert.equal(groups.length, 1);
    assert.equal(groups[0].sessionId, side);
    assert.equal(groups[0].title, "旅行攻略旁聊");
    assert.equal(groups[0].counts.files, 2);
  });

  it("无归属产物进「历史记录」组并排在最后", () => {
    const groups = buildGroups({
      actorId: ACTOR,
      files: [file("legacy.csv", ACTOR, "2026-11-12T02:00:00.000Z", "t1", "有归属")],
      images: [image("lost.png", "", "2026-11-10T00:00:00.000Z")],
      notes: [],
      travelPlans: [],
      titles: new Map(),
    });

    assert.equal(groups.length, 2);
    assert.equal(groups[0].sessionId.includes(ACTOR), true); // 轮次组在前（键含分隔符）
    assert.equal(groups[groups.length - 1].sessionId, ""); // 历史组最后
    assert.equal(groups[groups.length - 1].counts.images, 1);
  });
});
