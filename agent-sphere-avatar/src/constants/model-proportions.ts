/**
 * DG2 源文件比例 — source/DG2.fbx 在 Fusion 里按 cm 建模（主体半径 50），
 * scripts/build-model.mjs 转出 GLB 时已归一到半径 5，与旧 DG2.obj 同一量级
 */
export const DG2_SOURCE = {
  bodyRadius: 5,
  /** 实测源文件球心就在原点；这个值喂给 objOffset，属于既有构图，改它会移动已验收的机位 */
  bodyCenterY: 1,
} as const;

/** 缩放后场景常量（bodyRadius = 0.5 → scale = 0.1） */

const BODY_RADIUS = 0.5;

/**
 * 曲屏可视圆半径。
 * 上限被 DG2 模型自身的玻璃开窗卡死：实测 GLB 里 screen 组件的玻璃面
 * 覆盖 -Y 极 0–53.1°，即开窗半角 53.1°、半径 0.4。
 * screenFaceRadius 留 0.06 余量给金属圈，再大就会把脸画到壳上；
 * 要更大的脸只能改 CAD 模型，别在这里硬调。
 */
const FACE_RADIUS = 0.34;

export const MODEL = {
  bodyRadius: BODY_RADIUS,
  /** 模型 → 场景：绕 X 轴 -90°，使玻璃面朝向 +Z（相机） */
  objRotation: [-Math.PI / 2, 0, 0] as const,
  /** 沿 Y 下沉 bodyCenterY，与机位一起构成已验收的构图 */
  objOffset: [0, -DG2_SOURCE.bodyCenterY, 0] as const,
  /** 玻璃面中心（缩放+旋转后，相对视觉原点） */
  glassScreenPosition: [0, 0, 0.5] as const,
  /** 内嵌屏 angular 参数（供光标尺寸参考） */
  screenAngularR: Math.PI / 2.8,
  /** OLED 表情圆盘半径（与黑色曲屏可视圆一致） */
  screenFaceRadius: FACE_RADIUS,
  /** 交互热区半角（略大于可视圆，留一点边缘余量） */
  screenHitHalfAngle: Math.asin(Math.min(0.44, FACE_RADIUS + 0.06) / BODY_RADIUS),
  /** 拉丝钢壳 */
  shellColor: "#9a9aa2",
  shellRoughness: 0.38,
  shellMetalness: 0.82,
  shellClearcoat: 0.22,
  /** 纯黑前罩玻璃 — 不带蓝调、不吃补光，屏幕不亮时就是全黑 */
  glassColor: "#000000",
  /** 呼吸灯缝线 */
  seamEmissive: "#a8b8cc",
} as const;

export type SceneMode = "embed" | "overlay";

/** embed 网页机体锚点 —— 刚体创建位置与运动积分初值共用，否则首帧会掉 0.15 */
export const EMBED_BODY_ANCHOR: [number, number, number] = [0, 1.45, 0];

/** 桌宠机体锚点 —— 与相机 lookAt(1.26) 同一构图基准，改动会让桌宠整体上下移位 */
export const OVERLAY_BODY_ANCHOR: [number, number, number] = [0, 1.24, 0];

/** Electron 桌宠 — 固定机位，完整框选 DG2，禁止 3D 空间漫游 */
export const OVERLAY_SCENE = {
  cameraPosition: [0, 1.38, 4.15] as const,
  cameraFov: 34,
  lookAt: [0, 1.26, 0] as const,
  bodyPosition: OVERLAY_BODY_ANCHOR,
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
