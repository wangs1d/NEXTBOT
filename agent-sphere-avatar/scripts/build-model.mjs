/**
 * source/DG2.fbx → public/models/DG2.glb
 *
 * FBX 是 CAD 侧的源文件，只进仓库不进 web 构建产物；GLB 才是运行时资产。
 * 这里做四件事，让运行时不再靠猜：
 *   1. 按 CAD 组件实例名建稳定节点名（shell / screen / earRight …）；
 *   2. 按 Fusion 外观名归并材质槽（shell / glass）；
 *   3. 把 Fusion 的 cm 单位（主体半径 50）归一到场景沿用的半径 5；
 *   4. 合并重复顶点（FBX 网格是非索引的，顶点重复 3 倍）。
 *
 * 用法：node scripts/build-model.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Node 无 DOM，GLTFExporter 只用 FileReader 把 Blob 读成 ArrayBuffer */
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = b;
      this.onloadend?.();
    });
  }
};

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC_FBX = resolve(ROOT, "source/DG2.fbx");
const OUT_GLB = resolve(ROOT, "public/models/DG2.glb");

/** CAD 组件实例名 → 运行时节点名。改名会让运行时装不上屏，所以缺项直接失败 */
const PART_NAMES = {
  头1: "shell",
  屏幕1: "screen",
  右耳1: "earRight",
  右耳2: "earLeft",
};

/** 后部双突起的封闭端盖（CAD 里的 DG2_v12）：没有它，后部就只剩两个透孔 */
const CAP_ASSEMBLY = "DG2_v12";

/** Fusion 外观名 → 材质槽名 */
const APPEARANCE_SLOTS = {
  "Steel - Satin": "shell",
  "Glass - Heavy Color": "glass",
};

/** Fusion 按 cm 导出，主体半径 50；场景沿用 OBJ 时代的半径 5 */
const SOURCE_BODY_RADIUS = 50;
const TARGET_BODY_RADIUS = 5;

const buf = readFileSync(SRC_FBX);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const model = new FBXLoader().parse(ab, "");

const missing = Object.keys(PART_NAMES).filter((n) => !model.getObjectByName(n));
if (missing.length) {
  const found = [];
  model.traverse((n) => {
    if (n.isGroup || n.isObject3D) found.push(n.name);
  });
  throw new Error(
    `CAD 里找不到这些组件：${missing.join(", ")}。现有节点：${found.join(" | ")}`,
  );
}

if (!model.getObjectByName(CAP_ASSEMBLY)) {
  throw new Error(`CAD 里找不到封闭端盖组件 ${CAP_ASSEMBLY}，后部突起会变成透孔`);
}

const slotByName = new Map();
let vertsBefore = 0;
let vertsAfter = 0;
const unmapped = [];
const flippedMeshes = [];

/**
 * 有符号体积为负 = 整块网格的三角面绕序反了（法线朝内）。
 * 只翻转封闭网格；开放面/薄片的体积趋近 0，不做判断直接放过。
 */
function flipWindingIfInsideOut(geometry) {
  const index = geometry.index;
  const pos = geometry.attributes.position;
  const triCount = index ? index.count / 3 : pos.count / 3;
  if (!index) return false;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let t = 0; t < triCount; t += 1) {
    a.fromBufferAttribute(pos, index.getX(t * 3));
    b.fromBufferAttribute(pos, index.getX(t * 3 + 1));
    c.fromBufferAttribute(pos, index.getX(t * 3 + 2));
    volume += a.dot(b.clone().cross(c));
  }
  volume /= 6;
  if (Math.abs(volume) < 1e-3 || volume > 0) return false;

  for (let t = 0; t < triCount; t += 1) {
    const i1 = index.getX(t * 3 + 1);
    index.setX(t * 3 + 1, index.getX(t * 3 + 2));
    index.setX(t * 3 + 2, i1);
  }
  const nrm = geometry.attributes.normal;
  for (let i = 0; i < nrm.count; i += 1) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i));
  return true;
}

model.traverse((node) => {
  if (node.isGroup && PART_NAMES[node.name]) node.name = PART_NAMES[node.name];
  if (!node.isMesh) return;

  const source = Array.isArray(node.material) ? node.material[0] : node.material;
  let slot = APPEARANCE_SLOTS[source?.name];
  if (!slot) {
    unmapped.push(`${node.name}<${source?.name}>`);
    return;
  }
  // 突起端盖的端面跟本体同色：纯黑端面在桌宠尺寸下跟空洞分不开
  if (slot === "glass" && node.parent?.name === CAP_ASSEMBLY) slot = "shell";

  if (!slotByName.has(slot)) {
    const std = new THREE.MeshStandardMaterial({ name: slot });
    if (slot === "shell") {
      std.color.set("#a0a0a0");
      std.metalness = 0.82;
      std.roughness = 0.38;
    } else {
      std.color.set("#191919");
      std.metalness = 0.85;
      std.roughness = 0.04;
    }
    slotByName.set(slot, std);
  }
  node.material = slotByName.get(slot);

  // 只合并位置/法线/UV 完全相同的重复顶点；不重算法线，否则 CAD 的硬边会被磨圆
  vertsBefore += node.geometry.attributes.position.count;
  node.geometry = mergeVertices(node.geometry, 1e-4);
  vertsAfter += node.geometry.attributes.position.count;

  // Fusion 导出的封闭端盖整组里外翻了：单面材质下会被背面剔除，突起看着就是个敞口
  const flipped = flipWindingIfInsideOut(node.geometry);
  if (flipped) flippedMeshes.push(node.parent?.name ?? node.name);
});

if (unmapped.length) {
  throw new Error(`这些网格的外观名没有登记到材质槽：${unmapped.join(", ")}`);
}

model.scale.setScalar(TARGET_BODY_RADIUS / SOURCE_BODY_RADIUS);
model.name = "DG2";
model.updateMatrixWorld(true);

const glb = await new Promise((res, rej) =>
  new GLTFExporter().parse(model, res, rej, { binary: true }),
);
mkdirSync(dirname(OUT_GLB), { recursive: true });
writeFileSync(OUT_GLB, Buffer.from(glb));

const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());
console.log(`✓ ${OUT_GLB}`);
console.log(
  `  ${(buf.byteLength / 1024).toFixed(0)}KB FBX → ${(glb.byteLength / 1024).toFixed(0)}KB GLB` +
    ` | 顶点 ${vertsBefore} → ${vertsAfter}` +
    ` | 世界盒 ${size.toArray().map((v) => v.toFixed(2)).join("×")}` +
    ` | 材质槽 ${[...slotByName.keys()].join(",")}` +
    ` | 绕序翻转 ${flippedMeshes.length ? [...new Set(flippedMeshes)].join(",") : "无"}`,
);
