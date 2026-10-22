/**
 * 专注计时板 — 桌宠「掏出来」的小板子（不占屏、不需要大）。
 *
 * 设计约束：
 * - 尺寸小（166×~104），贴在球体左侧，不抢桌面
 * - 拉出来即开始计时（这就是"桌宠拿出计时板开始计时"的动作语义）
 * - 只有一个隐藏的 ✕，板面任意处点击 = 暂停/继续
 * - 落账只写事实（起止 + 分钟）→ focus-store，打卡卡读同一份台账
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadTodayBlocks, saveTodayBlock, todayStats } from "../widgets/focus-store";

type Phase = "focus" | "break";

export interface FocusTimerPanelProps {
  onClose: () => void;
  focusMin?: number;
  breakMin?: number;
  /** demo：跳过启动延迟 */
  autoStart?: boolean;
  /** 正在做收回动画（保留 DOM 时加此态） */
  retracting?: boolean;
}

function fmt(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function FocusTimerPanel({
  onClose,
  focusMin = 25,
  breakMin = 5,
  autoStart = true,
  retracting = false,
}: FocusTimerPanelProps) {
  const [phase, setPhase] = useState<Phase>("focus");
  const [round, setRound] = useState(1);
  const [left, setLeft] = useState(focusMin * 60);
  const [running, setRunning] = useState(false);
  const [doneToday, setDoneToday] = useState(() => todayStats().sessions);

  const deadlineRef = useRef(0);
  const leftAtPauseRef = useRef(focusMin * 60);
  const blockStartRef = useRef(Date.now());
  const switchingRef = useRef(false);

  const total = (phase === "focus" ? focusMin : breakMin) * 60;
  const progress = total > 0 ? 1 - left / total : 0;

  const startCountdown = useCallback((seconds: number) => {
    leftAtPauseRef.current = seconds;
    deadlineRef.current = Date.now() + seconds * 1000;
    setLeft(seconds);
    setRunning(true);
  }, []);

  // 打开即开始（"掏出来就开始计时"）
  useEffect(() => {
    if (!autoStart) return;
    const t = window.setTimeout(() => {
      blockStartRef.current = Date.now();
      startCountdown(focusMin * 60);
    }, 30);
    return () => window.clearTimeout(t);
  }, [autoStart, focusMin, startCountdown]);

  // 用 deadline 换算，后台节流也不漂移
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const rest = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000));
      setLeft(rest);
    }, 250);
    return () => window.clearInterval(id);
  }, [running]);

  const toggle = useCallback(() => {
    if (running) {
      leftAtPauseRef.current = left;
      setRunning(false);
      return;
    }
    deadlineRef.current = Date.now() + leftAtPauseRef.current * 1000;
    setRunning(true);
  }, [left, running]);

  // 段结束：专注段落账 → 休息段；休息段结束 → 下一轮专注
  useEffect(() => {
    if (!running || left > 0 || switchingRef.current) return;
    switchingRef.current = true;
    setRunning(false);

    if (phase === "focus") {
      const end = Date.now();
      const minutes = Math.max(1, Math.round((end - blockStartRef.current) / 60000));
      saveTodayBlock({ start: blockStartRef.current, end, minutes });
      setDoneToday(loadTodayBlocks().length);
      setPhase("break");
      window.setTimeout(() => {
        switchingRef.current = false;
        startCountdown(breakMin * 60);
      }, 1200);
      return;
    }

    setRound((r) => r + 1);
    setPhase("focus");
    window.setTimeout(() => {
      switchingRef.current = false;
      blockStartRef.current = Date.now();
      startCountdown(focusMin * 60);
    }, 1200);
  }, [left, running, phase, breakMin, focusMin, startCountdown]);

  const dotClass =
    phase === "break"
      ? "focus-timer__dot focus-timer__dot--break"
      : running
        ? "focus-timer__dot"
        : "focus-timer__dot focus-timer__dot--paused";

  return (
    <div
      className={`pet-panel focus-timer${retracting ? " pet-panel--leaving" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={running ? "暂停计时" : "继续计时"}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className="pet-panel__draw">
        <div className="pet-panel__body">
        <div className="focus-timer__head">
          <span className={dotClass} />
          <span>{phase === "focus" ? "专注" : "休息"}</span>
          <span style={{ marginLeft: "auto", letterSpacing: 0 }}>
            {running ? `第 ${round} 轮` : "已暂停"}
          </span>
        </div>

        <div className="focus-timer__time">
          {fmt(left)}
          <small>/ {phase === "focus" ? focusMin : breakMin}′</small>
        </div>

        <div className="focus-timer__bar">
          <i style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }} />
        </div>

        <div className="focus-timer__foot">
          <span>今日 {doneToday} 个</span>
          <span className="focus-timer__pips">
            {Array.from({ length: 6 }).map((_, i) => (
              <i key={i} className={i < Math.min(6, doneToday) ? "on" : ""} />
            ))}
          </span>
        </div>

        <button
          type="button"
          className="pet-panel__close"
          aria-label="收起计时板"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ✕
        </button>
        </div>
      </div>
      <span className="pet-panel__tether" />
    </div>
  );
}
