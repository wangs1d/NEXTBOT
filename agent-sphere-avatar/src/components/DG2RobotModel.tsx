import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MODEL, dg2Scale } from "../constants/model-proportions";
import { useOledScreenTexture } from "../context/oled-screen-context";
import { applyGlassOledUv } from "../utils/glass-oled-uv";
import { disableMeshRaycast } from "../utils/mesh-raycast";

const DEFAULT_MODEL_URL = `${import.meta.env.BASE_URL}models/DG2.obj`;
const GLASS_RENDER_ORDER = 2;

interface DG2RobotModelProps {
  modelUrl?: string;
  energy?: number;
  focused?: boolean;
  /** 待机呼吸/微摆（桌宠关闭以保持画面稳定） */
  idleMotion?: boolean;
  /** 无 Environment 贴图（桌宠本地灯光） */
  standaloneLighting?: boolean;
  opacity?: number;
}

function isGlassMaterial(name: string): boolean {
  return name.includes("玻璃");
}

/** DG2.obj 一比一还原 — 加载 CAD 网格并套用金属/玻璃材质 */
export function DG2RobotModel({
  modelUrl = DEFAULT_MODEL_URL,
  energy = 0.55,
  focused = false,
  idleMotion = true,
  standaloneLighting = false,
  opacity = 1,
}: DG2RobotModelProps) {
  const oledMap = useOledScreenTexture();
  const groupRef = useRef<THREE.Group>(null);
  const shellMatsRef = useRef<THREE.MeshPhysicalMaterial[]>([]);
  const glassMatRef = useRef<THREE.MeshPhysicalMaterial | null>(null);
  const glassMeshesRef = useRef<THREE.Mesh[]>([]);

  const obj = useLoader(OBJLoader, modelUrl);
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
    const glass = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(MODEL.glassColor),
      metalness: MODEL.glassMetalness,
      roughness: MODEL.glassRoughness,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      reflectivity: 0.95,
      envMapIntensity: standaloneLighting ? 0.35 : 1.4,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    return { shellMaterial: shell, glassMaterial: glass };
  }, []);

  const model = useMemo(() => {
    const root = obj.clone(true);
    shellMatsRef.current = [];
    glassMeshesRef.current = [];
    glassMatRef.current = glassMaterial;

    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;

      node.castShadow = true;
      node.receiveShadow = true;

      const sourceName =
        (Array.isArray(node.material)
          ? node.material[0]?.name
          : node.material?.name) ?? "";

      if (isGlassMaterial(sourceName)) {
        const geo = node.geometry.clone();
        applyGlassOledUv(geo);
        node.geometry = geo;
        glassMeshesRef.current.push(node);
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
  }, [obj, shellMaterial, glassMaterial]);

  useEffect(() => {
    const gMat = glassMatRef.current;
    for (const mesh of glassMeshesRef.current) {
      mesh.visible = opacity > 0.001;
      if (!gMat) continue;
      if (oledMap) {
        // OLED 激活时曲屏就是「屏」：不能有任何金属度/高光，
        // 否则环境反射会在屏面上打出块状亮斑，把表情盖掉
        gMat.color.set("#020306");
        gMat.opacity = opacity;
        gMat.transparent = true;
        gMat.metalness = 0;
        gMat.roughness = 1;
        gMat.clearcoat = 0;
        gMat.reflectivity = 0;
        gMat.envMapIntensity = 0;
        gMat.depthWrite = true;
      } else {
        gMat.color.set(MODEL.glassColor);
        gMat.opacity = 0.82 * opacity;
        gMat.transparent = true;
        gMat.metalness = MODEL.glassMetalness;
        gMat.roughness = MODEL.glassRoughness;
        gMat.depthWrite = opacity > 0.9;
      }
    }
  }, [oledMap, opacity]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pulse = 0.06 + ((Math.sin(t * 1.15) + 1) * 0.5) * (0.15 + energy * 0.25);

    shellMatsRef.current.forEach((mat) => {
      mat.emissive.set(MODEL.seamEmissive);
      mat.emissiveIntensity = pulse * 0.12;
      mat.opacity = opacity;
    });

    const gMat = glassMatRef.current;
    if (gMat && !oledMap) {
      gMat.emissive.set(focused ? "#334466" : "#000000");
      gMat.emissiveIntensity = focused ? 0.08 + pulse * 0.06 : 0;
    }

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
    </group>
  );
}
