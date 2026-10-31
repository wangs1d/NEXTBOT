import { useCallback, useEffect, useMemo, useState } from "react";
import { bindAgentBridge, dispatchEmbodimentCommand } from "../bridge/agent-bridge";
import { mapUserMessageSent } from "../bridge/ws-agent-mapper";
import { OverlayQuickMenu } from "../components/OverlayQuickMenu";
import { EmbedDragSurface } from "../components/EmbedDragSurface";
import { SphereAgentScene } from "../components/SphereAgentScene";
import { ScheduleSidebar } from "../components/ScheduleSidebar";
import { TaskFeed } from "../components/TaskFeed";
import { TaskNotificationCenter } from "../components/TaskNotificationCenter";
import { EMBED_SCENE } from "../constants/model-proportions";
import type { QuickCommand } from "../constants/quick-commands";
import { isWsOffMode, postToHost, readSphereQuery, SPHERE_MSG } from "../embed-protocol";
import { useAgentState } from "../hooks/useAgentState";
import { useAgentWebSocket } from "../hooks/useAgentWebSocket";
import { useEmbedFloatPan } from "../hooks/useEmbedFloatPan";
import { useEmbedParentBridge } from "../hooks/useEmbedParentBridge";
import type { SphereTouchEvent } from "../hooks/useSphereUserDrag";
import { useLivingMotion } from "../hooks/useLivingMotion";
import { useOverlaySpeech } from "../hooks/useOverlaySpeech";
import { useTaskEventAccumulator } from "../hooks/useTaskEventAccumulator";
import { useTaskEventStream } from "../hooks/useTaskEventStream";
import "./modes.css";

