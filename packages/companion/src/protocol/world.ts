import { z } from "zod";
import { Vec3Schema } from "./pose.ts";

/**
 * 世界是壳的属性，不是解算层的常数。
 * 重力、地面高度、墙、球半径、以及"1 场景单位等于多少屏幕像素"全部由壳声明，
 * 这样同一个积分器既能跑悬空的桌宠窗口，也能跑落地站着的测试间。
 */

const Unit = z.number().min(-1000).max(1000);

/** 相机只取桌宠现场用到的那种：沿 -Z 看原点，无旋转。 */
export const CameraSchema = z.object({
  posY: Unit,
  posZ: Unit.positive(),
  fovDeg: z.number().min(5).max(170),
});

export const ViewSchema = z.object({
  /** 真实窗口尺寸，像素。壳侧字段，允许出现在这里。 */
  viewportPx: z.object({ w: z.number().int().positive().max(8192), h: z.number().int().positive().max(8192) }),
  dpr: z.number().min(0.25).max(8),
  camera: CameraSchema,
});

export const FloorSchema = z.object({
  /** 地面平面的场景 y */
  planeY: Unit,
  restitution: z.number().min(0).max(0.94),
  friction: z.number().min(0).max(20),
});
export type Floor = z.infer<typeof FloorSchema>;

export const WallSchema = z.object({
  axis: z.enum(["x", "y", "z"]),
  sign: z.union([z.literal(-1), z.literal(1)]),
  /** 墙到原点的距离，恒正 */
  at: z.number().positive().max(1000),
  restitution: z.number().min(0).max(0.94),
});
export type Wall = z.infer<typeof WallSchema>;

export const AnchorSchema = z.object({
  pos: Vec3Schema,
  springK: z.number().min(0).max(24),
});

export const WorldDescriptorSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(64),
  gravity: Vec3Schema,
  /** 审计用：一个场景单位等于多少米。重力不从这里推，见 standingGravityForAirtime。 */
  metresPerUnit: z.number().positive().max(100),
  bodyRadius: z.number().positive().max(100),
  floor: FloorSchema.nullable(),
  walls: z.array(WallSchema).max(12),
  anchor: AnchorSchema.nullable(),
  view: ViewSchema,
});
export type WorldDescriptor = z.infer<typeof WorldDescriptorSchema>;
export type View = z.infer<typeof ViewSchema>;

/* ───────── 标尺：场景单位 ↔ 屏幕像素，由相机反解，不手填 ───────── */

export function visibleHeightUnits(view: View): number {
  return 2 * view.camera.posZ * Math.tan(((view.camera.fovDeg * Math.PI) / 180) / 2);
}

export function unitsPerPixel(view: View): number {
  return visibleHeightUnits(view) / (view.viewportPx.h / view.dpr);
}

export function pixelsPerUnit(view: View): number {
  return 1 / unitsPerPixel(view);
}

/** 球静止时球心该在的高度：有锚点听锚点，否则站在地面上。 */
export function restY(w: WorldDescriptor): number {
  if (w.anchor) return w.anchor.pos.y;
  return w.floor ? w.floor.planeY + w.bodyRadius : 0;
}

export function wallAt(w: WorldDescriptor, axis: Wall["axis"], sign: 1 | -1): number | null {
  const hit = w.walls.find((x) => x.axis === axis && x.sign === sign);
  return hit ? hit.at : null;
}

/** 窗口四条边落在场景坐标的哪里。底边就是用户看到的"桌面线"。 */
export function windowEdges(view: View): { topY: number; bottomY: number; leftX: number; rightX: number } {
  const half = visibleHeightUnits(view) / 2;
  const aspect = view.viewportPx.w / view.viewportPx.h;
  const halfX = half * aspect;
  return {
    topY: view.camera.posY + half,
    bottomY: view.camera.posY - half,
    leftX: -halfX,
    rightX: halfX,
  };
}

/**
 * 想让一次跳跃滞空 t 秒、顶点高 h 单位，需要的重力加速度。
 * 小尺寸物体按真实 g 会快得像昆虫，所以重力是按观感定的，metresPerUnit 只作审计。
 */
export function standingGravityForAirtime(apexUnits: number, airtimeSec: number): number {
  const half = airtimeSec / 2;
  return -((2 * apexUnits) / (half * half));
}

/* ───────── 接线：Pose → 屏幕 CSS 像素 ───────── */

export interface ScreenEllipse {
  cxPx: number;
  cyPx: number;
  rxPx: number;
  ryPx: number;
}

/**
 * 复算 agent-sphere-avatar/src/components/HitAreaReporter.tsx 的投影：
 * 透视除 → NDC → 视口矩形。热区算错一格，桌宠就点不着或者点到窗口外。
 */
