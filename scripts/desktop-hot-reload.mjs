/**
 * 桌面端 Dart 热重载 —— 改 lib/**.dart 即生效，不用全量构建、不用重启进程。
 *
 * 为什么需要它：
 *   本机 `flutter` 工具完全跑不起来（Dart VM 起子进程报 CreateFile failed 231 /
 *   ERROR_PIPE_BUSY，系统命名管道耗尽），官方 `flutter run -d windows` 那条热重载
 *   路径用不了；而 windows_dist\Debug\NEXTBOT.exe 是编译产物，改完 Dart
 *   代码只能整包重建 + 重启进程（scripts/rebuild-desktop-debug.ps1）。
 *
 * 它怎么做的（自己实现 flutter run 的热重载，链路等价）：
 *   1) debug 版应用启动时引擎会开一个 Dart VM Service（随机端口 + 随机鉴权码），
 *      并把地址打到 stdout。本脚本接管启动，把 stdout 落盘，解析出
 *      `http://127.0.0.1:<port>/<auth>=/`。
 *   2) 改代码后，用 dart-sdk 里的 frontend_server 做增量编译
 *      （--incremental --initialize-from-dill），产出新的 app.dill。基线取
 *      「应用当前真正在跑的 kernel」，保证 library id 与运行中的 isolate 对齐。
 *   3) 通过 VM Service 的 reloadSources RPC 把新 kernel 推给运行中的 isolate
 *      （rootLibUri 指向刚编出来的 dill），再调 ext.flutter.reassemble 让框架重建
 *      widget 树 —— 进程不重启、内存状态不丢、Dart 侧秒级生效。
 *
 * 本机特殊坑（重要）：这台机器的命名管道已耗尽，连 Node 的同步子进程
 *   （child_process.spawnSync）都会 EBUSY。所以本脚本一律用异步 spawn，
 *   不要退回 spawnSync。
 *
 * 边界（与 flutter 官方热重载限制一致）：
 *   - 只覆盖 Dart 代码。native（windows/**、插件原生、pubspec 依赖）改了必须全量
 *     `flutter build windows --debug`，本脚本只提示。
 *   - main() / 顶层初始化器不会重跑；这类改动用 r（重启进程）兜底。
 *   - 热重载被 VM 拒绝时，自动「把最新 kernel 同步进产物 + 重启进程」，改动不丢
 *     （等价旧 rebuild 流程，但不需要重新编译整包）。
 *
 * 用法：
 *   npm run dev:desktop                常驻：改 lib 下 Dart 文件自动热重载
 *   npm run dev:desktop -- --once      只跑一轮（编译 + 热重载）后退出
 *   npm run dev:desktop -- --restart   先重启应用到最新代码，再进常驻
 *   npm run dev:desktop -- --no-launch 只依附已接管的实例（不接管启动）
 *   npm run dev:desktop -- --restore-kernel  把产物 kernel 还原成出厂版本
 *   常驻交互：回车 = 立即热重载，r = 重启应用（保留已有改动），q = 退出
 *
 * 关键保证：脚本启动（非依附）与重启进程前都会先增量编译当前源码再落盘，
 *   所以「脚本没在跑时改的代码」在下次启动/重启时也会生效（重启 = 最新代码）。
 *
 * 产物/状态都在 build/hot-reload/（随 build/ 一起被 git 忽略）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

// ---------------------------------------------------------------- 路径与常量

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'client', 'flutter_app');
const LIB_DIR = path.join(APP_DIR, 'lib');
const DIST_DIR = path.join(ROOT, 'windows_dist', 'Debug');
const EXE = path.join(DIST_DIR, 'NEXTBOT.exe');
/** 应用启动时引擎真正加载的 kernel（相对 exe 目录的 data/flutter_assets）。 */
const BUNDLE_KERNELS = [
  path.join(DIST_DIR, 'data', 'flutter_assets', 'kernel_blob.bin'),
  path.join(APP_DIR, 'build', 'windows', 'x64', 'runner', 'Debug', 'data', 'flutter_assets', 'kernel_blob.bin'),
];
const WORK_DIR = path.join(ROOT, 'build', 'hot-reload');
const STATE_FILE = path.join(WORK_DIR, 'state.json');
const APP_STDOUT = path.join(WORK_DIR, 'app-stdout.log');
const APP_STDERR = path.join(WORK_DIR, 'app-stderr.log');
const DILL = path.join(WORK_DIR, 'app.dill');
const DILL_NEXT = path.join(WORK_DIR, 'app.next.dill');
const DILL_PREV = path.join(WORK_DIR, 'app.prev.dill');
const KERNEL_BACKUP = path.join(WORK_DIR, 'kernel_blob.orig.bin');

