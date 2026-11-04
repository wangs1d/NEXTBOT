import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { FaceRig, poseFor, type FaceExpression } from "./dg2-face/face-rig";
import { FACE_TEX_SIZE, drawFaceBackground, drawFaceEyes } from "./dg2-face/face-draw";

/** 模型空间球半径 */
const BODY_R = 5;
/** 曲屏片半角：正好等于玻璃开窗（53.1°），贴图正投影半径 = 4 */
const FACE_CAP_DEG = 53.0;
/** 曲屏片半径：与球同心，比玻璃面板高一丝，避免 z-fighting */
const FACE_CAP_RADIUS = BODY_R + 0.004;
const PLANAR_R = 4;
/** 眼睛重绘上限（帧/秒）—— 背景层有缓存，这里只重画眼睛 */
const REDRAW_FPS = 30;

/**
 * 与球同心的球冠，UV 用正面正交投影：
 * 画布内容就是正对着看到的样子，但表面跟着球面弯，是一块「曲屏」。
 */
function buildFaceCap(radius: number, maxTheta: number): THREE.BufferGeometry {
  const segU = 132;
  const segV = 46;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segV; i += 1) {
    const theta = (maxTheta * i) / segV;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let j = 0; j <= segU; j += 1) {
      const phi = (j / segU) * Math.PI * 2;
      const x = radius * st * Math.cos(phi);
      const z = radius * st * Math.sin(phi);
      positions.push(x, -radius * ct, z);
      uvs.push((x / PLANAR_R + 1) / 2, (z / PLANAR_R + 1) / 2);
    }
  }
  const stride = segU + 1;
  for (let i = 0; i < segV; i += 1) {
    for (let j = 0; j < segU; j += 1) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = i * stride + j + 1;
      const d = (i + 1) * stride + j + 1;
      indices.push(a, b, c, c, b, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

interface Dg2FaceScreenProps {
  expression?: FaceExpression;
  /** 外部驱动（宿主/主 Agent）：直接指定表情 */
  rigRef?: { current: FaceRig | null };
}

/**
 * 桌宠的脸 —— 一块会动的曲屏。
 * 每帧由 FaceRig 输出连续姿态，眼睛重绘到 CanvasTexture 上；
 * 表情切换走临界阻尼弹簧，所以是连续变化而不是一张张贴图切换。
 */
export function Dg2FaceScreen({ expression = "focused", rigRef }: Dg2FaceScreenProps) {
  const rig = useMemo(() => new FaceRig(), []);
  const geom = useMemo(() => buildFaceCap(FACE_CAP_RADIUS, FACE_CAP_DEG * (Math.PI / 180)), []);

  const { texture, ctx, bg, bgCtx } = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = FACE_TEX_SIZE;
    canvas.height = FACE_TEX_SIZE;
    const c = canvas.getContext("2d")!;
    const bgCanvas = document.createElement("canvas");
    bgCanvas.width = FACE_TEX_SIZE;
    bgCanvas.height = FACE_TEX_SIZE;
    const bctx = bgCanvas.getContext("2d")!;
    drawFaceBackground(bctx, poseFor("focused").glow);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(bgCanvas, 0, 0);
    drawFaceEyes(c, poseFor("focused"), 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return { texture: tex, ctx: c, bg: bgCanvas, bgCtx: bctx };
  }, []);

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        toneMapped: false,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    [texture],
  );

  const bgGlowRef = useRef(0.35);
  const accRef = useRef(0);

  useEffect(() => {
    rig.setExpression(expression);
  }, [rig, expression]);

  useEffect(() => {
    if (rigRef) rigRef.current = rig;
    // 宿主 / 主 Agent 可以直接驱动表情：__dg2FaceRig.setExpression("happy")
    (window as unknown as { __dg2FaceRig?: FaceRig }).__dg2FaceRig = rig;
    return () => {
      if (rigRef) rigRef.current = null;
    };
  }, [rig, rigRef]);

  useEffect(() => {
    return () => {
      texture.dispose();
      material.dispose();
      geom.dispose();
    };
  }, [texture, material, geom]);

  useFrame((_, delta) => {
    const frame = rig.update(delta);

    // 面罩辉光变了才重刷背景层
    if (Math.abs(frame.glow - bgGlowRef.current) > 0.015) {
      bgGlowRef.current = frame.glow;
      drawFaceBackground(bgCtx, frame.glow);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, FACE_TEX_SIZE, FACE_TEX_SIZE);
      ctx.drawImage(bg, 0, 0);
      texture.needsUpdate = true;
    }

    if (!frame.dirty) return;
    accRef.current += delta;
    if (accRef.current < 1 / REDRAW_FPS) return;
    accRef.current = 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, FACE_TEX_SIZE, FACE_TEX_SIZE);
    ctx.drawImage(bg, 0, 0);
    drawFaceEyes(ctx, frame, frame.blink);
    texture.needsUpdate = true;
  });

  return <mesh geometry={geom} material={material} raycast={() => null} renderOrder={3} />;
}
