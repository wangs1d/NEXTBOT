/**
 * 把「曲屏实机」打包成**单文件自包含 HTML**：JS、CSS、两个 OBJ 模型全部内联。
 *
 * 为什么必须单文件：预览面板的静态代理只发 HTML 本身，同目录的
 * `assets/*.js` 与 `models/*.obj` 一律 403。页面拿到骨架、拿不到脚本和模型，
 * 表现就是「一片黑」。本地起 http.server 也不可靠（后台进程每轮会话被清掉）。
 * 单文件版本两条路都不依赖。
 *
 * 产品代码一行没改：模型靠入口里拦 fetch 内联。
 */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const entry = path.join(root, "src/screen-preview-main.tsx");
const outFile = path.join(root, "dist/screen-preview.single.html");

const [dg2, dg] = await Promise.all([
  readFile(path.join(root, "public/models/DG2.obj"), "utf8"),
  readFile(path.join(root, "public/models/DG.obj"), "utf8"),
]);

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  sourcemap: false,
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.BASE_URL": '"/"',
    __DG2_OBJ__: JSON.stringify(dg2),
    __DG_OBJ__: JSON.stringify(dg),
  },
  loader: { ".tsx": "tsx", ".ts": "ts" },
  logLevel: "warning",
});

if (result.warnings.length) {
  for (const w of result.warnings) console.warn("warn:", w.text);
}
console.log("outputs:", result.outputFiles.map((f) => `${f.path} (${f.contents.length}B)`).join(", "));

// write:false 时主产物路径是 <stdout>，没有扩展名，只能按「非 css 即 js」来分
const js = result.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("没有拿到 JS 产物，检查 esbuild 输出");

const escape = (s) => s.replace(/<\/script/gi, "<\\/script").replace(/<\/style/gi, "<\\/style");

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>曲屏实机 · 单文件版</title>
    <style>
      html, body, #root { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0a0d13; }
      body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #cfe0f5; }
    </style>
    <style>${escape(css)}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${escape(js)}</script>
  </body>
</html>
`;

await writeFile(outFile, html, "utf8");
const mb = (Buffer.byteLength(html, "utf8") / 1024 / 1024).toFixed(2);
console.log(`✓ ${path.relative(root, outFile)} (${mb} MB, 自包含：JS + CSS + DG2.obj + DG.obj)`);