/** 网页聊天侧边嵌入 — 可对话、3D 漫游、接收主 Agent 具身指令 */
export function EmbedApp() {
  const wsOff = isWsOffMode();
  const mini = typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mini") === "1";
  const { state, apply, setFocused } = useAgentState({ mood: "idle", energy: 0.55 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const wsUrl = readSphereQuery("ws");
  const sessionId = readSphereQuery("sessionId");

  const stableApply = useCallback((patch: Parameters<typeof apply>[0]) => apply(patch), [apply]);

  // mini 模式：不挂 WebSocket / 任务流，徽标位只需一个静默的 3D 球
  const { connected, sendWake, sendChat } = useAgentWebSocket(stableApply, {
    wsUrl: wsUrl ?? undefined,
    sessionId: sessionId ?? undefined,
    enabled: !wsOff && !mini,
  });

  useEmbedParentBridge({ apply });
  useEmbedFloatPan(!mini);

  // 桌面嵌入模式 — 启用 DOM 级自主漫游（替换 useEmbedFloatPan 的纯拖动平移）
  const livingMotion = useLivingMotion({
    enabled: !mini,
    containerW: mini ? 64 : EMBED_SCENE.containerW,
    containerH: mini ? 64 : EMBED_SCENE.containerH,
    mood: state.mood,
    energy: state.energy,
  });

  // 任务事件流 — 来自 WS message / postMessage / 自定义 DOM 事件
  const { onTaskEvent } = useTaskEventAccumulator({ apply });
  useTaskEventStream({ onTaskEvent });
  const taskEvents = useMemo(() => state.taskEvents ?? [], [state.taskEvents]);

  const sendToAgent = useCallback(
    (action: "wake" | "chat" | "focus", text?: string) => {
      if (wsOff) {
        postToHost({ type: SPHERE_MSG.send, action, text });
        if (action === "wake" || action === "chat") {
          apply(mapUserMessageSent());
        } else if (action === "focus") {
          apply({ mood: "listening", energy: 0.62, caption: "等待输入…" });
        }
        return true;
      }
      if (action === "wake") return sendWake();
      if (action === "chat" && text) return sendChat(text);
      return false;
    },
    [apply, sendChat, sendWake, wsOff],
  );

  const handleSpeechResult = useCallback(
    (text: string) => {
      setMenuOpen(false);
      sendToAgent("chat", text);
    },
    [sendToAgent],
  );

  const speech = useOverlaySpeech({
    onResult: handleSpeechResult,
    onError: (msg) => apply({ mood: "alert", energy: 0.75, caption: msg }),
  });

  useEffect(
    () =>
      bindAgentBridge({
        onMood: (mood) => apply({ mood }),
        onEnergy: (energy) => apply({ energy }),
        onCaption: (caption) => apply({ caption }),
      }),
    [apply],
  );

  // caption 自动消失：显示一段时间后清除
  useEffect(() => {
    if (!state.caption) return;
    const timer = setTimeout(() => {
      apply({ caption: undefined });
    }, 2500);
    return () => clearTimeout(timer);
  }, [state.caption, apply]);

  const handleCommand = useCallback(
    (cmd: QuickCommand) => {
      switch (cmd.action) {
        case "wake":
          sendToAgent("wake");
          setMenuOpen(false);
          break;
        case "chat":
          if (cmd.text) sendToAgent("chat", cmd.text);
          setMenuOpen(false);
          break;
        case "roam":
          dispatchEmbodimentCommand({ action: "roam", strength: 1.1 });
          break;
        case "voice":
          if (!speech.supported) {
            apply({ mood: "alert", energy: 0.75, caption: "不支持语音识别" });
            break;
          }
          speech.start();
          apply({ mood: "listening", energy: 0.68, caption: "请说话…" });
          break;
        case "schedule":
          setMenuOpen(false);
          setScheduleOpen(true);
          break;
        default:
          break;
      }
    },
    [apply, sendToAgent, speech],
  );

  const handleEyeClick = useCallback(() => {
    setMenuOpen(true);
  }, []);

  const handleEyeInteraction = useCallback(
    (active: boolean) => {
      if (menuOpen) return;
      setFocused(active);
    },
    [menuOpen, setFocused],
  );

  const handleUserTouch = useCallback(
    (event: SphereTouchEvent) => {
      if (event.phase === "start") {
        apply({ mood: "listening", energy: 0.62, focused: true });
        return;
      }
      if (event.phase === "end") {
        const spin = event.spinStrength ?? 0;
        if (spin > 0.45) {
          apply({ mood: "happy", energy: 0.72, caption: "哈哈，转晕我了！" });
          dispatchEmbodimentCommand({ action: "excite", strength: 0.8 + spin * 0.6 });
        } else if ((event.totalRotationDeg ?? 0) > 25) {
          apply({ mood: "alert", energy: 0.68, caption: "嗯？你在转我？" });
        }
      }
    },
    [apply],
  );

  return (
    <div className="mode-shell mode-embed">
      <div
        ref={(el) => {
          livingMotion.setContainerRef(el);
        }}
        className="embed-pet-pane"
      >
        <SphereAgentScene
          state={state}
          mode="embed"
          physics={false}
          autonomous={false}
          domDragBridge
          onEyeFocus={setFocused}
          onEyeClick={handleEyeClick}
          onEyeInteractionChange={handleEyeInteraction}
          onUserTouch={handleUserTouch}
        />
      </div>

      {!mini && (
        <>
          <EmbedDragSurface
            disabled={menuOpen || speech.listening}
            onTap={handleEyeClick}
          />

          <TaskFeed events={taskEvents} />
          <TaskNotificationCenter events={taskEvents} />

          <p className="mode-embed-hint">拖动旋转 · 轻点打开菜单 · Shift+拖动移动窗口</p>

          <OverlayQuickMenu
            open={menuOpen || speech.listening}
            connected={wsOff || connected}
            voiceListening={speech.listening}
            voiceInterim={speech.interim}
            onSelect={handleCommand}
            onClose={() => {
              speech.stop();
              setMenuOpen(false);
            }}
          />

          <ScheduleSidebar
            open={scheduleOpen}
            onClose={() => setScheduleOpen(false)}
          />
        </>
      )}
    </div>
  );
}
