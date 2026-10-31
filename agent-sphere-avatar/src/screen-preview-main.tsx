/**
 * 曲屏实机单文件预览入口 —— 只显示球体本身，无任何 UI 外壳。
 *
 * 存在的唯一理由：预览面板的静态代理**只发 HTML 本身**，同目录的
 * `assets/*.js` 与 `models/*` 一律 403 —— 页面拿到骨架却拿不到脚本和模型，
 * 表现出来就是「一片黑 / 什么都没有」。所以这里把 JS 与模型全部内联，
 * 产出一个不依赖任何同目录资源的 HTML。
 *
 * 模型内联的做法：three 的 FileLoader 走 fetch，在应用启动前把 fetch 拦下来，
 * 命中模型路径就直接回内容。这样**不需要改任何产品代码**。
 */
import { createRoot } from "react-dom/client";
import { SphereAgentScene } from "./components/SphereAgentScene";
import { DEFAULT_AGENT_STATE } from "./types/agent";

declare const __DG2_GLB_B64__: string;

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const MODELS: Record<string, { body: BodyInit; mime: string }> = {
  "/models/DG2.glb": { body: decodeBase64(__DG2_GLB_B64__), mime: "model/gltf-binary" },
};

const rawFetch = window.fetch.bind(window);
window.fetch = ((
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  for (const [suffix, model] of Object.entries(MODELS)) {
    if (url.endsWith(suffix)) {
      return Promise.resolve(
        new Response(model.body, { status: 200, headers: { "content-type": model.mime } }),
      );
    }
  }
  return rawFetch(input, init);
}) as typeof window.fetch;

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <div style={{ width: "100%", height: "100%", background: "#0a0d13" }}>
      <SphereAgentScene state={DEFAULT_AGENT_STATE} mode="overlay" physics={false} />
    </div>,
  );
}
