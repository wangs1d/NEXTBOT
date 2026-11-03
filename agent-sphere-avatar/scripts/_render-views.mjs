/** 一次性：用桌宠运行时的材质与灯光，渲染当前 public/models/DG2.glb 的正/背/右视 */
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "../.scratch/deskpet-views");
const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => { try { readFileSync(p); return true; } catch { return false; } });

const SIZE = 720;

const HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/three.module.js"}}</script>
<style>html,body{margin:0;padding:0;width:720px;height:720px;overflow:hidden}canvas{display:block}</style>
</head><body>
<canvas id="c" width="720" height="720"></canvas>
<script type="module">
import * as THREE from "/three.module.js";
import { GLTFLoader } from "/GLTFLoader.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(720, 720, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
// 中性灰底：浅钢壳和纯黑玻璃面板同时可读
scene.background = new THREE.Color("#8b8f97");

// OverlaySceneLights 的等价灯光（桌宠运行时就是这套，不依赖 HDR）
scene.add(new THREE.AmbientLight(0xffffff, 1.05));
scene.add(new THREE.HemisphereLight(0xe8eef8, 0x2a3040, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.15); key.position.set(2.5, 4, 3.5); scene.add(key);
const cool = new THREE.DirectionalLight(0x88bbff, 0.45); cool.position.set(-2, 2.5, 2); scene.add(cool);
const pt = new THREE.PointLight(0xffffff, 0.35); pt.position.set(0, 2.5, 2); scene.add(pt);

const group = new THREE.Group();
group.scale.setScalar(0.1);            // dg2Scale()
group.rotation.set(-Math.PI / 2, 0, 0); // objRotation：玻璃面朝 +Z

const shellColor = new THREE.Color("#9a9aa2");
const seam = new THREE.Color("#a8b8cc");
const glassMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });

const parts = {};
const gltf = await new GLTFLoader().loadAsync("/models/DG2.glb");
gltf.scene.traverse((node) => {
  if (!(node instanceof THREE.Mesh)) return;
  const slot = (Array.isArray(node.material) ? node.material[0]?.name : node.material?.name) ?? "";
  if (slot === "glass") {
    node.material = glassMat;      // 屏不亮时的纯黑面板
  } else {
    node.material = new THREE.MeshPhysicalMaterial({
      color: shellColor.clone(), metalness: 0.82, roughness: 0.38,
      clearcoat: 0.22, clearcoatRoughness: 0.32, envMapIntensity: 0.25,
      emissive: seam.clone(), emissiveIntensity: 0.04, // 呼吸缝线取中间帧
    });
  }
});
gltf.scene.traverse((node) => { if (node.name && !parts[node.name]) parts[node.name] = node; });
group.add(gltf.scene);
scene.add(group);

const box = new THREE.Box3().setFromObject(group);
const center = box.getCenter(new THREE.Vector3());
const radius = box.getSize(new THREE.Vector3()).length() * 0.5;

const FOV = 34; // OVERLAY_SCENE.cameraFov
const dist = (radius / Math.tan((FOV * Math.PI) / 180 / 2)) * 1.06;

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
camera.up.set(0, 1, 0);

// 正/背由玻璃朝向定死（+Z / -Z）；左右取 earRight 实际所在的那一侧
function earSign() {
  const ear = parts["earRight"];
  if (!ear) return 1;
  const p = new THREE.Vector3();
  ear.getWorldPosition(p);
  return p.x >= center.x ? 1 : -1;
}

const VIEWS = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(earSign(), 0, 0),
  left: new THREE.Vector3(-earSign(), 0, 0),
};

window.__views = Object.keys(VIEWS);
window.__partPos = Object.fromEntries(
  Object.entries(parts).map(([n, o]) => [
    n,
    o.getWorldPosition(new THREE.Vector3()).sub(center).toArray().map((v) => +v.toFixed(3)),
  ]),
);

window.renderView = (name) => {
  const dir = VIEWS[name];
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.lookAt(center);
  renderer.render(scene, camera);
  return true;
};
window.__ready = true;
</script></body></html>`;

const MIME = { ".js": "text/javascript", ".glb": "model/gltf-binary" };
function serve(res, file) {
  res.writeHead(200, { "Content-Type": MIME["." + file.split(".").pop()] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/render.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  } else if (url === "/three.module.js") serve(res, resolve(ROOT, "node_modules/three/build/three.module.js"));
  else if (url === "/three.core.js") serve(res, resolve(ROOT, "node_modules/three/build/three.core.js"));
  else if (url === "/GLTFLoader.js") serve(res, resolve(ROOT, "node_modules/three/examples/jsm/loaders/GLTFLoader.js"));
  else if (url === "/utils/BufferGeometryUtils.js") serve(res, resolve(ROOT, "node_modules/three/examples/jsm/utils/BufferGeometryUtils.js"));
  else if (url === "/models/DG2.glb") serve(res, resolve(ROOT, "public/models/DG2.glb"));
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  defaultViewport: { width: SIZE, height: SIZE, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.warn("[pageerror]", e.message));
  page.on("response", (r) => { if (r.status() >= 400) console.warn("[http", r.status() + "]", r.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/render.html`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction("window.__ready === true", { timeout: 90000 });
  console.log("views:", await page.evaluate("__views"), "partPos:", await page.evaluate("__partPos"));
  for (const name of await page.evaluate("__views")) {
    await page.evaluate((n) => window.renderView(n), name);
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(join(OUT, `dg2-${name}.png`), await page.screenshot({ clip: { x: 0, y: 0, width: SIZE, height: SIZE } }));
    console.log("→", `dg2-${name}.png`);
  }
} finally {
  await browser.close();
  server.close();
}
