import { useCallback } from "react";

/**
 * 鼠标穿透已由原生 ClickThroughController 按命中区域统一管理
 *（Win32 WS_EX_TRANSPARENT 全穿透时页面收不到 hover，无法在前端切换）。
 * 这里保留 setMouseCapture 签名以兼容现有调用点，但不再直接操作穿透，
 * 避免与控制器的逐帧判定相互覆盖造成抖动。
 */
export function useOverlayPointerCapture(_menuOpen: boolean) {
  const setMouseCapture = useCallback((_active: boolean) => {
    /* no-op：穿透由原生 ClickThroughController 管理 */
  }, []);

  return { setMouseCapture };
}