const CACHE = 'D:\\Flutter\\bin\\cache';
const PKG_NAME = 'nextbot';
const PROC_NAME = 'NEXTBOT.exe';
const DEBOUNCE_MS = 1200;
const BOOT_TIMEOUT_MS = 45000;
/** 全量 kernel 约 80MB；增量产物低于此值判定编译异常。 */
const MIN_DILL_BYTES = 20 * 1024 * 1024;

const ARGV = process.argv.slice(2);
const OPT = {
  restart: ARGV.includes('--restart'),
  once: ARGV.includes('--once'),
  noLaunch: ARGV.includes('--no-launch'),
  restoreKernel: ARGV.includes('--restore-kernel'),
  help: ARGV.includes('--help') || ARGV.includes('-h'),
};

// ---------------------------------------------------------------- 小工具

const fwd = (p) => p.replace(/\\/g, '/');
const stamp = () => new Date().toLocaleTimeString('sv-SE');
const say = (m) => console.log(`[${stamp()}] [desktop-hot] ${m}`);
const warn = (m) => console.warn(`[${stamp()}] [desktop-hot] ${m}`);
const fail = (m) => console.error(`[${stamp()}] [desktop-hot] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* 不存在即可 */
  }
}

function copyQuiet(from, to) {
  try {
    fs.copyFileSync(from, to);
    return true;
  } catch (e) {
    warn(`复制失败 ${from} -> ${to}：${e.message}`);
    return false;
  }
}

/** 异步跑一个命令并收集输出（本机禁用 spawnSync：命名管道耗尽会 EBUSY）。 */
function run(cmd, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: `${err}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

// ---------------------------------------------------------------- 进程 / 端口

/** NEXTBOT.exe 的全部 pid（主窗、简报、行程等子进程模式共用同一 exe）。 */
async function appPids() {
  const r = await run('tasklist', ['/FI', `IMAGENAME eq ${PROC_NAME}`, '/FO', 'CSV', '/NH'], {
    timeoutMs: 15000,
  });
  if (r.code !== 0 || !r.out) return [];
  return r.out
    .split(/\r?\n/)
    .map((line) => line.match(/"[^"]+","(\d+)"/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
}

/** 某 pid 正在 LISTEN 的本机端口集合（用于把 VM Service URL 认到主进程上）。 */
async function listenPorts(pid) {
  const r = await run('netstat', ['-ano'], { timeoutMs: 20000 });
  if (r.code !== 0 || !r.out) return new Set();
  const ports = new Set();
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (m && Number(m[2]) === pid) ports.add(Number(m[1]));
  }
  return ports;
}

/** 3000 端口（本地 runtime）是否在监听：应用自己会拉起它，这里只做提示。 */
async function backendListening() {
  const r = await run('netstat', ['-ano'], { timeoutMs: 20000 });
  return r.out
    .split(/\r?\n/)
    .some((l) => /LISTENING/.test(l) && /:3000\s/.test(l));
}

async function killApp() {
  const pids = await appPids();
  if (pids.length === 0) return;
  say(`停止应用（pid ${pids.join(', ')}）...`);
  // 注意：不要加 /T。应用会把「本地 runtime（node 起的 3000 服务）」和
  // 「灵动岛/简报等子进程模式（同 exe 再起一份）」都挂在自己名下，
  // /T 会把 runtime 一起带走（应用随后连不上后端、重试耗尽后自杀）。
  // 子进程模式本身就是 NEXTBOT.exe，/IM 已全覆盖。
  await run('taskkill', ['/IM', PROC_NAME, '/F'], { timeoutMs: 20000 });
  for (let i = 0; i < 40; i++) {
    if ((await appPids()).length === 0) return;
    await sleep(200);
  }
  warn('taskkill 后应用仍在，继续尝试接管');
}

function startApp() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const outFd = fs.openSync(APP_STDOUT, 'a');
  const child = spawn(EXE, [], {
    cwd: DIST_DIR,
    env: { ...process.env, PAI_STDERR_LOG: APP_STDERR },
    detached: true,
    stdio: ['ignore', outFd, outFd],
    windowsHide: false,
  });
  child.unref();
  fs.closeSync(outFd);
  return child.pid;
}

