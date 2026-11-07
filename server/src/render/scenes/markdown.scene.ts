/**
 * markdown 兜底场景（priority 0，恒命中）。
 *
 * 没有任何结构化面时，正文形态交给 decideBody 的规则链（markdown / brief /
 * fold / plain）。本场景的职责只是**保证计划永远有一个落点**，
 * 不让「没有场景命中」变成一条无形态的裸文本。
 */

import type { RenderScene, SceneMatch } from "./types.js";

export const markdownScene: RenderScene = {
  id: "markdown",
  label: "正文兜底",
  priority: 0,
  phase: "pre",
  produces: { forms: ["structured", "brief", "image_result"] },
  contract: "无结构化面；形态由正文结构规则链决定，不注入任何版式指令。",

  detect(): SceneMatch | null {
    return { reason: "无结构化面，走正文规则链" };
  },

  plan() {
    return {
      sceneId: "markdown",
      label: "正文兜底",
      cards: [],
      constraints: [],
      reason: "正文形态交给 decideBody",
    };
  },
};
