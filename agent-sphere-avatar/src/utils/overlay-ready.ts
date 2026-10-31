/** 桌宠就绪信号 —— 由"机体画在屏上"这一刻发出，宿主据此结束召唤等待。
 *
 * 原生桥在 loadFinished 之后才注入，可能晚于模型首帧，故桥缺失时等 ready 事件补发。
 */
let reported = false;

export function reportOverlayPainted(): void {
  if (reported) return;
  const flush = () => {
    if (reported) return;
    const notify = window.sphereOverlay?.notifyReady;
    if (!notify) return;
    reported = true;
    notify.call(window.sphereOverlay);
  };
  flush();
  if (reported) return;
  window.addEventListener("sphere-overlay:ready", flush, { once: true });
}
