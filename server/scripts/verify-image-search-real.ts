/**
 * 真实图片搜索端到端验证（2026-11-08）。
 *
 * 与单元测试不同，这里不 mock：真实请求 Bing 图片页 → 真实下载远程图 →
 * sharp 转 PNG 落盘 → 由运行中的 :3000 服务把 /agent/images/... 拉回来，
 * 校验 HTTP 200 + PNG magic。断言任一 query 拿不到可访问图片即失败退出。
 *
 * 运行：cd server && node --import tsx scripts/verify-image-search-real.ts
 */
import assert from "node:assert/strict";
import { copyFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), override: true });

const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
const { ImageGenerationService } = await import("../src/services/image-generation-service.js");
const { getDataDir } = await import("../src/config/data-dir.js");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE = "http://127.0.0.1:3000";
const ACTOR = "verify-real-image";
const storage = new ImageGenerationService();
const service = new UpstreamSearchService({} as never);
service.setImageStorageService(storage);

const queries = [
  "卢昱晓 红毯礼服 时尚大片 写真", // 事故复现：长改写 query
  "卢昱晓",                        // 对照：短核心词
  "灯塔 风景",                    // 对照：中性景物
];

let failures = 0;
let firstImagePath: string | null = null;

for (const query of queries) {
  const started = Date.now();
  const res = await service.searchImages(query, 4, ACTOR);
  const ms = Date.now() - started;
  console.log(`\n=== query="${query}" ===`);
  console.log(`provider=${res.provider} items=${res.items.length} ${ms}ms`);
  for (const n of res.notes) console.log(`  note: ${n}`);

  try {
    assert.ok(res.items.length > 0, "必须至少拿到 1 张图片");
  } catch (e) {
    failures += 1;
    console.log(`  FAIL ${(e as Error).message}`);
    continue;
  }

  for (const [idx, item] of res.items.entries()) {
    const url = item.mediaUrl ?? "";
    let line = `  [${idx + 1}] ${item.title.slice(0, 46)} | ${url}`;
    try {
      assert.ok(url.startsWith("/agent/images/"), "mediaUrl 必须是本地转存路径");
      const rel = url.slice("/agent/images/".length);
      const [actor, file, ...extra] = rel.split("/");
      assert.equal(extra.length, 0, "本地图片路径必须只有 actor/file 两层");
      const full = resolve(getDataDir(), "images", actor!, file!);
      const s = await stat(full);
      const buf = await readFile(full);
      assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), "落盘文件必须是 PNG");
      const http = await fetch(`${BASE}${url}`);
      const bytes = Buffer.from(await http.arrayBuffer());
      assert.equal(http.status, 200, "运行中的服务必须能供图");
      assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC), "HTTP 返回必须是 PNG");
      assert.equal(bytes.length, s.size, "HTTP 字节数应与落盘一致");
      line += ` | disk=${s.size}B http=200 png=ok`;
      if (!firstImagePath) {
        firstImagePath = full;
        await copyFile(full, resolve(process.cwd(), "../.scratch/verify-image-first.png"));
      }
    } catch (e) {
      failures += 1;
      line += ` | FAIL ${(e as Error).message}`;
    }
    console.log(line);
  }
}

console.log(`\nfirst image: ${firstImagePath ?? "none"}`);
console.log(failures === 0 ? "VERIFY-PASS: 所有 query 都拿到了真实可访问的图片" : `VERIFY-FAIL: ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
