/**
 * 构建期导出双端渲染契约（P4）。
 *
 * 运行：npm run render:contract
 * 输出：packages/agent-protocol/render-contract.json
 *
 * 契约由场景的 produces 声明汇总而来，客户端与服务端测试都读同一份文件，
 * 不再靠人记住「新增形态要登记几处」。声明不合法直接非零退出，挡在构建期。
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sceneRegistry, seedDefaultScenes } from "../server/src/render/scenes/index.js";
import { buildRenderContract, assertRenderContract } from "../server/src/render/contract.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

seedDefaultScenes();
const problems = assertRenderContract(sceneRegistry);
if (problems.length > 0) {
  console.error(`[render-contract] 契约校验失败：\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

const contract = buildRenderContract(sceneRegistry);
const out = join(root, "packages", "agent-protocol", "render-contract.json");
writeFileSync(out, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
console.log(
  `[render-contract] 已导出 ${contract.scenes.length} 个场景 / ` +
    `${contract.cardTypes.length} 个 cardType / ${contract.forms.length} 个形态 → ${out}`,
);
