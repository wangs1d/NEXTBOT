/**
 * 叫车卡 3D 地图（高德 JS API 2.0）运行配置。
 *
 * 选点卡/报价卡的地图在移动端走 WebView 内的高德 JS API 3D 视图（真 3D 建筑、
 * 俯仰视角，对齐滴滴选点页）。key 属「Web端(JS API)」产品，与 Android 定位
 * key、AMAP_WEB_KEY（Web 服务 key）都不是同一套，需在高德控制台单独创建，
 * 新 key 还要配安全密钥（securityJsCode）。
 *
 * 未配置 key 时 rideMap3dEnabled()=false：卡片不带 map3d 标记，客户端保留现有
 * flutter_map 平面地图；/ride-map/picker 返回 503，不会把半残页面发给 WebView。
 */
export function amapJsKey(): string {
  return process.env.AMAP_JS_KEY?.trim() ?? "";
}

export function amapJsSecurityCode(): string {
  return process.env.AMAP_JS_SECURITY_CODE?.trim() ?? "";
}

export function rideMap3dEnabled(): boolean {
  return amapJsKey().length > 0;
}
