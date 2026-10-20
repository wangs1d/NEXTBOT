import * as THREE from "three";
import { DG2_SOURCE, MODEL } from "../constants/model-proportions";

/** DG2.obj 球心（未缩放） */
const OBJ_BODY_CENTER = new THREE.Vector3(0, DG2_SOURCE.bodyCenterY, 0);

/** 玻璃朝外法向：OBJ 里前面为 -Y，经 MODEL.objRotation 后对齐场景 +Z */
const SCREEN_AXIS = new THREE.Vector3(0, -1, 0);

const UV_SCALE = 0.5 / Math.tan(MODEL.screenFaceHalfAngle);

/**
 * 为 DG2 玻璃网格重算 0–1 UV（CAD 导出 vt 约在 ±1.5，无法正确采样 Canvas）。
 * 以球心为基准、-Y 极点的立体投影，与 OledScreen 的面板画布坐标一致。
 */
export function applyGlassOledUv(geometry: THREE.BufferGeometry): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  let uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;

  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geometry.setAttribute("uv", uv);
  }

  const tmp = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(OBJ_BODY_CENTER);
    const len = tmp.length();
    if (len < 1e-6) {
      uv.setXY(i, 0.5, 0.5);
      continue;
    }

    tmp.multiplyScalar(1 / len);
    const nx = tmp.x;
    const ny = tmp.y;
    const nz = tmp.z;

    // 只映射朝前的玻璃（-Y 半球）；背面压到边缘避免脏采样
    if (ny > -0.2) {
      uv.setXY(i, 0.5, 0.5);
      continue;
    }

    const denom = 1 + ny;
    if (denom < 1e-4) {
      uv.setXY(i, 0.5, 0.5);
      continue;
    }

    const u = THREE.MathUtils.clamp(0.5 + (nx / denom) * UV_SCALE * 0.5, 0.02, 0.98);
    const v = THREE.MathUtils.clamp(0.5 + (nz / denom) * UV_SCALE * 0.5, 0.02, 0.98);
    uv.setXY(i, u, v);
  }

  uv.needsUpdate = true;
  geometry.computeVertexNormals();
}

/** 玻璃网格是否应贴 OLED（朝 -Y 的三角面占主导） */
export function isFrontGlassGeometry(geometry: THREE.BufferGeometry): boolean {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  if (!pos?.count) return false;

  let front = 0;
  const tmp = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(OBJ_BODY_CENTER);
    if (tmp.lengthSq() < 1e-8) continue;
    tmp.normalize();
    if (tmp.dot(SCREEN_AXIS) > 0.25) front += 1;
  }

  return front > pos.count * 0.08;
}
