#!/usr/bin/env node
/**
 * 校验「用户保留的 #1 diana / #6 anna / #2 alex」三个声音：
 *   试听板内嵌 base64 → data/tts_samples → APK assets → A/B 页内嵌 base64 逐字一致，
 *   且都过服务端 mp3 质量门禁、端侧 Kotlin/Dart 接线齐全。
 *
 * 运行（需要 tsx 加载 voice-quality.ts）：
 *   node --import tsx scripts/verify-builtin-voices.mjs
 *   node --import tsx scripts/verify-builtin-voices.mjs --apk client/flutter_app/build/app/outputs/flutter-apk/app-release.apk
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMp3 } from "../server/src/services/alarm-clock/voice-quality.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = path.join(ROOT, "data/tts_samples");
const ASSETS = path.join(ROOT, "client/flutter_app/android/app/src/main/assets/alarm_voices");
const KT = path.join(
  ROOT,
  "client/flutter_app/android/app/src/main/kotlin/com/example/private_ai_app/AlarmClockPlugin.kt",
);
const DART = path.join(ROOT, "client/flutter_app/lib/features/alarm/alarm_platform.dart");

const VOICES = [
  { id: "diana", file: "diana_44k.mp3", label: "#1 diana 44.1kHz" },
  { id: "anna", file: "current_anna_24k.mp3", label: "#6 anna 24kHz" },
  { id: "alex", file: "alex_44k.mp3", label: "#2 alex 44.1kHz" },
];

const md5 = (buf) => createHash("md5").update(buf).digest("hex");
const read = (p) => (existsSync(p) ? readFileSync(p) : null);
const embedded = (html) =>
  [...html.matchAll(/data:audio\/[^"']+;base64,([A-Za-z0-9+/=]+)/g)].map((m) =>
    Buffer.from(m[1], "base64"),
  );

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const warn = (name, detail) => console.log(`WARN  ${name} — ${detail}`);

const apkArgIndex = process.argv.indexOf("--apk");
const apkPath = apkArgIndex > -1 ? path.resolve(ROOT, process.argv[apkArgIndex + 1]) : null;

// 1. 试听板（用户当时点选保留的那三个）恰好 3 条，且与磁盘样本逐字一致
const boardHtml = read(path.join(SAMPLES, "tts-voice-samples.html"));
const board = boardHtml ? embedded(boardHtml.toString("utf8")) : [];
check("音色试听板保留 3 条", board.length === 3, `实际 ${board.length} 条`);

// 2. A/B 页前 3 条必须是同一批字节
const abHtml = read(path.join(SAMPLES, "voice-quality-ab.html"));
const ab = abHtml ? embedded(abHtml.toString("utf8")) : [];

for (let i = 0; i < VOICES.length; i++) {
  const v = VOICES[i];
  const sample = read(path.join(SAMPLES, v.file));
  const asset = read(path.join(ASSETS, v.file));
  const hashes = {
    board: board[i] ? md5(board[i]) : null,
    sample: sample ? md5(sample) : null,
    asset: asset ? md5(asset) : null,
    ab: ab[i] ? md5(ab[i]) : null,
  };
  const present = [hashes.board, hashes.sample, hashes.asset, hashes.ab].filter(Boolean);
  check(
    `${v.label} 四处字节一致`,
    present.length === 4 && new Set(present).size === 1,
    `board=${hashes.board?.slice(0, 8)} sample=${hashes.sample?.slice(0, 8)} ` +
      `asset=${hashes.asset?.slice(0, 8)} ab=${hashes.ab?.slice(0, 8)}`,
  );
  if (sample) {
    const verdict = inspectMp3(sample, 20);
    check(
      `${v.label} 过音质门禁`,
      verdict.ok,
      `score=${verdict.score} degraded=${verdict.degraded} ` +
        `sr=${verdict.metrics.sampleRate} frames=${verdict.metrics.frames}` +
        (verdict.reasons.length ? " reasons=" + verdict.reasons.join("|") : ""),
    );
  } else {
    check(`${v.label} 过音质门禁`, false, "样本文件缺失");
  }
}

// 3. 端侧接线：MethodChannel + Dart 都必须吃 builtinVoice
const kt = read(KT)?.toString("utf8") ?? "";
const dart = read(DART)?.toString("utf8") ?? "";
check(
  "Kotlin 内置音色接线齐全",
  ["ASSET_VOICE_DIR", "listBuiltinVoices", "resolveBuiltinVoice", "builtinVoiceId", "enum class BuiltinVoice"].every(
    (k) => kt.includes(k),
  ),
);
check(
  "Dart 内置音色接线齐全",
  ["listBuiltinVoices", "testBuiltinVoice", "builtinVoice"].every((k) => dart.includes(k)),
);
check(
  "Kotlin enum 登记全部三个 id",
  VOICES.every((v) => kt.includes(`"${v.id}"`)),
  VOICES.map((v) => v.id).join(" / "),
);

// 4. APK 实包检查（可选）：用 unzip -p 取条目字节做 md5
if (apkPath) {
  if (!existsSync(apkPath)) {
    check("APK 存在", false, apkPath);
  } else {
    const list = spawnSync("unzip", ["-Z1", apkPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (list.status !== 0) {
      warn("APK 内含三个音色", "unzip 不可用，跳过实包校验");
    } else {
      for (const v of VOICES) {
        const entry = `assets/alarm_voices/${v.file}`;
        const has = list.stdout.split(/\r?\n/).includes(entry);
        if (!has) {
          check(`APK 内含 ${v.file}`, false, "未找到条目 " + entry);
          continue;
        }
        const out = spawnSync("unzip", ["-p", apkPath, entry], { maxBuffer: 16 * 1024 * 1024 });
        const ok = out.status === 0 && md5(out.stdout) === md5(read(path.join(SAMPLES, v.file)));
        check(`APK 内含 ${v.file} 且字节一致`, ok, ok ? `${out.stdout.length}B` : "内容不一致");
      }
    }
  }
} else {
  warn("APK 实包校验", "未传 --apk，跳过（重编后请带上 APK 路径再跑一次）");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error("失败项：\n" + failed.map((r) => "  - " + r.name).join("\n"));
  process.exit(1);
}
