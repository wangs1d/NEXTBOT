import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const ALLOWED: Record<string, string[]> = {
  protocol: [],
  mind: ["protocol"],
  body: ["protocol"],
};

const FORBIDDEN_IMPORT = /^(three|@react-three|react|react-dom|cannon|pixi|live2d|jsdom)/;
const RENDERER_TOKEN = /\b(window|document|requestAnimationFrame|navigator|HTMLElement|canvas)\b/;

function sources(dir: string): Array<{ name: string; src: string }> {
  return readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: `${dir}/${f}`, src: readFileSync(join(SRC, dir, f), "utf8") }));
}

function importedLayers(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const spec = m[1];
    const seg = spec.replace(/^(\.\.\/)+/, "").split("/")[0];
    if (seg === "protocol" || seg === "mind" || seg === "body") out.add(seg);
  }
  return [...out];
}

for (const [layer, allowed] of Object.entries(ALLOWED)) {
  test(`${layer} 只依赖 ${allowed.length ? allowed.join("/") : "零依赖"}，反向依赖即架构泄漏`, () => {
    for (const { name, src } of sources(layer)) {
      const bad = importedLayers(src).filter((l) => l !== layer && !allowed.includes(l));
      assert.deepEqual(bad, [], `${name} 不该依赖 ${bad.join(",")}`);
    }
  });

  test(`${layer} 不认识渲染器：不引 three/react，不碰 window/document`, () => {
    for (const { name, src } of sources(layer)) {
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
        assert.equal(FORBIDDEN_IMPORT.test(m[1]), false, `${name} 引入了 ${m[1]}`);
      }
      assert.equal(RENDERER_TOKEN.test(src), false, `${name} 出现渲染器/DOM 全局量`);
    }
  });
}

test("心智层不出现动画名，解算层不出现决策", () => {
  const mindSrc = sources("mind").map((s) => s.src).join("\n");
  assert.equal(/\.mp4|\.glb|sprite|clip|timeline|keyframe/i.test(mindSrc), false);
  const bodySrc = sources("body").map((s) => s.src).join("\n");
  assert.equal(/if\s*\(\s*(source|kind|event)\s*===/.test(bodySrc), false, "解算层里出现了按事件分派的决策");
});
