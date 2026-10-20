// 文件系统感知传感器（file_watcher）—— "用户拿到了什么文件"的实感来源。
//
// 数据链路：fs.watch（Windows/macOS 递归监听）捕获目录事件 → 队列缓冲 →
// SensorKernel 按 pollInterval 排水 → 指纹去重后产出 Signal。
// 与逐事件推送相比，经内核排水有两点好处：沿用统一的熔断/健康记账/落盘
// 环形日志；一次批量下载（浏览器分片落盘）收敛为少量低显著性信号。
//
// 隐私边界：信号只含文件名/扩展名/大小/动作，绝不读文件内容；预览类需求
// 由上层显式调用 readDocument 类工具（用户可见的工具调用），传感层不偷看。
//
// 目录来源：AGENT_FILE_WATCH_DIRS（分号/逗号分隔，env 优先）；缺省监听
// 用户下载目录。目录不可达时 collect 抛错 → 内核熔断记健康，恢复后自动半开。
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProactiveSensor, Signal } from "./types.js";

/** 排水轮询间隔（fs.watch 是推式，这里只是批量排水节奏） */
export const FILE_WATCH_POLL_MS = 30_000;
/** 单次排水上限（防大目录批量变化刷屏；超出部分下次排水继续） */
const MAX_SIGNALS_PER_COLLECT = 20;
/** 忽略的临时/中间文件后缀（浏览器下载中间态） */
const IGNORED_SUFFIXES = [".crdownload", ".part", ".tmp", ".partial", "!ut"];
/**
 * 忽略的系统文件名（小写比对，2026-10-20）：desktop.ini/缩略图缓存/NT 用户配置
 * 等由系统反复触碰，产生零信息量信号刷满环形日志（真实运行数据 signals.jsonl
 * 里 file 流 95% 是 desktop.ini），挤占排水名额且污染信号流。
 */
const IGNORED_FILENAMES = new Set(["desktop.ini", "thumbs.db", ".ds_store", "shellclasscache"]);
/** Office/下载临时文件前缀（~$ 开头） */
const IGNORED_FILENAME_PREFIXES = ["~$", "ntuser.dat"];
/** 队列上限（内核长时间不可用时丢弃最旧事件，防内存膨胀） */
const QUEUE_CAP = 200;

export type FileWatchEventKind = "added" | "changed";

type QueuedEvent = {
  dir: string;
  file: string;
  kind: FileWatchEventKind;
  at: number;
};

/** 解析监听目录清单（env 优先；缺省下载目录；去重 + 展开为绝对路径）。 */
export function resolveWatchDirs(envValue: string | undefined, home: string): string[] {
  const raw = envValue?.trim();
  const source = raw
    ? raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
    : [join(home, "Downloads")];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of source) {
    const abs = dir.startsWith("~") ? join(home, dir.slice(1)) : dir;
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

export type FileWatcherSensorOptions = {
  /** 监听目录（绝对路径）；缺省取 resolveWatchDirs(env, home) */
  dirs?: string[];
  pollIntervalMs?: number;
  nowFn?: () => number;
};

export class FileWatcherSensor implements ProactiveSensor {
  readonly id = "file_watcher";
  readonly stream = "file" as const;
  readonly pollIntervalMs: number;
  private readonly dirs: string[];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly queue: QueuedEvent[] = [];
  private readonly nowFn: () => number;
  private started = false;

  constructor(private readonly opts: FileWatcherSensorOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? FILE_WATCH_POLL_MS;
    this.dirs = opts.dirs ?? resolveWatchDirs(process.env.AGENT_FILE_WATCH_DIRS, homedir());
    this.nowFn = opts.nowFn ?? Date.now;
  }

  /** 惰性启动监听（内核首次 collect 时触发；目录不可达不致命，逐目录尽力）。 */
  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (const dir of this.dirs) {
      try {
        const watcher = watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const file = String(filename);
          const lower = file.toLowerCase();
          if (IGNORED_SUFFIXES.some((s) => lower.endsWith(s))) return;
          const base = lower.split(/[\\/]/).pop() ?? lower;
          if (IGNORED_FILENAMES.has(base)) return;
          if (IGNORED_FILENAME_PREFIXES.some((p) => base.startsWith(p))) return;
          this.queue.push({ dir, file, kind: "added", at: this.nowFn() });
          if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP);
        });
        watcher.on("error", () => watchersCleanup(this.watchers, dir));
        this.watchers.set(dir, watcher);
      } catch {
        /* 目录不可达：留给 collect 抛错触发内核熔断，恢复后半开重试 */
      }
    }
    if (this.watchers.size === 0) {
      throw new Error(`no_watch_dirs_available:${this.dirs.join(",")}`);
    }
  }

  /** 排水：队列 → 去重信号（同文件同动作在窗口内收敛为一条）。 */
  async collect(_since: number): Promise<Signal[]> {
    this.ensureStarted();
    if (this.queue.length === 0) return [];
    const drained = this.queue.splice(0, this.queue.length);
    const signals: Signal[] = [];
    const seen = new Set<string>();
    for (const ev of drained) {
      const fingerprint = `file:${ev.dir}:${ev.file}`;
      if (seen.has(fingerprint)) continue; // 同文件多次事件收敛为一条
      seen.add(fingerprint);
      signals.push({
        stream: this.stream,
        at: ev.at,
        fingerprint: `${fingerprint}:${Math.floor(ev.at / 60_000)}`,
        salience: "low",
        delta: `文件更新：${ev.file}（${shortDir(ev.dir)}）`,
        payload: { dir: ev.dir, name: ev.file, kind: ev.kind },
      });
      if (signals.length >= MAX_SIGNALS_PER_COLLECT) break;
    }
    return signals;
  }

  /** @internal 测试/停机：关闭全部 watcher */
  dispose(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.queue.length = 0;
    this.started = false;
  }
}

function watchersCleanup(map: Map<string, FSWatcher>, dir: string): void {
  map.get(dir)?.close();
  map.delete(dir);
}

function shortDir(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.slice(-1)[0] ?? dir;
}
