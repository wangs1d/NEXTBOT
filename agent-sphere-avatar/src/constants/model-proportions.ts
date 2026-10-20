/**
 * DG2.obj 参考模型比例 — Autodesk 导出，主体半径 5，直径 10
 * 场景内统一缩放到 bodyRadius
 */
export const DG2_SOURCE = {
  bodyRadius: 5,
  bodyCenterY: 1,
  /** 玻璃面中心（OBJ 坐标，Y 轴负向为前面） */
  glassCenter: [0, -4, 0] as const,
  sideEarCenterX: 5.17,
  topEarCenters: [
    [3.088, 2.421, 3.056],
    [-3.056, 2.421, 3.088],
  ] as const,
} as const;

/** 缩放后场景常量（bodyRadius = 0.5 → scale = 0.1） */

const BODY_RADIUS = 0.5;

/**
 * 曲屏可视圆半径。
 * 上限被 DG2 模型自身的玻璃开窗卡死：实测玻璃面与 -Y 极夹角 0–45°，
 * 即开窗半角 45°。screenFaceRadius 超过 0.35（半角 44.4°）就会把脸画到
 * 金属壳上。要更大的脸只能改 CAD 模型，别在这里硬调。
 */
const FACE_RADIUS = 0.34;

export const MODEL = {
  bodyRadius: BODY_RADIUS,
  /** OBJ → 场景：绕 X 轴 -90°，使玻璃面朝向 +Z（相机） */
  objRotation: [-Math.PI / 2, 0, 0] as const,
  /** 将 OBJ 球心 (0, bodyCenterY, 0) 对齐到视觉原点 */
  objOffset: [0, -DG2_SOURCE.bodyCenterY, 0] as const,
  /** 玻璃面中心（缩放+旋转后，相对视觉原点） */
  glassScreenPosition: [0, 0, 0.5] as const,
  /** 内嵌屏 angular 参数（供光标尺寸参考） */
  screenAngularR: Math.PI / 2.8,
  /** 曲屏内嵌表情 — 球冠半径（略小于外壳，贴在玻璃内侧） */
  screenCapRadius: 0.497,
  /** OLED 表情圆盘半径（与黑色曲屏可视圆一致） */
  screenFaceRadius: FACE_RADIUS,
  /** 表情可见区域半角（球冠 UV 参考）— 由 screenFaceRadius 派生，勿重复硬编码 */
  screenFaceHalfAngle: Math.asin(FACE_RADIUS / BODY_RADIUS),
  /** 交互热区半角（略大于可视圆，留一点边缘余量） */
  screenHitHalfAngle: Math.asin(Math.min(0.44, FACE_RADIUS + 0.06) / BODY_RADIUS),
  /** 拉丝钢壳 */
  shellColor: "#9a9aa2",
  shellRoughness: 0.38,
  shellMetalness: 0.82,
  shellClearcoat: 0.22,
  /** 深色玻璃 */
  glassColor: "#080a0e",
  glassRoughness: 0.04,
  glassMetalness: 0.85,
  /** 呼吸灯缝线 */
  seamEmissive: "#a8b8cc",
} as const;

export type SceneMode = "embed" | "overlay";

/** Electron 桌宠 — 固定机位，完整框选 DG2，禁止 3D 空间漫游 */
export const OVERLAY_SCENE = {
  cameraPosition: [0, 1.38, 4.15] as const,
  cameraFov: 34,
  lookAt: [0, 1.26, 0] as const,
  bodyPosition: [0, 1.24, 0] as const,
  modelScale: 0.88,
} as const;

/** 网页 embed — 相对桌宠缩小展示，DOM 漫游边界与 modelScale 对齐 */
export const EMBED_SCENE = {
  modelScale: 0.25,
  containerW: 110,
  containerH: 110,
} as const;

export function dg2Scale(bodyRadius = MODEL.bodyRadius): number {
  return bodyRadius / DG2_SOURCE.bodyRadius;
}
