import { createContext, useContext } from "react";
import type * as THREE from "three";

/** OledScreen 每帧绘制的 Canvas 纹理，供 DG2 玻璃曲面贴图（OLED） */
export const OledScreenTextureContext = createContext<THREE.CanvasTexture | null>(null);

export function useOledScreenTexture(): THREE.CanvasTexture | null {
  return useContext(OledScreenTextureContext);
}
