import { PerspectiveCamera } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/cannon";
import { useEffect, useRef, useState } from "react";
import type { SceneMode } from "../constants/model-proportions";
import { EMBED_SCENE, OVERLAY_SCENE } from "../constants/model-proportions";
import type { AgentState } from "../types/agent";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import { HitAreaReporter, type EllipseShape } from "./HitAreaReporter";
import { OverlayCameraRig } from "./OverlayCameraRig";
import { OverlaySceneLights } from "./OverlaySceneLights";
import { SphereAgent } from "./SphereAgent";

interface SphereAgentSceneProps {
  state: AgentState;
  onEyeFocus?: (focused: boolean) => void;
  onEyeClick?: () => void;
  physics?: boolean;
  autonomous?: boolean;
  mode?: SceneMode;
  onEyeInteractionChange?: (active: boolean) => void;
  userDragRotate?: boolean;
  onUserTouch?: (event: SphereTouchEvent) => void;
  onBodyHover?: (active: boolean) => void;
  /** embed 网页：DOM 层接管拖拽，Canvas 不接收指针 */
  domDragBridge?: boolean;
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
  /** 球体命中椭圆上报（overlay 模式） */
  onHitAreaReport?: (shape: EllipseShape) => void;
}

/**
 * embed 模式的模型缩放覆盖：URL 查询参数 `?ms=<number>`（如
 * `embed.html?wsOff=1&ms=1.8`）。默认仍取 EMBED_SCENE.modelScale，
 * 供注册页等需要大尺寸展示的宿主放大球体（加法参数，不影响既有调用）。
 */
function readEmbedModelScaleOverride(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("ms");
  if (raw == null || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(5, Math.max(0.1, v));
}

function Ground({ invisibleCollision }: { invisibleCollision?: boolean }) {
  if (!invisibleCollision) return null;
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      receiveShadow
      raycast={() => null}
    >
      <planeGeometry args={[2.6, 2.6]} />
      <meshStandardMaterial
        color="#0a0c12"
        metalness={0.2}
        roughness={0.85}
        transparent
        opacity={0}
      />
    </mesh>
  );
}

/** 3D 场景 — embed 网页端 / overlay 桌宠 */
export function SphereAgentScene({
  state,
  onEyeFocus,
  onEyeClick,
  physics: _physics = true,
  autonomous = true,
  mode = "embed",
  onEyeInteractionChange,
  userDragRotate = true,
  onUserTouch,
  onBodyHover,
  domDragBridge = false,
  canvasCaptureLenient = false,
  onPanDelta,
  onPanEnd,
  onLiveReact,
  onSpinDelta,
  onDragRelease,
  onShakeRequest,
  onHitAreaReport,
}: SphereAgentSceneProps) {
  const isOverlay = mode === "overlay";
  const isEmbed = mode === "embed";

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(true);

  useEffect(() => {
    if (!isEmbed) return;
    const el = wrapperRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInView(entry.isIntersecting);
        }
      },
      { threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isEmbed]);

  return (
    <div ref={wrapperRef} style={{ width: "100%", height: "100%" }}>
    <Canvas
      dpr={isOverlay ? 1 : [1, 1.25]}
      frameloop={isEmbed ? (inView ? "always" : "never") : "always"}
      gl={{
        antialias: false,
        alpha: true,
        powerPreference: isOverlay ? "high-performance" : "low-power",
        preserveDrawingBuffer: isOverlay,
      }}
      style={{
        width: "100%",
        height: "100%",
        touchAction: "none",
        pointerEvents: domDragBridge ? "none" : "auto",
        cursor: userDragRotate && !domDragBridge ? "default" : undefined,
        background: "transparent",
      }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        if (!isOverlay) return;
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
        position={isOverlay ? [...OVERLAY_SCENE.cameraPosition] : [0, 1.4, 3.2]}
        fov={isOverlay ? OVERLAY_SCENE.cameraFov : 48}
      />
      {isOverlay ? <OverlayCameraRig /> : null}
      {isOverlay && onHitAreaReport ? (
        <HitAreaReporter onReport={onHitAreaReport} />
      ) : null}

      {isOverlay ? (
        <OverlaySceneLights />
      ) : (
        <>
          <ambientLight intensity={0.35} />
          <directionalLight
            intensity={1.05}
            position={[3, 6, 4]}
            shadow-mapSize={[2048, 2048]}
          />
          <pointLight position={[-3, 2, 2]} intensity={0.42} color="#88bbff" />
          <spotLight position={[0, 4, 3]} angle={0.35} penumbra={0.8} intensity={0.55} color="#ffffff" />
        </>
      )}

      <Physics
        gravity={isOverlay ? [0, 0, 0] : [0, -5.5, 0]}
        allowSleep={isOverlay ? false : !autonomous}
      >
        <Ground invisibleCollision={isEmbed} />
        <SphereAgent
          state={state}
          onEyeFocus={onEyeFocus}
          onEyeClick={onEyeClick}
          physics={false}
          autonomous={autonomous && !isOverlay}
          bodyPosition={isOverlay ? [...OVERLAY_SCENE.bodyPosition] : undefined}
          idleBodyMotion={!isOverlay}
          modelScale={isOverlay ? OVERLAY_SCENE.modelScale : (readEmbedModelScaleOverride() ?? EMBED_SCENE.modelScale)}
          motionBounds={isOverlay ? 0 : 1.15}
          hardMotionClamp={isEmbed}
          verticalStable={isOverlay}
          onEyeInteractionChange={onEyeInteractionChange}
          userDragRotate={userDragRotate}
          onUserTouch={onUserTouch}
          onBodyHover={onBodyHover}
          registerDragBridge={domDragBridge}
          canvasCaptureLenient={canvasCaptureLenient}
          onPanDelta={onPanDelta}
          onPanEnd={onPanEnd}
          onLiveReact={onLiveReact}
          onSpinDelta={onSpinDelta}
          onDragRelease={onDragRelease}
          onShakeRequest={onShakeRequest}
        />
      </Physics>
    </Canvas>
    </div>
  );
}
