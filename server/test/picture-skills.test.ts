import assert from "node:assert/strict";
import test from "node:test";

import type { PictureKit } from "@nextbot/picture";
import { SkillValidator } from "../src/skills/skill-validator.js";
import type { SkillDefinition } from "../src/skills/types.js";
import { createPictureBuiltinSkills } from "../src/skills/builtin/picture-skills.js";

/** invokeRaw 可编程桩：按 toolName 返回预设 ToolCallResponse。 */
function fakeKit(
  impl: (toolName: string) => { success: boolean; result?: Record<string, unknown> | null; error?: string | null },
): PictureKit {
  return {
    invokeRaw: async (toolName: string) => impl(toolName),
  } as unknown as PictureKit;
}

const skills = createPictureBuiltinSkills({ pictureKit: fakeKit(() => ({ success: true })) });

test("picture skill 家族：9 个定义全部通过元数据校验且名字唯一", () => {
  assert.equal(skills.length, 9);
  const names = skills.map((s) => s.metadata.name);
  assert.equal(new Set(names).size, names.length);
  for (const skill of skills) {
    const errors = SkillValidator.validateMetadata(skill.metadata);
    assert.deepEqual(errors, [], `${skill.metadata.name} 元数据校验失败: ${JSON.stringify(errors)}`);
  }
  assert.deepEqual(
    names.sort(),
    [
      "picture.analyze",
      "picture.evaluate",
      "picture.gallery",
      "picture.generate",
      "picture.housekeeping",
      "picture.memories",
      "picture.process",
      "picture.store",
      "picture.stylize",
    ],
  );
});

test("picture skill 家族：kind 均为 builtin，写类 skill 声明 storage:write", () => {
  for (const skill of skills) {
    assert.equal(skill.metadata.kind, "builtin", skill.metadata.name);
  }
  const writeSkills = new Set([
    "picture.generate",
    "picture.process",
    "picture.store",
    "picture.stylize",
    "picture.housekeeping",
  ]);
  for (const skill of skills) {
    const hasWrite = skill.metadata.permissions.includes("storage:write");
    assert.equal(hasWrite, writeSkills.has(skill.metadata.name), skill.metadata.name);
  }
});

test("invokeRaw 型 handler：成功响应映射为 ok:true 且字段平铺", async () => {
  const kit = fakeKit((toolName) => {
    assert.equal(toolName, "image_generate");
    return { success: true, result: { images: [{ path: "a.webp" }], count: 1 } };
  });
  const [generate] = createPictureBuiltinSkills({ pictureKit: kit }).filter(
    (s) => s.metadata.name === "picture.generate",
  ) as SkillDefinition[];
  const result = await generate.handler({ prompt: "一只橘猫" }, {} as never);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
});

test("invokeRaw 型 handler：失败响应映射为 ok:false + error", async () => {
  const kit = fakeKit(() => ({ success: false, error: "缺少 OPENAI_API_KEY" }));
  const [analyze] = createPictureBuiltinSkills({ pictureKit: kit }).filter(
    (s) => s.metadata.name === "picture.analyze",
  ) as SkillDefinition[];
  const result = await analyze.handler({ input: "a.jpg" }, {} as never);
  assert.equal(result.ok, false);
  assert.equal(result.error, "缺少 OPENAI_API_KEY");
});

test("picture.gallery handler：复用 capability handler，返回图库查询结果", async () => {
  const kit = {
    store: {
      query: async () => ({
        total: 0,
        page: 1,
        pageSize: 20,
        items: [],
      }),
    },
  } as unknown as PictureKit;
  const [gallery] = createPictureBuiltinSkills({ pictureKit: kit }).filter(
    (s) => s.metadata.name === "picture.gallery",
  ) as SkillDefinition[];
  const result = await gallery.handler({ action: "query" }, {} as never);
  assert.equal(result.ok, true);
  assert.deepEqual(result.photos, []);
});
