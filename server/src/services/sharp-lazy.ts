/**
 * sharp（libvips 原生库）懒加载。
 *
 * 只有真正处理图片时才需要它，而图片路径在大多数进程生命周期里根本不触发；
 * 顶层 import 会让 libvips 在启动时就进内存。
 *
 * 默认导出在 ESM interop 下是构造器，而 `typeof import("sharp")` 是模块命名
 * 空间，两者类型不兼容；这里以默认导出的类型为准。
 */
type SharpFactory = (typeof import("sharp"))["default"];

export type SharpInstance = ReturnType<SharpFactory>;

let cached: Promise<SharpFactory> | null = null;

export function loadSharp(): Promise<SharpFactory> {
  return (cached ??= import("sharp").then((m) => m.default));
}
