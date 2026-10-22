/**
 * 桌宠附加面板的开关 + 宿主扩窗协调。
 *
 * 面板与桌宠绑定的关键：面板在桌宠窗口内部，宿主窗口向左扩出面板宽度，
 * 因此"窗口被拖动 / 球体被拖动"时面板天然跟着走，不需要任何位置同步。
 *
 * 退场动画期间保留 DOM 与窗口宽度，动画结束后才真正回收。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type AttachPanelKind = "focus" | "offwork";

/** 面板槽位宽度（px）。宿主按此宽度向左扩窗，须与 CSS 面板宽度一致。 */
export const ATTACH_PANEL_WIDTH: Record<AttachPanelKind, number> = {
  focus: 170,
  offwork: 224,
};

const DRAW_MS = 400;
const RETRACT_MS = 190;

export interface UseAttachPanelResult {
  panel: AttachPanelKind | null;
  retracting: boolean;
  /** 槽位宽度：退场动画期间保持，结束归零 */
  width: number;
  open: (kind: AttachPanelKind) => void;
  close: () => void;
  toggle: (kind: AttachPanelKind) => void;
}

export function useAttachPanel(onDrawStart?: () => void): UseAttachPanelResult {
  const [panel, setPanel] = useState<AttachPanelKind | null>(null);
  const [retracting, setRetracting] = useState(false);

  const timerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const panelRef = useRef<AttachPanelKind | null>(null);
  panelRef.current = panel;

  const clearTimers = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const open = useCallback(
    (kind: AttachPanelKind) => {
      clearTimers();
      if (panelRef.current === kind) {
        setRetracting(false);
        return;
      }
      // 已开着另一块板：先收再出，避免两块板抢同一个槽位
      if (panelRef.current != null) {
        setRetracting(true);
        timerRef.current = window.setTimeout(() => {
          setRetracting(false);
          onDrawStart?.();
          setPanel(kind);
        }, RETRACT_MS);
        return;
      }
      // 球体先"动一下"（掏出动作的物理铺垫），板随后被拉出来
      onDrawStart?.();
      timerRef.current = window.setTimeout(() => setPanel(kind), 80);
    },
    [clearTimers, onDrawStart],
  );

  const close = useCallback(() => {
    if (panelRef.current == null) return;
    clearTimers();
    setRetracting(true);
    closeTimerRef.current = window.setTimeout(() => {
      setPanel(null);
      setRetracting(false);
    }, RETRACT_MS);
  }, [clearTimers]);

  const toggle = useCallback(
    (kind: AttachPanelKind) => {
      if (panelRef.current === kind && !retracting) close();
      else open(kind);
    },
    [close, open, retracting],
  );

  useEffect(() => clearTimers, [clearTimers]);

  const width = panel ? ATTACH_PANEL_WIDTH[panel] : 0;

  // 布局同步：先改窗口再让 DOM 排版，避免一帧错位
  useLayoutEffect(() => {
    window.sphereOverlay?.setAttachPanel?.(width);
  }, [width]);

  // 卸载/关闭兜底：窗口恢复原宽
  useEffect(() => {
    return () => {
      window.sphereOverlay?.setAttachPanel?.(0);
    };
  }, []);

  return { panel, retracting, width, open, close, toggle };
}

export { DRAW_MS };
