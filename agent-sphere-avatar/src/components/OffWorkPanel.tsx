/**
 * 下班打卡卡 — 也长在桌宠身上（从球左侧抽出来），不是独立浮窗。
 *
 * 数据全部来自本地台账（focus-store），评语由服务端 LLM 现写：
 * 失败/断线就只显示数据，绝不本地编词。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { todayStats } from "../widgets/focus-store";
import type { AgentLineContext } from "../hooks/useWidgetsAgent";

const STREAK_KEY = "pai_offwork_streak_v1";
const AUTO_HIDE_MS = 40_000;

const CONFETTI_COLORS = ["#7fd4a8", "#6ec6ff", "#ffc46b", "#ff8fa3", "#a78bfa"];

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 连续准点下班天数：今天算一次，昨天有记录才续上 */
function bumpStreak(): number {
  try {
    const raw = localStorage.getItem(STREAK_KEY);
    const prev = raw ? (JSON.parse(raw) as { date?: string; days?: number }) : {};
    const today = todayKey();
    if (prev.date === today) return Math.max(1, prev.days ?? 1);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const days = prev.date === yesterday ? Math.max(1, prev.days ?? 1) + 1 : 1;
    localStorage.setItem(STREAK_KEY, JSON.stringify({ date: today, days }));
    return days;
  } catch {
    return 1;
  }
}

export interface OffWorkPanelProps {
  onClose: () => void;
  offworkTime: string;
  requestLine: (ctx: AgentLineContext) => Promise<string | null>;
  retracting?: boolean;
}

export function OffWorkPanel({
  onClose,
  offworkTime,
  requestLine,
  retracting = false,
}: OffWorkPanelProps) {
  const stats = useMemo(() => todayStats(), []);
  const [streak, setStreak] = useState(0);
  const [line, setLine] = useState<string | null>(null);
  const [lineState, setLineState] = useState<"loading" | "done" | "failed">("loading");
  const requestedRef = useRef(false);

  useEffect(() => {
    const days = bumpStreak();
    setStreak(days);
    if (requestedRef.current) return;
    requestedRef.current = true;
    void requestLine({
      trigger: "offwork_card",
      stats: {
        focusMinutes: stats.focusMinutes,
        sessions: stats.sessions,
        streakDays: days,
        offworkTime,
      },
    }).then((text) => {
      if (text) {
        setLine(text);
        setLineState("done");
      } else {
        setLineState("failed");
      }
    });
  }, [requestLine, stats.focusMinutes, stats.sessions, offworkTime]);

  const autoHide = useCallback(() => {
    const t = window.setTimeout(onClose, AUTO_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [onClose]);

  useEffect(autoHide, [autoHide]);

  const confetti = useMemo(
    () =>
      Array.from({ length: 22 }).map((_, i) => ({
        left: `${(i * 4.6 + (i % 3) * 3.1) % 96}%`,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        delay: `${(i % 11) * 42}ms`,
        duration: `${620 + (i % 5) * 110}ms`,
      })),
    [],
  );

  return (
    <div
      className={`pet-panel offwork-card${retracting ? " pet-panel--leaving" : ""}`}
      role="dialog"
      aria-label="下班打卡"
    >
      <div className="pet-panel__draw">
        <div className="pet-panel__body">
        <div className="offwork-card__body">
          <div className="offwork-card__confetti" aria-hidden="true">
            {confetti.map((c, i) => (
              <i
                key={i}
                style={{
                  left: c.left,
                  background: c.color,
                  animationDelay: c.delay,
                  animationDuration: c.duration,
                }}
              />
            ))}
          </div>

          <div className="offwork-card__kicker">下班打卡</div>
          <div className="offwork-card__time">{offworkTime}</div>

          <div className="offwork-card__rows">
            <div className="offwork-card__row">
              <span>今日专注</span>
              <b>{stats.focusMinutes} 分钟</b>
            </div>
            <div className="offwork-card__row">
              <span>番茄轮次</span>
              <b>{stats.sessions} 个</b>
            </div>
            <div className="offwork-card__row">
              <span>连续准点</span>
              <b>{streak} 天</b>
            </div>
          </div>

          {lineState !== "failed" && (
            <div
              className={`offwork-card__line${lineState === "loading" ? " offwork-card__line--muted" : ""}`}
            >
              {lineState === "loading" ? "···" : (line ?? "")}
            </div>
          )}
        </div>

        <button type="button" className="pet-panel__close" aria-label="关闭打卡卡" onClick={onClose}>
          ✕
        </button>
        </div>
      </div>
      <span className="pet-panel__tether" />
    </div>
  );
}
