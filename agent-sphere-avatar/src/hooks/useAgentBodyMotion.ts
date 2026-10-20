import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import type { PublicApi } from "@react-three/cannon";
import type { AgentMood } from "../types/agent";
import type { ScreenSignals } from "../components/OledScreen";
import type { TaskEvent } from "../types/agent";

const MOOD_PROFILE: Record<
  AgentMood,
  { speed: number; roam: number; pauseSec: number; breath: number; vitality: number }
> = {
  idle: { speed: 0.48, roam: 0.78, pauseSec: 1.6, breath: 0.045, vitality: 0.22 },
  listening: { speed: 0.32, roam: 0.42, pauseSec: 2.8, breath: 0.032, vitality: 0.28 },
  thinking: { speed: 0.4, roam: 0.88, pauseSec: 1.4, breath: 0.038, vitality: 0.32 },
  happy: { speed: 0.85, roam: 1, pauseSec: 0.35, breath: 0.062, vitality: 0.75 },
  alert: { speed: 0.58, roam: 0.62, pauseSec: 0.8, breath: 0.035, vitality: 0.5 },
};

const MASS = 1.1;
const RESTITUTION = 0.48;
const RESTITUTION_EXCITED = 0.62;
type LifePhase = "roam" | "observe" | "inspect" | "settle";
type HabitCycle = "neutral" | "relax" | "irritated" | "seek";

interface IntentState {
  yaw: number;
  yawVelocity: number;
  yawTarget: number;
  pitchTarget: number;
  rollTarget: number;
  glanceYaw: number;
  glancePitch: number;
  expression: number;
  phase: LifePhase;
  phaseUntil: number;
  lastTargetAt: number;
  nod: number;
  habit: HabitCycle;
  habitUntil: number;
}

interface AttentionState {
  x: number;
  y: number;
  strength: number;
  source: "idle" | "mouse" | "screen" | "task" | "peer" | "phone";
  updatedAt: number;
}

interface EmotionMemory {
  curiosity: number;
  caution: number;
  sociability: number;
  diligence: number;
  familiarity: number;
  lastSource?: string;
}

interface BehaviorMemoryEntry {
  kind: "task" | "interaction" | "message" | "alert" | "explore";
  weight: number;
  source?: string;
  timestamp: number;
}

interface UseAgentBodyMotionOptions {
  api?: PublicApi;
  visualRef: RefObject<THREE.Group | null>;
  faceSignalsRef?: RefObject<ScreenSignals>;
  enabled?: boolean;
  bounds?: number;
  mood?: AgentMood;
  energy?: number;
  focused?: boolean;
  phase?: string;
  caption?: string;
  source?: string;
  attentionTarget?: {
    screenX: number;
    screenY: number;
    strength?: number;
    source?: string;
    expiresAt?: number;
  };
  taskEvents?: TaskEvent[];
  onBoundaryHit?: (edge: "left" | "right" | "top" | "bottom" | "front" | "back") => void;
  /** 固定机位模式：锁定 Y 轴，关闭持续呼吸/悬浮位移（桌宠防抖） */
  verticalStable?: boolean;
}

