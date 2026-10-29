import * as THREE from "three";
import { DG2_SOURCE } from "../constants/model-proportions";

/** DG2.obj 外壳与前罩是同一个球面：球心在原点、半径 5 */
const OBJ_SPHERE_RADIUS = DG2_SOURCE.bodyRadius;
/** 前罩被 y=-3 平面切出，半角 acos(3/5) ≈ 53.13° */
const VISOR_HALF_ANGLE = Math.acos(3 / OBJ_SPHERE_RADIUS);
/** 让纹理圆盘正好落在玻璃窗边缘 */
const UV_SCALE = 0.5 / Math.tan(VISOR_HALF_ANGLE);

/**
 * 给 DG2 前罩重算 0–1 UV（CAD 导出的 vt 约在 ±1.5，无法正确采样 Canvas）。
 * 以球心为基准、-Y 极点的切平面投影，铺满整块玻璃窗。
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
    tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const len = tmp.length();
    if (len < 1e-6) {
      uv.setXY(i, 0.5, 0.5);
      continue;
    }

    tmp.multiplyScalar(1 / len);

    const denom = -tmp.y;
    if (denom < 0.02) {
      uv.setXY(i, 0.5, 0.5);
      continue;
    }

    const u = THREE.MathUtils.clamp(0.5 + (tmp.x / denom) * UV_SCALE, 0, 1);
    const v = THREE.MathUtils.clamp(0.5 + (tmp.z / denom) * UV_SCALE, 0, 1);
    uv.setXY(i, u, v);
  }

  uv.needsUpdate = true;
  geometry.computeVertexNormals();
}
