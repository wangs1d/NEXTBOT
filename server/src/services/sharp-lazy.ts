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

/**
 * 图片解码/编码的并发闸。
 *
 * 单张 2048² RGBA 位图约 16MB，而历史遗留的超大 PNG（几十 MB）解码后可达
 * 200MB+。资料库一屏几十张缩略图并发请求时，若不设闸，峰值内存会瞬间翻几倍，
 * 在 1.4GB 容器里直接触发 OOM kill（比 GC 严重得多）。
 *
 * 只限并发、不丢请求：缩略图生成后会落盘缓存，队列很快排空。
 */
const MAX_CONCURRENT_SHARP_JOBS = 2;
let activeSharpJobs = 0;
const sharpWaiters: Array<() => void> = [];

export async function withSharpDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSharpJobs >= MAX_CONCURRENT_SHARP_JOBS) {
    // 槽位在释放时直接交接（不先减后加），避免交接窗口里被新请求挤进来。
    await new Promise<void>((resolve) => sharpWaiters.push(resolve));
  } else {
    activeSharpJobs += 1;
  }

  try {
    return await fn();
  } finally {
    const next = sharpWaiters.shift();
    if (next) next();
    else activeSharpJobs -= 1;
  }
}
