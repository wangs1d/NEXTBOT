import { PerspectiveCamera } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/cannon";
import { OVERLAY_SCENE } from "../constants/model-proportions";
import type { AgentState } from "../types/agent";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import { HitAreaReporter, type EllipseShape } from "./HitAreaReporter";
import { OverlayCameraRig } from "./OverlayCameraRig";
import { OverlaySceneLights } from "./OverlaySceneLights";
import { SphereAgent } from "./SphereAgent";
import { reportOverlayPainted } from "../utils/overlay-ready";

interface SphereAgentSceneProps {
  state: AgentState;
  onEyeFocus?: (focused: boolean) => void;
  onEyeClick?: () => void;
  physics?: boolean;
  autonomous?: boolean;
  onEyeInteractionChange?: (active: boolean) => void;
  userDragRotate?: boolean;
  onUserTouch?: (event: SphereTouchEvent) => void;
  onBodyHover?: (active: boolean) => void;
  canvasCaptureLenient?: boolean;
  onPanDelta?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
  /** 实时拖动/旋转反应 */
  onLiveReact?: (intensity: number, mode: "pan" | "rotate") => void;
  /** 旋转中累计 yaw/pitch 角度（弧度）回调 */
  onSpinDelta?: (deltaYaw: number, deltaPitch: number) => void;
  /** 拖动结束回调 */
  onDragRelease?: (info: { mode: "pan" | "rotate"; totalRotationDeg: number; panDistance: number; spinStrength: number }) => void;
  /** 触发身体晃动函数 */
  onShakeRequest?: (strength: number, durationMs: number) => void;
  /** 球体命中椭圆上报（宿主据此切换点击穿透） */
  onHitAreaReport?: (shape: EllipseShape) => void;
}

/** 3D 场景 — 桌宠 overlay：固定机位，完整框选 DG2，禁止 3D 空间漫游 */
export function SphereAgentScene({
  state,
  onEyeFocus,
  onEyeClick,
  physics: _physics = true,
  autonomous = true,
  onEyeInteractionChange,
  userDragRotate = true,
  onUserTouch,
  onBodyHover,
  canvasCaptureLenient = false,
  onPanDelta,
  onPanEnd,
  onLiveReact,
  onSpinDelta,
  onDragRelease,
  onShakeRequest,
  onHitAreaReport,
}: SphereAgentSceneProps) {
  return (
    <div style={{ width: "100%", height: "100%" }}>
      <Canvas
        dpr={1}
        frameloop="always"
        gl={{
          antialias: false,
          alpha: true,
          powerPreference: "high-performance",
          preserveDrawingBuffer: true,
        }}
        style={{
          width: "100%",
          height: "100%",
          touchAction: "none",
          pointerEvents: "auto",
          cursor: userDragRotate ? "default" : undefined,
          background: "transparent",
        }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
          const canvas = gl.domElement;
          canvas.addEventListener("webglcontextlost", (ev) => {
            ev.preventDefault();
          });
          canvas.addEventListener("webglcontextrestored", () => {
            gl.resetState();
            gl.setClearColor(0x000000, 0);
          });
        }}
      >
        <PerspectiveCamera
          makeDefault
          position={[...OVERLAY_SCENE.cameraPosition]}
          fov={OVERLAY_SCENE.cameraFov}
        />
        <OverlayCameraRig />
        {onHitAreaReport ? <HitAreaReporter onReport={onHitAreaReport} /> : null}
        <OverlaySceneLights />

        <Physics gravity={[0, 0, 0]} allowSleep={false}>
          <SphereAgent
            state={state}
            onEyeFocus={onEyeFocus}
            onEyeClick={onEyeClick}
            physics={false}
            autonomous={autonomous}
            bodyPosition={OVERLAY_SCENE.bodyPosition}
            idleBodyMotion={false}
            modelScale={OVERLAY_SCENE.modelScale}
            motionBounds={0}
            verticalStable
            onEyeInteractionChange={onEyeInteractionChange}
            userDragRotate={userDragRotate}
            onUserTouch={onUserTouch}
            onBodyHover={onBodyHover}
            canvasCaptureLenient={canvasCaptureLenient}
            onPanDelta={onPanDelta}
            onPanEnd={onPanEnd}
            onLiveReact={onLiveReact}
            onSpinDelta={onSpinDelta}
            onDragRelease={onDragRelease}
            onShakeRequest={onShakeRequest}
            onModelPainted={reportOverlayPainted}
          />
        </Physics>
      </Canvas>
    </div>
  );
}
