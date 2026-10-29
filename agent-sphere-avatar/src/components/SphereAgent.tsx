import { useSphere } from "@react-three/cannon";
import { Suspense, useCallback, useEffect, useRef, type Ref, type RefObject } from "react";
import * as THREE from "three";
import { bindEmbodimentCommand } from "../bridge/agent-bridge";
import { triggerOverlayRoam } from "../utils/overlay-roam-bridge";
import { MODEL } from "../constants/model-proportions";
import { postToHost, SPHERE_MSG } from "../embed-protocol";
import { useAgentBodyMotion } from "../hooks/useAgentBodyMotion";
import { useAutonomousMotion } from "../hooks/useAutonomousMotion";
import { useSphereUserDrag, type SphereTouchEvent } from "../hooks/useSphereUserDrag";
import type { AgentState, EmbodimentCommand } from "../types/agent";
import { DG2RobotModel } from "./DG2RobotModel";
import { OledScreen, type ScreenSignals } from "./OledScreen";
import { SphereBodyHandle } from "./SphereBodyHandle";

interface SphereAgentProps {
  state: AgentState;
  onEyeFocus?: (focused: boolean) => void;
  onEyeClick?: () => void;
  physics?: boolean;
  autonomous?: boolean;
  motionBounds?: number;
  hardMotionClamp?: boolean;
  /** 覆盖默认刚体/视觉中心（桌宠固定机位） */
  bodyPosition?: [number, number, number];
  /** 关闭 DG2 待机呼吸位移（桌宠保持尺寸稳定） */
  idleBodyMotion?: boolean;
  /** 桌宠视觉缩放 */
  modelScale?: number;
  onEyeInteractionChange?: (active: boolean) => void;
  /** 允许用户拖拽旋转球体 */
  userDragRotate?: boolean;
  onUserTouch?: (event: SphereTouchEvent) => void;
  onBodyHover?: (active: boolean) => void;
  registerDragBridge?: boolean;
  canvasCaptureLenient?: boolean;
  onPanDelta?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
  /** 实时拖动/旋转反应：每次达到反应阈值时回调，可用于触发身体晃动与说话 */
  onLiveReact?: (intensity: number, mode: "pan" | "rotate") => void;
  /** 旋转中累计 yaw/pitch 角度（弧度）回调 */
  onSpinDelta?: (deltaYaw: number, deltaPitch: number) => void;
  /** 拖动结束回调 */
  onDragRelease?: (info: { mode: "pan" | "rotate"; totalRotationDeg: number; panDistance: number; spinStrength: number }) => void;
  /** 触发身体晃动函数（可由外部任何时机调用） */
  onShakeRequest?: (strength: number, durationMs: number) => void;
  /** 固定机位：锁定 Y 轴，关闭持续呼吸/悬浮位移（桌宠防抖） */
  verticalStable?: boolean;
}

function relayBoundaryToParent(edge: string) {
  if (window.parent === window) return;
  postToHost({ type: SPHERE_MSG.boundary, edge: edge as "left" | "right" | "top" | "bottom" });
}

