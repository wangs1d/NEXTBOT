/**
 * 把 DG2 球形机器人渲染成静态透明 PNG（供 Flutter 输入框徽标使用）。
 *
 * 思路：
 *   1. 起本地 HTTP 服务，用 import map 把 `three` 解析到 node_modules，
 *      页面用 three.js 加载 public/models/DG2.obj，套用与 DG2RobotModel 相同的
 *      金属壳/深色玻璃材质 + RoomEnvironment 环境反射，渲染到固定画布；
 *   2. puppeteer-core 连接系统 Chrome（不下载浏览器）无头打开页面，
 *      等 WebGL 一帧渲染完成后截取画布尺寸区域存为 PNG。
 *
 * 用法：
 *   node scripts/render-icon.mjs [--out 目标路径]
 *   默认输出到 ../client/flutter_app/assets/agent_avatars/sphere_icon.png
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script type="importmap">
{"imports":{"three":"/three.module.js"}}
</script>
<style>html,body{margin:0;padding:0;background:transparent;width:100%;height:100%;overflow:hidden}
canvas#c{position:absolute;inset:0}</style>
</head>
<body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import * as THREE from "/three.module.js";
import { OBJLoader } from "/OBJLoader.js";
import { RoomEnvironment } from "/RoomEnvironment.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
renderer.setSize(256, 256, false);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
camera.up.set(0, 1, 0);

// 环境反射：让金属壳/玻璃呈现出 DG2RobotModel 那种拉丝金属质感
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
pmrem.dispose();

// 基础照明
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(4, 6, 5); scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 1.3); rim.position.set(-5, -2, 3); scene.add(rim);
const fill = new THREE.DirectionalLight(0xbfd7ff, 0.7); fill.position.set(0, -4, -4); scene.add(fill);

// 与 DG2RobotModel 相同：
const SCALE = 0.5 / 5;              // dg2Scale()：bodyRadius 0.5 / 源半径 5
const ROTATION = [-Math.PI / 2, 0, 0]; // 绕 X -90°，玻璃面朝向 +Z（相机）
const group = new THREE.Group();
group.scale.setScalar(SCALE);
group.rotation.set(...ROTATION);
group.position.set(0, -1, 0);       // MODEL.objOffset

const obj = await new OBJLoader().loadAsync("/models/DG2.obj");
obj.traverse((node) => {
  if (!node.isMesh) return;
  const name = (Array.isArray(node.material) ? node.material[0]?.name : node.material?.name) ?? "";
  if (name.includes("\u73bb\u7483")) { // 玻璃
    node.material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#080a0e"),
      metalness: 0.85, roughness: 0.04,
      clearcoat: 1, clearcoatRoughness: 0.02,
      envMapIntensity: 1.4, reflectivity: 0.95,
      transparent: true, opacity: 0.82, depthWrite: false,
      side: THREE.FrontSide,
    });
  } else {                            // 拉丝钢壳
    node.material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#9a9aa2"),
      metalness: 0.82, roughness: 0.38,
      clearcoat: 0.22, clearcoatRoughness: 0.32,
      envMapIntensity: 0.85,
      emissive: new THREE.Color("#a8b8cc"),
      emissiveIntensity: 0.02,        // 呼吸灯缝线很淡的冷色让金属不死黑
    });
  }
});
group.add(obj);
scene.add(group);

// 自适应取景：居中 + 视锥框定整个机器人
const box = new THREE.Box3().setFromObject(group);
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const radius = size.length() * 0.5;
const fovRad = (camera.fov * Math.PI) / 180;
const dist = (radius / Math.tan(fovRad / 2)) * 1.05;
camera.position.set(center.x, center.y + radius * 0.15, center.z + dist);
camera.lookAt(center);

renderer.render(scene, camera);
window.__sphereReady = true;
</script>
</body>
</html>`;

const MIME = {
  ".js": "text/javascript",
  ".obj": "text/plain",
};

function serveStatic(req, res, path) {
  const ext = "." + path.split(".").pop();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(path));
}

function startServer() {
  const threeModule = resolve(ROOT, "node_modules/three/build/three.module.js");
  const threeCore = resolve(ROOT, "node_modules/three/build/three.core.js");
  const objLoader = resolve(ROOT, "node_modules/three/examples/jsm/loaders/OBJLoader.js");
  const roomEnv = resolve(ROOT, "node_modules/three/examples/jsm/environments/RoomEnvironment.js");
  const dg2 = resolve(ROOT, "public/models/DG2.obj");

  return createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/" || url === "/render.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
    } else if (url === "/three.module.js") serveStatic(req, res, threeModule);
    else if (url === "/three.core.js") serveStatic(req, res, threeCore);
    else if (url === "/OBJLoader.js") serveStatic(req, res, objLoader);
    else if (url === "/RoomEnvironment.js") serveStatic(req, res, roomEnv);
    else if (url === "/models/DG2.obj") serveStatic(req, res, dg2);
    else { res.writeHead(404); res.end(); }
  });
}

async function main() {
  const idx = process.argv.indexOf("--out");
  const out = idx >= 0 && process.argv[idx + 1]
    ? resolve(process.cwd(), process.argv[idx + 1])
    : resolve(ROOT, "../client/flutter_app/assets/agent_avatars/sphere_icon.png");

  const chromePath = CHROME_CANDIDATES.find((p) => { try { readFileSync(p); return true; } catch { return false; } });
  if (!chromePath) {
    console.error("[render-icon] 未找到系统 Chrome/Edge，请安装 Chrome 或传入可执行路径。");
    process.exit(1);
  }

  const server = startServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/render.html`;
  console.log("[render-icon] 页面:", url);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    defaultViewport: { width: 256, height: 256, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.warn("[page]", m.text()); });
    page.on("pageerror", (e) => console.warn("[pageerror]", e.message));
    page.on("response", (r) => { if (r.status() >= 400) console.warn("[http", r.status() + "]", r.url()); });
    page.on("requestfailed", (r) => console.warn("[reqfail]", r.url(), r.failure()?.errorText));
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForFunction("window.__sphereReady === true", { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 256, height: 256 } });
    console.log("[render-icon] 已输出:", out);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });