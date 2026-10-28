import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EntranceAnimation } from "../components/EntranceAnimation";
import { FocusTimerPanel } from "../components/FocusTimerPanel";
import type { EllipseShape } from "../components/HitAreaReporter";
import { MessageList } from "../components/MessageList";
import { OffWorkPanel } from "../components/OffWorkPanel";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { SphereAgentScene } from "../components/SphereAgentScene";
import { TaskFeed } from "../components/TaskFeed";
import { TaskNotificationCenter } from "../components/TaskNotificationCenter";
import type { QuickCommand } from "../constants/quick-commands";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useAttachPanel } from "../hooks/useAttachPanel";
import { useDynamicSpeech, type DynamicSpeechContext } from "../hooks/useDynamicSpeech";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import { useEmbodimentCommandRelay } from "../hooks/useEmbodimentCommandRelay";
import { useOverlayPointerCapture } from "../hooks/useOverlayPointerCapture";
import { useOverlayWindowMotion } from "../hooks/useOverlayWindowMotion";
import { useTaskEventAccumulator } from "../hooks/useTaskEventAccumulator";
import { useTaskEventStream } from "../hooks/useTaskEventStream";
import { useWidgetsAgent } from "../hooks/useWidgetsAgent";
import type { AgentMood } from "../types/agent";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import "../index.css";
import "../components/overlay-panels.css";
import "./modes.css";

/** TTS 语音播报：使用浏览器 SpeechSynthesis API 让主agent直接说话 */
function speakText(text: string): void {
  if (!text.trim() || typeof window === "undefined") return;
  const utt = new SpeechSynthesisUtterance(text.trim());
  utt.lang = "zh-CN";
  utt.rate = 1.1;
  utt.pitch = 1.0;
  utt.volume = 1.0;
  // 取消前一段未完的语音，避免重叠
  speechSynthesis.cancel();
  speechSynthesis.speak(utt);
}

function stopSpeaking(): void {
  if (typeof window === "undefined") return;
  speechSynthesis.cancel();
}

function readQuery(key: string): string | undefined {
  return new URLSearchParams(window.location.search).get(key) ?? undefined;
}

/** 桌面透明桌宠 — Electron 无框 3D（DG2 写实机器人），直连主 Agent */
function readAttentionElementCenter(selector: string): { screenX: number; screenY: number } | undefined {
  const el = document.querySelector(selector);
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return undefined;
  return {
    screenX: window.screenX + rect.left + rect.width / 2,
    screenY: window.screenY + rect.top + rect.height / 2,
  };
}

function resolveAttentionTargetFromDom(source?: string) {
  const selector =
    source === "phone" || source === "reminder" || source === "error"
      ? ".task-toast"
      : source === "agent_task" || source === "tool"
        ? ".task-feed"
        : source === "pet_reaction"
          ? ".overlay-pet-pane"
          : source === "menu"
            ? ".overlay-quick-menu"
            : ".task-toast, .task-feed";
  const center = readAttentionElementCenter(selector);
  if (!center) return undefined;
  return {
    ...center,
    strength: source === "phone" || source === "error" ? 0.82 : source === "agent_task" ? 0.68 : 0.58,
    source,
    expiresAt: Date.now() + 2400,
  };
}

