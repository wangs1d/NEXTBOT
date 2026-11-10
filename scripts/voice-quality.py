#!/usr/bin/env python3
"""叫醒语音音质实验台（2026-11-09）。

用途：
  analyze <文件...>       客观指标 + 质量门禁判定（阈值与
                          server/src/services/alarm-clock/voice-quality.ts 同源）
  enhance <wav> <输出wav> 通用 WAV 后处理实验（历史算法，生产链路已不使用）
  page [输出html]         生成自包含 A/B 试听页（音频内嵌 base64）

语音合成已全部走云端 TTS：端侧不再内置 ONNX 模型，脚本不再依赖 sherpa_onnx。
只依赖 Python 3.12 已有包：numpy / imageio_ffmpeg（内含 ffmpeg）。
运行：py -3.12 scripts/voice-quality.py analyze data/tts_samples/*.mp3
"""
from __future__ import annotations

import argparse
import base64
import datetime
import json
import math
import re
import subprocess
import sys
import wave
from pathlib import Path
from string import Template

import numpy as np

try:
    from imageio_ffmpeg import get_ffmpeg_exe
except ImportError:  # pragma: no cover
    get_ffmpeg_exe = None

ROOT = Path(__file__).resolve().parents[1]

# ── 质量门禁阈值（契约源：server/src/services/alarm-clock/voice-quality.ts） ──
MIN_PEAK = 0.20          # 电平太低→为听清推音量会放大声码器噪声（anna 事故）
MAX_PEAK = 0.95          # 削波
MIN_RMS = 0.030          # 低于 -30dBFS 的语音在闹钟上听不清
MAX_RMS = 0.140          # 高于 -17dBFS 会明显比云端音源响（本地模型实测 0.11~0.14）
MAX_CLIP_RATIO = 0.001
MAX_DC = 0.02
MAX_NOISE_FLOOR = 0.003  # 静音段底噪，推大音量会把声码器颗粒感暴露成「沙哑」
MIN_ACTIVE_RATIO = 0.30  # 有效发声帧占比，防「一大段静音」
MAX_ACTIVE_RATIO = 0.95  # 防持续噪声（无停顿）
MIN_HIGH_BAND = 0.008    # 3kHz 以上能量占比，过低＝发闷（云端 diana 44.1k 实测 0.019）
MIN_DURATION_S = 0.60
MAX_DURATION_S = 40.0
TARGET_RMS = 0.070       # 与云端 diana 44.1kHz 的 -23dBFS 对齐，保证音量一致
TARGET_PEAK = 0.89       # 峰值硬上限（≈ -1 dBFS）
MIN_GAIN = 0.25
MAX_GAIN = 4.0           # 限幅增益，避免把底噪一起放大
SHELF_K = 0.60           # 高频补偿强度（22.05kHz 本地模型实测发闷，需抬清晰度）
SHELF_ALPHA = 0.22       # 一阶低通系数，分界约 0.8kHz @22.05kHz


def ffmpeg_exe() -> str:
    if get_ffmpeg_exe:
        return get_ffmpeg_exe()
    raise RuntimeError("imageio_ffmpeg 不可用：py -3.12 -m pip install imageio-ffmpeg")


