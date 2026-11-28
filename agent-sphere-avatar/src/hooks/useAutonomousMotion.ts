import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import type { PublicApi } from "@react-three/cannon";

interface UseAutonomousMotionOptions {
  api: PublicApi;
  enabled?: boolean;
  bounds?: number;
  strength?: number;
}

/** Cannon 物理体自主漫游 — 随机目标点 + 缓动推力 */
export function useAutonomousMotion({
  api,
  enabled = true,
  bounds = 2.2,
  strength = 1,
}: UseAutonomousMotionOptions) {
  const target = useRef(new THREE.Vector3(0, 1.6, 0));
  const position = useRef(new THREE.Vector3(0, 1.6, 0));
  const nextRetargetAt = useRef(0);
  const enabledRef = useRef(enabled);
  const strengthRef = useRef(strength);
  enabledRef.current = enabled;
  strengthRef.current = strength;

  const pickRandomTarget = useCallback(() => {
    target.current.set(
      (Math.random() - 0.5) * bounds,
      1.4 + Math.random() * 0.8,
      (Math.random() - 0.5) * bounds,
    );
    nextRetargetAt.current = 0;
  }, [bounds]);

  const setTarget = useCallback(
    (x: number, y: number, z: number) => {
      target.current.set(
        Math.max(-bounds, Math.min(bounds, x)),
        Math.max(0.9, Math.min(2.6, y)),
        Math.max(-bounds, Math.min(bounds, z)),
      );
      nextRetargetAt.current = 0;
    },
    [bounds],
  );

  const stopMotion = useCallback(() => {
    enabledRef.current = false;
    api.velocity.set(0, 0, 0);
    api.angularVelocity.set(0, 0, 0);
  }, [api]);

  const resumeMotion = useCallback(() => {
    enabledRef.current = true;
  }, []);

  useEffect(() => {
    pickRandomTarget();
    const unsub = api.position.subscribe((p) => {
      position.current.set(p[0], p[1], p[2]);
    });
    return unsub;
  }, [api, pickRandomTarget]);

  useFrame(({ clock }) => {
    if (!enabledRef.current) return;
    const t = clock.elapsedTime;

    if (t > nextRetargetAt.current) {
      pickRandomTarget();
      nextRetargetAt.current = t + 2.5 + Math.random() * 3.5;
    }

    const dir = target.current.clone().sub(position.current);
    const dist = dir.length();
    if (dist > 0.05) dir.normalize();

    const wander = new THREE.Vector3(
      Math.sin(t * 0.9) * 0.35,
      Math.cos(t * 0.6) * 0.2,
      Math.cos(t * 0.75) * 0.35,
    );

    const force = dir
      .multiplyScalar(0.55 * strengthRef.current)
      .add(wander.multiplyScalar(0.25 * strengthRef.current));
    api.applyForce([force.x, force.y + 1.8, force.z], [0, 0, 0]);

    if (dist < 0.25) {
      nextRetargetAt.current = t;
    }
  });

  return { pickRandomTarget, setTarget, stopMotion, resumeMotion };
}