export function projectCenter(pos: { x: number; y: number; z: number }, view: View): { cxPx: number; cyPx: number; depth: number } {
  const depth = view.camera.posZ - pos.z;
  const tanHalf = Math.tan(((view.camera.fovDeg * Math.PI) / 180) / 2);
  const ndcY = (pos.y - view.camera.posY) / (depth * tanHalf);
  const aspect = view.viewportPx.w / view.viewportPx.h;
  const ndcX = pos.x / (depth * tanHalf * aspect);
  return {
    cxPx: ((ndcX + 1) / 2) * (view.viewportPx.w / view.dpr),
    cyPx: ((1 - ndcY) / 2) * (view.viewportPx.h / view.dpr),
    depth,
  };
}

export function projectBody(pos: { x: number; y: number; z: number }, radiusUnits: number, view: View): ScreenEllipse {
  const c = projectCenter(pos, view);
  const r = (radiusUnits / (c.depth * Math.tan(((view.camera.fovDeg * Math.PI) / 180) / 2))) *
    ((view.viewportPx.h / view.dpr) / 2);
  return { cxPx: c.cxPx, cyPx: c.cyPx, rxPx: r, ryPx: r };
}

/** 热区越出窗口的距离，像素。>0 就是有一部分点不到了。 */
export function overflowPx(e: ScreenEllipse, view: View): { top: number; bottom: number; left: number; right: number } {
  const W = view.viewportPx.w / view.dpr;
  const H = view.viewportPx.h / view.dpr;
  return {
    top: Math.max(0, e.cyPx - e.ryPx),
    bottom: Math.max(0, e.cyPx + e.ryPx - H),
    left: Math.max(0, e.cxPx - e.rxPx),
    right: Math.max(0, e.cxPx + e.rxPx - W),
  };
}

/* ───────── 三个世界 ───────── */

/** 桌宠现场：248×309 无边框置顶透明窗，相机 fov34，dpr 强制 1，重力 0，无地面。 */
const DESKTOP_VIEW: View = {
  viewportPx: { w: 248, h: 309 },
  dpr: 1,
  camera: { posY: 1.38, posZ: 4.15, fovDeg: 34 },
};

const BODY_RADIUS = 0.5 * 0.88 * 1.12;

/** 窗口左右边与顶边直接由相机反解，不手填数字。 */
function windowWalls(view: View, restitution: number): Wall[] {
  const e = windowEdges(view);
  return [
    { axis: "x", sign: -1, at: -e.leftX, restitution },
    { axis: "x", sign: 1, at: e.rightX, restitution },
    { axis: "y", sign: 1, at: e.topY, restitution },
  ];
}

/** 今天真实存在的那个世界：飘着，没有地面，所以也不会有落地接触。 */
export const DESKTOP_HOVER_WORLD: WorldDescriptor = WorldDescriptorSchema.parse({
  version: 1,
  name: "desktop-hover-248x309",
  gravity: { x: 0, y: 0, z: 0 },
  metresPerUnit: 0.0322,
  bodyRadius: BODY_RADIUS,
  floor: null,
  walls: windowWalls(DESKTOP_VIEW, 0.4),
  anchor: { pos: { x: 0, y: 1.4, z: 0 }, springK: 5.2 },
  view: DESKTOP_VIEW,
});

/** 同一个窗口，但给它重力和真地面：底边就是桌面线。 */
export const DESKTOP_STANDING_WORLD: WorldDescriptor = (() => {
  const edges = windowEdges(DESKTOP_VIEW);
  return WorldDescriptorSchema.parse({
    version: 1,
    name: "desktop-standing-248x309",
    gravity: { x: 0, y: standingGravityForAirtime(0.6, 0.585), z: 0 },
    metresPerUnit: 0.0322,
    bodyRadius: BODY_RADIUS,
    floor: { planeY: edges.bottomY, restitution: 0.42, friction: 3.4 },
    walls: windowWalls(DESKTOP_VIEW, 0.42),
    anchor: { pos: { x: 0, y: edges.bottomY + BODY_RADIUS, z: 0 }, springK: 5.2 },
    view: DESKTOP_VIEW,
  });
})();

/** 无窗口约束的测试间，用来单验力学本身。 */
export const TEST_ROOM_WORLD: WorldDescriptor = WorldDescriptorSchema.parse({
  version: 1,
  name: "test-room",
  gravity: { x: 0, y: -14, z: 0 },
  metresPerUnit: 1,
  bodyRadius: 0.5,
  floor: { planeY: 0, restitution: 0.6, friction: 2 },
  walls: [
    { axis: "x", sign: -1, at: 3, restitution: 0.6 },
    { axis: "x", sign: 1, at: 3, restitution: 0.6 },
    { axis: "z", sign: -1, at: 3, restitution: 0.6 },
    { axis: "z", sign: 1, at: 3, restitution: 0.6 },
  ],
  anchor: { pos: { x: 0, y: 1.4, z: 0 }, springK: 5.2 },
  view: { viewportPx: { w: 800, h: 600 }, dpr: 1, camera: { posY: 1.38, posZ: 6, fovDeg: 40 } },
});
