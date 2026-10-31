/**
 * 服务根目录：含 dist / node_modules / models / data 的那一层。
 *
 * 三种布局下相对深度一致，因此同一套相对路径都成立：
 *   server/src/config/paths.ts     （开发态 tsx）
 *   server/dist/config/paths.js    （未打包构建）
 *   server/dist/bundle/index.js    （esbuild 单文件）
 * 打包后 import.meta.url 指向 bundle 入口，任何按"自己的子目录深度"推算的资源路径
 * 都会错一层，所以统一从这里取根。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
