import { useSphere } from "@react-three/cannon";
import { useFrame } from "@react-three/fiber";
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

const HEADPHONE_MODEL_URL = `${import.meta.env.BASE_URL}models/DG.obj`;

function clamp01(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function remap(value: number, inMin: number, inMax: number): number {
  return clamp01((value - inMin) / (inMax - inMin));
}

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
  const baseModelRef = useRef<THREE.Group>(null);
  const headphoneModelRef = useRef<THREE.Group>(null);
  const transitionFxRef = useRef<THREE.Group>(null);
  const leftPodRef = useRef<THREE.Group>(null);
  const rightPodRef = useRef<THREE.Group>(null);
  const headbandRef = useRef<THREE.Group>(null);
  const leftGhostRef = useRef<THREE.Mesh>(null);
  const rightGhostRef = useRef<THREE.Mesh>(null);
  const leftSolidRef = useRef<THREE.Mesh>(null);
  const rightSolidRef = useRef<THREE.Mesh>(null);
  const bandGhostRef = useRef<THREE.Mesh>(null);
  const bandSolidRef = useRef<THREE.Mesh>(null);
  const leftScanRef = useRef<THREE.Mesh>(null);
  const rightScanRef = useRef<THREE.Mesh>(null);
  const bandScanRef = useRef<THREE.Mesh>(null);
  const faceSignalsRef = useRef<ScreenSignals>({
    boundaryBump: 0,
    excitement: 0,
    speed: 0,
    speakPulse: 0,
    userTouch: 0,
    userSpin: 0,
  });
  const listenTransitionRef = useRef(0);

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
      // 实时身体晃动 + 物理冲量
      triggerShake(0.35 + intensity * 0.5, 600);
      if (kinematic) bodyMotion.excite?.(0.25 + intensity * 0.45);
    },
    onSpinDelta,
    onDragRelease: (info) => {
      onDragRelease?.(info);
      // 松手时给一个最终的身体晃动 + 物理抖动
      const endShake = Math.min(1, info.spinStrength * 1.4 + Math.min(1, info.totalRotationDeg / 360) * 0.6);
      triggerShake(0.5 + endShake * 0.5, 950);
    },
    onBodyHover: (active) => {
      onBodyHover?.(active);
      onEyeInteractionChange?.(active);
      if (active) onEyeFocus?.(true);
      else onEyeFocus?.(false);
    },
    onExcite: (strength) => {
      if (kinematic) exciteMotion?.(strength);
      else if (physics && autonomous) {
        motion.resumeMotion();
        motion.pickRandomTarget();
      }
      if (faceSignalsRef.current) {
        faceSignalsRef.current.excitement = Math.max(faceSignalsRef.current.excitement, 0.5 + strength * 0.35);
      }
      triggerShake(0.6 + strength * 0.3, 1100);
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

  useFrame((_, delta) => {
    const target = state.mood === "listening" ? 1 : 0;
    const blend = 1 - Math.exp(-delta * 4.4);
    listenTransitionRef.current += (target - listenTransitionRef.current) * blend;
    const p = THREE.MathUtils.clamp(listenTransitionRef.current, 0, 1);
    const pulse = Math.sin(performance.now() * 0.01) * 0.5 + 0.5;
    const corePhase = THREE.MathUtils.smootherstep(p, 0.05, 0.28);
    const podPhase = THREE.MathUtils.smootherstep(p, 0.24, 0.66);
    const printPhase = THREE.MathUtils.smootherstep(p, 0.42, 0.78);
    const bandPhase = THREE.MathUtils.smootherstep(p, 0.62, 0.9);
    const revealPhase = THREE.MathUtils.smootherstep(p, 0.9, 0.995);

    if (baseModelRef.current) {
      const scale = 1 - podPhase * 0.028 - revealPhase * 0.018;
      baseModelRef.current.scale.setScalar(scale);
      baseModelRef.current.position.y = podPhase * 0.005;
      baseModelRef.current.rotation.z = -podPhase * 0.02;
    }

    if (headphoneModelRef.current) {
      const scale = 0.985 + revealPhase * 0.015;
      headphoneModelRef.current.scale.setScalar(scale);
      headphoneModelRef.current.position.y = (1 - revealPhase) * -0.006;
      headphoneModelRef.current.position.z = (1 - revealPhase) * -0.004;
      headphoneModelRef.current.rotation.z = (1 - revealPhase) * 0.012;
    }

    if (transitionFxRef.current) {
      transitionFxRef.current.visible = p > 0.02 && p < 0.72;
      transitionFxRef.current.scale.setScalar(0.52 + corePhase * 0.14 + pulse * 0.01);
      transitionFxRef.current.rotation.z += delta * (0.12 + corePhase * 0.34);
      transitionFxRef.current.position.z = 0.008 + corePhase * 0.014;
    }

    const podArc = Math.sin(podPhase * Math.PI) * 0.01;
    const podVisibility = p > 0.16 && p < 0.94;
    const podScale = 0.84 + (1 - Math.abs(podPhase - 0.5) * 2) * 0.08;
    const podSpin = Math.sin(podPhase * Math.PI) * 0.012;
    const ghostOpacity = (1 - revealPhase) * Math.sin(podPhase * Math.PI) * 0.14;
    const metalOpacity = clamp01(remap(p, 0.56, 0.86)) * (1 - revealPhase * 0.65);
    const scanOpacity = Math.sin(printPhase * Math.PI) * (1 - revealPhase) * 0.3;
    const scanLocalZ = -0.07 + printPhase * 0.15;

    if (leftPodRef.current) {
      leftPodRef.current.visible = podVisibility;
      leftPodRef.current.position.set(
        -0.325 + podPhase * 0.04,
        0.018 + podArc,
        0.028 + Math.sin(podPhase * Math.PI) * 0.04,
      );
      leftPodRef.current.rotation.set(
        0.03 + podSpin,
        -0.36 + podPhase * 0.04,
        0.01,
      );
      leftPodRef.current.scale.setScalar(podScale);
    }

    if (rightPodRef.current) {
      rightPodRef.current.visible = podVisibility;
      rightPodRef.current.position.set(
        0.325 - podPhase * 0.04,
        0.018 + podArc,
        0.028 + Math.sin(podPhase * Math.PI) * 0.04,
      );
      rightPodRef.current.rotation.set(
        0.03 + podSpin,
        0.36 - podPhase * 0.04,
        -0.01,
      );
      rightPodRef.current.scale.setScalar(podScale);
    }

    if (headbandRef.current) {
      headbandRef.current.visible = bandPhase > 0.02 && p < 0.975;
      headbandRef.current.position.y = 0.428 - bandPhase * 0.012;
      headbandRef.current.position.z = 0.072 + (1 - bandPhase) * 0.012;
      headbandRef.current.rotation.x = Math.PI / 2;
      headbandRef.current.scale.set(
        0.985 + bandPhase * 0.025,
        0.985 + bandPhase * 0.025,
        0.985 + bandPhase * 0.025,
      );
    }

    if (leftGhostRef.current) {
      (leftGhostRef.current.material as THREE.MeshBasicMaterial).opacity = ghostOpacity;
    }
    if (rightGhostRef.current) {
      (rightGhostRef.current.material as THREE.MeshBasicMaterial).opacity = ghostOpacity;
    }
    if (leftSolidRef.current) {
      (leftSolidRef.current.material as THREE.MeshStandardMaterial).opacity = metalOpacity;
    }
    if (rightSolidRef.current) {
      (rightSolidRef.current.material as THREE.MeshStandardMaterial).opacity = metalOpacity;
    }
    if (bandGhostRef.current) {
      (bandGhostRef.current.material as THREE.MeshBasicMaterial).opacity =
        (1 - revealPhase) * clamp01(remap(p, 0.48, 0.88)) * 0.16;
    }
    if (bandSolidRef.current) {
      (bandSolidRef.current.material as THREE.MeshStandardMaterial).opacity =
        clamp01(remap(p, 0.74, 0.93)) * (1 - revealPhase * 0.7);
    }
    if (leftScanRef.current) {
      leftScanRef.current.position.z = scanLocalZ;
      (leftScanRef.current.material as THREE.MeshBasicMaterial).opacity = scanOpacity;
    }
    if (rightScanRef.current) {
      rightScanRef.current.position.z = scanLocalZ;
      (rightScanRef.current.material as THREE.MeshBasicMaterial).opacity = scanOpacity;
    }
    if (bandScanRef.current) {
      bandScanRef.current.position.z = -0.012 + printPhase * 0.05;
      (bandScanRef.current.material as THREE.MeshBasicMaterial).opacity =
        Math.sin(THREE.MathUtils.smootherstep(p, 0.7, 0.9) * Math.PI) * (1 - revealPhase) * 0.18;
    }
  });

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
              <group ref={baseModelRef}>
                <DG2RobotModel
                  energy={state.energy}
                  focused={state.focused}
                  idleMotion={idleBodyMotion}
                  standaloneLighting={modelScale !== 1}
                  opacity={1 - remap(listenTransitionRef.current, 0.58, 0.94)}
                />
              </group>
              <group ref={transitionFxRef}>
                <mesh rotation={[Math.PI / 2, 0, 0]}>
                  <torusGeometry args={[MODEL.bodyRadius * 0.72, MODEL.bodyRadius * 0.024, 20, 80]} />
                  <meshBasicMaterial color="#66d8ff" transparent opacity={0.07} depthWrite={false} />
                </mesh>
                <mesh>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.08, 20, 20]} />
                  <meshBasicMaterial color="#d7f6ff" transparent opacity={0.08} depthWrite={false} />
                </mesh>
              </group>
              <group ref={leftPodRef}>
                <mesh ref={leftGhostRef} scale={[0.72, 1.08, 0.44]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.13, 24, 24]} />
                  <meshBasicMaterial color="#7ae7ff" transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh ref={leftScanRef} scale={[0.64, 0.96, 0.08]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.135, 20, 20]} />
                  <meshBasicMaterial color="#f3ffff" transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh ref={leftSolidRef} scale={[0.58, 0.9, 0.34]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.118, 24, 24]} />
                  <meshStandardMaterial color="#aeb6c2" metalness={0.92} roughness={0.24} emissive="#aeefff" emissiveIntensity={0.04} transparent opacity={0} />
                </mesh>
              </group>
              <group ref={rightPodRef}>
                <mesh ref={rightGhostRef} scale={[0.72, 1.08, 0.44]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.13, 24, 24]} />
                  <meshBasicMaterial color="#7ae7ff" transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh ref={rightScanRef} scale={[0.64, 0.96, 0.08]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.135, 20, 20]} />
                  <meshBasicMaterial color="#f3ffff" transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh ref={rightSolidRef} scale={[0.58, 0.9, 0.34]}>
                  <sphereGeometry args={[MODEL.bodyRadius * 0.118, 24, 24]} />
                  <meshStandardMaterial color="#aeb6c2" metalness={0.92} roughness={0.24} emissive="#aeefff" emissiveIntensity={0.04} transparent opacity={0} />
                </mesh>
              </group>
              <group ref={headbandRef}>
                <mesh ref={bandGhostRef}>
                  <torusGeometry args={[MODEL.bodyRadius * 0.55, MODEL.bodyRadius * 0.03, 20, 64, Math.PI]} />
                  <meshBasicMaterial color="#7ae7ff" transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh ref={bandScanRef}>
                  <torusGeometry args={[MODEL.bodyRadius * 0.55, MODEL.bodyRadius * 0.016, 20, 64, Math.PI]} />
                  <meshBasicMaterial color="#f3ffff" transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh ref={bandSolidRef}>
                  <torusGeometry args={[MODEL.bodyRadius * 0.55, MODEL.bodyRadius * 0.038, 18, 48, Math.PI]} />
                  <meshStandardMaterial color="#98a3b3" metalness={0.94} roughness={0.22} emissive="#9fd5ff" emissiveIntensity={0.03} transparent opacity={0} />
                </mesh>
              </group>
              <group ref={headphoneModelRef}>
                <DG2RobotModel
                  modelUrl={HEADPHONE_MODEL_URL}
                  energy={state.energy}
                  focused={state.focused}
                  idleMotion={idleBodyMotion}
                  standaloneLighting={modelScale !== 1}
                  opacity={remap(listenTransitionRef.current, 0.94, 1)}
                />
              </group>
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
