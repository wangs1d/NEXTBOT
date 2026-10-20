import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { PublicApi } from "@react-three/cannon";
import { MODEL } from "../constants/model-proportions";
import type { ScreenSignals } from "../components/OledScreen";
import { registerSphereDrag, type SphereDragApi } from "../bridge/sphere-drag-bridge";
import { postToHost, SPHERE_MSG } from "../embed-protocol";
import { pointerHitsSphere } from "../utils/sphere-hit";

export type SphereTouchPhase = "start" | "drag" | "end";

export interface SphereTouchEvent {
  phase: SphereTouchPhase;
  spinStrength?: number;
  totalRotationDeg?: number;
}

interface UseSphereUserDragOptions {
  userRotRef: RefObject<THREE.Group | null>;
  /** 物理体/根 group — 用于 Canvas 级命中检测 */
  bodyRef?: RefObject<THREE.Object3D | null>;
  faceSignalsRef?: RefObject<ScreenSignals>;
  enabled?: boolean;
  /** Canvas DOM 级拖拽 */
  canvasCapture?: boolean;
  /** 任意 Canvas 点击即拖拽（demo 页） */
  canvasCaptureLenient?: boolean;
  /** 注册到 DOM 拖拽桥（embed 网页层） */
  registerBridge?: boolean;
  api?: PublicApi;
  onTouch?: (event: SphereTouchEvent) => void;
  onExcite?: (strength: number) => void;
  onBodyHover?: (active: boolean) => void;
  onEyeClick?: () => void;
  /** 左键拖动平移（无桌面 overlay API 时回调） */
  onPanDelta?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
  /** 拖动中累积强度变化（每次跨过 LIVE_REACT_THRESHOLD 触发一次）。强度基于累计位移 + 当前速度 */
  onLiveReact?: (intensity: number, mode: DragMode) => void;
  /** 旋转中累计角度（弧度）回调 — 用于实时反应动画与状态 */
  onSpinDelta?: (deltaYaw: number, deltaPitch: number) => void;
  /** 拖动结束事件（用于松手瞬间触发动态反应/说话） */
  onDragRelease?: (info: { mode: DragMode; totalRotationDeg: number; panDistance: number; spinStrength: number }) => void;
}

type DragMode = "pan" | "rotate";

const SPIN_EXCITE_THRESHOLD = 0.35;
const HIT_RADIUS = MODEL.bodyRadius * 1.12;
const EYE_HIT_RADIUS = MODEL.bodyRadius * Math.sin(MODEL.screenHitHalfAngle);
const EYE_CLICK_DRAG_PX = 10;
/** 实时反应：旋转/拖动累积到该强度阈值就触发一次身体晃动 */
const LIVE_REACT_THRESHOLD = 0.12;
/** onLiveReact 冷却间隔（ms），防止快速拖动时频繁触发 shake 动画导致卡顿 */
const LIVE_REACT_COOLDOWN_MS = 80;
/** 旋转过冲衰减：在 useFrame 中用 decay 指数衰减 */

