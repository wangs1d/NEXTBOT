import { useCallback, useEffect, useRef, useState } from "react";

interface ScheduleItem {
  id: string;
  title: string;
  time: string;
  /** 简洁展示标题（创建时由 LLM 生成，优先展示；缺省回退 title 的剥离简化） */
  shortTitle?: string;
  description?: string;
  completed?: boolean;
}

/** 从 URL 参数获取连接信息 */
function getConfig() {
  const params = new URLSearchParams(window.location.search);
  return {
    wsUrl: params.get("ws") || "",
    sessionId: params.get("sessionId") || "",
    httpBase: params.get("httpBase") || "",
  };
}

/** 格式化今日日期 */
function formatTodayLabel(): string {
  const now = new Date();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${now.getMonth() + 1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
}

/**
 * 今日安排标题简洁化（与 Flutter 端 _simplifyScheduleTitle 逻辑对齐）：
 * 剥离「该X啦」提醒式包装、指令前缀、元描述前缀、以及和左侧时间列重复的
 * 时间词，再清理冗余代词词头，只保留说明事情的核心文案。
 * “该去游泳啦，带上泳衣和浴巾！” -> “去游泳”；“记得提醒我3点吃药” -> “吃药”
 */
function simplifyScheduleTitle(raw: string): string {
  let s = raw.trim();
  if (!s) return s;

  // 提醒式包装：“该去游泳啦，带上泳衣和浴巾！” -> “去游泳”
  const wrapperMatch = s.match(/^该([^啦了，。！!?？\s]{1,10})(啦|了)/);
  if (wrapperMatch && wrapperMatch[1]) s = wrapperMatch[1];

  const instruction =
    /^\s*(请)?(记得|别忘了|不要忘记|不要忘了|提醒用户|提醒我|提醒一下|提醒|帮我|记着|叫我|喊我|给我|让我)\s*(提醒|一下)?/;
  const metaPrefix = /^\s*(定时|设置|安排|添加|创建|新增)(一个|一下|个|条)?(提醒|日程|事项)?/;
  const timeExpr =
    /(今天|明天|后天|今晚|明晚|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|半夜)?(\d{1,2}(点|[:：])[:：]?\d{0,2}(分|分钟)?(半|整|左右)?|[一二三四五六七八九十两]+点(半|整|左右)?|\d{1,2}[:：]\d{2})/g;
  const pronoun = /^(我(?!们)|帮我|给我)(的)?/;

  // 交替剥离指令前缀 / 元描述前缀 / 时间词 / 冗余代词，直到不再变化
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s
      .replace(instruction, "")
      .replace(metaPrefix, "")
      .replace(timeExpr, "")
      .replace(pronoun, "");
  }

  // 清理“的提醒：X”残留结构，以及开头的日期词（今日安排均为当天事项）
  s = s.replace(/^[^：:]*的?(提醒|闹钟|日程)[：:]/, "");
  s = s.replace(/^(今天|明天|后天|明早|明晚|大后天)/, "");

  s = s.replace(/^[\s，,、.。!！?？\-~—－–]+/, "").trim();
  return s || "待办事项";
}

/**
 * 独立桌面悬浮窗 — 今日安排
 *
 * 拖动策略（JS 实现）：
 * - 标题栏上 PointerDown 进入拖动态，记录起点 + pointerId
 * - window 级 pointermove 计算 delta，调用 sphereOverlay.moveBy 移动窗口
 * - window 级 pointerup/pointercancel 结束拖动
 * - 子元素（折叠按钮）通过 closest(".schedule-float__action, .schedule-float__badge") 排除，
 *   让按钮的 click 事件不受影响
 *
 * 不使用 `-webkit-app-region: drag`：在 transparent + frame:false 窗口下
 * 不同 Electron 版本表现不一致，JS 拖动更可控。
 */
