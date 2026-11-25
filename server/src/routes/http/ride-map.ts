/**
 * 叫车卡 3D 地图页面（GET /ride-map/picker）。
 *
 * 移动端选点卡/报价卡的 WebView 加载本页：高德 JS API 2.0 3D 视图
 * （viewMode: "3D"，俯仰 52°，真 3D 建筑），页面经 JS 桥（RideMapBridge）
 * 向 Flutter 回传 ready / move / pick / error。
 *
 * key 与安全密钥在服务端注入，页面本身不含任何用户数据，故列入公开路径
 * （见 auth.ts PUBLIC_PATH_PREFIXES）——WebView 打开时不需要带设备凭证。
 * 未配置 AMAP_JS_KEY 时返回 503：客户端据此保留 flutter_map 平面地图。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { serverRoot } from "../../config/paths.js";
import { amapJsKey, amapJsSecurityCode } from "../../services/ride-map-config.js";

const PAGE_PATH = join(serverRoot(), "web", "ride-map", "picker.html");

/** 注入 script 块内联 JSON 时防止 "</script" 提前收尾。 */
function safeJsonString(value: string): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

export function registerRideMapRoutes(app: FastifyInstance): void {
  // 启动自检（2026-11-24）：3D 到底是「没配」「配错」还是「页面缺失」，
  // 只看一行日志就能分清——此前排查全靠 curl 反推。
  const bootKey = amapJsKey();
  if (!bootKey) {
    console.log("[ride-map] 3D 关闭：未配置 AMAP_JS_KEY → 客户端保留 flutter_map 平面地图");
  } else {
    console.log(
      `[ride-map] 3D 启用 key=…${bootKey.slice(-6)} ` +
        `securityCode=${amapJsSecurityCode() ? "已配置" : "未配置"} ` +
        `page=${existsSync(PAGE_PATH) ? "ok" : `缺失(${PAGE_PATH})`}`,
    );
  }

  app.get("/ride-map/picker", async (_req, reply) => {
    const key = amapJsKey();
    if (!key) {
      return reply
        .code(503)
        .type("text/plain; charset=utf-8")
        .send("AMAP_JS_KEY 未配置：叫车卡暂用平面地图");
    }
    let html: string;
    try {
      html = readFileSync(PAGE_PATH, "utf8");
    } catch {
      // 页面没随部署上传（tar 漏打包 web/）时别抛 500，给客户端一个明确的降级信号
      return reply
        .code(503)
        .type("text/plain; charset=utf-8")
        .send("叫车地图页面缺失：server/web/ride-map/picker.html 未随部署同步");
    }
    html = html
      .replaceAll("__AMAP_JS_KEY__", encodeURIComponent(key))
      .replaceAll("__AMAP_SECURITY_JSON__", safeJsonString(amapJsSecurityCode()));
    return reply
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(html);
  });
}
