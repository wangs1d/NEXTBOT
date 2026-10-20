import { useMemo } from "react";
import * as THREE from "three";
import { MODEL } from "../constants/model-proportions";
import { createScreenCapGeometry } from "../utils/screen-cap-geometry";

interface OledScreenMeshProps {
  map: THREE.CanvasTexture;
}

/**
 * OLED 显示层 — 内容纹理贴在与 DG2 玻璃同形的球冠上。
 *
 * 注意：这里刻意不再叠任何反光 / 玻璃罩 / 扫描层。
 * 那块面板本身是「玻璃 + 金属」材质，场景光已经在它表面成像；
 * 再往上糊一层自造的菲涅尔或高光，就会出现与真实光照互相打架的
 * 块状亮斑（看起来像贴纸）。屏幕的质感交给画布层与真实光照。
 */
export function OledScreenMesh({ map }: OledScreenMeshProps) {
  const geometry = useMemo(
    () =>
      createScreenCapGeometry({
        radius: MODEL.screenCapRadius,
        halfAngle: MODEL.screenFaceHalfAngle,
        widthSegments: 128,
        heightSegments: 96,
        uvInset: 0.06,
        uvEdgeCurve: 1.16,
      }),
    [],
  );

  return (
    <mesh geometry={geometry} renderOrder={100} position={[0, 0, 0.002]}>
      <meshBasicMaterial
        map={map}
        transparent={false}
        depthWrite={true}
        depthTest={true}
        toneMapped={false}
      />
    </mesh>
  );
}