function getTodayRange(): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function ScheduleFloatingWidget() {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const { wsUrl, httpBase, sessionId } = getConfig();

  /**
   * 拖动策略（最终版）：
   * 1. pointerdown：加 .dragging class（CSS 关掉 backdrop-filter），记起点
   * 2. pointermove：直接写 CSS transform translate 走 GPU 合成，**零 IPC**
   * 3. pointerup：一次 moveBy IPC 把窗口挪过去，清 transform
   *
   * 之前 transform 方案出现残影，是因为 .dragging 没有同时关掉
   * will-change / box-shadow，且 transform 值没有取整。
   * 现在用 Math.round 取整 + 强制开 compositor 层，DWM 合成不抖。
   */
  const dragStateRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    totalDx: number;
    totalDy: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /** 加载日程 */
  const loadSchedules = useCallback(async () => {
    try {
      if (httpBase && sessionId) {
        const { from, to } = getTodayRange();
        const params = new URLSearchParams({ sessionId, from, to });
        const response = await fetch(
          `${httpBase.replace(/\/$/, "")}/api/schedule/today?${params.toString()}`,
          { headers: { "Content-Type": "application/json" } },
        );
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data) && data.length > 0) {
            const items: ScheduleItem[] = data.map((item: Record<string, unknown>) => ({
              id: String(item.id ?? Date.now()),
              title: simplifyScheduleTitle(String(item.title ?? "未命名")),
              shortTitle: item.shortTitle ? String(item.shortTitle).trim() : undefined,
              time: item.startAt
                ? new Date(item.startAt as string).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "",
              description: item.notes ? String(item.notes) : undefined,
              completed: item.completed as boolean | undefined,
            }));
            setSchedules(items);
            return;
          }
        }
      }
      setSchedules([]);
    } catch {
      setSchedules([]);
    }
  }, [httpBase, sessionId]);

  useEffect(() => {
    loadSchedules();
    const interval = setInterval(loadSchedules, 30000);
    return () => clearInterval(interval);
  }, [loadSchedules]);

  useEffect(() => {
    if (!wsUrl || !sessionId) return;
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: { sessionId, userId: sessionId } }));
    });
    ws.addEventListener("message", (event) => {
      let message: { type?: string };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (
        message.type === "schedule.tasks_changed" ||
        message.type === "schedule.reminder_fired"
      ) {
        void loadSchedules();
      }
    });
    return () => {
      ws.close();
    };
  }, [loadSchedules, sessionId, wsUrl]);

  /** 监听来自宿主窗口的日程更新 */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "schedule-update" && Array.isArray(event.data.schedules)) {
        setSchedules(
          event.data.schedules.map((item: { title?: string; shortTitle?: string }) => ({
            ...item,
            shortTitle: item.shortTitle ? String(item.shortTitle).trim() : undefined,
            title: simplifyScheduleTitle(String(item.title ?? "未命名")),
          })),
        );
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  /**
   * 标题栏 PointerDown — 进入拖动态
   * 排除点击折叠按钮 / 角标
   */
  const handleHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".schedule-float__action, .schedule-float__badge")) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    rootRef.current?.classList.add("dragging");
    dragStateRef.current = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      totalDx: 0,
      totalDy: 0,
    };
  }, []);

  /**
   * window 级 pointermove / pointerup
   * 关键：拖动期间零 IPC，只用 CSS transform 做 GPU 合成位移。
   * 松手时发 1 次 moveBy，再清 transform。
   */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const dx = e.clientX - state.lastX;
      const dy = e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      state.totalDx += dx;
      state.totalDy += dy;
      const root = rootRef.current;
      if (root) {
        // Math.round 防止亚像素抖动；translate3d 强制独立合成层
        root.style.transform = `translate3d(${Math.round(state.totalDx)}px, ${Math.round(state.totalDy)}px, 0)`;
      }
    };
    const onUp = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      // 1. 发 IPC 移动窗口（异步 send）
      if (state.totalDx !== 0 || state.totalDy !== 0) {
        window.sphereOverlay?.moveBy?.(state.totalDx, state.totalDy);
      }
      // 2. 立刻清 transform（DOM 回到窗口原点，窗口通过 IPC 移到目标位置）
      const root = rootRef.current;
      if (root) {
        root.style.transform = "";
      }
      // 3. 延迟恢复 backdrop-filter：等窗口移动完成 + DWM 合成稳定，
      //    否则 blur 在窗口位置变化中采样异常，界面会"慢慢消失"
      const target = root;
      setTimeout(() => {
        target?.classList.remove("dragging");
      }, 200);
      dragStateRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  /** 切换展开/折叠 — 同步通知主进程修改窗口高度 */
  const toggleCollapse = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCollapsed((prev) => {
      const next = !prev;
      // 让主进程真正修改窗口 bounds；窗口始终保持可交互（不再穿透）
      window.sphereOverlay?.setScheduleCollapsed?.(next);
      return next;
    });
  }, []);

  const pendingCount = schedules.filter((s) => !s.completed).length;
  const todayLabel = formatTodayLabel();

  return (
    <div
      ref={rootRef}
      className={`schedule-float${collapsed ? " schedule-float--collapsed" : ""}`}
    >
      {/* 标题栏 — JS 拖动：PointerDown 进入拖动态，window 级 move/up 跟踪位移 */}
      <header className="schedule-float__header" onPointerDown={handleHeaderPointerDown}>
        <div className="schedule-float__title-row">
          <span className="schedule-float__icon">📅</span>
          <span className="schedule-float__title">今日安排</span>
          <span className="schedule-float__date">{todayLabel}</span>
        </div>
        <div className="schedule-float__actions">
          {schedules.length > 0 && (
            <span className="schedule-float__badge">{pendingCount}</span>
          )}
          <button
            type="button"
            className="schedule-float__action"
            onClick={toggleCollapse}
            onPointerDown={(e) => e.stopPropagation()}
            title={collapsed ? "展开" : "折叠"}
          >
            {collapsed ? "▼" : "▲"}
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          <div className="schedule-float__body">
            {schedules.length === 0 ? (
              <div className="schedule-float__empty">
                <span className="schedule-float__empty-icon">📝</span>
                <span>暂无日程数据</span>
              </div>
            ) : (
              <ul className="schedule-float__list">
                {schedules.map((item) => (
                  <li
                    key={item.id}
                    className={`schedule-float__item${item.completed ? " is-completed" : ""}`}
                  >
                    <span className="schedule-float__item-time">{item.time}</span>
                    <span className="schedule-float__item-title">
                      {item.shortTitle || item.title}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {schedules.length > 0 && (
            <div className="schedule-float__footer">
              共 {schedules.length} 项 · {pendingCount} 待执行
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 全局类型声明 — 扩展 window.electronAPI（sphereOverlay 已在 useOverlayWindowMotion 中声明） */
declare global {
  interface Window {
    electronAPI?: {
      moveWindow: (dx: number, dy: number) => void;
      resizeWindow: (collapsed: boolean) => void;
    };
  }
}
