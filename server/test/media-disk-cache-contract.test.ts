import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 媒体磁盘缓存契约（源码级）测试。
 *
 * ⚠️ 口径（2026-10-13 定稿）：客户端一切「网络 URL → 图片展示」必须走
 * `CachedMediaImage`（media_disk_cache.dart，磁盘缓存落盘 + 内存解码），
 * 禁止业务代码直接裸用 `Image.network` / `NetworkImage`——它们只有进程内
 * 存缓存，重启即空，是「预加载做了但每次进入仍要等图」事故的根因。
 *
 * 白名单（唯一豁免点）：
 * - media_disk_cache.dart 内部的 `_networkImage` 回退分支（磁盘层故障时兜底直连）；
 * - travel_image_warmer.dart 的解码预热器（同会话内存预热，与磁盘缓存双轨互补）。
 *
 * 为什么锁源码而不是锁运行时：本机 `flutter test` 不可用（管道耗尽），
 * 服务端测试直接读客户端源码做静态断言——项目既有契约锁法，
 * 改坏必挂 `cd server && node --import tsx --test`。
 */

const CLIENT_LIB = join(import.meta.dirname, "../../client/flutter_app/lib");

/** 递归收集 lib 下全部 .dart 文件（绝对路径）。 */
function listDartFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listDartFiles(full));
    else if (entry.name.endsWith(".dart")) out.push(full);
  }
  return out;
}

const dartFiles = listDartFiles(CLIENT_LIB).map((full) => ({
  full,
  rel: full.slice(CLIENT_LIB.length + 1).replaceAll("\\", "/"),
  src: readFileSync(full, "utf8"),
}));

test("业务代码禁止裸用 Image.network（唯一豁免：media_disk_cache.dart 内部回退）", () => {
  const offenders = dartFiles.filter(
    (f) => f.rel !== "features/chat/media_disk_cache.dart" && f.src.includes("Image.network("),
  );
  assert.deepEqual(
    offenders.map((f) => f.rel),
    [],
    "发现裸 Image.network：请改用 CachedMediaImage（磁盘缓存，重启不丢）。" +
      "若确属新豁免场景，需在本测试与 media_disk_cache.dart 头注释同步登记理由。",
  );
});

test("业务代码禁止裸用 NetworkImage（唯一豁免：travel_image_warmer.dart 解码预热）", () => {
  const offenders = dartFiles.filter(
    (f) => f.rel !== "features/chat/travel_image_warmer.dart" && f.src.includes("NetworkImage("),
  );
  assert.deepEqual(
    offenders.map((f) => f.rel),
    [],
    "发现裸 NetworkImage：预热请走 MediaDiskCache.instance.warm（落盘持久），" +
      "内存解码预热统一收敛在 TravelImageWarmer。",
  );
});

test("契约依赖在位：CachedMediaImage 组件与 MediaDiskCache.warm 预热入口存在", () => {
  const diskCache =
    dartFiles.find((f) => f.rel === "features/chat/media_disk_cache.dart")?.src ?? "";
  assert.ok(diskCache.includes("class CachedMediaImage"), "CachedMediaImage 组件必须存在");
  assert.ok(diskCache.includes("void warm("), "MediaDiskCache.warm 预热入口必须存在");
  assert.ok(
    diskCache.includes("class MediaDiskCache"),
    "MediaDiskCache 磁盘缓存实现必须存在",
  );
});
