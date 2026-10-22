import { useCallback, useEffect, useRef } from "react";
import type { AgentMood } from "../types/agent";
import {
  OVERLAY_PET_HEIGHT,
  OVERLAY_PET_WIDTH,
} from "../constants/overlay-layout";
import { setOverlayRoamHandler } from "../utils/overlay-roam-bridge";

declare global {
  interface Window {
    sphereOverlay?: {
      moveTo: (x: number, y: number, animateMs?: number) => void;
      moveBy: (dx: number, dy: number) => void;
      setPosition: (x: number, y: number) => void;
      getPosition: () => Promise<{ x: number; y: number }>;
      getWorkArea: () => Promise<{ x: number; y: number; width: number; height: number }>;
      setIgnoreMouseEvents: (ignore: boolean, forward?: boolean) => void;
      /** 调整宿主窗口包围盒（悬浮组件层按可见组件收缩窗口，避免遮挡桌面） */
      /** 附加面板宽度（px）：宿主向左扩窗，面板随桌宠移动 */
      setAttachPanel?: (width: number) => void;
      setMenuExpanded?: (expanded: boolean) => void;
      setScheduleCollapsed?: (collapsed: boolean) => void;
      onPatch?: (cb: (patch: Record<string, unknown>) => void) => void;
      onRoam?: (cb: () => void) => void;
    };
    spherePetPos?: { x: number; y: number };
    SpeechRecognition?: typeof SpeechRecognition;
    webkitSpeechRecognition?: typeof SpeechRecognition;
  }
}

interface UseOverlayWindowMotionOptions {
  enabled?: boolean;
  mood?: AgentMood;
}

/** 桌面 overlay 模式 — Electron 窗口在屏幕上自主漫游 */
export function useOverlayWindowMotion({ enabled = false, mood = "idle" }: UseOverlayWindowMotionOptions) {
  const targetRef = useRef<{ x: number; y: number } | null>(null);
  const currentPosRef = useRef<{ x: number; y: number } | null>(null);
  const nextMoveAt = useRef(0);
  /** 垂直方向小幅度振荡（用于身体晃动时窗口上下抖） */
  const verticalShakeRef = useRef<{
    active: boolean;
    until: number;
    amplitude: number;
    nextShakeAt: number;
  }>({ active: false, until: 0, amplitude: 0, nextShakeAt: 0 });

  const pickPetSize = useCallback(() => {
    return {
      w: Number(new URLSearchParams(window.location.search).get("petW")) || OVERLAY_PET_WIDTH,
      h: Number(new URLSearchParams(window.location.search).get("petH")) || OVERLAY_PET_HEIGHT,
    };
  }, []);

  const syncPetScreenCenter = useCallback((x: number, y: number) => {
    const { w, h } = pickPetSize();
    currentPosRef.current = { x, y };
    window.spherePetPos = {
      x: x + w / 2,
      y: y + h / 2,
    };
  }, [pickPetSize]);

  const roamNow = useCallback(async () => {
    if (!window.sphereOverlay) return;
    const area = await window.sphereOverlay.getWorkArea();
    const margin = 12;
    const { w, h } = pickPetSize();
    // 上下左右 + 360° 自由漫游：X / Y 同时随机
    const x = area.x + margin + Math.random() * Math.max(40, area.width - w - margin * 2);
    const y = area.y + margin + Math.random() * Math.max(40, area.height - h - margin * 2);
    targetRef.current = { x, y };
    syncPetScreenCenter(x, y);
    window.sphereOverlay.moveTo(Math.round(x), Math.round(y), 1200);
    nextMoveAt.current = Date.now() + 5000;
  }, [mood, pickPetSize, syncPetScreenCenter]);

  /**
   * 上下方向小幅度振荡 — 让窗口在当前位置附近快速来回移动（视觉上的"上蹿下跳"）。
   * - strength: 0~1
   * - durationMs: 持续时间
   */
  const triggerVerticalShake = useCallback((strength = 0.7, durationMs = 800) => {
    if (!window.sphereOverlay?.moveBy) return;
    const s = Math.min(1, Math.max(0.1, strength));
    const now = Date.now();
    const until = now + Math.max(150, durationMs);
    verticalShakeRef.current.active = true;
    verticalShakeRef.current.until = until;
    verticalShakeRef.current.amplitude = Math.round(6 + s * 22);
    verticalShakeRef.current.nextShakeAt = now;
  }, []);

  useEffect(() => {
    if (!enabled || !window.sphereOverlay) return;

    const runRoam = () => void roamNow();
    setOverlayRoamHandler(runRoam);
    window.sphereOverlay.onRoam?.(runRoam);

    let cancelled = false;

    const schedule = async () => {
      if (cancelled) return;
      await roamNow();
    };

    /** 垂直振荡 tick：每 ~50ms 切换一次方向 */
    const tickVerticalShake = () => {
      const now = Date.now();
      const ref = verticalShakeRef.current;
      if (!ref.active || now >= ref.until) {
        if (ref.active) {
          ref.active = false;
          ref.amplitude = 0;
        }
        return;
      }
      if (now >= ref.nextShakeAt) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        const dy = Math.round(dir * ref.amplitude * (0.4 + Math.random() * 0.6));
        const dx = Math.round((Math.random() - 0.5) * ref.amplitude * 0.3);
        window.sphereOverlay?.moveBy?.(dx, dy);
        if (currentPosRef.current) {
          syncPetScreenCenter(currentPosRef.current.x + dx, currentPosRef.current.y + dy);
        }
        ref.nextShakeAt = now + 50 + Math.random() * 30;
      }
    };

    const tick = () => {
      if (cancelled) return;
      const now = Date.now();
      // 优先跑垂直振荡（高优先级，视觉感强）
      tickVerticalShake();
      const interval = mood === "thinking" ? 5000 : 7000;
      if (!verticalShakeRef.current.active && now >= nextMoveAt.current) {
        void schedule();
        nextMoveAt.current = now + interval;
      }
      window.requestAnimationFrame(tick);
    };

    // 启动后先停留 45s，避免一出现就漫游到屏幕外被误认为"消失"
    nextMoveAt.current = Date.now() + 45_000;
    void window.sphereOverlay.getWorkArea().then((area) => {
      if (cancelled) return;
      const { w, h } = pickPetSize();
      syncPetScreenCenter(
        area.x + Math.max(12, area.width - w - 12),
        area.y + Math.max(12, area.height - h - 12),
      );
    });
    const raf = window.requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      setOverlayRoamHandler(null);
      window.cancelAnimationFrame(raf);
      verticalShakeRef.current.active = false;
      delete window.spherePetPos;
    };
  }, [enabled, mood, pickPetSize, roamNow, syncPetScreenCenter]);

  return { roamNow, triggerVerticalShake };
}
