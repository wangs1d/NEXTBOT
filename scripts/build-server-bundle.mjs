/**
 * 后端单文件打包：把 server/src 的入口图压成 dist-bundle/*.js。
 *
 * 产物布局（与装机布局 runtime/dist/bundle 一致）：
 *   dist-bundle/index.js                 Fastify 服务（supervisor 的 worker）
 *   dist-bundle/supervisor-main.js       端口持有 + worker 监督
 *   dist-bundle/local-embedding-host.js  向量引擎子进程
 *   dist-bundle/runtime-main.js          remote 拓扑下的 runtime 进程
 *   dist-bundle/workers/*.mjs            worker_threads 任务脚本（不参与打包，原样拷贝）
 *
 * 第三方依赖保持 external（node_modules 原样随包），因此打包只消灭「数千次
 * 模块 stat/open/read + 编译」，不改变模块解析语义。
 */
import { existsSync } from "node:fs";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "server");
const outdir = join(serverDir, "dist-bundle");
const workersSrc = join(serverDir, "src", "services", "workers");

const entryPoints = [
  { in: "src/index.ts", out: "index" },
  { in: "src/supervisor-main.ts", out: "supervisor-main" },
  { in: "src/agentic-memory/local-embedding/local-embedding-host.ts", out: "local-embedding-host" },
  { in: "src/runtime-main.ts", out: "runtime-main" },
].map((e) => ({ in: join(serverDir, e.in), out: e.out }));

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  banner: {
    // 部分 CJS 依赖在 ESM 下需要 require；Node 22+ 的 ESM 里没有全局 require。
    js: 'import { createRequire as __nbCreateRequire } from "node:module"; const require = __nbCreateRequire(import.meta.url);',
  },
});

const workersOut = join(outdir, "workers");
mkdirSync(workersOut, { recursive: true });
for (const name of readdirSync(workersSrc)) {
  if (!name.endsWith(".mjs")) continue;
  cpSync(join(workersSrc, name), join(workersOut, name));
}

for (const required of ["index.js", "supervisor-main.js", "local-embedding-host.js"]) {
  if (!existsSync(join(outdir, required))) throw new Error(`打包产物缺失: ${required}`);
}
console.log(`[bundle] 输出 ${outdir}`);