/** DG2 深灰金属球形机器人 — OBJ 一比一还原 */
export function SphereAgent({
  state,
  onEyeFocus,
  onEyeClick,
  physics = true,
  autonomous = true,
  motionBounds = 2.4,
  hardMotionClamp = false,
  bodyPosition,
  idleBodyMotion = true,
  modelScale = 1,
  onEyeInteractionChange,
  userDragRotate = true,
  onUserTouch,
  onBodyHover,
  registerDragBridge = false,
  canvasCaptureLenient = false,
  onPanDelta,
  onPanEnd,
  onLiveReact,
  onSpinDelta,
  onDragRelease,
  onShakeRequest,
  verticalStable = false,
}: SphereAgentProps) {
  const visualRef = useRef<THREE.Group>(null);
  const userRotRef = useRef<THREE.Group>(null);
  const faceSignalsRef = useRef<ScreenSignals>({
    boundaryBump: 0,
    excitement: 0,
    speed: 0,
    speakPulse: 0,
    userTouch: 0,
    userSpin: 0,
  });

  const [ref, api] = useSphere(() => ({
    mass: physics ? 1.2 : 0,
    type: physics ? "Dynamic" : "Static",
    position: bodyPosition ?? [0, 1.6, 0],
    args: [MODEL.bodyRadius * 0.94],
    linearDamping: physics ? 0.82 : 0.95,
    angularDamping: 0.9,
    material: { friction: 0.35, restitution: 0.22 },
  }));

  const motionStrength =
    state.mood === "thinking" ? 0.85 : 1;

  const kinematic = !physics && (autonomous || motionBounds === 0);

  const bodyMotion = useAgentBodyMotion({
    api: kinematic ? api : undefined,
    visualRef,
    faceSignalsRef,
    enabled: kinematic,
    bounds: motionBounds,
    mood: state.mood,
    energy: state.energy,
    focused: state.focused,
    phase: state.phase,
    caption: state.caption,
    source: state.source,
    attentionTarget: state.attentionTarget,
    taskEvents: state.taskEvents,
    onBoundaryHit: (edge) => relayBoundaryToParent(edge),
    verticalStable,
  });

  const physicsMotion = useAutonomousMotion({
    api,
    enabled: physics && autonomous,
    bounds: motionBounds,
    strength: motionStrength,
    hardClamp: hardMotionClamp,
  });

  const motion = kinematic ? bodyMotion : physicsMotion;
  const exciteMotion = kinematic ? bodyMotion.excite : undefined;
  const shakeMotion = kinematic ? bodyMotion.shake : undefined;
  const verticalBiasMotion = kinematic ? bodyMotion.applyVerticalBias : undefined;
  const shakeBridgeRef = useRef<((strength: number, durationMs: number) => void) | null>(null);

  /** 触发身体晃动（内部或外部均可） */
  const triggerShake = useCallback((strength: number, durationMs: number) => {
    shakeMotion?.(strength, durationMs);
    verticalBiasMotion?.(Math.sin(performance.now() * 0.013) * strength);
  }, [shakeMotion, verticalBiasMotion]);

  // 外部 onShakeRequest 也可触发身体晃动
  useEffect(() => {
    if (!onShakeRequest) return;
    shakeBridgeRef.current = triggerShake;
    return () => {
      shakeBridgeRef.current = null;
    };
  }, [onShakeRequest, triggerShake]);

  const relayTouchToParent = useCallback(
    (event: SphereTouchEvent) => {
      onUserTouch?.(event);
      if (window.parent === window) return;
      postToHost({
        type: SPHERE_MSG.touch,
        phase: event.phase,
        spinStrength: event.spinStrength,
        totalRotationDeg: event.totalRotationDeg,
      });
    },
    [onUserTouch],
  );

  const dragHandlers = useSphereUserDrag({
    userRotRef,
    bodyRef: ref as unknown as RefObject<THREE.Object3D | null>,
    faceSignalsRef,
    enabled: userDragRotate,
    canvasCapture: false,
    canvasCaptureLenient,
    registerBridge: registerDragBridge,
    api: physics ? api : undefined,
    onTouch: relayTouchToParent,
    onEyeClick,
    onPanDelta,
    onPanEnd,
    onLiveReact: (intensity, mode) => {
      onLiveReact?.(intensity, mode);
      // 右键旋转只让用户观察模型，不产生任何身体反应
      if (mode !== "pan") return;
      triggerShake(0.35 + intensity * 0.5, 600);
      if (kinematic) bodyMotion.excite?.(0.25 + intensity * 0.45);
    },
    onSpinDelta,
    onDragRelease: (info) => {
      // 右键旋转松手同样不触发任何动作
      if (info.mode !== "pan") return;
      onDragRelease?.(info);
      triggerShake(0.5, 950);
    },
    onBodyHover: (active) => {
      onBodyHover?.(active);
      onEyeInteractionChange?.(active);
      if (active) onEyeFocus?.(true);
      else onEyeFocus?.(false);
    },
  });

  useEffect(() => {
    const handleCommand = (cmd: EmbodimentCommand) => {
      if (kinematic && typeof cmd.screenX === "number" && typeof cmd.screenY === "number") {
        bodyMotion.lookAtScreenPoint(cmd.screenX, cmd.screenY, cmd.strength ?? 0.7, cmd.source ?? "screen", 2200);
      }
      switch (cmd.action) {
        case "roam":
          if (kinematic) {
            motion.resumeMotion();
            const s = typeof cmd.strength === "number" ? cmd.strength : 1;
            if (s >= 1.05) exciteMotion?.(s);
            else motion.pickRandomTarget();
          } else if (physics) {
            motion.resumeMotion();
            motion.pickRandomTarget();
          } else {
            triggerOverlayRoam();
          }
          break;
        case "excite":
          if (kinematic) {
            motion.resumeMotion();
            exciteMotion?.(cmd.strength ?? 1.4);
          } else if (physics) {
            motion.resumeMotion();
            motion.pickRandomTarget();
          } else {
            postToHost({
              type: SPHERE_MSG.command,
              action: "excite",
              strength: cmd.strength ?? 1.4,
            });
          }
          break;
        case "move":
          if (kinematic || physics) {
            motion.resumeMotion();
            if (cmd.x != null && cmd.z != null) {
              motion.setTarget(cmd.x, cmd.y ?? 1.6, cmd.z);
            }
          }
          break;
        case "stop":
          motion.stopMotion();
          break;
        case "window_roam":
          triggerOverlayRoam();
          if (window.parent !== window) {
            postToHost({ type: SPHERE_MSG.command, action: "window_roam" });
          }
          break;
        default:
          break;
      }
    };
    return bindEmbodimentCommand(handleCommand);
  }, [kinematic, physics, motion, exciteMotion, bodyMotion.lookAtScreenPoint]);

  return (
    <group ref={ref as Ref<THREE.Group>}>
      <group ref={visualRef}>
        <group ref={userRotRef} scale={modelScale}>
          <OledScreen
            mood={state.mood}
            energy={state.energy}
            focused={state.focused}
            signalsRef={faceSignalsRef}
          >
            <Suspense
              fallback={
                <mesh>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.7, 24, 24]} />
                  <meshStandardMaterial color="#5a6a7a" wireframe />
                </mesh>
              }
            >
              <DG2RobotModel
                energy={state.energy}
                focused={state.focused}
                idleMotion={idleBodyMotion}
                standaloneLighting={modelScale !== 1}
              />
            </Suspense>
            {userDragRotate ? (
              <SphereBodyHandle
                radius={dragHandlers.bodyRadius}
                onPointerDown={dragHandlers.handlePointerDown}
                onPointerMove={dragHandlers.handlePointerMove}
                onPointerUp={dragHandlers.handlePointerUp}
                onBodyHover={dragHandlers.handleBodyHover}
              />
            ) : null}
          </OledScreen>
        </group>
      </group>
    </group>
  );
}