export function OverlayApp() {
  const {
    state,
    apply: rawApply,
    setFocused,
    setMood,
    pushMessage,
    appendToLastMessage,
  } = useAgentState({ mood: "idle", energy: 0.55 });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWasOpenOnPointerDown = useRef(false);
  // 球体命中椭圆（由 Canvas 内 HitAreaReporter 投影上报）
  const [sphereHit, setSphereHit] = useState<EllipseShape | null>(null);
  const wsUrl = readQuery("ws");
  const sessionId = readQuery("sessionId");

  // ---- 主agent回复文本累积与TTS ----
  const assistantTextRef = useRef("");
  const isConversationRef = useRef(false);
  /** 当前是否有进行中的 agent 消息（用于区分多步骤多次回复） */
  const pendingAgentMsgRef = useRef(false);

  /** 增强 apply：把 assistant_chunk/user_message/assistant_done 转为消息列表追加 */
  const apply = useCallback((patch: Parameters<typeof rawApply>[0]) => {
    const source = patch.source;
    const attentionTarget =
      patch.attentionTarget ??
      (source || patch.caption || patch.phase ? resolveAttentionTargetFromDom(source) : undefined);
    const patchWithAttention = attentionTarget ? { ...patch, attentionTarget } : patch;

    // 用户发送消息：追加 user 消息，重置累积文本，结束上一条 agent 消息
    if (source === "user_message") {
      assistantTextRef.current = "";
      isConversationRef.current = false;
      pendingAgentMsgRef.current = false;
      stopSpeaking();
      // caption 不用于对话文本展示，清空避免与消息列表重复
      rawApply({ ...patchWithAttention, caption: undefined });
      return;
    }

    // 主agent流式回复：追加到最后一条 agent 消息（支持多步骤多次回复）
    if (source === "assistant_chunk") {
      isConversationRef.current = true;
      const chunkText = patch.caption ?? "";
      if (chunkText) {
        assistantTextRef.current += chunkText;
        // pendingAgentMsgRef 区分：进行中→追加到当前消息；已完成→新建消息（多步骤的新一次回复）
        if (pendingAgentMsgRef.current) {
          appendToLastMessage("agent", chunkText);
        } else {
          pushMessage("agent", chunkText);
        }
        pendingAgentMsgRef.current = true;
      }
      rawApply({ ...patchWithAttention, caption: undefined });
      return;
    }

    // 回复完成：触发TTS播报完整文本，标记当前 agent 消息完成
    if (source === "assistant_done") {
      const finalText = assistantTextRef.current.trim();
      if (finalText) {
        speakText(finalText);
      }
      // 标记当前 agent 消息已完成（下一次 chunk 到来时新建消息）
      pendingAgentMsgRef.current = false;
      assistantTextRef.current = "";
      isConversationRef.current = false;
      rawApply({ ...patchWithAttention, caption: undefined });
      return;
    }

    // 其他事件直接透传
    rawApply(patchWithAttention);
  }, [rawApply, appendToLastMessage, pushMessage]);

  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);

  const { connected, sendWake, sendChat, sendPetReaction } = useAgentWebSocket(stableApply, {
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
  });

  useEmbodimentCommandRelay(true);

  // 自动漫游已禁用：桌宠不再自己随机移动，避免晃出屏幕外看不见
  const windowMotion = useOverlayWindowMotion({ enabled: false, mood: state.mood });
  const { roamNow, triggerVerticalShake } = windowMotion;
  const roamNowRef = useRef<(() => void) | null>(null);
  roamNowRef.current = roamNow;

  const dynamicSpeech = useDynamicSpeech({
    send: sendPetReaction,
    setMood: (m) => setMood(m),
  });

  // ── 桌宠附加面板（专注计时板 / 下班打卡）──
  // 面板在桌宠窗口内部，宿主向左扩窗，因此天然跟随桌宠移动。
  // 打开时让球先顿一下（"掏出"的物理铺垫），板随后从球侧被拉出来。
  const pulseForDraw = useCallback(() => {
    triggerVerticalShake(0.16, 170);
  }, [triggerVerticalShake]);
  const attach = useAttachPanel(pulseForDraw);
  // 评语走独立轻连接（pet.reaction），不污染主对话/TTS
  const { requestLine } = useWidgetsAgent({
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
  });
  const offworkTime = useMemo(() => readQuery("offwork") ?? "18:30", []);

  // 下班打卡：每天到点弹一次（按本地日期记已弹，避免刷新重复）
  useEffect(() => {
    const openPanel = attach.open;
    const check = () => {
      const now = new Date();
      const [h, m] = offworkTime.split(":").map((v) => Number.parseInt(v, 10));
      if (!Number.isFinite(h) || !Number.isFinite(m)) return;
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      if (now < target) return;
      const key = `pai_offwork_fired_${now.toISOString().slice(0, 10)}`;
      try {
        if (localStorage.getItem(key) === "1") return;
        localStorage.setItem(key, "1");
      } catch {
        return;
      }
      openPanel("offwork");
    };
    check();
    const id = window.setInterval(check, 30_000);
    return () => window.clearInterval(id);
  }, [attach.open, offworkTime]);

  // 对外入口：球形动画做完后由球体回调 / 主窗口工具调用
  useEffect(() => {
    const openPanel = attach.open;
    const closePanel = attach.close;
    const api = {
      openFocus: () => openPanel("focus"),
      openOffWork: () => openPanel("offwork"),
      close: () => closePanel(),
    };
    (window as unknown as { __paiPet?: typeof api }).__paiPet = api;
    const onEvent = (e: Event) => {
      const kind = (e as CustomEvent<{ panel?: string }>).detail?.panel;
      if (kind === "focus" || kind === "offwork") openPanel(kind);
      else if (kind === "close") closePanel();
    };
    window.addEventListener("pai-pet-panel", onEvent);
    return () => {
      window.removeEventListener("pai-pet-panel", onEvent);
      delete (window as unknown as { __paiPet?: typeof api }).__paiPet;
    };
  }, [attach.open, attach.close]);

  // demo / 手动打开：?panel=focus|offwork
  useEffect(() => {
    const preset = readQuery("panel");
    if (preset !== "focus" && preset !== "offwork") return;
    const openPanel = attach.open;
    const t = window.setTimeout(() => openPanel(preset), 500);
    return () => window.clearTimeout(t);
  }, [attach.open]);

  /** 对话过程中不发送 pet.reaction 请求（避免与主agent回复冲突） */
  const safeSpeak = useCallback(
    (params: Parameters<typeof dynamicSpeech.speak>[0]) => {
      if (isConversationRef.current) return; // 对话中不发送 LLM 反应请求
      dynamicSpeech.speak(params);
    },
    [dynamicSpeech],
  );

  // 累计拖动/旋转的"今日总量"——作为台词的数值感
  const interactionTotalsRef = useRef({ pan: 0, spin: 0, shake: 0, lastPos: { x: 0, y: 0 } });
  const dragStartAtRef = useRef<number | null>(null);
  const lastDragEndAtRef = useRef(0);
  const lastLiveReactAtRef = useRef(0);

  /** 把窗口在工作区中的位置换算成 region 上下文（用于空间感台词） */
  const resolveRegion = useCallback((): DynamicSpeechContext["region"] => {
    if (typeof window === "undefined") return undefined;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;
    // 默认假设桌宠在右下角；如已设置 sphereOverlay.petScreenPos 则用真实值
    const pos = (window as unknown as { spherePetPos?: { x: number; y: number } }).spherePetPos;
    const x = pos?.x ?? cx;
    const y = pos?.y ?? cy;
    const v: "top" | "middle" | "bottom" = y < h / 3 ? "top" : y > (2 * h) / 3 ? "bottom" : "middle";
    const hr: "left" | "center" | "right" = x < w / 3 ? "left" : x > (2 * w) / 3 ? "right" : "center";
    return { v, h: hr };
  }, []);

  const { onTaskEvent } = useTaskEventAccumulator({ apply });
  useTaskEventStream({ onTaskEvent });
  const taskEvents = useMemo(() => state.taskEvents ?? [], [state.taskEvents]);

  const closeMenuRef = useRef<() => void>(() => {});

  const handleSpeechResult = useCallback(
    (text: string) => {
      closeMenuRef.current();
      if (connected) {
        pushMessage("user", text);
        sendChat(text);
      }
    },
    [connected, sendChat, pushMessage],
  );

  const speech = useOverlaySpeech({
    onResult: handleSpeechResult,
    onError: (msg) => apply({ mood: "alert", energy: 0.75, caption: msg }),
  });

  const menuVisible = menuOpen || speech.listening;

  const closeMenu = useCallback(() => {
    speech.stop();
    setMenuOpen(false);
    window.sphereOverlay?.setMenuExpanded?.(false);
    // 菜单关闭：恢复按命中区域动态穿透
    window.sphereOverlay?.setForceInteractive?.(false);
  }, [speech]);

  closeMenuRef.current = closeMenu;

  const openMenu = useCallback(() => {
    setMenuOpen(true);
    window.sphereOverlay?.setMenuExpanded?.(true);
    // 菜单打开：整个窗口可交互
    window.sphereOverlay?.setForceInteractive?.(true);
  }, []);

  // 托盘「设置」入口：宿主 runJavaScript 调用以打开快捷菜单
  useEffect(() => {
    (window as unknown as { __paiOpenMenu?: () => void }).__paiOpenMenu = openMenu;
    return () => {
      delete (window as unknown as { __paiOpenMenu?: () => void }).__paiOpenMenu;
    };
  }, [openMenu]);

  const { setMouseCapture } = useOverlayPointerCapture(menuVisible);

  /**
   * 处理桌宠上的拖动/旋转/松手事件
   * - 实时拖动 / 旋转：累计强度 → 跨阈值就触发身体晃动 + 上下抖动 + 短句台词
   * - 松手：根据累计量给一个总结性的"感想" + 身体晃动
   */
  const handleLiveReact = useCallback(
    (intensity: number, mode: "pan" | "rotate") => {
      const now = performance.now();
      if (now - lastLiveReactAtRef.current < 120) return;
      lastLiveReactAtRef.current = now;
      const total =
        mode === "pan"
          ? interactionTotalsRef.current.pan
          : interactionTotalsRef.current.spin;
      if (mode === "pan") {
        interactionTotalsRef.current.pan += intensity * 20;
        return;
      }
      interactionTotalsRef.current.spin += intensity * 90;
      // 同步触发身体晃动
      triggerVerticalShake(0.18 + intensity * 0.28, 220);
      // 触发动态台词（节流后由 useDynamicSpeech 控制）
      safeSpeak({
        trigger: "spin",
        intensity: Math.min(1, intensity + 0.12),
        totalMagnitude: total + intensity * 10,
        region: resolveRegion(),
        mood: state.mood,
      });
    },
    [dynamicSpeech, resolveRegion, state.mood, triggerVerticalShake],
  );

  const handleDragRelease = useCallback(
    (info: { mode: "pan" | "rotate"; totalRotationDeg: number; panDistance: number; spinStrength: number }) => {
      const now = performance.now();
      if (now - lastDragEndAtRef.current < 350) return;
      lastDragEndAtRef.current = now;
      dragStartAtRef.current = null;
      // 强松手再给一次"最终感言" + 身体晃动
      const intensity = Math.min(1, info.spinStrength * 1.4 + Math.min(1, info.totalRotationDeg / 360) * 0.7 + Math.min(1, info.panDistance / 400) * 0.4);
      triggerVerticalShake(0.5 + intensity * 0.5, 900);
      const total = info.mode === "rotate" ? interactionTotalsRef.current.spin : interactionTotalsRef.current.pan;
      safeSpeak({
        trigger: info.mode === "rotate" ? "rotate_release" : "drag_release",
        intensity,
        totalMagnitude: total,
        region: resolveRegion(),
        mood: state.mood,
        force: true,
      });
    },
    [dynamicSpeech, resolveRegion, state.mood, triggerVerticalShake],
  );

  const handleSphereTouch = useCallback(
    (event: SphereTouchEvent) => {
      if (menuVisible && event.phase === "start") {
        closeMenu();
        return;
      }

      if (event.phase === "start") {
        setMouseCapture(true);
        dragStartAtRef.current = performance.now();
        apply({ mood: "listening", energy: 0.62, focused: true });
        safeSpeak({
          trigger: "tap",
          intensity: 0.35,
          totalMagnitude: 1,
          region: resolveRegion(),
          mood: state.mood,
        });
      }
      // 松手的反应统一由 onDragRelease 处理
    },
    [apply, closeMenu, dynamicSpeech, menuVisible, resolveRegion, setMouseCapture, state.mood],
  );

  const handleEyeInteraction = useCallback(
    (active: boolean) => {
      if (menuVisible) return;
      setMouseCapture(active);
      setFocused(active);
    },
    [menuVisible, setFocused, setMouseCapture],
  );

  const handleEyeClick = useCallback(() => {
    if (menuVisible) return;
    openMenu();
  }, [menuVisible, openMenu]);

  const handlePetPanePointerDown = useCallback(() => {
    menuWasOpenOnPointerDown.current = menuVisible;
  }, [menuVisible]);

  const handlePetPanePointerUp = useCallback(() => {
    if (menuWasOpenOnPointerDown.current) {
      closeMenu();
    }
  }, [closeMenu]);

  const handleCommand = useCallback(
    (cmd: QuickCommand) => {
      switch (cmd.action) {
        case "wake":
          if (connected) sendWake();
          closeMenu();
          break;
        case "chat":
          if (connected && cmd.text) {
            pushMessage("user", cmd.text);
            sendChat(cmd.text);
          }
          closeMenu();
          break;
        case "roam":
          roamNowRef.current?.();
          break;
        case "voice":
          if (!speech.supported) {
            apply({ mood: "alert", energy: 0.75, caption: "不支持语音识别" });
            break;
          }
          speech.start();
          apply({ mood: "listening", energy: 0.68, caption: "请说话…" });
          break;

        default:
          break;
      }
    },
    [apply, closeMenu, connected, sendChat, sendWake, speech, sessionId, pushMessage],
  );

  useEffect(() => {
    document.body.classList.add("overlay-body");

    window.sphereOverlay?.onPatch?.((patch: {
      mood?: AgentMood;
      energy?: number;
      caption?: string | null;
      phase?: string;
      subAgentType?: string;
      subAgentDisplayName?: string;
      source?: string;
      screenX?: number;
      screenY?: number;
      attentionTarget?: Parameters<typeof rawApply>[0]["attentionTarget"];
    }) => {
      // LLM pet.reaction.ack 会以 caption 形式覆盖桌宠台词 — 不要再用 caption 自动清除
      apply({
        mood: patch.mood,
        energy: patch.energy,
        caption: patch.caption === null ? undefined : patch.caption,
        phase: patch.phase,
        subAgentType: patch.subAgentType,
        subAgentDisplayName: patch.subAgentDisplayName,
        source: patch.source,
        attentionTarget:
          patch.attentionTarget ??
          (typeof patch.screenX === "number" && typeof patch.screenY === "number"
            ? {
                screenX: patch.screenX,
                screenY: patch.screenY,
                strength: 0.72,
                source: patch.source,
                expiresAt: Date.now() + 2400,
              }
            : undefined),
      });
    });

    window.sphereOverlay?.onRoam?.(() => roamNowRef.current?.());

    // 托盘换肤：data-theme 切换配色变量
    const unlistenTheme = window.sphereOverlay?.onTheme?.((theme: string) => {
      document.documentElement.setAttribute("data-theme", theme);
      try {
        localStorage.setItem("pai_theme", theme);
      } catch {
        /* ignore */
      }
    });

    // 启动时恢复上次主题
    try {
      const saved = localStorage.getItem("pai_theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch {
      /* ignore */
    }

    return () => {
      document.body.classList.remove("overlay-body");
      unlistenTheme?.();
    };
  }, [apply]);

  // 命中区域上报：球体椭圆 + 附加面板 + 消息列表（client 坐标）。
  // 原生 ClickThroughController 据此动态切换穿透。
  useEffect(() => {
    type RectShape = { type: "rect"; x: number; y: number; w: number; h: number };
    const shapes: Array<EllipseShape | RectShape> = [];
    if (sphereHit) shapes.push(sphereHit);

    const selectors = [".overlay-attach-slot", ".overlay-pet-pane .message-list"];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        shapes.push({ type: "rect", x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }

    window.sphereOverlay?.setHitAreas?.(JSON.stringify({ shapes }));
  }, [sphereHit, attach.width, attach.panel]);

  // caption 自动消失：显示一段时间后清除
  // - assistant_chunk / user_message / assistant_done 不自动清（主agent回复由TTS逻辑统一管理）
  // - pet_reaction 也需要自动清（useDynamicSpeech 的定时器不一定能覆盖所有路径）
  useEffect(() => {
    if (!state.caption) return;
    if (state.source === "assistant_chunk" || state.source === "user_message" || state.source === "assistant_done") {
      return;
    }
    // pet_reaction 来源用较长的显示时间，其他来源用 2.5s
    const duration = state.source === "pet_reaction" ? 5000 : 2500;
    const timer = setTimeout(() => {
      apply({ caption: undefined });
    }, duration);
    return () => clearTimeout(timer);
  }, [state.caption, state.source, apply]);

  // alert mood 超时回退：当 mood 为 alert 且没有活跃 caption 时，一段时间后回到 idle
  useEffect(() => {
    if (state.mood !== "alert") return;
    if (state.caption) return; // 有内容显示时保持 alert
    const timer = setTimeout(() => {
      apply({ mood: "idle" });
    }, 6000);
    return () => clearTimeout(timer);
  }, [state.mood, state.caption, apply]);

  return (
    <div className={`mode-shell mode-overlay${menuVisible ? " mode-overlay--menu-open" : ""}`}>
      <EntranceAnimation />
      <div className="overlay-attach-slot" style={{ width: attach.width }}>
        {attach.panel === "focus" && (
          <FocusTimerPanel retracting={attach.retracting} onClose={attach.close} />
        )}
        {attach.panel === "offwork" && (
          <OffWorkPanel
            retracting={attach.retracting}
            onClose={attach.close}
            offworkTime={offworkTime}
            requestLine={requestLine}
          />
        )}
      </div>
      <div className="overlay-pet-pane"
        onPointerDown={handlePetPanePointerDown}
        onPointerUp={handlePetPanePointerUp}
      >
        <SphereAgentScene
          state={state}
          mode="overlay"
          physics={false}
          autonomous={false}
          onEyeFocus={setFocused}
          onEyeClick={handleEyeClick}
          onEyeInteractionChange={handleEyeInteraction}
          onUserTouch={handleSphereTouch}
          onBodyHover={setMouseCapture}
          onLiveReact={handleLiveReact}
          onDragRelease={handleDragRelease}
          onShakeRequest={(strength, durationMs) => triggerVerticalShake(strength, durationMs)}
          onHitAreaReport={setSphereHit}
        />
        <MessageList messages={state.messages ?? []} />
      </div>

      <TaskFeed events={taskEvents} />
      <TaskNotificationCenter events={taskEvents} />

      <OverlayQuickMenu
        open={menuVisible}
        layout="side"
        connected={connected}
        voiceListening={speech.listening}
        voiceInterim={speech.interim}
        onSelect={handleCommand}
        onClose={closeMenu}
      />
    </div>
  );
}
