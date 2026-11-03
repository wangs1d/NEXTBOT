import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MODEL, dg2Scale } from "../constants/model-proportions";
import { disableMeshRaycast } from "../utils/mesh-raycast";
import { Dg2FaceScreen } from "./Dg2FaceScreen";
import type { FaceExpression } from "./dg2-face/face-rig";

const DEFAULT_MODEL_URL = `${import.meta.env.BASE_URL}models/DG2.glb`;
const GLASS_RENDER_ORDER = 2;

interface DG2RobotModelProps {
  modelUrl?: string;
  energy?: number;
  /** 待机呼吸/微摆（桌宠关闭以保持画面稳定） */
  idleMotion?: boolean;
  /** 无 Environment 贴图（桌宠本地灯光） */
  standaloneLighting?: boolean;
  opacity?: number;
  /** 脸部表情（曲屏电子脸，默认开启） */
  face?: boolean;
  /** 当前表情，切换时由面部弹簧平滑过渡 */
  expression?: FaceExpression;
}

function slotName(material: THREE.Material | THREE.Material[]): string {
  const m = Array.isArray(material) ? material[0] : material;
  return m?.name ?? "";
}

/** DG2 模型 — 由 source/DG2.fbx 经 scripts/build-model.mjs 转出的 GLB */
export function DG2RobotModel({
  modelUrl = DEFAULT_MODEL_URL,
  energy = 0.55,
  idleMotion = true,
  standaloneLighting = false,
  opacity = 1,
  face = true,
  expression,
}: DG2RobotModelProps) {
  const groupRef = useRef<THREE.Group>(null);
  const shellMatsRef = useRef<THREE.MeshPhysicalMaterial[]>([]);

  const gltf = useLoader(GLTFLoader, modelUrl);
  const scale = dg2Scale();

  const { shellMaterial, glassMaterial } = useMemo(() => {
    const shell = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(MODEL.shellColor),
      metalness: MODEL.shellMetalness,
      roughness: MODEL.shellRoughness,
      clearcoat: MODEL.shellClearcoat,
      clearcoatRoughness: 0.32,
      envMapIntensity: standaloneLighting ? 0.25 : 0.85,
      transparent: true,
      opacity: 1,
    });
    // 屏幕不亮时是纯黑面板：basic 材质不吃灯光，避免蓝色补光在玻璃上留反射
    const glass = new THREE.MeshBasicMaterial({
      color: new THREE.Color(MODEL.glassColor),
      toneMapped: false,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    return { shellMaterial: shell, glassMaterial: glass };
  }, [standaloneLighting]);

  const model = useMemo(() => {
    const root = gltf.scene.clone(true);
    shellMatsRef.current = [];

    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;

      node.castShadow = true;
      node.receiveShadow = true;

      if (slotName(node.material) === "glass") {
        node.material = glassMaterial;
        node.renderOrder = GLASS_RENDER_ORDER;
        return;
      }

      const steel = shellMaterial.clone();
      shellMatsRef.current.push(steel);
      node.material = steel;
    });

    disableMeshRaycast(root);
    return root;
  }, [gltf, shellMaterial, glassMaterial]);

  useEffect(() => {
    glassMaterial.opacity = opacity;
    glassMaterial.transparent = opacity < 0.999;
  }, [glassMaterial, opacity]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pulse = 0.06 + ((Math.sin(t * 1.15) + 1) * 0.5) * (0.15 + energy * 0.25);

    shellMatsRef.current.forEach((mat) => {
      mat.emissive.set(MODEL.seamEmissive);
      mat.emissiveIntensity = pulse * 0.12;
      mat.opacity = opacity;
    });

    if (groupRef.current) {
      groupRef.current.visible = opacity > 0.001;
    }

    if (groupRef.current && idleMotion) {
      const breathe = Math.sin(t * 1.45) * 0.018 * (0.4 + energy);
      groupRef.current.rotation.y = Math.sin(t * 0.1) * 0.015 + breathe * 0.3;
      groupRef.current.position.y = Math.sin(t * 1.35) * 0.012 * (0.35 + energy * 0.5);
    } else if (groupRef.current) {
      groupRef.current.rotation.y = 0;
      groupRef.current.position.y = 0;
    }
  });

  return (
    <group
      ref={groupRef}
      scale={scale}
      rotation={[...MODEL.objRotation]}
      position={[...MODEL.objOffset]}
    >
      <primitive object={model} />
      {face ? <Dg2FaceScreen expression={expression ?? "focused"} /> : null}
    </group>
  );
}
