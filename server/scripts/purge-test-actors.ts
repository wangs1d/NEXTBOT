/**
 * 测试数据清理（2026-11-12 建，2026-11-14 扩展覆盖面 + 统一数据根）
 *
 * 生产数据里混进了大量 `e2e-*` / `probe-*` / `eval-*` / `leak-probe-*` 测试数据：
 * 实测 KV 395 个 session 中 378 个是测试，STM 603 个中 508 个是测试，
 * user_profiles 453 个目录里 451 个是测试，账号表 11 个账号里 9 个是测试。
 * 它们既占体积，也让"某条记忆为什么变多"无法归因，还污染管理后台用户列表。
 *
 * 覆盖面（全部走同一份 TEST_ACTOR_RE 判定）：
 *   - agent-memory-sync.json       KV sessions
 *   - short-term-task-stack.json   episodic / sessions / episodicIdx / loopFirstSeen
 *   - agent-accounts.json          注册账号（管理后台用户列表数据源）
 *   - user_profiles/               用户画像目录
 *
 * 数据根：loadServerEnv() + getDataDir()——与运行期服务同根（.env.local 的
 * NEXTBOT_DATA_DIR 优先），不再依赖 cwd/data 相对路径（2026-10-24 统一数据根后
 * cwd/data 只剩旧根残留，清理会清错地方）。
 *
 * 做法：**先隔离再删除**——命中的数据原样导出到
 * `data/_quarantine/test-actors-<date>.json`（目录则整体搬进去），再从生产文件移除。
 *
 * 注意：server 进程内存里持有账号表/记忆的完整快照，运行期跑本脚本会被下次
 * persist 覆盖回去——**先停 server 再跑**。
 *
 * 运行：cd server && npx tsx scripts/purge-test-actors.ts [--apply]
 */
import fs from "node:fs";
import path from "node:path";

import { loadServerEnv } from "../src/config/load-server-env.js";
import { getDataDir } from "../src/config/data-dir.js";

loadServerEnv();
const APPLY = process.argv.includes("--apply");
const DATA = getDataDir();
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const TEST_ACTOR_RE = /(^|[-_])(e2e|probe|leak|eval-acc|gui|dbg|mem50|test|restart-check)/i;
/** 压测/验收探针留下的目录名（perf-1、verify-images-*、smoke-booking-user 等） */
const TEST_DIR_RE = /^(perf[-_]|verify[-_]|smoke[-_]|session-mvp|profile-(battery|uv))/i;

function isTestActor(id: string): boolean {
  return TEST_ACTOR_RE.test(id) || /^(e2e|probe|leak)/i.test(id);
}
function isTestProfileDir(name: string): boolean {
  return isTestActor(name) || TEST_DIR_RE.test(name);
}

const quarantineDir = path.join(DATA, "_quarantine");
const quarantineFile = path.join(quarantineDir, `test-actors-${STAMP}.json`);

// —— 1. 记忆文件（KV + STM）——
const kvPath = path.join(DATA, "agent-memory-sync.json");
const stmPath = path.join(DATA, "short-term-task-stack.json");

const kv = JSON.parse(fs.readFileSync(kvPath, "utf8")) as { sessions: Record<string, unknown> };
const stm = fs.existsSync(stmPath)
  ? (JSON.parse(fs.readFileSync(stmPath, "utf8")) as {
      episodic?: Record<string, unknown>;
      sessions?: Record<string, unknown>;
      episodicIdx?: Record<string, unknown>;
      loopFirstSeen?: Record<string, unknown>;
    })
  : null;

const kvTest = Object.keys(kv.sessions ?? {}).filter(isTestActor);
const stmEpisodicTest = Object.keys(stm?.episodic ?? {}).filter(isTestActor);
const stmSessionTest = Object.keys(stm?.sessions ?? {}).filter(isTestActor);

// —— 2. 账号表（管理后台用户列表数据源）——
const accountsPath = path.join(DATA, "agent-accounts.json");
const accountsData = JSON.parse(fs.readFileSync(accountsPath, "utf8")) as {
  accounts?: { userId: string; [k: string]: unknown }[];
};
const accountsTest = (accountsData.accounts ?? []).filter((a) => isTestActor(a.userId));

