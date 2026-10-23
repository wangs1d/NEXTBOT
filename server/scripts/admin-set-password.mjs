// 管理后台密码重置 CLI（锁死自救用）。
//
// 用法（在 server 目录下运行，data/admin-auth.db 按 cwd 解析）：
//   本地:  node scripts/admin-set-password.mjs
//   ECS:   该脚本随 deploy-ecs.ps1 的 tarball 分发到 /opt/nextbot/server/scripts，
//          ssh 上去后: cd /opt/nextbot/server && node scripts/admin-set-password.mjs
//   非交互: --user <账号> --password <新密码>（会留在 shell 历史，谨慎使用）
//
// 重置会清空全部会话（所有已登录立即失效）。scrypt 参数与
// src/routes/http/admin-session-auth.ts 保持一致，改那边记得同步这里。

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";

import Database from "better-sqlite3";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--user") out.user = argv[++i];
    else if (argv[i] === "--password") out.password = argv[++i];
  }
  return out;
}

/** 隐藏输入（TTY 原始模式逐键读取，回显 *）；非 TTY 退回普通输入。 */
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
      return;
    }
    process.stdout.write(question);
    const chars = [];
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (str, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolve(chars.join(""));
        return;
      }
      if (key.name === "backspace") {
        chars.pop();
        process.stdout.write("\b \b");
        return;
      }
      if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
        chars.push(str);
        process.stdout.write("*");
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onData);
    };
    process.stdin.on("keypress", onData);
  });
}

function askVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

const args = parseArgs(process.argv.slice(2));

const dbPath = process.env.ADMIN_AUTH_DB?.trim() || join(process.cwd(), "data", "admin-auth.db");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_auth (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    username   TEXT NOT NULL,
    pwhash     TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash   TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
`);

const current = db.prepare("SELECT username FROM admin_auth WHERE id = 1").get();
console.log(`管理后台密码重置 → ${dbPath}${current ? `（当前账号: ${current.username}）` : "（尚未初始化）"}`);

const username = (args.user || (await askVisible(`账号 [${current?.username ?? "admin"}]: `)) || current?.username || "admin").trim();
if (username.length < 3 || username.length > 32) {
  console.error("账号需 3-32 位");
  process.exit(1);
}

let password = args.password;
if (!password) {
  password = await askHidden("新密码（至少 8 位，输入不回显）: ");
  if (password.length < 8) {
    console.error("密码至少 8 位");
    process.exit(1);
  }
  const again = await askHidden("再输一遍: ");
  if (again !== password) {
    console.error("两次输入不一致");
    process.exit(1);
  }
}
if (password.length < 8 || password.length > 128) {
  console.error("密码需 8-128 位");
  process.exit(1);
}

const now = new Date().toISOString();
db.prepare(`
  INSERT INTO admin_auth (id, username, pwhash, updated_at) VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET username = excluded.username, pwhash = excluded.pwhash, updated_at = excluded.updated_at
`).run(username, hashPassword(password), now);
const removed = db.prepare("DELETE FROM admin_sessions").run();
console.log(`已重置: 账号 ${username}；已吊销 ${removed.changes} 个会话（全部需重新登录）。`);
db.close();
