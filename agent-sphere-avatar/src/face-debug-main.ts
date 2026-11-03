/** 脸部屏调试页：画出某一帧表情 / 导出定帧序列，便于和参考图对照与验收动画 */
import { drawFaceBackground, drawFaceEyes, FACE_TEX_SIZE } from "./components/dg2-face/face-draw";
import { FaceRig, type FaceExpression } from "./components/dg2-face/face-rig";

const canvas = document.getElementById("c") as HTMLCanvasElement;
canvas.width = FACE_TEX_SIZE;
canvas.height = FACE_TEX_SIZE;
const ctx = canvas.getContext("2d")!;
const params = new URLSearchParams(location.search);

const bg = document.createElement("canvas");
bg.width = bg.height = FACE_TEX_SIZE;
const bgCtx = bg.getContext("2d")!;
drawFaceBackground(bgCtx, 0.35);

const blit = () => {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, FACE_TEX_SIZE, FACE_TEX_SIZE);
  ctx.drawImage(bg, 0, 0);
};

if (params.get("film") === "1") {
  // 定帧导出：给定 [(表情, 时长ms), ...]，按固定 dt 推演，返回每帧 PNG
  const rig = new FaceRig();
  (window as unknown as { __film: unknown }).__film = (
    steps: Array<{ expr: FaceExpression; ms: number; blink?: boolean }>,
    fps = 24,
  ) => {
    const dt = 1 / fps;
    const frames: string[] = [];
    for (const step of steps) {
      rig.setExpression(step.expr);
      const count = Math.max(1, Math.round((step.ms / 1000) * fps));
      for (let i = 0; i < count; i += 1) {
        if (step.blink && i === Math.floor(count * 0.4)) rig.blink();
        const frame = rig.update(dt);
        blit();
        drawFaceEyes(ctx, frame, frame.blink);
        frames.push(canvas.toDataURL("image/png"));
      }
    }
    return frames;
  };
  (window as unknown as { __ready?: boolean }).__ready = true;
} else {
  const expr = (params.get("expr") ?? "focused") as FaceExpression;
  const rig = new FaceRig();
  rig.setExpression(expr);
  let frame = rig.update(0.016);
  // 只推进 1.2s：超过 2.4s 会撞上自动眨眼，导出的静帧会被「闭到一半」污染
  for (let i = 0; i < 72; i += 1) frame = rig.update(1 / 60);
  blit();
  drawFaceEyes(ctx, frame, 1);
  (window as unknown as { __ready?: boolean }).__ready = true;
}