/** 具身物理 — 持续有生命力，兴奋时更狂，说话时有节奏摆动感 */
export function useAgentBodyMotion({
  api,
  visualRef,
  faceSignalsRef,
  enabled = true,
  bounds = 1.15,
  mood = "idle",
  energy = 0.55,
  focused = false,
  phase,
  caption,
  source,
  attentionTarget,
  taskEvents,
  onBoundaryHit,
  verticalStable = false,
}: UseAgentBodyMotionOptions) {
  const pos = useRef(new THREE.Vector3(0, 1.45, 0));
  const vel = useRef(new THREE.Vector3());
  const target = useRef(new THREE.Vector3(0, 1.45, 0));
  /** 固定机位 Y 轴锚点（取初始高度，保持当前构图不变） */
  const verticalAnchorRef = useRef(pos.current.y);
  const verticalStableRef = useRef(verticalStable);
  const pauseUntil = useRef(0);
  const visitRef = useRef<Map<string, number>>(new Map());
  const excitementRef = useRef(0);
  const excitedUntilRef = useRef(0);
  const lastBoundaryAt = useRef(0);
  const fidgetAt = useRef(0);
  /**
   * 自主漫游授权 —— 默认关闭，球体不再自己乱动（用户要求）。
   *
   * 只有显式命令才打开：`roam` / `pickRandomTarget` 授权后常驻，
   * `excite` 期间临时生效（兴奋退去自动失效），`stop` 收回。
   * 未授权时：不随机取点、不自主张望、不自主小动作，只剩原地呼吸。
   */
  const roamArmedRef = useRef(false);
  const intentRef = useRef<IntentState>({
    yaw: 0,
    yawVelocity: 0,
    yawTarget: 0,
    pitchTarget: 0,
    rollTarget: 0,
    glanceYaw: 0,
    glancePitch: 0,
    expression: 0,
    phase: "observe",
    phaseUntil: 0,
    lastTargetAt: 0,
    nod: 0,
    habit: "neutral",
    habitUntil: 0,
  });
  const attentionRef = useRef<AttentionState>({
    x: 0,
    y: -0.08,
    strength: 0.18,
    source: "idle",
    updatedAt: 0,
  });
  const emotionRef = useRef<EmotionMemory>({
    curiosity: 0.58,
    caution: 0.34,
    sociability: 0.52,
    diligence: 0.61,
    familiarity: 0.4,
    lastSource: undefined,
  });
  const phaseRef = useRef(phase);
  const captionRef = useRef(caption);
  const sourceRef = useRef(source);
  const attentionTargetRef = useRef(attentionTarget);
  const taskEventsRef = useRef(taskEvents);
  const recentTaskCountRef = useRef(taskEvents?.length ?? 0);
  const deliberateUntilRef = useRef(0);
  const behaviorMemoryRef = useRef<BehaviorMemoryEntry[]>([]);
  const lastInteractionAtRef = useRef(performance.now());
  const lastTaskActiveRef = useRef(false);
  const lastSeekAtRef = useRef(0);
  /** 身体晃动：累计的随机冲量、剩余持续时间、衰减时间戳 */
  const shakeRef = useRef<{ intensity: number; until: number; lastImpulseAt: number }>({
    intensity: 0,
    until: 0,
    lastImpulseAt: 0,
  });
  /** 当前用户传入的额外垂直方向摆动速率（来自旋转/拖动反应） */
  const verticalBiasRef = useRef(0);

  const enabledRef = useRef(enabled);
  const moodRef = useRef(mood);
  const energyRef = useRef(energy);
  const focusedRef = useRef(focused);
  const boundsRef = useRef(bounds);
  const onBoundaryHitRef = useRef(onBoundaryHit);
  enabledRef.current = enabled;
  moodRef.current = mood;
  energyRef.current = energy;
  focusedRef.current = focused;
  boundsRef.current = bounds;
  onBoundaryHitRef.current = onBoundaryHit;
  verticalStableRef.current = verticalStable;
  phaseRef.current = phase;
  captionRef.current = caption;
  sourceRef.current = source;
  attentionTargetRef.current = attentionTarget;
  taskEventsRef.current = taskEvents;

  useEffect(() => {
    if (mood === "happy") {
      excitementRef.current = Math.max(excitementRef.current, 0.95);
      excitedUntilRef.current = performance.now() + 4500;
      intentRef.current.phase = "inspect";
      intentRef.current.phaseUntil = performance.now() + 1500;
      intentRef.current.nod = 0.45;
    }
  }, [mood, energy]);

  const setPhase = useCallback((phase: LifePhase, durationMs: number) => {
    intentRef.current.phase = phase;
    intentRef.current.phaseUntil = performance.now() + durationMs;
  }, []);

  const setAttention = useCallback(
    (
      x: number,
      y: number,
      strength: number,
      source: AttentionState["source"],
      durationMs: number,
    ) => {
      attentionRef.current = {
        x: THREE.MathUtils.clamp(x, -1, 1),
        y: THREE.MathUtils.clamp(y, -1, 1),
        strength: THREE.MathUtils.clamp(strength, 0, 1),
        source,
        updatedAt: performance.now() + durationMs,
      };
    },
    [],
  );

  const rememberBehavior = useCallback(
    (kind: BehaviorMemoryEntry["kind"], weight: number, source?: string) => {
      const next: BehaviorMemoryEntry = {
        kind,
        weight,
        source,
        timestamp: performance.now(),
      };
      const trimmed = behaviorMemoryRef.current
        .filter((entry) => next.timestamp - entry.timestamp < 180_000)
        .slice(-11);
      trimmed.push(next);
      behaviorMemoryRef.current = trimmed;
    },
    [],
  );

  const lookAtScreenPoint = useCallback(
    (screenX: number, screenY: number, strength = 0.62, targetSource = "screen", durationMs = 1800) => {
      const petPos = window.spherePetPos;
      const width = Math.max(window.innerWidth, 1);
      const height = Math.max(window.innerHeight, 1);
      const originX = petPos?.x ?? width / 2;
      const originY = petPos?.y ?? height / 2;
      const dx = THREE.MathUtils.clamp((screenX - originX) / Math.max(width * 0.5, 1), -1, 1);
      const dy = THREE.MathUtils.clamp((screenY - originY) / Math.max(height * 0.5, 1), -1, 1);
      const sourceKind: AttentionState["source"] =
        targetSource === "phone"
          ? "phone"
          : targetSource === "peer"
            ? "peer"
            : targetSource === "task" || targetSource === "agent_task"
              ? "task"
              : "screen";
      setAttention(dx, dy, strength, sourceKind, durationMs);
    },
    [setAttention],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const width = Math.max(window.innerWidth, 1);
      const height = Math.max(window.innerHeight, 1);
      const x = (event.clientX / width) * 2 - 1;
      const y = (event.clientY / height) * 2 - 1;
      const emotion = emotionRef.current;
      setAttention(
        x * (0.45 + emotion.curiosity * 0.35),
        y * (0.18 + emotion.sociability * 0.16),
        0.28 + emotion.curiosity * 0.42,
        "mouse",
        700,
      );
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [setAttention]);

  useEffect(() => {
    if (!attentionTarget) return;
    if (attentionTarget.expiresAt && attentionTarget.expiresAt < Date.now()) return;
    lookAtScreenPoint(
      attentionTarget.screenX,
      attentionTarget.screenY,
      attentionTarget.strength ?? 0.66,
      attentionTarget.source ?? source ?? "screen",
      1800,
    );
  }, [attentionTarget, lookAtScreenPoint, source]);

  useEffect(() => {
    const nextCount = taskEvents?.length ?? 0;
    const hasActiveTask = (taskEvents ?? []).some((event) => event.type === "progress");
    if (lastTaskActiveRef.current && !hasActiveTask) {
      intentRef.current.habit = "relax";
      intentRef.current.habitUntil = performance.now() + 9000;
      emotionRef.current.caution = Math.max(0, emotionRef.current.caution - 0.08);
      emotionRef.current.curiosity = Math.min(1, emotionRef.current.curiosity + 0.05);
      setPhase("roam", 1800);
      rememberBehavior("explore", 0.46, "task_done");
    }
    lastTaskActiveRef.current = hasActiveTask;

    if (nextCount > recentTaskCountRef.current) {
      const event = taskEvents?.[nextCount - 1];
      const emotion = emotionRef.current;
      emotion.diligence = Math.min(1, emotion.diligence + 0.08);
      emotion.curiosity = Math.min(1, emotion.curiosity + 0.06);
      emotion.lastSource = event?.source ?? source;
      rememberBehavior("task", 0.58, event?.source ?? source);
      lastInteractionAtRef.current = performance.now();
      deliberateUntilRef.current = performance.now() + 700 + emotion.diligence * 900;
      intentRef.current.nod = Math.max(intentRef.current.nod, 0.38);
      setPhase("observe", 1100);
      if (attentionTargetRef.current) {
        lookAtScreenPoint(
          attentionTargetRef.current.screenX,
          attentionTargetRef.current.screenY,
          attentionTargetRef.current.strength ?? 0.68,
          attentionTargetRef.current.source ?? event?.source ?? "task",
          1900,
        );
      } else {
        setAttention(
          event?.source === "phone" ? 0.72 : event?.source === "peer" ? -0.64 : 0,
          -0.1,
          0.62,
          event?.source === "phone" ? "phone" : event?.source === "peer" ? "peer" : "task",
          1800,
        );
      }
    }
    recentTaskCountRef.current = nextCount;
  }, [lookAtScreenPoint, rememberBehavior, setAttention, setPhase, source, taskEvents]);

  useEffect(() => {
    const emotion = emotionRef.current;
    if (source === "phone") {
      emotion.caution = Math.min(1, emotion.caution + 0.12);
      emotion.curiosity = Math.min(1, emotion.curiosity + 0.05);
      rememberBehavior("alert", 0.72, source);
      lastInteractionAtRef.current = performance.now();
      setAttention(0.76, -0.08, 0.74, "phone", 2200);
      deliberateUntilRef.current = performance.now() + 900;
    } else if (source === "peer") {
      emotion.sociability = Math.min(1, emotion.sociability + 0.1);
      rememberBehavior("message", 0.55, source);
      lastInteractionAtRef.current = performance.now();
      setAttention(-0.68, 0.02, 0.66, "peer", 1800);
    } else if (source === "agent_task" || phase?.includes("agent_task")) {
      emotion.diligence = Math.min(1, emotion.diligence + 0.1);
      rememberBehavior("task", 0.64, source);
      lastInteractionAtRef.current = performance.now();
      deliberateUntilRef.current = performance.now() + 1000 + emotion.diligence * 900;
      setPhase("observe", 1200);
      setAttention(0, -0.12, 0.58, "task", 1800);
    } else if (source === "assistant_chunk" || source === "tool") {
      emotion.diligence = Math.min(1, emotion.diligence + 0.04);
      rememberBehavior("task", 0.34, source);
      setAttention(0.08, -0.04, 0.42, "screen", 900);
    } else if (source === "user_message") {
      emotion.sociability = Math.min(1, emotion.sociability + 0.08);
      emotion.familiarity = Math.min(1, emotion.familiarity + 0.05);
      rememberBehavior("interaction", 0.48, source);
      lastInteractionAtRef.current = performance.now();
      setAttention(0, -0.02, 0.6, "screen", 1600);
    } else if (source === "error") {
      emotion.caution = Math.min(1, emotion.caution + 0.14);
      rememberBehavior("alert", 0.82, source);
      lastInteractionAtRef.current = performance.now();
      deliberateUntilRef.current = performance.now() + 1100;
      setAttention(0, -0.18, 0.72, "task", 1600);
    }
  }, [phase, rememberBehavior, setAttention, setPhase, source]);

  useEffect(() => {
    if (!caption) return;
    const len = caption.trim().length;
    const emotion = emotionRef.current;
    emotion.familiarity = Math.min(1, emotion.familiarity + Math.min(0.08, len / 500));
    if (len > 18) {
      rememberBehavior("message", Math.min(0.72, len / 90), source);
      deliberateUntilRef.current = Math.max(
        deliberateUntilRef.current,
        performance.now() + 700 + Math.min(1800, len * 18),
      );
      setPhase("inspect", 1200);
      setAttention(0.06, -0.06, 0.48 + Math.min(0.22, len / 160), "screen", 1600);
    }
  }, [caption, rememberBehavior, setAttention, setPhase, source]);

  const pickTarget = useCallback((clock: number) => {
    const profile = MOOD_PROFILE[moodRef.current];
    const b = boundsRef.current;
    const excited = excitementRef.current > 0.28;
    const memoryNow = performance.now();
    const memory = behaviorMemoryRef.current.filter((entry) => memoryNow - entry.timestamp < 180_000);
    let taskWeight = 0;
    let interactionWeight = 0;
    for (const entry of memory) {
      const ageFactor = Math.max(0.18, 1 - (memoryNow - entry.timestamp) / 180_000);
      if (entry.kind === "task") taskWeight += entry.weight * ageFactor;
      if (entry.kind === "interaction" || entry.kind === "message") interactionWeight += entry.weight * ageFactor;
    }
    const focusFactor = 1 - Math.min(0.22, taskWeight * 0.025);
    const socialFactor = 1 + Math.min(0.18, interactionWeight * 0.02);
    const roam = profile.roam * b * (0.6 + energyRef.current * 0.5) * (excited ? 1.35 : 1) * focusFactor * socialFactor;

    let bestX = 0;
    let bestZ = 0;
    let bestScore = -Infinity;
    const samples = excited ? 14 : 9;

    for (let i = 0; i < samples; i++) {
      const angle = (Math.PI * 2 * i) / samples + (Math.random() - 0.5) * (excited ? 1.6 : 0.5);
      const dist = (excited ? 0.55 + Math.random() * 0.45 : 0.4 + Math.random() * 0.6) * roam;
      const tx = Math.cos(angle) * dist;
      const tz = Math.sin(angle) * dist * 0.85;
      const key = `${Math.round(tx * 4)}_${Math.round(tz * 4)}`;
      const visits = visitRef.current.get(key) ?? 0;
      const score = -visits + Math.random() * (0.24 + emotionRef.current.curiosity * 0.34) - Math.abs(tz) * taskWeight * 0.04;
      if (score > bestScore) {
        bestScore = score;
        bestX = tx;
        bestZ = tz;
      }
    }

    visitRef.current.set(`${Math.round(bestX * 4)}_${Math.round(bestZ * 4)}`, (visitRef.current.get(`${Math.round(bestX * 4)}_${Math.round(bestZ * 4)}`) ?? 0) + 1);

    target.current.set(bestX, 1.28 + Math.random() * 0.45 + profile.breath, bestZ);
    intentRef.current.lastTargetAt = performance.now();
    intentRef.current.phase = excited
      ? "inspect"
      : moodRef.current === "thinking"
        ? "inspect"
        : Math.random() > 0.58
          ? "observe"
          : "roam";
    intentRef.current.phaseUntil =
      performance.now() +
      (excited ? 850 + Math.random() * 650 : 1100 + Math.random() * 1800);
    intentRef.current.glanceYaw = (Math.random() - 0.5) * (excited ? 0.4 : 0.2);
    intentRef.current.glancePitch = (Math.random() - 0.5) * 0.16;
    intentRef.current.nod = Math.random() * 0.45;
    pauseUntil.current = clock + (excited ? 0.15 + Math.random() * 0.25 : profile.pauseSec * (0.45 + Math.random() * 0.55));
  }, []);

  const resolveBoundary = useCallback(
    (axis: "x" | "y" | "z", edge: "left" | "right" | "top" | "bottom" | "front" | "back", limit: number) => {
      const now = performance.now();
      if (now - lastBoundaryAt.current < 140) return;
      lastBoundaryAt.current = now;

      if (faceSignalsRef?.current) faceSignalsRef.current.boundaryBump = 1;
      onBoundaryHitRef.current?.(edge);
      intentRef.current.yawVelocity += (Math.random() - 0.5) * 1.8;
      intentRef.current.glanceYaw =
        edge === "left" ? 0.32 : edge === "right" ? -0.32 : (Math.random() - 0.5) * 0.18;
      intentRef.current.glancePitch =
        edge === "top" ? -0.18 : edge === "bottom" ? 0.2 : (Math.random() - 0.5) * 0.12;
      setPhase("settle", 700);

      const rest = excitementRef.current > 0.35 ? RESTITUTION_EXCITED : RESTITUTION;
      if (axis === "x") vel.current.x *= -rest;
      if (axis === "y") vel.current.y *= -rest * 0.55;
      if (axis === "z") vel.current.z *= -rest;
      pos.current[axis] = limit;

      if (excitementRef.current > 0.4) {
        vel.current.x += (Math.random() - 0.5) * 1.2;
        vel.current.z += (Math.random() - 0.5) * 1.2;
      }
    },
    [faceSignalsRef, setPhase],
  );

  useEffect(() => {
    pickTarget(0);
    if (api) {
      api.position.set(pos.current.x, pos.current.y, pos.current.z);
      api.velocity.set(0, 0, 0);
      api.angularVelocity.set(0, 0, 0);
    }
  }, [api, pickTarget]);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.032);
    if (!enabledRef.current) return;

    const t = clock.elapsedTime;
    const verticalStable = verticalStableRef.current;
    const profile = MOOD_PROFILE[moodRef.current];
    const b = boundsRef.current;
    const nowMs = performance.now();
    const intent = intentRef.current;
    const attention = attentionRef.current;
    const emotion = emotionRef.current;
    const recentBehaviors = behaviorMemoryRef.current.filter((entry) => nowMs - entry.timestamp < 180_000);
    behaviorMemoryRef.current = recentBehaviors;
    let recentTaskWeight = 0;
    let recentInteractionWeight = 0;
    let recentAlertWeight = 0;
    for (const entry of recentBehaviors) {
      const ageFactor = Math.max(0.18, 1 - (nowMs - entry.timestamp) / 180_000);
      const weighted = entry.weight * ageFactor;
      if (entry.kind === "task") recentTaskWeight += weighted;
      else if (entry.kind === "interaction" || entry.kind === "message") recentInteractionWeight += weighted;
      else if (entry.kind === "alert") recentAlertWeight += weighted;
    }
    const petPos = typeof window !== "undefined" ? window.spherePetPos : undefined;
    const petScreenBiasX = petPos ? THREE.MathUtils.clamp(((petPos.x / Math.max(window.innerWidth, 1)) - 0.5) * 2, -1, 1) : 0;
    const petScreenBiasY = petPos ? THREE.MathUtils.clamp(((petPos.y / Math.max(window.innerHeight, 1)) - 0.5) * 2, -1, 1) : 0;
    const idleMs = nowMs - lastInteractionAtRef.current;
    if (recentAlertWeight + recentInteractionWeight > 2.2 && intent.habit !== "irritated") {
      intent.habit = "irritated";
      intent.habitUntil = nowMs + 8000;
      intent.nod = Math.max(intent.nod, 0.35);
    } else if (idleMs > 75_000 && nowMs - lastSeekAtRef.current > 55_000 && intent.habit !== "seek") {
      intent.habit = "seek";
      intent.habitUntil = nowMs + 11_000;
      lastSeekAtRef.current = nowMs;
      setAttention(-petScreenBiasX * 0.65, -0.18, 0.5 + emotion.sociability * 0.22, "screen", 4500);
      rememberBehavior("interaction", 0.28, "attention_seek");
    } else if (intent.habit !== "neutral" && nowMs > intent.habitUntil) {
      intent.habit = "neutral";
    }

    if (nowMs > excitedUntilRef.current) {
      excitementRef.current = Math.max(0, excitementRef.current - dt * 0.28);
    } else {
      excitementRef.current = Math.min(1, Math.max(excitementRef.current, 0.65));
    }

    emotion.curiosity = THREE.MathUtils.lerp(emotion.curiosity, 0.56, dt * 0.08);
    emotion.caution = THREE.MathUtils.lerp(emotion.caution, 0.32, dt * 0.06);
    emotion.sociability = THREE.MathUtils.lerp(emotion.sociability, 0.5, dt * 0.06);
    emotion.diligence = THREE.MathUtils.lerp(emotion.diligence, 0.6, dt * 0.05);
    emotion.familiarity = THREE.MathUtils.lerp(emotion.familiarity, 0.42, dt * 0.025);
    emotion.diligence = THREE.MathUtils.clamp(emotion.diligence + recentTaskWeight * 0.0009, 0, 1);
    emotion.sociability = THREE.MathUtils.clamp(emotion.sociability + recentInteractionWeight * 0.0008, 0, 1);
    emotion.caution = THREE.MathUtils.clamp(emotion.caution + recentAlertWeight * 0.001, 0, 1);

    const excited = excitementRef.current > 0.28;
    /** 拿到漫游授权、或正处于命令触发的兴奋期，才允许自主行为；其余时间只呼吸 */
    const lively = roamArmedRef.current || excited;
    const speedMul =
      profile.speed *
      (0.7 + energyRef.current * 0.55) *
      (1 + excitementRef.current * 1.25) *
      (0.92 + emotion.curiosity * 0.16 - emotion.caution * 0.06);
    const deliberate = nowMs < deliberateUntilRef.current;
    const habitSpeed =
      intent.habit === "relax"
        ? 1.12
        : intent.habit === "irritated"
          ? 0.82
          : intent.habit === "seek"
            ? 1.05
            : 1;

    const vitality = profile.vitality * (0.5 + energyRef.current * 0.5);
    vel.current.x += Math.sin(t * 2.1 + 0.5) * vitality * 0.022;
    if (!verticalStable) {
      // 固定机位关闭持续呼吸导致的 Y 向漂移
      vel.current.y += Math.sin(t * 1.55) * profile.breath * 0.35;
    }
    vel.current.z += Math.cos(t * 1.85) * vitality * 0.018;

    if (excited) {
      const burstRate = 4.5 + excitementRef.current * 4;
      if (Math.random() < dt * burstRate) {
        const f = 1.5 + excitementRef.current * 2.8;
        vel.current.x += (Math.random() - 0.5) * f * 2.2;
        vel.current.z += (Math.random() - 0.5) * f * 2.2;
        vel.current.y += (Math.random() - 0.15) * f * 1.4;
      }
    }

    // 身体晃动：周期性注入小幅随机冲量，模拟"摇头晃脑"
    if (nowMs < shakeRef.current.until) {
      const s = shakeRef.current.intensity;
      // 抖动频率 ~14Hz，按强度衰减
      if (nowMs - shakeRef.current.lastImpulseAt > 70) {
        shakeRef.current.lastImpulseAt = nowMs;
        vel.current.x += (Math.random() - 0.5) * 1.8 * s;
        vel.current.z += (Math.random() - 0.5) * 1.6 * s;
        vel.current.y += (Math.random() - 0.2) * 1.2 * s;
        // 随机抽一下 verticalBias，让球在垂直方向摆动
        verticalBiasRef.current = (Math.random() - 0.5) * s;
      }
    } else if (shakeRef.current.intensity > 0) {
      shakeRef.current.intensity = 0;
      verticalBiasRef.current = 0;
    }

    // 垂直偏置 → 持续给 Y 一个小幅振荡
    if (Math.abs(verticalBiasRef.current) > 0.001) {
      vel.current.y += verticalBiasRef.current * 0.55 * dt * 60;
    }

    const dx = target.current.x - pos.current.x;
    const dz = target.current.z - pos.current.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const travelDir = horizDist > 0.001 ? Math.atan2(dx, dz) : intent.yawTarget;
    const attentionActive = attention.updatedAt > nowMs;
    const spaceYawBias = -petScreenBiasX * 0.14;
    const spacePitchBias = petScreenBiasY * 0.05;
    const attentionYaw = attention.x * (0.48 + attention.strength * 0.52) + spaceYawBias;
    const attentionPitch = attention.y * (0.14 + attention.strength * 0.12) + spacePitchBias;

    if (lively && nowMs > intent.phaseUntil) {
      if (moodRef.current === "listening" || focusedRef.current) {
        setPhase("observe", 1200 + Math.random() * 900 + emotion.familiarity * 700);
      } else if (moodRef.current === "thinking") {
        setPhase("inspect", 1100 + Math.random() * 1300 + emotion.diligence * 700);
      } else {
        setPhase(
          Math.random() > 0.48 + emotion.curiosity * 0.08 ? "observe" : "roam",
          900 + Math.random() * 1800 + emotion.curiosity * 500 + recentInteractionWeight * 40,
        );
      }
    }

    // 两处「自己给自己找下一个点」—— 未授权时都不许触发，否则球会一直乱走
    if (lively && t >= pauseUntil.current && horizDist < (excited ? 0.28 : 0.14)) {
      pickTarget(t);
    }

    if (lively && !excited && t > fidgetAt.current && horizDist < 0.08 && Math.random() < dt * 0.55) {
      fidgetAt.current = t + 1.8 + Math.random() * 2.5;
      vel.current.x += (Math.random() - 0.5) * 0.45;
      vel.current.z += (Math.random() - 0.5) * 0.45;
      pickTarget(t);
    }

    // 固定机位：无呼吸目标与呼吸弹簧，Y 轴由下方锁定
    const breathY = verticalStable
      ? 0
      : Math.sin(t * 1.65) * profile.breath * (0.5 + energyRef.current * 0.5) +
        Math.sin(t * 3.4) * profile.breath * 0.22;
    const dy = verticalStable ? 0 : target.current.y + breathY - pos.current.y;

    const springK = (focusedRef.current ? 2.6 : 4.8) * (excited ? 1.65 : 1);
    const forceScale = speedMul / MASS;

    if (!deliberate) {
      vel.current.x += dx * springK * forceScale * habitSpeed * dt;
      vel.current.y += dy * springK * forceScale * 0.9 * dt;
      vel.current.z += dz * springK * forceScale * habitSpeed * dt;
    } else {
      vel.current.multiplyScalar(Math.exp(-dt * (8.5 + emotion.diligence * 1.5)));
      vel.current.y += dy * springK * forceScale * 0.25 * dt;
    }

    const drag = excited ? 2.8 : 5.8;
    vel.current.multiplyScalar(Math.exp(-drag * dt));

    const maxSpeed = excited ? 3.8 : 1.85;
    if (vel.current.length() > maxSpeed) vel.current.setLength(maxSpeed);

    if (verticalStable) {
      // 固定机位：Y 轴锁定在锚点，彻底消除上下微动（保留旋转与水平反应）
      pos.current.y = verticalAnchorRef.current;
      vel.current.y = 0;
    }
    pos.current.addScaledVector(vel.current, dt);

    if (pos.current.x < -b) resolveBoundary("x", "left", -b);
    else if (pos.current.x > b) resolveBoundary("x", "right", b);
    if (pos.current.y < 1.05) resolveBoundary("y", "bottom", 1.05);
    else if (pos.current.y > 2.15) resolveBoundary("y", "top", 2.15);
    if (pos.current.z < -b) resolveBoundary("z", "back", -b);
    else if (pos.current.z > b) resolveBoundary("z", "front", b);

    if (api) {
      api.position.set(pos.current.x, pos.current.y, pos.current.z);
      api.velocity.set(vel.current.x, vel.current.y, vel.current.z);
    }

    const speed = vel.current.length();
    if (faceSignalsRef?.current) {
      faceSignalsRef.current.excitement = excitementRef.current;
      faceSignalsRef.current.speed = speed;
    }

    const group = visualRef.current;
    if (!group) return;

    const moodLookBias =
      moodRef.current === "listening"
        ? 0.18
        : moodRef.current === "thinking"
          ? -0.08
          : moodRef.current === "alert"
            ? 0.12
            : 0;
    const leanX = THREE.MathUtils.clamp(-vel.current.x * 0.34, -0.28, 0.28);
    const leanZ = THREE.MathUtils.clamp(vel.current.z * 0.28, -0.22, 0.22);
    const shakeActive = shakeRef.current.intensity > 0 && nowMs < shakeRef.current.until;
    const shakeAmp = shakeActive ? shakeRef.current.intensity : 0;
    const wobble = excited
      ? Math.sin(t * 14) * 0.08 * excitementRef.current
      : Math.sin(t * 1.2) * 0.012;
    // 晃动时附加额外高频抖动（摇头/左右扭）
    const shakeJitter = shakeAmp > 0
      ? Math.sin(t * 22) * 0.18 * shakeAmp + Math.sin(t * 17.3) * 0.12 * shakeAmp
      : 0;
    const shakePitch = shakeAmp > 0 ? Math.sin(t * 13.5) * 0.1 * shakeAmp : 0;
    const shakeRoll = shakeAmp > 0 ? Math.cos(t * 19) * 0.14 * shakeAmp : 0;
    const attentionPull =
      focusedRef.current || moodRef.current === "listening"
        ? 0.9
        : moodRef.current === "thinking"
          ? 0.65
          : 0.35 + excitementRef.current * 0.45 + emotion.familiarity * 0.08;
    // 自主张望 / 习惯性摆动：同样只在授权期生效，未授权时球体只剩注意力驱动的转头
    const roamLook = lively
      ? intent.phase === "roam"
        ? Math.sin(t * (0.7 + emotion.curiosity * 0.55)) * (0.05 + emotion.curiosity * 0.06)
        : intent.phase === "inspect"
          ? Math.sin(t * (1.4 + emotion.diligence * 1.2)) * (0.08 + emotion.curiosity * 0.08)
          : 0
      : 0;
    const habitLook = lively
      ? intent.habit === "irritated"
        ? Math.sin(t * 4.5) * 0.09
        : intent.habit === "seek"
          ? Math.sin(t * 1.25) * 0.18
          : intent.habit === "relax"
            ? Math.sin(t * 0.55) * 0.08
            : 0
      : 0;

    intent.expression = THREE.MathUtils.lerp(
      intent.expression,
      speed > 0.35 ? 1 : moodRef.current === "thinking" ? 0.72 + emotion.diligence * 0.12 : 0.45 + emotion.familiarity * 0.08,
      dt * 2.4,
    );
    intent.glanceYaw = THREE.MathUtils.lerp(
      intent.glanceYaw,
      roamLook + habitLook + (attentionActive ? attentionYaw : spaceYawBias * 0.6) + recentInteractionWeight * 0.003,
      dt * (intent.phase === "inspect" ? 2.8 : 1.4) * (attentionActive ? 1.8 : 1),
    );
    intent.glancePitch = THREE.MathUtils.lerp(
      intent.glancePitch,
      moodLookBias +
        (intent.phase === "observe" ? Math.sin(t * 1.4) * 0.04 : 0) +
        (attentionActive ? attentionPitch : spacePitchBias * 0.4) -
        recentTaskWeight * 0.0018 +
        (intent.habit === "seek" ? -0.08 : intent.habit === "irritated" ? 0.06 : 0),
      dt * (attentionActive ? 2.8 : 1.8),
    );
    intent.nod = Math.max(0, intent.nod - dt * (0.45 + speed * 0.12));
    intent.yawTarget = THREE.MathUtils.lerp(
      intent.yawTarget,
      (deliberate ? intent.yawTarget : travelDir) + intent.glanceYaw,
      dt * (2.2 + attentionPull * 2.4 + (attentionActive ? 1.2 : 0)),
    );

    const yawDelta =
      THREE.MathUtils.euclideanModulo(intent.yawTarget - intent.yaw + Math.PI, Math.PI * 2) - Math.PI;
    intent.yawVelocity += yawDelta * dt * (4.2 + attentionPull * 3.4);
    intent.yawVelocity *= Math.exp(-dt * (6.5 - excitementRef.current * 2.4));
    intent.yaw += intent.yawVelocity * dt;
    intent.pitchTarget =
      leanZ +
      shakePitch +
      intent.glancePitch +
      (intent.phase === "inspect" || deliberate ? -0.05 - emotion.diligence * 0.04 : 0) +
      (intent.habit === "relax" ? 0.05 : 0) +
      Math.sin(t * (1.8 + intent.expression * 0.8)) * 0.018 * profile.vitality -
      intent.nod * 0.08;
    intent.rollTarget =
      leanX +
      wobble +
      shakeJitter +
      shakeRoll +
      (intent.habit === "irritated" ? Math.sin(t * 7.5) * 0.045 : 0) +
      Math.sin(t * 1.1 + intent.expression) * 0.012 * profile.vitality;

    group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, intent.rollTarget, dt * 7);
    group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, intent.pitchTarget, dt * 7.5);
    group.rotation.y = THREE.MathUtils.lerp(group.rotation.y, intent.yaw, dt * (5.2 + attentionPull * 1.6));

    const hoverLift =
      (intent.phase === "observe" ? 0.012 : intent.phase === "inspect" ? 0.02 : 0.007) *
      (0.55 + energyRef.current * 0.55);
    // 固定机位：视觉组 Y 向回中，关闭悬浮浮沉
    group.position.y = THREE.MathUtils.lerp(
      group.position.y,
      verticalStable
        ? 0
        : Math.sin(t * (2.1 + excitementRef.current * 1.1)) * hoverLift +
          (shakeActive ? Math.sin(t * 16) * 0.006 * shakeAmp : 0) +
          (deliberate ? Math.sin(t * (1.3 + emotion.diligence * 0.8)) * 0.01 : 0),
      dt * 5,
    );
  });

  const pickRandomTarget = useCallback(() => {
    pauseUntil.current = 0;
    roamArmedRef.current = true;
  }, []);

  const setTarget = useCallback((x: number, y: number, z: number) => {
    const b = boundsRef.current;
    target.current.set(
      THREE.MathUtils.clamp(x, -b, b),
      THREE.MathUtils.clamp(y, 1.05, 2.15),
      THREE.MathUtils.clamp(z, -b, b),
    );
    pauseUntil.current = 0;
  }, []);

  const excite = useCallback((strength = 1) => {
    const s = Math.min(2.2, Math.max(0.4, strength));
    excitementRef.current = Math.min(1, 0.7 + s * 0.28);
    excitedUntilRef.current = performance.now() + 3200 + s * 1200;
    intentRef.current.glanceYaw = (Math.random() - 0.5) * 0.6;
    intentRef.current.glancePitch = -0.12 - Math.random() * 0.08;
    intentRef.current.nod = 0.65;
    setPhase("inspect", 1200 + s * 550);
    vel.current.x += (Math.random() - 0.5) * 3.8 * s;
    vel.current.z += (Math.random() - 0.5) * 3.8 * s;
    vel.current.y += 1.1 * s;
    pauseUntil.current = 0;
    const b = boundsRef.current;
    target.current.set(
      (Math.random() - 0.5) * b * 1.85,
      1.22 + Math.random() * 0.65,
      (Math.random() - 0.5) * b * 1.65,
    );
  }, [setPhase]);

  /**
   * 触发身体晃动 — 不依赖物理引擎，由 RAF 周期叠加随机冲量。
   * - strength: 0~1
   * - durationMs: 持续时间；> durationMs 后自动衰减
   */
  const shake = useCallback((strength = 0.7, durationMs = 800) => {
    const s = Math.min(1, Math.max(0.1, strength));
    const until = performance.now() + Math.max(150, durationMs);
    // 取较大值，避免被低强度覆盖
    if (s > shakeRef.current.intensity || shakeRef.current.until < performance.now()) {
      shakeRef.current = { intensity: s, until, lastImpulseAt: 0 };
    } else {
      shakeRef.current.until = Math.max(shakeRef.current.until, until);
    }
    // 顺带注入兴奋度，让视觉更生动
    excitementRef.current = Math.min(1, Math.max(excitementRef.current, 0.45 + s * 0.4));
    excitedUntilRef.current = Math.max(excitedUntilRef.current, performance.now() + durationMs);
    intentRef.current.nod = Math.max(intentRef.current.nod, 0.2 + s * 0.5);
    intentRef.current.glanceYaw = (Math.random() - 0.5) * 0.35 * s;
    // 注入初始冲量（X/Z 随机）
    vel.current.x += (Math.random() - 0.5) * 2.6 * s;
    vel.current.z += (Math.random() - 0.5) * 2.6 * s;
    vel.current.y += 0.55 * s;
    pauseUntil.current = 0;
  }, []);

  /** 注入垂直方向偏置（来自拖动/旋转的实时反应 — 让身体上下抖动） */
  const applyVerticalBias = useCallback((bias: number) => {
    verticalBiasRef.current = Math.max(-1, Math.min(1, bias));
  }, []);

  const stopMotion = useCallback(() => {
    enabledRef.current = false;
    roamArmedRef.current = false;
    excitementRef.current = 0;
    vel.current.set(0, 0, 0);
    if (api) api.velocity.set(0, 0, 0);
  }, [api]);

  const resumeMotion = useCallback(() => {
    enabledRef.current = true;
    roamArmedRef.current = true;
  }, []);

  return { pickRandomTarget, setTarget, stopMotion, resumeMotion, excite, shake, applyVerticalBias, lookAtScreenPoint };
}
