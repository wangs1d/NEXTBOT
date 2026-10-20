import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { ScreenPanel } from "../screen/screen-panel";
import { OledScreenTextureContext } from "../context/oled-screen-context";
import type { AgentMood } from "../types/agent";
import { OledScreenMesh } from "./OledScreenMesh";

export interface ScreenSignals {
  boundaryBump: number;
  excitement: number;
  speed: number;
  speakPulse: number;
  /** 用户正在触摸/拖拽身体 */
  userTouch: number;
  /** 用户旋转强度 */
  userSpin: number;
}

interface OledScreenProps {
  mood: AgentMood;
  energy: number;
  focused: boolean;
  signalsRef: React.RefObject<ScreenSignals>;
  children?: ReactNode;
}

const CANVAS = 512;

/** 刷新亮带速度 — 情绪越激烈，屏幕刷得越快，是「活着」最低限度的表达 */
const BAND_SPEED: Record<AgentMood, number> = {
  idle: 0.75,
  listening: 1,
  thinking: 1.35,
  happy: 1.75,
  alert: 2.4,
};

/**
 * DG2 黑色曲面玻璃上的 OLED 面板。
 *
 * 只负责「屏幕本身的质感」：背板 / 中心背光 / 扫描线 / 刷新亮带 / 边缘暗角。
 * 表情系统已整体移除（用户对 SVG 表情方案不满意），此处不再绘制五官。
 */
export function OledScreen({ mood, energy, focused, signalsRef, children }: OledScreenProps) {
  const canvasRef = useRef(document.createElement("canvas"));
  const litRef = useRef(1);

  const panel = useMemo(() => new ScreenPanel(CANVAS), []);

  const texture = useMemo(() => {
    const c = canvasRef.current;
    c.width = CANVAS;
    c.height = CANVAS;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useEffect(
    () => () => {
      texture.dispose();
      panel.dispose();
    },
    [texture, panel],
  );

  const redraw = (t: number, lit: number): void => {
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    panel.draw(ctx, {
      lit,
      time: t,
      bandSpeed: BAND_SPEED[mood] ?? 1,
      glow: 0.45 + energy * 0.5,
    });
    texture.needsUpdate = true;
  };

  useLayoutEffect(() => {
    redraw(0, 1);
  }, [mood, energy, texture, panel]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const signals = signalsRef.current;

    // boundaryBump 在别处只被置 1、没人衰减 —— 这个衰减责任原本在旧组件里，必须接住
    if (signals) {
      signals.boundaryBump = Math.max(0, signals.boundaryBump - 0.035);
    }
    const excitement = signals?.excitement ?? 0;

    const targetLit = Math.min(1, 0.72 + energy * 0.22 + (focused ? 0.1 : 0) + excitement * 0.12);
    litRef.current = THREE.MathUtils.lerp(litRef.current, targetLit, 0.06);

    redraw(t, litRef.current);
  });

  return (
    <>
      <OledScreenMesh map={texture} />
      <OledScreenTextureContext.Provider value={texture}>
        {children}
      </OledScreenTextureContext.Provider>
    </>
  );
}