// —— 3. user_profiles 目录 ——
const profilesRoot = path.join(DATA, "user_profiles");
const profilesTest = fs.existsSync(profilesRoot)
  ? fs
      .readdirSync(profilesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isTestProfileDir(e.name))
      .map((e) => e.name)
  : [];

console.log(`模式：${APPLY ? "APPLY" : "DRY-RUN"}　数据根：${DATA}`);
console.log(`KV sessions: ${Object.keys(kv.sessions ?? {}).length} → 测试账号 ${kvTest.length}`);
console.log(`STM episodic: ${Object.keys(stm?.episodic ?? {}).length} → 测试账号 ${stmEpisodicTest.length}`);
console.log(`STM sessions: ${Object.keys(stm?.sessions ?? {}).length} → 测试账号 ${stmSessionTest.length}`);
console.log(`账号表: ${(accountsData.accounts ?? []).length} → 测试账号 ${accountsTest.length}（${accountsTest.map((a) => a.userId).slice(0, 5).join(", ")}${accountsTest.length > 5 ? " …" : ""}）`);
console.log(`user_profiles: 测试目录 ${profilesTest.length}（示例：${profilesTest.slice(0, 5).join(", ")}）`);

if (!APPLY) {
  console.log("\n加 --apply 执行（会先隔离到 data/_quarantine/，目录整体搬入不销毁）。");
  process.exit(0);
}

fs.mkdirSync(quarantineDir, { recursive: true });
const quarantine: Record<string, unknown> = {
  exportedAt: new Date().toISOString(),
  dataRoot: DATA,
  kvSessions: Object.fromEntries(kvTest.map((id) => [id, kv.sessions[id]])),
  stmEpisodic: Object.fromEntries(stmEpisodicTest.map((id) => [id, stm?.episodic?.[id]])),
  stmSessions: Object.fromEntries(stmSessionTest.map((id) => [id, stm?.sessions?.[id]])),
  accounts: accountsTest,
  profileDirs: profilesTest,
};
fs.writeFileSync(quarantineFile, JSON.stringify(quarantine, null, 2), "utf8");

for (const id of kvTest) delete kv.sessions[id];
fs.writeFileSync(kvPath, JSON.stringify(kv), "utf8");

let stmIdxRemoved = 0;
if (stm) {
  for (const id of stmEpisodicTest) delete stm.episodic?.[id];
  for (const id of stmSessionTest) delete stm.sessions?.[id];
  // 索引类键按自身 key 判定（loopFirstSeen/episodicIdx 里有不在 KV/STM 会话里的残留，
  // 如 debug-photo-probe——只按 kvTest 联动删会漏）
  const idxTestIds = [
    ...new Set([
      ...kvTest,
      ...stmEpisodicTest,
      ...stmSessionTest,
      ...Object.keys(stm.episodicIdx ?? {}).filter(isTestActor),
      ...Object.keys(stm.loopFirstSeen ?? {}).filter(isTestActor),
    ]),
  ];
  for (const id of idxTestIds) {
    delete stm.episodicIdx?.[id];
    delete stm.loopFirstSeen?.[id];
  }
  stmIdxRemoved = idxTestIds.length;
  fs.writeFileSync(stmPath, JSON.stringify(stm), "utf8");
}

if (accountsTest.length > 0) {
  accountsData.accounts = (accountsData.accounts ?? []).filter((a) => !isTestActor(a.userId));
  fs.writeFileSync(accountsPath, JSON.stringify(accountsData, null, 2), "utf8");
}

let movedDirs = 0;
for (const name of profilesTest) {
  const dest = path.join(quarantineDir, "user_profiles", name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(path.join(profilesRoot, name), dest);
  movedDirs++;
}

console.log(`\n已隔离 → ${quarantineFile}`);
console.log(
  `已从生产文件移除：KV ${kvTest.length} / STM ${stmEpisodicTest.length + stmSessionTest.length}（含索引 ${stmIdxRemoved}）/ 账号 ${accountsTest.length} / 画像目录 ${movedDirs}`,
);
