import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { OVERLAY_SCENE } from "../constants/model-proportions";
import { MODEL } from "../constants/model-proportions";

export interface EllipseShape {
  type: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

interface HitAreaReporterProps {
  /** 计算出球体在 client 坐标中的椭圆（节流上报） */
  onReport: (shape: EllipseShape) => void;
}

const REPORT_INTERVAL_MS = 120;

/**
 * 在 Canvas 内把球体世界坐标投影到屏幕，得到命中椭圆（client CSS 像素）。
 * 原生 ClickThroughController 据此判断光标是否在角色上，决定穿透与否。
 */
export function HitAreaReporter({ onReport }: HitAreaReporterProps) {
  const { camera, gl } = useThree();
  const lastReportRef = useRef(0);

  const center = new THREE.Vector3(...OVERLAY_SCENE.bodyPosition);
  // 视觉球半径 = 模型半径 * 桌宠缩放，再略放大一点留边缘余量
  const radius = MODEL.bodyRadius * OVERLAY_SCENE.modelScale * 1.12;
  const vRight = new THREE.Vector3(radius, 0, 0);
  const vTop = new THREE.Vector3(0, radius, 0);

  const c = new THREE.Vector3();
  const r = new THREE.Vector3();
  const t = new THREE.Vector3();

  useFrame(() => {
    const now = performance.now();
    if (now - lastReportRef.current < REPORT_INTERVAL_MS) return;
    lastReportRef.current = now;

    const rect = gl.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    c.copy(center).project(camera);
    r.copy(center).add(vRight).project(camera);
    t.copy(center).add(vTop).project(camera);

    const cx = (c.x * 0.5 + 0.5) * rect.width + rect.left;
    const cy = (-c.y * 0.5 + 0.5) * rect.height + rect.top;
    const rx = Math.abs((r.x - c.x) * 0.5) * rect.width;
    const ry = Math.abs((t.y - c.y) * 0.5) * rect.height;

    onReport({ type: "ellipse", cx, cy, rx, ry });
  });

  return null;
}