/** 从 stdout 日志里取 VM Service URL，优先认到指定 pid 的监听端口上。 */
async function readVmServiceUrl(pid) {
  let text = '';
  try {
    text = fs.readFileSync(APP_STDOUT, 'utf8');
  } catch {
    return null;
  }
  const marker = 'Dart VM service is listening on ';
  const urls = [];
  let i = text.indexOf(marker);
  while (i >= 0) {
    const url = text.slice(i + marker.length).split(/[\s\r\n]+/)[0];
    if (url.startsWith('http://')) urls.push(url);
    i = text.indexOf(marker, i + marker.length);
  }
  if (urls.length === 0) return null;
  if (pid && (await appPids()).includes(pid)) {
    const ports = await listenPorts(pid);
    const hit = urls.find((u) => ports.has(Number(new URL(u).port)));
    if (hit) return hit;
  }
  return urls[urls.length - 1];
}

// ---------------------------------------------------------------- VM Service

class VmClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.ws = null;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { handshakeTimeout: timeoutMs });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('连接 VM Service 超时')), timeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else slot.resolve(msg.result);
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ws.on('close', () => {
        for (const [, slot] of this.pending) slot.reject(new Error('VM Service 连接已关闭'));
        this.pending.clear();
      });
    });
  }

  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++this.seq);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close() {
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const wsOf = (httpUrl) => `${httpUrl.replace('http://', 'ws://')}ws`;

async function probeVm(httpUrl) {
  const client = new VmClient(wsOf(httpUrl));
  try {
    await client.connect(3000);
    await client.rpc('getVM');
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/** Flutter 桌面端根 isolate 名为 main。 */
async function pickIsolate(client) {
  const vm = await client.rpc('getVM');
  if (!vm.isolates || vm.isolates.length === 0) throw new Error('VM 里没有 isolate');
  const main = vm.isolates.find((i) => i.name === 'main') || vm.isolates[0];
  return main.id;
}

// ---------------------------------------------------------------- 增量编译

async function compileTo(outPath, basePath) {
  // frontend_server 不会自建目录：build/ 被清理后首跑会因写不出 outPath 直接
  // PathNotFoundException（exit=255），然后带着旧 kernel 启动。这里先补目录。
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const dartExe = path.join(CACHE, 'dart-sdk', 'bin', 'dartaotruntime.exe');
  const feServer = path.join(CACHE, 'dart-sdk', 'bin', 'snapshots', 'frontend_server_aot.dart.snapshot');
  const sdkRoot = `${fwd(path.join(CACHE, 'artifacts', 'engine', 'common', 'flutter_patched_sdk'))}/`;
  const regFile = path.join(APP_DIR, '.dart_tool', 'flutter_build', 'dart_plugin_registrant.dart');
  const regUri = `file:///${fwd(regFile)}`;

  for (const p of [dartExe, feServer, basePath, regFile]) {
    if (!fs.existsSync(p)) throw new Error(`缺少编译输入：${p}`);
  }

  const args = [
    fwd(feServer),
    '--sdk-root',
    sdkRoot,
    '--target=flutter',
    '--no-print-incremental-dependencies',
    '-Ddart.vm.profile=false',
    '-Ddart.vm.product=false',
    '--enable-asserts',
    '--track-widget-creation',
    '--packages',
    fwd(path.join(APP_DIR, '.dart_tool', 'package_config.json')),
    '--output-dill',
    fwd(outPath),
    '--depfile',
    fwd(`${outPath}.d`),
    '--incremental',
    '--initialize-from-dill',
    fwd(basePath),
    '--source',
    regUri,
    '--source',
    'package:flutter/src/dart_plugin_registrant.dart',
    `-Dflutter.dart_plugin_registrant=${regUri}`,
    '--verbosity=error',
    `package:${PKG_NAME}/main.dart`,
  ];

  const r = await run(dartExe, args, { timeoutMs: 600000 });
  const output = `${r.out}${r.err}`.trim();
  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  return { ok: r.code === 0 && size > MIN_DILL_BYTES, output, size, code: r.code };
}

// ---------------------------------------------------------------- 状态

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(patch) {
  const next = { ...loadState(), ...patch };
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------- 启动 / 重启

/** 把当前增量链的 kernel 同步进产物，让「重启进程」也不会退回旧代码。 */
function shipChainToBundle() {
  if (!fs.existsSync(DILL)) return false;
  const target = BUNDLE_KERNELS[0];
  if (!fs.existsSync(KERNEL_BACKUP) && fs.existsSync(target)) {
    copyQuiet(target, KERNEL_BACKUP);
    say(`已备份出厂 kernel -> ${KERNEL_BACKUP}`);
  }
  for (const p of BUNDLE_KERNELS) {
    if (!fs.existsSync(path.dirname(p))) continue;
    copyQuiet(DILL, p);
  }
  say(`已把最新 kernel 同步进产物（${mb(fs.statSync(DILL).size)}）`);
  return true;
}

function restoreFactoryKernel() {
  if (!fs.existsSync(KERNEL_BACKUP)) {
    warn('没有出厂 kernel 备份，跳过');
    return false;
  }
  for (const p of BUNDLE_KERNELS) {
    if (!fs.existsSync(path.dirname(p))) continue;
    copyQuiet(KERNEL_BACKUP, p);
  }
  unlinkQuiet(DILL);
  saveState({ chainDill: null });
  say('产物 kernel 已还原为出厂版本');
  return true;
}

/** 启动应用并等 VM Service 就绪；failFast 时不抛错而是返回 null。 */
async function launchAndWait({ failFast = false } = {}) {
  unlinkQuiet(APP_STDOUT);
  const pid = startApp();
  say(`已拉起桌面应用 pid=${pid}，等待 VM Service 就绪...`);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(700);
    if (!(await appPids()).includes(pid)) {
      if (failFast) return null;
      throw new Error('应用启动后很快退出，看 build/hot-reload/app-stderr.log');
    }
    const url = await readVmServiceUrl(pid);
    if (url && (await probeVm(url))) {
      say(`VM Service 就绪：${url}`);
      return { pid, url };
    }
  }
  if (failFast) return null;
  throw new Error(`${BOOT_TIMEOUT_MS / 1000}s 内没等到 VM Service，可能启动失败`);
}

/**
 * 重启进程：先增量编译当前源码、再把最新 kernel 同步进产物，保证「重启 = 最新代码」。
 * compile=false 仅用于热重载刚编译完的场合（DILL 已是最新，跳过重复编译）。
 */
async function restartApp({ compile = true } = {}) {
  if (compile) {
    const r = await compileChain('重启前编译');
    if (r !== 'ok') warn('重启前增量编译失败：按上一版 kernel 重启（本次源码改动可能缺失）');
  }
  // 必须先杀再落盘：运行中的 exe 把 kernel_blob.bin 内存映射住，先拷会 UNKNOWN/EPERM。
  await killApp();
  shipChainToBundle();
  await sleep(400);
  if (!(await backendListening())) {
    warn('本地 runtime（127.0.0.1:3000）没在监听：应用启动后会自己拉起，首次可能要等十几秒');
  }
  let launched = await launchAndWait({ failFast: true });
  if (!launched && fs.existsSync(KERNEL_BACKUP)) {
    warn('新 kernel 启动失败，回滚出厂 kernel 再试一次');
    for (const p of BUNDLE_KERNELS) if (fs.existsSync(path.dirname(p))) copyQuiet(KERNEL_BACKUP, p);
    await killApp();
    await sleep(400);
    launched = await launchAndWait({ failFast: true });
  }
  if (!launched) throw new Error('应用重启失败，看 build/hot-reload/app-stderr.log');
  saveState({ appPid: launched.pid, appStartedAt: new Date().toISOString() });
  return launched;
}

// ---------------------------------------------------------------- 一轮热重载

/**
 * 选增量基线：优先上一条增量链产物，否则出厂 kernel（首次）。
 */
function pickBase() {
  const state = loadState();
  const base = state.chainDill && fs.existsSync(state.chainDill) ? state.chainDill : BUNDLE_KERNELS[0];
  if (!fs.existsSync(base)) throw new Error(`找不到增量基线 kernel：${base}`);
  return base;
}

/**
 * 把当前源码增量编译成新链头 DILL（不推送）。
 * 编译产物即时转正并记入状态：即使后续推送/重启失败，
 * 下一次重启 ship 到产物里的也是这份最新 kernel。
 * @returns {'ok'|'compile-error'}
 */
async function compileChain(reason) {
  const base = pickBase();
  if (base === BUNDLE_KERNELS[0]) say(`增量基线 = 应用启动 kernel（${mb(fs.statSync(base).size)}）`);

  const t0 = Date.now();
  unlinkQuiet(DILL_NEXT);
  const res = await compileTo(DILL_NEXT, base);
  if (!res.ok) {
    unlinkQuiet(DILL_NEXT);
    fail(`增量编译失败（exit=${res.code}），保留上一版 kernel`);
    if (res.output) console.error(res.output.split(/\r?\n/).slice(0, 40).join('\n'));
    return 'compile-error';
  }
  if (fs.existsSync(DILL)) copyQuiet(DILL, DILL_PREV);
  fs.renameSync(DILL_NEXT, DILL);
  saveState({ chainDill: DILL });
  say(`增量编译完成 ${mb(res.size)}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s（触发：${reason}）`);
  return 'ok';
}

/**
 * 增量编译 + 推送 VM Service。
 * @returns {'ok'|'compile-error'|'rejected'}
 */
async function hotReloadOnce(url, reason) {
  const compiled = await compileChain(reason);
  if (compiled !== 'ok') return compiled;

  const client = new VmClient(wsOf(url));
  try {
    await client.connect();
    const isolateId = await pickIsolate(client);
    const t1 = Date.now();
    const report = await client.rpc('reloadSources', {
      isolateId,
      rootLibUri: `file:///${fwd(DILL)}`,
      pause: false,
    });
    const details = report.details || {};
    if (!report.success) {
      const notices = (report.notices || []).map((n) => `  - [${n.severity || '?'}] ${n.message}`).join('\n');
      warn(`VM 拒绝本次热重载${notices ? `：\n${notices}` : ''}`);
      return 'rejected';
    }
    say(
      `热重载成功：${details.loadedLibraryCount ?? '?'}/${details.finalLibraryCount ?? '?'} 个库，` +
        `VM 用时 ${Date.now() - t1}ms`,
    );
    try {
      await client.rpc('ext.flutter.reassemble', { isolateId });
    } catch (e) {
      warn(`reassemble 调用失败（界面可能没立刻刷新）：${e.message}`);
    }
    saveState({ lastReloadAt: new Date().toISOString() });
    return 'ok';
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------- 主流程

function printHelp() {
  console.log(`桌面端 Dart 热重载 —— 改 lib/**.dart 免重建、免重启

  npm run dev:desktop                      常驻监听（改文件自动热重载）
  npm run dev:desktop -- --once            只跑一轮编译 + 热重载
  npm run dev:desktop -- --restart         先把应用重启到最新代码，再常驻
  npm run dev:desktop -- --no-launch       只依附已接管的实例
  npm run dev:desktop -- --restore-kernel  产物 kernel 还原为出厂版本
  常驻交互：回车=立即热重载  r=重启应用（保留改动）  q=退出

产物与状态：build/hot-reload/（随 build/ 忽略）
启动/重启前会先增量编译当前源码：脚本没跑时改过的代码也会生效。
注意：native / pubspec 改动仍需全量 flutter build windows --debug。`);
}

async function main() {
  if (OPT.help) return printHelp();
  if (OPT.restoreKernel) return void restoreFactoryKernel();
  if (!fs.existsSync(EXE)) throw new Error(`找不到桌面应用：${EXE}`);
  if (!fs.existsSync(LIB_DIR)) throw new Error(`找不到客户端源码：${LIB_DIR}`);
  if (!fs.existsSync(BUNDLE_KERNELS[0])) throw new Error(`找不到 ${BUNDLE_KERNELS[0]}`);

  let url = null;
  const state = loadState();
  const pids = await appPids();
  const adopted = !OPT.restart && state.appPid && pids.includes(state.appPid);

  if (adopted) {
    const cached = await readVmServiceUrl(state.appPid);
    if (cached && (await probeVm(cached))) {
      url = cached;
      say(`依附已接管的实例 pid=${state.appPid}（${url}）`);
    }
  }
  if (!url && OPT.noLaunch) {
    throw new Error('只想依附、但没找到可用的已接管实例；去掉 --no-launch 让脚本接管启动');
  }
  if (!url) {
    if (pids.length > 0) say('检测到应用在跑但不是本脚本接管的（拿不到 VM Service 地址），先停掉重开');
    const launched = await restartApp();
    url = launched.url;
  }

  if (OPT.once) {
    const r = await hotReloadOnce(url, '手动 --once');
    process.exit(r === 'ok' ? 0 : 1);
  }

  // ---------------- 常驻：watcher + 交互 ----------------
  let running = false;
  let queued = false;
  let debounce = null;
  let lastReloadStart = 0;

  async function runOnce(reason) {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    lastReloadStart = Date.now();
    try {
      const r = await hotReloadOnce(url, reason);
      if (r === 'rejected') {
        warn('热重载被拒 -> 把最新 kernel 同步进产物并重启进程（改动不会丢）');
        const launched = await restartApp({ compile: false });
        url = launched.url;
      }
    } catch (e) {
      fail(`热重载异常：${e.message}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        runOnce('补充轮');
      }
    }
  }

  fs.watch(LIB_DIR, { recursive: true }, (_evt, file) => {
    if (!file) return;
    const f = String(file).replace(/\\/g, '/');
    if (f.endsWith('~') || f.startsWith('.')) return;
    // 编辑器一次保存常连发多个事件、且可能是编译期间才派发到的旧事件：
    // mtime 早于本轮编译开始的直接丢掉，避免白跑一轮 3s 增量编译。
    try {
      if (fs.statSync(path.join(LIB_DIR, f)).mtimeMs < lastReloadStart) return;
    } catch {
      /* 文件刚被删除/改名：照常触发 */
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => runOnce(f), DEBOUNCE_MS);
  });

  // native / pubspec 改动热重载救不了，只提示（这两处经常有构建产物抖动，
  // 所以按扩展名过滤 + 10s 去重，避免刷屏）。
  let lastNativeHint = 0;
  const hintNative = (what) => {
    if (Date.now() - lastNativeHint < 10000) return;
    lastNativeHint = Date.now();
    warn(`${what} 变了：需要全量 flutter build windows --debug，热重载救不了`);
  };
  const NATIVE_FILE = /\.(cpp|cc|cxx|h|hpp|rc|ico)$/i;
  for (const dir of [
    path.join(APP_DIR, 'windows'),
    path.join(APP_DIR, 'windows', 'runner'),
    path.join(APP_DIR, 'windows', 'runner', 'resources'),
  ]) {
    try {
      fs.watch(dir, (_evt, file) => {
        const f = String(file || '');
        if (!NATIVE_FILE.test(f) && !/^CMakeLists\.txt$/i.test(f)) return;
        hintNative(`windows/${f}`);
      });
    } catch {
      /* 目录不存在时忽略 */
    }
  }
  try {
    fs.watch(path.join(APP_DIR, 'pubspec.yaml'), () => hintNative('pubspec.yaml'));
  } catch {
    /* 忽略 */
  }

  say(`监听 ${LIB_DIR} —— 改 Dart 文件即热重载；回车=立即重载，r=重启应用，q=退出`);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', async (chunk) => {
    const cmd = String(chunk).trim().toLowerCase();
    if (cmd === 'q') process.exit(0);
    if (cmd === 'r') {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        const launched = await restartApp();
        url = launched.url;
      } catch (e) {
        fail(`重启失败：${e.message}`);
      } finally {
        running = false;
      }
      return;
    }
    runOnce('手动');
  });
  setInterval(() => {}, 2 ** 31 - 1);
}

main().catch((e) => {
  fail(e.message);
  process.exit(1);
});