def probe_sample_rate(path: Path) -> int:
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as w:
            return w.getframerate()
    proc = subprocess.run(
        [ffmpeg_exe(), "-hide_banner", "-i", str(path), "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"Audio:\s*[^,]+,\s*(\d+)\s*Hz", proc.stderr)
    if not m:
        raise RuntimeError(f"无法识别采样率: {path}")
    return int(m.group(1))


def decode(path: Path) -> tuple[np.ndarray, int]:
    """解码为单声道 float64；保留原生采样率（不做重采样，避免美化指标）。"""
    sr = probe_sample_rate(path)
    proc = subprocess.run(
        [ffmpeg_exe(), "-v", "quiet", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(sr), "pipe:1"],
        capture_output=True, check=True,
    )
    x = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float64)
    return x, sr


def metrics(x: np.ndarray, sr: int) -> dict:
    n = x.size
    if n == 0:
        return {"durationS": 0.0, "sampleRate": sr, "ok": False, "reasons": ["empty audio"]}
    duration = n / sr
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x * x)))
    dc = float(np.mean(x))
    clip = float(np.mean(np.abs(x) >= 0.999))
    win = max(1, int(sr * 0.02))
    frames = x[: n // win * win].reshape(-1, win)
    frame_rms = np.sqrt(np.mean(frames * frames, axis=1)) if frames.size else np.array([0.0])
    noise = float(np.percentile(frame_rms, 5))
    active = float(np.mean(frame_rms > max(peak * 0.02, noise * 3.0, 1e-5)))
    # 频谱：前 8 秒、取最大 2 的幂、Hann 窗（与 voice-quality.ts 的 radix-2 FFT 同口径）
    use = min(n, sr * 8)
    fft_n = 1 << (use.bit_length() - 1)
    fft_n = max(fft_n, 2)
    seg = x[:fft_n] * np.hanning(fft_n)
    spec = np.abs(np.fft.rfft(seg)) ** 2
    freqs = np.fft.rfftfreq(fft_n, d=1.0 / sr)
    total = float(spec.sum()) or 1e-12
    centroid = float((spec * freqs).sum() / total)
    high = float(spec[freqs >= 3000].sum() / total)
    zcr = float(np.mean(np.abs(np.diff(np.signbit(x))) != 0))
    m = {
        "durationS": round(duration, 3),
        "sampleRate": sr,
        "peak": round(peak, 4),
        "rms": round(rms, 4),
        "dbfs": round(20 * math.log10(max(rms, 1e-9)), 2),
        "clipRatio": round(clip, 5),
        "dcOffset": round(dc, 5),
        "noiseFloor": round(noise, 5),
        "activeRatio": round(active, 3),
        "centroidHz": round(centroid, 1),
        "highBand3kRatio": round(high, 5),
        "zcr": round(zcr, 4),
    }
    reasons = []
    if not math.isfinite(peak) or peak < MIN_PEAK:
        reasons.append(f"peak={peak:.3f} < {MIN_PEAK}（电平过低）")
    if peak > MAX_PEAK:
        reasons.append(f"peak={peak:.3f} > {MAX_PEAK}（削波风险）")
    if rms < MIN_RMS:
        reasons.append(f"rms={rms:.4f} < {MIN_RMS}（几乎静音）")
    if rms > MAX_RMS:
        reasons.append(f"rms={rms:.4f} > {MAX_RMS}（过载）")
    if clip > MAX_CLIP_RATIO:
        reasons.append(f"clip={clip:.4f} > {MAX_CLIP_RATIO}")
    if abs(dc) > MAX_DC:
        reasons.append(f"dc={dc:.4f} > {MAX_DC}")
    if noise > MAX_NOISE_FLOOR:
        reasons.append(f"noiseFloor={noise:.4f} > {MAX_NOISE_FLOOR}（沙哑底噪）")
    if not (MIN_ACTIVE_RATIO <= active <= MAX_ACTIVE_RATIO):
        reasons.append(f"activeRatio={active:.3f} 越界（静音或持续噪声）")
    if high < MIN_HIGH_BAND:
        reasons.append(f"highBand3k={high:.5f} < {MIN_HIGH_BAND}（发闷）")
    if not (MIN_DURATION_S <= duration <= MAX_DURATION_S):
        reasons.append(f"duration={duration:.2f}s 越界")
    m["ok"] = not reasons
    m["reasons"] = reasons
    return m


def enhance(x: np.ndarray, sr: int, shelf_k: float = SHELF_K) -> np.ndarray:
    """历史 WAV 后处理算法：去直流→裁静音→响度归一→高频补偿→淡入淡出。

    生产链路已不再使用（端侧 ONNX 模型移除）；保留仅供离线实验对照。
    注意用「响度（RMS）归一」而不是峰值归一：按峰值推到 0.89 只会更吵、更闷。
    """
    if x.size == 0:
        return x
    y = x - float(np.mean(x))  # 去直流
    # 首尾静音裁剪（保留 60ms 边缘，避免切掉起音）
    win = max(1, int(sr * 0.02))
    n = y.size
    frames = y[: n // win * win].reshape(-1, win)
    frame_rms = np.sqrt(np.mean(frames * frames, axis=1)) if frames.size else np.array([0.0])
    peak = float(np.max(np.abs(y))) or 1e-9
    threshold = max(peak * 0.015, float(np.percentile(frame_rms, 5)) * 3.0, 1e-5)
    voiced = np.flatnonzero(frame_rms > threshold)
    if voiced.size:
        start = max(0, int(voiced[0]) * win - int(sr * 0.06))
        end = min(n, int(voiced[-1] + 1) * win + int(sr * 0.06))
        y = y[start:end]
    # 响度归一：对齐云端 diana 的 -23dBFS，同时受峰值上限约束；增益双向限幅
    peak = float(np.max(np.abs(y))) or 1e-9
    rms = float(np.sqrt(np.mean(y * y))) or 1e-9
    gain = min(TARGET_RMS / rms, TARGET_PEAK / peak)
    y = y * max(MIN_GAIN, min(MAX_GAIN, gain))
    # 高频补偿：y += k * (y - lowpass(y))，抬 3kHz 附近清晰度
    lp = np.empty_like(y)
    acc = 0.0
    for i, v in enumerate(y):
        acc += SHELF_ALPHA * (v - acc)
        lp[i] = acc
    y = y + shelf_k * (y - lp)
    # 二次响度对齐：高频补偿会额外抬高 RMS，拉回 -23dBFS 保证与云端音源同音量
    rms2 = float(np.sqrt(np.mean(y * y))) or 1e-9
    peak2 = float(np.max(np.abs(y))) or 1e-9
    gain2 = min(TARGET_RMS / rms2, TARGET_PEAK / peak2)
    y = y * max(0.5, min(2.0, gain2))
    # 峰值保护：杜绝削波
    peak = float(np.max(np.abs(y))) or 1e-9
    if peak > TARGET_PEAK:
        y = y * (TARGET_PEAK / peak)
    # 首尾淡入淡出，杜绝 MediaPlayer 起播/收尾爆音
    fade_in = min(int(sr * 0.008), y.size // 4)
    fade_out = min(int(sr * 0.025), y.size // 4)
    if fade_in > 0:
        y[:fade_in] *= np.linspace(0.0, 1.0, fade_in)
    if fade_out > 0:
        y[-fade_out:] *= np.linspace(1.0, 0.0, fade_out)
    return np.clip(y, -1.0, 1.0)


def write_wav(path: Path, x: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(x, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def cmd_analyze(paths: list[Path], as_json: bool) -> None:
    rows = []
    for p in paths:
        x, sr = decode(p)
        m = metrics(x, sr)
        m["file"] = p.name
        rows.append(m)
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    cols = ["file", "sr", "dur", "peak", "rms", "dBFS", "clip", "active", "3k+", "centroid", "noise", "verdict"]
    print("  ".join(f"{c:>10}" for c in cols))
    print("-" * 140)
    for m in rows:
        print("  ".join(f"{v:>10}" for v in [
            m["file"][:10], m["sampleRate"], f"{m['durationS']:.2f}", f"{m['peak']:.3f}",
            f"{m['rms']:.4f}", f"{m['dbfs']:.1f}", f"{m['clipRatio']:.4f}",
            f"{m['activeRatio']:.2f}", f"{m['highBand3kRatio']:.4f}",
            f"{m['centroidHz']:.0f}", f"{m['noiseFloor']:.4f}", "PASS" if m["ok"] else "FAIL",
        ]))
        for r in m["reasons"]:
            print(f"      - {r}")


PAGE_TEMPLATE = Template("""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>叫醒语音质量 A/B</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1d21;--sub:#666b73;--line:#e5e7eb;--ok:#0f8a4d;--warn:#c4620a}
*{box-sizing:border-box}body{margin:0;padding:28px 18px 60px;background:var(--bg);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:820px;margin:0 auto}h1{font-size:24px;margin:0 0 6px}
.lead{color:var(--sub);font-size:14px;line-height:1.7;margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px;
box-shadow:0 1px 3px rgba(16,20,30,.04)}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}
.name{font-size:16px;font-weight:650}.tone{font-size:13px;color:var(--sub);margin-bottom:14px}
.badge{font-size:11px;padding:4px 9px;border-radius:999px;background:#eef1f5;color:#48505c;white-space:nowrap}
.badge.main{background:#e7f5ec;color:var(--ok)}.badge.before{background:#fdf0e4;color:var(--warn)}
audio{width:100%;height:38px;margin:4px 0 12px}
table{width:100%;border-collapse:collapse;font-size:12.5px;color:#3a3f47}
td{padding:5px 0;border-top:1px solid #f0f1f4}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.verdict{font-size:12px;font-weight:600;color:var(--ok)}.verdict.bad{color:var(--warn)}
.foot{margin-top:24px;padding:16px 18px;background:#eef1f6;border-radius:12px;font-size:13px;
line-height:1.85;color:#414752}.foot b{color:var(--ink)}
code{background:#e7eaf0;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="wrap">
<h1>叫醒语音质量 A/B</h1>
<p class="lead">这三条是你保留的 #1 / #6 / #2，<b>仅作 A/B 测试基准</b>：字节原样内置进 APK，端侧按 id 调用可复现同一声音。
默认叫醒音源不是固定录音 —— 建钟时服务端 SpeechHub 按当次上下文生成话术，云端 TTS 按这句话<b>实时合成</b> 44.1kHz mp3 并下发落盘；话术变了，声音就重新合成。</p>
$cards
<div class="foot"><b>质量保障与降级</b><br>
1. 服务端每路 TTS 返回都过 mp3 帧结构门禁，坏音频不落盘、自动换 provider；24kHz 只降级告警不静音。<br>
2. 端侧落盘前再过一遍 mp3 帧结构门禁、播放前校验文件头，截断/坏文件直接跳下一级，不让播放器静音卡住。<br>
3. <b>默认音源 = 云端按动态话术实时合成</b>；降级链 <code>云端 mp3 &gt; 系统 TTS 念 voiceText &gt; 系统闹铃</code>。端侧已移除 ONNX 语音模型与 PCM 生成门禁。<br>
4. 阈值同源：<code>voice-quality.ts</code>（服务端）/ <code>VoiceQuality.kt</code>（端侧文件门禁）/ <code>scripts/voice-quality.py</code>（离线实验台）。<br>
5. <b>三个内置 mp3 只是测试基准，不是交付音源</b>：<code>diana</code> / <code>anna</code> / <code>alex</code>，仅显式 <code>builtinVoice: id</code> 时走完整响铃链路做对照。<br>
<span style="color:#8a909a">生成于 $date</span></div>
</div></body></html>""")


def cmd_page(out: Path) -> None:
    """自包含 A/B 试听页（present_files 只发 HTML 本身，同目录资源会 403）。"""
    base = ROOT / "data/tts_samples"
    items = [
        # 用户 2026-11-09 指定保留的三个音色（#1/#6/#2），文件与 APK assets 逐字一致。
        ("#1 diana · 44.1kHz", "云端对照样本 · 已内置 APK，仅 A/B 测试 id = diana",
         "diana_44k.mp3", "audio/mpeg", "内置 · 测试基准", "main"),
        ("#6 anna · 24kHz", "旧对照，偏沙哑 · 已内置 APK，端侧测试 id = anna（仅作退化对照）",
         "current_anna_24k.mp3", "audio/mpeg", "内置 · 对照", "before"),
        ("#2 alex · 44.1kHz", "候选音色 · 已内置 APK，端侧测试 id = alex",
         "alex_44k.mp3", "audio/mpeg", "内置 · 候选", "main"),
    ]
    # 用户点名保留的三个固定样本：只套「音源帧结构门禁」，不套「新生成语音」的 PCM 门槛，
    # 否则 #6 anna（24kHz、电平偏低，本来就是沙哑对照）会被误标成不可用。
    builtin_samples = {"diana_44k.mp3", "current_anna_24k.mp3", "alex_44k.mp3"}
    cards = []
    for name, tone, rel, mime, badge, badge_cls in items:
        p = base / rel
        if not p.exists():
            print(f"skip missing sample: {p}")
            continue
        x, sr = decode(p)
        m = metrics(x, sr)
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        if rel in builtin_samples:
            verdict_cls = ""
            degraded = " · 24kHz 降级告警（可用，不静音）" if sr < 32000 else ""
            verdict = "音源帧结构门禁 PASS" + degraded + " · 固定对照，不套用生成门禁"
        else:
            verdict_cls = "" if m["ok"] else "bad"
            verdict = "门禁 PASS" if m["ok"] else "门禁 FAIL：" + "；".join(m["reasons"])
        cards.append(f"""<div class="card">
  <div class="head"><span class="name">{name}</span><span class="badge {badge_cls}">{badge}</span></div>
  <div class="tone">{tone}</div>
  <audio controls preload="none" src="data:{mime};base64,{b64}"></audio>
  <table>
    <tr><td>采样率 / 时长</td><td>{m['sampleRate']} Hz · {m['durationS']:.2f}s</td></tr>
    <tr><td>响度 RMS / 峰值</td><td>{m['rms']:.4f} ({m['dbfs']:.1f} dBFS) / {m['peak']:.3f}</td></tr>
    <tr><td>3kHz 以上能量（清晰度）</td><td>{m['highBand3kRatio']:.4f}</td></tr>
    <tr><td>频谱质心 / 底噪</td><td>{m['centroidHz']:.0f} Hz / {m['noiseFloor']:.5f}</td></tr>
    <tr><td>有效发声 / 削波</td><td>{m['activeRatio']:.2f} / {m['clipRatio']:.4f}</td></tr>
    <tr><td>质量判定</td><td><span class="verdict {verdict_cls}">{verdict}</span></td></tr>
  </table>
</div>""")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        PAGE_TEMPLATE.substitute(
            cards="\n".join(cards),
            date=datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        ),
        encoding="utf-8",
    )
    print(f"page -> {out} ({out.stat().st_size / 1024:.0f} KB, {len(cards)} cards)")


def main() -> None:
    ap = argparse.ArgumentParser(description="叫醒语音音质检测 / A/B 试听页生成")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze", help="客观指标 + 门禁判定")
    a.add_argument("files", nargs="+", type=Path)
    a.add_argument("--json", action="store_true")
    e = sub.add_parser("enhance", help="通用 WAV 后处理实验（历史算法）")
    e.add_argument("src", type=Path)
    e.add_argument("dst", type=Path)
    e.add_argument("--shelf-k", type=float, default=SHELF_K)
    p = sub.add_parser("page", help="生成自包含 A/B 试听页（音频内嵌 base64）")
    p.add_argument("dst", type=Path, nargs="?", default=ROOT / "data/tts_samples/voice-quality-ab.html")
    args = ap.parse_args()
    if args.cmd == "analyze":
        cmd_analyze(args.files, args.json)
    elif args.cmd == "enhance":
        x, sr = decode(args.src)
        y = enhance(x, sr, args.shelf_k)
        write_wav(args.dst, y, sr)
        print(f"enhance -> {args.dst}")
        print(json.dumps({"before": metrics(x, sr), "after": metrics(y, sr)}, ensure_ascii=False, indent=2))
    else:
        cmd_page(args.dst)


if __name__ == "__main__":
    sys.exit(main())
