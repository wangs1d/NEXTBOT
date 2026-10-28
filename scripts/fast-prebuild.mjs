/**
 * server 依赖包（agent-world / agent-protocol / picture）快速预构建。
 * 取代原 predev:server 的串行 4 遍 tsc（agent-world 还被构建两遍）：
 * - 源码 mtime 不新于 dist 时整包跳过 —— 开机自启无代码改动时走最快路径
 * - 确实需要重建的包并行执行 tsc（直接调根目录 typescript，免 npm/npx 开销）
 * 任一构建失败以非零码退出，交由上游 npm 链 / autostart 退避层感知。
 * 用法：node scripts/fast-prebuild.mjs（server 的 predev:server 钩子调用）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = path.join(REPO, "node_modules", "typescript", "bin", "tsc");

// 各包源码扫描范围须与各自 tsconfig.build.json 的 include/exclude 语义一致：
// agent-world 源码平铺在包根目录（include ./**/*.ts），其余两个包是标准 src/ 布局
const PACKAGES = [
  {
    name: "@nextbot/agent-world",
    dir: "agent-world",
    tsconfig: "tsconfig.build.json",
    srcRoots: ["."],
    pruneDirs: new Set(["node_modules", "dist", "standalone", "tests", ".git"]),
    testFilePattern: /\.test\.ts$/,
  },
  {
    name: "@nextbot/agent-protocol",
    dir: path.join("packages", "agent-protocol"),
    tsconfig: "tsconfig.build.json",
    srcRoots: ["src"],
  },
  {
    name: "@nextbot/picture",
    dir: path.join("packages", "picture"),
    tsconfig: "tsconfig.build.json",
    srcRoots: ["src"],
  },
];

/** 递归收集目录下（剪枝 pruneDirs）最新的 .ts / .json(tsconfig) 文件 mtime */
function newestMtime(dir, pruneDirs, testFilePattern) {
  let newest = 0;
  const walk = (cur) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (pruneDirs.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const isTs = entry.name.endsWith(".ts") || /^tsconfig.*\.json$/.test(entry.name);
        if (!isTs) continue;
        if (testFilePattern && testFilePattern.test(entry.name)) continue;
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          /* 文件恰好被删，忽略 */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

function newestDistMtime(distDir) {
  let newest = 0;
  const walk = (cur) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          /* 同上 */
        }
      }
    }
  };
  walk(distDir);
  return newest;
}

function buildPackage(pkg) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [TSC, "-p", path.join(REPO, pkg.dir, pkg.tsconfig), "--pretty", "false"],
      { cwd: path.join(REPO, pkg.dir), stdio: "inherit", windowsHide: true },
    );
    child.once("exit", (code) => resolve({ pkg, code, elapsed: Date.now() - startedAt }));
    child.once("error", (err) => {
      console.error(`[${pkg.name}] tsc 启动失败：${err.message}`);
      resolve({ pkg, code: 1, elapsed: Date.now() - startedAt });
    });
  });
}

const results = await Promise.all(
  PACKAGES.map(async (pkg) => {
    const pkgDir = path.join(REPO, pkg.dir);
    const distDir = path.join(pkgDir, "dist");
    const pruneDirs = pkg.pruneDirs ?? new Set(["node_modules", "dist", "test", ".git"]);
    const srcNewest = Math.max(...pkg.srcRoots.map((r) => newestMtime(path.join(pkgDir, r), pruneDirs, pkg.testFilePattern)));
    const distNewest = newestDistMtime(distDir);
    if (srcNewest === 0 || (srcNewest <= distNewest)) {
      return { pkg, code: 0, skipped: true, elapsed: 0 };
    }
    console.log(`[fast-prebuild] ${pkg.name} 源码有更新，重新构建…`);
    const r = await buildPackage(pkg);
    if (r.code === 0) console.log(`[fast-prebuild] ${pkg.name} 构建完成（${(r.elapsed / 1000).toFixed(1)}s）`);
    return r;
  }),
);

for (const r of results) {
  if (r.skipped) console.log(`[fast-prebuild] ${r.pkg.name} 已是最新，跳过`);
}

if (results.some((r) => r.code !== 0)) {
  console.error("[fast-prebuild] 存在构建失败，退出");
  process.exit(1);
}