/** 左键拖动平移、右键拖动旋转 */
export function useSphereUserDrag({
  userRotRef,
  bodyRef,
  faceSignalsRef,
  enabled = true,
  canvasCapture = true,
  canvasCaptureLenient = false,
  registerBridge = false,
  api,
  onTouch,
  onExcite,
  onBodyHover,
  onEyeClick,
  onPanDelta,
  onPanEnd,
  onLiveReact,
  onSpinDelta,
  onDragRelease,
}: UseSphereUserDragOptions) {
  const { camera, gl, raycaster } = useThree();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const spinVelRef = useRef({ x: 0, y: 0 });
  const totalRotRef = useRef(0);
  const totalYawRadRef = useRef(0);
  const totalPitchRadRef = useRef(0);
  const touchPulseRef = useRef(0);
  const dragModeRef = useRef<DragMode>("pan");
  const activeButtonRef = useRef(0);
  const panMovedRef = useRef(0);
  const panRemainderRef = useRef({ x: 0, y: 0 });
  /** 实时反应累积强度（每次跨越 LIVE_REACT_THRESHOLD 触发一次 onLiveReact） */
  const liveReactBucketRef = useRef(0);
  /** 上次触发 onLiveReact 的时间戳（用于冷却限流，防止频繁 shake 导致卡顿） */
  const lastLiveReactTimeRef = useRef(0);
  /** 物理引擎 angularVelocity 同步节流计数器（每 3 次写入一次即可） */
  const physicsSyncCounterRef = useRef(0);
  /** Electron 窗口拖拽须用 screen 坐标，否则 moveBy 后 client 坐标反馈导致抖动 */
  const panUseScreenSpaceRef = useRef(false);
  /** 直接应用位移增量（移除 RAF 节流，避免与 R3F useFrame 渲染帧不同步导致卡顿） */
  const bodyCenterRef = useRef(new THREE.Vector3(0, 1.6, 0));
  const eyeLocalRef = useRef(new THREE.Vector3(...MODEL.glassScreenPosition));
  const eyeWorldRef = useRef(new THREE.Vector3());
  /** 记录最后一次 pointerup 的坐标（用于 eye-click 检测，解决 window/mesh 双路径竞争） */
  const lastUpCoordsRef = useRef({ clientX: 0, clientY: 0 });
  /** 防止同一轮拖拽重复触发 onEyeClick */
  const eyeClickFiredRef = useRef(false);

  const applyScreenSignals = useCallback(
    (touch: number, spin: number) => {
      const signals = faceSignalsRef?.current;
      if (!signals) return;
      signals.userTouch = Math.max(signals.userTouch, touch);
      signals.userSpin = Math.max(signals.userSpin, spin);
    },
    [faceSignalsRef],
  );

  const readPointer = useCallback((clientX: number, clientY: number, screenX: number, screenY: number) => {
    if (panUseScreenSpaceRef.current) {
      return { x: screenX, y: screenY };
    }
    return { x: clientX, y: clientY };
  }, []);

  const applyDragDelta = useCallback(
    (dx: number, dy: number) => {
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

      if (dragModeRef.current === "pan") {
        panMovedRef.current += Math.abs(dx) + Math.abs(dy);

        if (window.sphereOverlay?.moveBy) {
          panRemainderRef.current.x += dx;
          panRemainderRef.current.y += dy;
          const ix = Math.trunc(panRemainderRef.current.x);
          const iy = Math.trunc(panRemainderRef.current.y);
          if (ix !== 0 || iy !== 0) {
            panRemainderRef.current.x -= ix;
            panRemainderRef.current.y -= iy;
            window.sphereOverlay.moveBy(ix, iy);
          }
        } else if (onPanDelta) {
          onPanDelta(dx, dy);
        } else if (window.parent !== window) {
          postToHost({ type: SPHERE_MSG.pan, dx, dy });
        }

        // 实时反应：拖动也累计强度，到达阈值触发晃动（带冷却限流）
        liveReactBucketRef.current += (Math.abs(dx) + Math.abs(dy)) / 100;
        while (liveReactBucketRef.current >= LIVE_REACT_THRESHOLD) {
          liveReactBucketRef.current -= LIVE_REACT_THRESHOLD;
          const now = performance.now();
          if (now - lastLiveReactTimeRef.current >= LIVE_REACT_COOLDOWN_MS) {
            lastLiveReactTimeRef.current = now;
            onLiveReact?.(
              Math.min(1, liveReactBucketRef.current / LIVE_REACT_THRESHOLD + 0.3),
              "pan",
            );
          }
        }
        return;
      }

      const dt = 0.016;
      const rotY = dx * 0.014;
      const rotX = dy * 0.011;
      totalRotRef.current += Math.abs(dx) + Math.abs(dy);
      // 360° 旋转：累计 yaw 不再夹紧（X 仅用于短期倾斜动量）
      totalYawRadRef.current += rotY;
      totalPitchRadRef.current += rotX;

      const group = userRotRef.current;
      if (group) {
        // Y 轴自由 360° 旋转；X 轴跟随输入（惯性阶段由 useFrame lerp 回归）
        group.rotation.y += rotY;
        group.rotation.x += rotX;
        // 防止浮点溢出
        if (group.rotation.x > Math.PI * 2) group.rotation.x -= Math.PI * 2;
        else if (group.rotation.x < -Math.PI * 2) group.rotation.x += Math.PI * 2;
      }

      onSpinDelta?.(rotY, rotX);

      spinVelRef.current = {
        x: THREE.MathUtils.lerp(spinVelRef.current.x, rotX / dt, 0.35),
        y: THREE.MathUtils.lerp(spinVelRef.current.y, rotY / dt, 0.35),
      };

      if (api) {
        physicsSyncCounterRef.current++;
        if (physicsSyncCounterRef.current % 3 === 0) {
          api.angularVelocity.set(spinVelRef.current.x * 2.2, spinVelRef.current.y * 3.5, spinVelRef.current.x * 0.4);
        }
      }

      const spin = Math.min(1, (Math.abs(spinVelRef.current.x) + Math.abs(spinVelRef.current.y)) * 0.18);
      applyScreenSignals(1, spin);

      // 实时反应：旋转累计强度跨越阈值就触发一次身体晃动（带冷却限流）
    },
    [api, applyScreenSignals, onLiveReact, onPanDelta, onSpinDelta, onTouch, userRotRef],
  );

  /** 直接调用 applyDragDelta（移除 RAF 节流，消除与 R3F 渲染帧不同步导致的卡顿） */
  const applyPointerMove = useCallback(
    (clientX: number, clientY: number, screenX: number, screenY: number) => {
      const p = readPointer(clientX, clientY, screenX, screenY);
      const dx = p.x - lastPointerRef.current.x;
      const dy = p.y - lastPointerRef.current.y;
      lastPointerRef.current = { x: p.x, y: p.y };
      applyDragDelta(dx, dy);
    },
    [readPointer, applyDragDelta],
  );
  const finishDrag = useCallback(
    (upClientX?: number, upClientY?: number) => {
      if (!draggingRef.current) return;

      // 记录 up 坐标（用于 eye-click 检测）
      if (upClientX != null && upClientY != null) {
        lastUpCoordsRef.current = { clientX: upClientX, clientY: upClientY };
      }

      const mode = dragModeRef.current;
      const wasPan = mode === "pan";
      const button = activeButtonRef.current;
      const panPx = panMovedRef.current;

      draggingRef.current = false;
      pointerIdRef.current = null;

      let releaseInfo: { mode: DragMode; totalRotationDeg: number; panDistance: number; spinStrength: number };

      if (mode === "rotate") {
        const spinStrength = Math.min(
          1,
          (Math.abs(spinVelRef.current.x) + Math.abs(spinVelRef.current.y)) * 0.22,
        );
        const totalRotationDeg = (totalYawRadRef.current * 180) / Math.PI;
        const totalPitchDeg = (totalPitchRadRef.current * 180) / Math.PI;

        if (spinStrength > SPIN_EXCITE_THRESHOLD) {
          onExcite?.(0.6 + spinStrength * 0.9);
          applyScreenSignals(0.6, spinStrength);
        } else if (totalRotRef.current > 8) {
          applyScreenSignals(0.45, spinStrength * 0.5);
        }

        onTouch?.({ phase: "end", spinStrength, totalRotationDeg });
        releaseInfo = {
          mode: "rotate",
          totalRotationDeg: Math.abs(totalRotationDeg) + Math.abs(totalPitchDeg),
          panDistance: 0,
          spinStrength,
        };
      } else {
        if (window.sphereOverlay?.moveBy) {
          const rx = Math.round(panRemainderRef.current.x);
          const ry = Math.round(panRemainderRef.current.y);
          if (rx !== 0 || ry !== 0) {
            window.sphereOverlay.moveBy(rx, ry);
          }
        }
        panRemainderRef.current = { x: 0, y: 0 };
        panUseScreenSpaceRef.current = false;
        onPanEnd?.();
        releaseInfo = {
          mode: "pan",
          totalRotationDeg: 0,
          panDistance: panPx,
          spinStrength: 0,
        };
      }

      onDragRelease?.(releaseInfo);
      liveReactBucketRef.current = 0;

      dragModeRef.current = "pan";
      activeButtonRef.current = 0;
      panMovedRef.current = 0;
      totalYawRadRef.current = 0;
      totalPitchRadRef.current = 0;

      // Eye-click 检测：左键短距离平移 + 命中眼部区域 → 触发 onEyeClick
      // 使用 guard 防止 window/mesh 双路径重复触发
      if (
        !eyeClickFiredRef.current &&
        onEyeClick &&
        wasPan &&
        button === 0 &&
        panPx < EYE_CLICK_DRAG_PX
      ) {
        const coords = upClientX != null ? { clientX: upClientX, clientY: upClientY! } : lastUpCoordsRef.current;
        if (
          pointerHitsSphere(
            coords.clientX,
            coords.clientY,
            gl.domElement,
            camera,
            raycaster,
            eyeWorldRef.current,
            EYE_HIT_RADIUS,
          )
        ) {
          eyeClickFiredRef.current = true;
          onEyeClick();
        }
      }
    },
    [applyDragDelta, applyScreenSignals, camera, gl.domElement, onDragRelease, onExcite, onEyeClick, onPanEnd, onTouch, raycaster],
  );

  const beginDrag = useCallback(
    (
      clientX: number,
      clientY: number,
      screenX: number,
      screenY: number,
      pointerId: number,
      mode: DragMode,
      button: number,
    ) => {
      if (!enabledRef.current || draggingRef.current) return false;
      draggingRef.current = true;
      pointerIdRef.current = pointerId;
      dragModeRef.current = mode;
      activeButtonRef.current = button;
      panUseScreenSpaceRef.current = mode === "pan" && !!window.sphereOverlay?.moveBy;
      const p = readPointer(clientX, clientY, screenX, screenY);
      lastPointerRef.current = { x: p.x, y: p.y };
      spinVelRef.current = { x: 0, y: 0 };
      totalRotRef.current = 0;
      panMovedRef.current = 0;
      panRemainderRef.current = { x: 0, y: 0 };
      physicsSyncCounterRef.current = 0;
      touchPulseRef.current = 1;
      applyScreenSignals(1, 0);
      // 每轮拖拽开始时重置 eye-click 标记
      eyeClickFiredRef.current = false;
      if (mode === "rotate") {
        onTouch?.({ phase: "start" });
      }
      return true;
    },
    [applyScreenSignals, onTouch, readPointer],
  );

  const resolveDragMode = (button: number): DragMode | null => {
    if (button === 0) return "pan";
    if (button === 2) return "rotate";
    return null;
  };

  const handlePointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const mode = resolveDragMode(e.button);
      if (!enabledRef.current || mode == null) return;
      e.stopPropagation();
      beginDrag(e.clientX, e.clientY, e.screenX, e.screenY, e.pointerId, mode, e.button);
    },
    [beginDrag],
  );

  const handlePointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();
      applyPointerMove(e.clientX, e.clientY, e.screenX, e.screenY);
    },
    [applyPointerMove],
  );

  const handlePointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.stopPropagation();
      // finishDrag 内部统一处理 eye-click 检测（含防重复 guard）
      finishDrag(e.clientX, e.clientY);
    },
    [finishDrag],
  );

  const handleBodyHover = useCallback(
    (active: boolean) => {
      if (draggingRef.current) return;
      onBodyHover?.(active);
    },
    [onBodyHover],
  );

  useFrame((_, delta) => {
    const root = bodyRef?.current ?? userRotRef.current;
    root?.getWorldPosition(bodyCenterRef.current);
    const rotGroup = userRotRef.current;
    if (rotGroup) {
      eyeWorldRef.current.copy(eyeLocalRef.current);
      rotGroup.localToWorld(eyeWorldRef.current);
    }

    if (!enabledRef.current) return;

    const dt = Math.min(delta, 0.032);
    touchPulseRef.current = Math.max(0, touchPulseRef.current - dt * 2.8);

    const signals = faceSignalsRef?.current;
    if (signals) {
      signals.userTouch = Math.max(touchPulseRef.current, signals.userTouch - dt * 2.5);
      signals.userSpin = Math.max(0, signals.userSpin - dt * 1.8);
    }

    if (draggingRef.current) return;

    const group = userRotRef.current;
    if (!group) return;

    const sv = spinVelRef.current;
    if (Math.abs(sv.x) + Math.abs(sv.y) < 0.002) {
      spinVelRef.current = { x: 0, y: 0 };
      // X 轴软回归 0（保持竖直）
      group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, 0, dt * 2.2);
      // 衰减后归一化 Y 轴到 (-PI, PI] 防止浮点漂移
      const TAU = Math.PI * 2;
      if (group.rotation.y > Math.PI) group.rotation.y -= TAU;
      else if (group.rotation.y < -Math.PI) group.rotation.y += TAU;
      return;
    }

    // 360° 自由旋转：Y 轴不夹紧；X 轴不夹紧但在更高频的 lerp 回归中
    group.rotation.y += sv.y * dt;
    group.rotation.x += sv.x * dt;
    group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, 0, dt * 0.6);

    const decay = Math.exp(-3.2 * dt);
    spinVelRef.current = { x: sv.x * decay, y: sv.y * decay };

    if (api && (Math.abs(sv.x) + Math.abs(sv.y)) > 0.01) {
      api.angularVelocity.set(sv.x * 1.8, sv.y * 2.8, sv.x * 0.3);
    }
  });

  useEffect(() => {
    const onWindowMove = (e: PointerEvent) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      applyPointerMove(e.clientX, e.clientY, e.screenX, e.screenY);
    };

    const onWindowUp = (e: PointerEvent) => {
      if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
      // finishDrag 内部统一处理 eye-click 检测（含防重复 guard）
      finishDrag(e.clientX, e.clientY);
    };

    window.addEventListener("pointermove", onWindowMove, { passive: false });
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowUp);
    return () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
    };
  }, [applyPointerMove, finishDrag]);

  useEffect(() => {
    const dom = gl.domElement;
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    dom.addEventListener("contextmenu", onContextMenu);
    return () => dom.removeEventListener("contextmenu", onContextMenu);
  }, [gl]);

  useEffect(() => {
    if (!registerBridge) return;
    const bridgeApi: SphereDragApi = {
      beginDrag: (x, y, id) => beginDrag(x, y, x, y, id, "rotate", 2),
      moveBy: (dx, dy) => applyDragDelta(dx, dy),
      endDrag: () => finishDrag(),
    };
    registerSphereDrag(bridgeApi);
    return () => registerSphereDrag(null);
  }, [registerBridge, beginDrag, applyDragDelta, finishDrag]);

  useEffect(() => {
    if (!canvasCapture) return;
    const dom = gl.domElement;
    dom.style.touchAction = "none";

    const onCanvasDown = (e: PointerEvent) => {
      const mode = resolveDragMode(e.button);
      if (!enabledRef.current || mode == null || draggingRef.current) return;

      if (!canvasCaptureLenient) {
        if (
          !pointerHitsSphere(
            e.clientX,
            e.clientY,
            dom,
            camera,
            raycaster,
            bodyCenterRef.current,
            HIT_RADIUS,
          )
        ) {
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();
      beginDrag(e.clientX, e.clientY, e.screenX, e.screenY, e.pointerId, mode, e.button);
      dom.setPointerCapture(e.pointerId);
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    const onCanvasUp = (e: PointerEvent) => {
      if (pointerIdRef.current !== e.pointerId) return;
      try {
        dom.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };

    dom.addEventListener("pointerdown", onCanvasDown, { capture: true });
    dom.addEventListener("pointerup", onCanvasUp, { capture: true });
    dom.addEventListener("pointercancel", onCanvasUp, { capture: true });
    dom.addEventListener("contextmenu", onContextMenu);

    return () => {
      dom.removeEventListener("pointerdown", onCanvasDown, { capture: true });
      dom.removeEventListener("pointerup", onCanvasUp, { capture: true });
      dom.removeEventListener("pointercancel", onCanvasUp, { capture: true });
      dom.removeEventListener("contextmenu", onContextMenu);
    };
  }, [beginDrag, camera, canvasCapture, canvasCaptureLenient, gl, raycaster, userRotRef]);

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleBodyHover,
    bodyRadius: HIT_RADIUS,
    isDragging: () => draggingRef.current,
    dragDistance: () => totalRotRef.current,
    getYawRad: () => userRotRef.current?.rotation.y ?? 0,
    getPitchRad: () => userRotRef.current?.rotation.x ?? 0,
  };
}
