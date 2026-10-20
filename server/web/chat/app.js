/**
 * 浏览器聊天页（与 Flutter 共用同一 WS 协议）。
 */
import {
  parseContentSummaryV2,
  renderContentSummaryCardV2,
  storeDetailContent,
  storeSections
} from "./content-summary-card.js";

const SESSION_KEY = "pai_web_session_id";
const FULL_ACCESS_KEY = "pai_web_full_access";
const AGENT_NAME_KEY = "pai_agent_name";
const DAILY_CHAT_PREFIX = "pai_daily_chat_";
if (typeof history !== "undefined" && history.scrollRestoration) {
  history.scrollRestoration = "manual";
}

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const fullAccessBtn = document.getElementById("full-access");
const statusEl = document.getElementById("status");
const focusListEl = document.getElementById("focus-list");
const confirmListEl = document.getElementById("confirm-list");
const confirmBadgeEl = document.getElementById("confirm-badge");
const headerTitleEl = document.querySelector(".header-title");

const STORAGE_KEYS = {
  TODAY_FOCUS: 'pai_today_focus',
  PENDING: 'pai_pending_items',
};

/// 滚动到最新消息（column-reverse 布局下 scrollTop=0 即为底部/最新处）
function scrollToLatest() {
  if (!messagesEl) return;
  messagesEl.scrollTop = 0;
}

const uiState = {
  todayFocus: [],
  pending: [],
};

let fullComputerAccessEnabled = localStorage.getItem(FULL_ACCESS_KEY) === "1";

function getTodayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

class DailyChatStorage {
  constructor() {
    this.currentDay = getTodayKey();
    this.messages = [];
    this.loadTodayMessages();
    this.startDayChangeDetector();
  }

  getStorageKey(day) {
    return `${DAILY_CHAT_PREFIX}${day || this.currentDay}`;
  }

  loadTodayMessages() {
    try {
      const raw = localStorage.getItem(this.getStorageKey());
      if (raw) {
        this.messages = JSON.parse(raw);
        this.restoreMessagesToUI();
      }
    } catch (e) {
      console.error("[DailyChatStorage] Load failed:", e);
      this.messages = [];
    }
  }

  saveMessage(role, text, messageId, timestamp = new Date().toISOString()) {
    const msg = {
      role,
      text,
      messageId,
      timestamp,
      day: this.currentDay
    };
    this.messages.push(msg);
    this.persist();
  }

  persist() {
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify(this.messages));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        console.warn("[DailyChatStorage] Storage full, keeping only last 200 messages");
        this.messages = this.messages.slice(-200);
        localStorage.setItem(this.getStorageKey(), JSON.stringify(this.messages));
      } else {
        console.error("[DailyChatStorage] Save failed:", e);
      }
    }
  }

  restoreMessagesToUI() {
    if (!messagesEl) return;

    const todayMsgs = this.messages.filter(m => m.day === this.currentDay);

    for (const msg of todayMsgs) {
      if (msg.role === 'user') {
        appendBubble('user', escapeHtml(msg.text), msg.messageId);
      } else if (msg.role === 'assistant') {
        const row = ensureAssistant(msg.messageId);
        row.text = msg.text;
        paintAssistant(msg.messageId);
      } else if (msg.role === 'system') {
        appendBubble('system', escapeHtml(msg.text), msg.messageId);
      }
    }
    scrollToLatest();
  }

  clearCurrentDay() {
    this.messages = [];
    localStorage.removeItem(this.getStorageKey());
  }

  startDayChangeDetector() {
    setInterval(() => {
      const newDay = getTodayKey();
      if (newDay !== this.currentDay) {
        console.log(`[DailyChatStorage] Day changed: ${this.currentDay} -> ${newDay}`);
        this.currentDay = newDay;
        this.messages = [];
        this.loadTodayMessages();

        if (typeof window.onDayChange === 'function') {
          window.onDayChange(this.currentDay);
        }
      }
    }, 60_000);
  }

  getTodayStats() {
    const todayMsgs = this.messages.filter(m => m.day === this.currentDay);
    const userCount = todayMsgs.filter(m => m.role === 'user').length;
    const assistantCount = todayMsgs.filter(m => m.role === 'assistant').length;
    return { total: todayMsgs.length, userCount, assistantCount };
  }

  async syncToServer() {
    if (!this.messages || this.messages.length === 0) return;

    const todayMsgs = this.messages.filter(m => m.day === this.currentDay);

    if (todayMsgs.length === 0) return;

    const syncData = {
      actorId: sessionId(),
      day: this.currentDay,
      messages: todayMsgs.map(m => ({
        role: m.role,
        text: m.text,
        messageId: m.messageId,
        timestamp: m.timestamp
      })),
      clientTimestamp: new Date().toISOString()
    };

    try {
      const response = await fetch('/api/chat/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(syncData)
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[DailyChatSync] ✅ Synced ${result.messageCount} messages to server`);

        localStorage.setItem(`pai_last_sync_${this.currentDay}`, JSON.stringify({
          syncedAt: new Date().toISOString(),
          messageCount: result.messageCount
        }));
      } else {
        console.error('[DailyChatSync] ❌ Sync failed:', response.status);
      }
    } catch (err) {
      console.error('[DailyChatSync] ❌ Sync error:', err);
    }
  }

  startAutoSync(intervalMs = 5 * 60 * 1000) {
    setInterval(() => {
      this.syncToServer();
    }, intervalMs);

    window.addEventListener('beforeunload', () => {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({
          actorId: sessionId(),
          day: this.currentDay,
          messages: this.messages.filter(m => m.day === this.currentDay),
          clientTimestamp: new Date().toISOString()
        })], { type: 'application/json' });
        navigator.sendBeacon('/api/chat/sync', blob);
      }
    });

    setTimeout(() => this.syncToServer(), 10_000);
  }
}

const dailyChatStorage = new DailyChatStorage();

function agentAccessMode() {
  return fullComputerAccessEnabled ? "full" : "sandbox";
}

function paintFullAccessButton() {
  if (!fullAccessBtn) return;
  fullAccessBtn.textContent = fullComputerAccessEnabled ? "🔓" : "🛡️";
  fullAccessBtn.title = fullComputerAccessEnabled
    ? "完全访问：已开启（可控制电脑等高权限操作）"
    : "沙箱模式：点击开启完全访问";
  fullAccessBtn.setAttribute("aria-pressed", fullComputerAccessEnabled ? "true" : "false");
  fullAccessBtn.classList.toggle("full-access-on", fullComputerAccessEnabled);
}

paintFullAccessButton();
fullAccessBtn?.addEventListener("click", () => {
  fullComputerAccessEnabled = !fullComputerAccessEnabled;
  localStorage.setItem(FULL_ACCESS_KEY, fullComputerAccessEnabled ? "1" : "0");
  paintFullAccessButton();
  setStatus(
    fullComputerAccessEnabled
      ? "已开启完全访问：下一条消息将携带高权限工具"
      : "已切换为沙箱模式",
  );
});

/** @type {WebSocket | null} */
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastInboundAt = 0;
/** 与聊天区「处理中」进度条同步，供服务端合并用户连发消息 */
let agentProcessingUiActive = false;
/** @type {Map<string, { el: HTMLElement, text: string }>} */
const assistants = new Map();

/** @type {HTMLIFrameElement | null} */
let avatarFrame = null;
let avatarReady = false;
let avatarSpeakingEnergy = 0.45;
let avatarSummoned = false;

function getAvatarFrame() {
  if (!avatarFrame) avatarFrame = document.getElementById("agent-avatar-frame");
  return avatarFrame;
}

function updateAvatarSummonButton() {
  const btn = document.getElementById("avatar-summon-btn");
  if (!btn) return;
  btn.title = avatarSummoned ? "收起桌宠" : "召唤桌宠";
  btn.setAttribute("aria-pressed", avatarSummoned ? "true" : "false");
}

function summonAvatar() {
  const frame = getAvatarFrame();
  const host = document.getElementById("agent-avatar-float");
  if (!frame || !host) return;
  if (!avatarSummoned) {
    const sid = sessionId();
    frame.src = `/chat/assets/avatar/embed.html?wsOff=1&sessionId=${encodeURIComponent(sid)}`;
  }
  avatarSummoned = true;
  host.hidden = false;
  host.classList.remove("is-hidden");
  updateAvatarSummonButton();
}

function dismissAvatar() {
  const frame = getAvatarFrame();
  const host = document.getElementById("agent-avatar-float");
  if (!host) return;
  avatarSummoned = false;
  avatarReady = false;
  host.hidden = true;
  host.classList.add("is-hidden");
  if (frame) frame.src = "about:blank";
  updateAvatarSummonButton();
}

/** 桌宠拖动与可选召唤（默认隐藏，点击按钮后加载） */
function initAvatarFrame() {
  const frame = getAvatarFrame();
  const host = document.getElementById("agent-avatar-float");
  if (!frame || !host) return;

  const summonBtn = document.getElementById("avatar-summon-btn");
  summonBtn?.addEventListener("click", () => {
    if (avatarSummoned) dismissAvatar();
    else summonAvatar();
  });
  updateAvatarSummonButton();

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const onPointerDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    // Shift/Alt + 拖动：移动悬浮窗位置（左键在 iframe 内旋转球体）
    if (!ev.shiftKey && !ev.altKey) return;
    dragging = true;
    frame.style.pointerEvents = "none";
    host.classList.add("is-dragging");
    startX = ev.clientX;
    startY = ev.clientY;
    const rect = host.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    host.style.left = `${originLeft}px`;
    host.style.top = `${originTop}px`;
    host.style.right = "auto";
    host.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  };

  const onPointerMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - w);
    const maxTop = Math.max(0, window.innerHeight - h);
    const nextLeft = Math.min(maxLeft, Math.max(0, originLeft + dx));
    const nextTop = Math.min(maxTop, Math.max(0, originTop + dy));
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
  };

  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    frame.style.pointerEvents = "auto";
    host.classList.remove("is-dragging");
    host.releasePointerCapture?.(ev.pointerId);
  };

  host.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
}

/** 向嵌入的 3D Agent 形象同步状态（服务端 embodiment.patch 或聊天事件） */
function patchAvatar(patch) {
  const frame = getAvatarFrame();
  if (!frame?.contentWindow || !avatarReady) return;
  frame.contentWindow.postMessage({ type: "agent-sphere:patch", ...patch }, "*");
}

function applyEmbodimentPatch(p) {
  patchAvatar({
    mood: p.mood,
    energy: p.energy,
    caption: p.caption === null ? undefined : p.caption,
    phase: p.phase,
    subAgentType: p.subAgentType,
    subAgentDisplayName: p.subAgentDisplayName,
    source: p.source,
  });
  if (p.mood === "happy") {
    setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1800);
  }
}

window.addEventListener("message", (ev) => {
  if (ev.data?.type === "agent-sphere:ready") {
    avatarReady = true;
    patchAvatar({ mood: "idle", energy: 0.5 });
    return;
  }
  if (ev.data?.type === "agent-sphere:touch") {
    const phase = ev.data.phase;
    const spin = ev.data.spinStrength ?? 0;
    if (phase === "start") {
      patchAvatar({ mood: "listening", energy: 0.62, focused: true, caption: "嗯？" });
      return;
    }
    if (phase === "end") {
      if (spin > 0.45) {
        patchAvatar({ mood: "happy", energy: 0.75, caption: "哈哈，别转了！" });
        forwardEmbodimentCommand({ action: "excite", strength: 0.85 + spin * 0.5 });
        setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1600);
      } else if ((ev.data.totalRotationDeg ?? 0) > 25) {
        patchAvatar({ mood: "alert", energy: 0.7, caption: "你在摸我？" });
        setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1200);
      }
    }
    return;
  }
  if (ev.data?.type === "agent-sphere:interact" && ev.data.action === "focus") {
    inputEl?.focus();
    inputEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  if (ev.data?.type === "agent-sphere:boundary") {
    const host = document.getElementById("agent-avatar-float");
    if (host) {
      const edge = ev.data.edge;
      const rect = host.getBoundingClientRect();
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
      let left = rect.left;
      let top = rect.top;
      const nudge = 52;
      if (edge === "left") left = Math.min(maxLeft, left + nudge);
      else if (edge === "right") left = Math.max(0, left - nudge);
      else if (edge === "top") top = Math.min(maxTop, top + nudge);
      else if (edge === "bottom") top = Math.max(0, top - nudge);
      else forwardEmbodimentCommand({ action: "window_roam" });
      if (edge === "left" || edge === "right" || edge === "top" || edge === "bottom") {
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
        host.style.right = "auto";
        patchAvatar({ mood: "alert", energy: 0.82, caption: "哎哟，撞到了！" });
        setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 900);
      }
    }
    return;
  }
  if (ev.data?.type === "agent-sphere:command" && ev.data.action === "window_roam") {
    forwardEmbodimentCommand({ action: "window_roam" });
    return;
  }
  if (ev.data?.type === "agent-sphere:send" && ws?.readyState === WebSocket.OPEN) {
    const sid = sessionId();
    const action = ev.data.action;
    const text = ev.data.text;
    ws.send(
      JSON.stringify({
        type: "agent.embodiment.interact",
        payload: {
          sessionId: sid,
          userId: sid,
          action,
          ...(text ? { text } : {}),
        },
      }),
    );
    if (action === "wake" || action === "chat") {
      patchAvatar({ mood: "listening", caption: "正在聆听…", energy: 0.65 });
    }
  }
});

function forwardEmbodimentCommand(p) {
  const frame = getAvatarFrame();
  if (!frame?.contentWindow || !avatarReady) return;
  frame.contentWindow.postMessage(
    {
      type: "agent-sphere:command",
      action: p.action,
      x: p.x,
      y: p.y,
      z: p.z,
      strength: p.strength,
    },
    "*",
  );
}

function sessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `web-${Date.now().toString(36)}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function getAgentName() {
  return localStorage.getItem(AGENT_NAME_KEY) || "我的AI助手";
}

function setAgentName(name) {
  localStorage.setItem(AGENT_NAME_KEY, name);
  updateAgentNameDisplay();
}

function updateAgentNameDisplay() {
  if (headerTitleEl) {
    headerTitleEl.textContent = getAgentName();
  }
}

function wsUrl() {
  const u = new URL("/ws", window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

function setStatus(line) {
  statusEl.textContent = line ?? "";
}

// === Data Persistence ===
function loadFromStorage() {
  try {
    const focusData = localStorage.getItem(STORAGE_KEYS.TODAY_FOCUS);
    const pendingData = localStorage.getItem(STORAGE_KEYS.PENDING);
    
    if (focusData) {
      uiState.todayFocus = JSON.parse(focusData);
    }
    if (pendingData) {
      uiState.pending = JSON.parse(pendingData);
    }
  } catch (e) {
    console.error('[Storage] Load failed:', e);
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEYS.TODAY_FOCUS, JSON.stringify(uiState.todayFocus));
    localStorage.setItem(STORAGE_KEYS.PENDING, JSON.stringify(uiState.pending));
  } catch (e) {
    console.error('[Storage] Save failed:', e);
  }
}

// === Helper Functions ===
function generateId() {
  return `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function parsePriority(text) {
  const lower = text.toLowerCase();
  if (lower.includes('紧急') || lower.includes('high') || lower.includes('urgent')) return 'high';
  if (lower.includes('重要') || lower.includes('medium')) return 'medium';
  return 'low';
}

// === Rendering Functions ===
function renderItem(item, type) {
  const priorityClass = item.priority ? `priority-${item.priority}` : '';
  const completedClass = item.completed ? 'completed' : '';
  
  return `
    <div class="panel-item ${priorityClass} ${completedClass}" data-id="${item.id}" data-type="${type}">
      <div class="panel-item-content">
        <div class="panel-item-text">${escapeHtml(item.text)}</div>
        <div class="panel-item-meta">
          ${item.tag ? `<span class="panel-item-tag">${escapeHtml(item.tag)}</span>` : ''}
          <span class="panel-item-time">${formatTime(item.timestamp)}</span>
        </div>
      </div>
      <div class="panel-item-actions">
        <button class="panel-item-btn complete" title="完成" onclick="toggleComplete('${item.id}', '${type}')">
          ${item.completed ? '↩️' : '✓'}
        </button>
        <button class="panel-item-btn delete" title="删除" onclick="deleteItem('${item.id}', '${type}')">
          🗑️
        </button>
      </div>
    </div>
  `;
}

function renderFocusPanel() {
  if (!focusListEl) return;
  const items = uiState.todayFocus.slice(0, 8);
  if (!items.length) {
    focusListEl.innerHTML = '<div class="panel-empty">今天还没有安排，和我说一声就能添加。</div>';
    return;
  }
  focusListEl.innerHTML = `<div class="panel-list">${items.map(item => renderItem(item, 'focus')).join('')}</div>`;
}

function renderConfirmPanel() {
  if (!confirmListEl || !confirmBadgeEl) return;
  const items = uiState.pending.slice(0, 8);
  confirmBadgeEl.textContent = String(items.length);
  if (!items.length) {
    confirmListEl.innerHTML = '<div class="panel-empty">当前没有待处理事项。</div>';
    return;
  }
  confirmListEl.innerHTML = `<div class="panel-list">${items.map(item => renderItem(item, 'pending')).join('')}</div>`;
}

// === Item Operations ===
function pushFocus(text, priority = null) {
  const t = String(text ?? "").trim();
  if (!t) return;
  
  const newItem = {
    id: generateId(),
    text: t,
    priority: priority || parsePriority(t),
    tag: null,
    timestamp: Date.now(),
    completed: false,
  };
  
  uiState.todayFocus = [newItem, ...uiState.todayFocus.filter(x => x.text !== t)].slice(0, 8);
  saveToStorage();
  renderFocusPanel();
}

function setPending(items) {
  uiState.pending = items
    .map(x => {
      if (typeof x === 'string') {
        return {
          id: generateId(),
          text: String(x ?? "").trim(),
          priority: parsePriority(x),
          tag: null,
          timestamp: Date.now(),
          completed: false,
        };
      }
      return x;
    })
    .filter(x => x && x.text)
    .slice(0, 8);
  saveToStorage();
  renderConfirmPanel();
}

function toggleComplete(id, type) {
  const list = type === 'focus' ? uiState.todayFocus : uiState.pending;
  const item = list.find(x => x.id === id);
  if (item) {
    item.completed = !item.completed;
    saveToStorage();
    if (type === 'focus') renderFocusPanel();
    else renderConfirmPanel();
  }
}

function deleteItem(id, type) {
  if (type === 'focus') {
    uiState.todayFocus = uiState.todayFocus.filter(x => x.id !== id);
    saveToStorage();
    renderFocusPanel();
  } else {
    uiState.pending = uiState.pending.filter(x => x.id !== id);
    saveToStorage();
    renderConfirmPanel();
  }
}

// Make functions available globally for inline onclick
window.toggleComplete = toggleComplete;
window.deleteItem = deleteItem;

function syncAgentProcessingUi(active) {
  if (agentProcessingUiActive === active) return;
  agentProcessingUiActive = active;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const sid = sessionId();
  ws.send(
    JSON.stringify({
      type: "chat.agent_processing_ui",
      payload: { sessionId: sid, userId: sid, active },
    }),
  );
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把 agent 回复文本渲染为 HTML。
 * 优先用 marked + DOMPurify 渲染 Markdown（独立排版 2：Markdown 排版）；
 * 库未加载或渲染失败时回退为纯文本转义。
 *
 * 整体包在 `.reply-card` 容器中：边框/圆角/阴影，与聊天区其它元素区分。
 */
function renderMessageHtml(text) {
  const md = window.marked;
  const dp = window.DOMPurify;
  let inner = "";
  if (md && dp) {
    try {
      const raw = md.parse(String(text ?? ""));
      inner = dp.sanitize(raw, { USE_PROFILES: { html: true } });
    } catch {
      inner = escapeHtml(text);
    }
  } else {
    inner = escapeHtml(text);
  }
  return `<div class="reply-card"><div class="md-body">${inner}</div></div>`;
}

function appendBubble(role, html, id) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.dataset.messageId = id ?? "";
  el.innerHTML = html;
  messagesEl.insertBefore(el, messagesEl.firstChild);
  return el;
}

function paintAssistant(id) {
  const row = assistants.get(id);
  if (!row) return;
  const { summary, briefText, cleanedText } = parseContentSummaryV2(row.text);
  if (summary) {
    // 独立排版 1：内容摘要卡片（原本就有的图片形式卡片，<details_card> 标记触发）
    const cardHtml = renderContentSummaryCardV2(summary, briefText);
    if (summary.detailContent) {
      storeDetailContent(summary.id, summary.detailContent);
    }
    if (summary.sections) {
      storeSections(summary.id, summary.sections);
    }
    if (cleanedText && cleanedText.trim()) {
      row.el.innerHTML = cardHtml + `<div class="card-context-text" style="margin-top: 8px;">${escapeHtml(cleanedText)}</div>`;
    } else {
      row.el.innerHTML = cardHtml;
    }
    if (!window.__contentSummaries) {
      window.__contentSummaries = {};
    }
    window.__contentSummaries[summary.id] = summary;
  } else {
    // 独立排版 2：Markdown 排版，包一层「回复卡」容器（边框/圆角/阴影，与其它元素区分）
    row.el.innerHTML = renderMessageHtml(row.text);
  }
}

function ensureAssistant(id) {
  let row = assistants.get(id);
  if (row) return row;
  const el = appendBubble("assistant", "", id);
  row = { el, text: "" };
  assistants.set(id, row);
  return row;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect(delayMs = 3000) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    if (Date.now() - lastInboundAt > 45000) {
      try {
        ws.close();
      } catch {}
      return;
    }
    ws.send(JSON.stringify({ type: "ws.keepalive", payload: { clientTime: new Date().toISOString() } }));
  }, 20000);
}

function connect() {
  const sid = sessionId();
  clearReconnectTimer();
  stopHeartbeat();
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    try {
      ws.close();
    } catch {}
  }
  const currentWs = new WebSocket(wsUrl());
  ws = currentWs;
  setStatus("鏉╃偞甯存稉顓涒偓?");
  currentWs.addEventListener("open", () => {
    if (ws !== currentWs) return;
    lastInboundAt = Date.now();
    currentWs.send(JSON.stringify({ type: "session.init", payload: { sessionId: sid, userId: sid } }));
    setStatus("瀹歌尪绻涢幒?");
    sendBtn.disabled = false;
    startHeartbeat();
  });
  currentWs.addEventListener("close", () => {
    if (ws !== currentWs) return;
    syncAgentProcessingUi(false);
    setStatus("瀹稿弶鏌囧鈧敍? 缁夋帒鎮楅柌宥堢箾閳?");
    sendBtn.disabled = true;
    stopHeartbeat();
    scheduleReconnect(3000);
  });
  currentWs.addEventListener("message", (ev) => {
    if (ws !== currentWs) return;
    lastInboundAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleWs(msg);
  });
}

function handleWs(msg) {
  const type = msg.type;
  const p = msg.payload ?? {};

  if (type === "agent.embodiment.patch") {
    applyEmbodimentPatch(p);
    return;
  }

  if (type === "agent.embodiment.command") {
    forwardEmbodimentCommand(p);
    return;
  }

  if (type === "agent.phone.incoming") {
    showPhoneIncoming(p);
    patchAvatar({ mood: "alert", caption: "来电", energy: 0.9 });
    return;
  }

  if (type === "agent.phone.call_status") {
    const status = String(p.status ?? "");
    if (status === "ringing") {
      const pendingTexts = uiState.pending.map(x => typeof x === 'string' ? x : x.text);
      if (!pendingTexts.some(t => t.startsWith("电话处理中："))) {
        setPending(["电话处理中：振铃中", ...uiState.pending]);
      }
    }
    if (status === "connected") {
      const filtered = uiState.pending.filter(x => {
        const text = typeof x === 'string' ? x : x.text;
        return !text.startsWith("电话处理中：");
      });
      setPending(["电话处理中：已接通", ...filtered]);
    }
    if (status === "ended") {
      const filtered = uiState.pending.filter(x => {
        const text = typeof x === 'string' ? x : x.text;
        return !text.startsWith("电话处理中：");
      });
      setPending(filtered);
    }
    handlePhoneCallStatus(p);
    return;
  }

  if (type === "chat.agent_status") {
    const line = String(p.line ?? "").trim();
    if (!line) return;
    pushFocus(line);
    const phase = String(p.phase ?? "");
    if (phase === "delegate_start") {
      const pendingTexts = uiState.pending.map(x => typeof x === 'string' ? x : x.text);
      if (!pendingTexts.includes("后台任务处理中")) {
        setPending(["后台任务处理中", ...uiState.pending]);
      }
    }
    if (phase === "delegate_done") {
      const filtered = uiState.pending.filter(x => {
        const text = typeof x === 'string' ? x : x.text;
        return text !== "后台任务处理中";
      });
      setPending(filtered);
    }
    let prog = document.getElementById("progress-bubble");
    if (!prog) {
      prog = appendBubble("progress", "", "progress");
      prog.id = "progress-bubble";
      prog._steps = [];
    }
    const steps = prog._steps || [];
    if (!steps.includes(line)) {
      steps.push(line);
      prog._steps = steps;
    }
    prog.innerHTML = steps
      .map((s, i) => {
        const isLast = i === steps.length - 1;
        const prefix = isLast ? '<span class="prog-active">▸</span>' : '<span class="prog-done">✓</span>';
        return `<div class="prog-step${isLast ? ' prog-step-current' : ''}">${prefix} ${escapeHtml(s)}</div>`;
      })
      .join("");
    scrollToLatest();
    syncAgentProcessingUi(true);
    patchAvatar({ mood: "thinking", caption: line, energy: 0.72 });
    return;
  }

  // 「分阶段异步对话交互」阶段一：即时确认应答。
  // 在多步/工具型请求开始时由服务端推送，作为 progress-bubble 的临时占位。
  // 后续 chat.agent_status 会继续追加步骤；chat.assistant_chunk/done 抵达时
  // 现有逻辑会自动让位/清理该 bubble。
  if (type === "chat.assistant_interim") {
    const line = String(p.text ?? "").trim();
    if (!line) return;
    const traceId = String(p.traceId ?? "");
    if (!traceId) return;
    let prog = document.getElementById("progress-bubble");
    if (!prog) {
      prog = appendBubble("progress", "", "progress");
      prog.id = "progress-bubble";
      prog._steps = [];
      prog._traceId = traceId;
    } else if (prog._traceId && prog._traceId !== traceId) {
      // 跨轮次的迟到的 interim：清空旧 steps，避免误用
      prog._steps = [];
      prog._traceId = traceId;
    } else {
      prog._traceId = traceId;
    }
    const steps = prog._steps || [];
    // 防止重复推同一条
    if (steps[steps.length - 1] === line) {
      // already the latest; nothing to do
    } else if (steps.includes(line)) {
      // 把这条线移到最后（最新的进度置顶）
      const idx = steps.indexOf(line);
      steps.splice(idx, 1);
      steps.push(line);
      prog._steps = steps;
    } else {
      steps.push(line);
      prog._steps = steps;
    }
    prog.innerHTML = steps
      .map((s, i) => {
        const isLast = i === steps.length - 1;
        const prefix = isLast ? '<span class="prog-active">▸</span>' : '<span class="prog-done">✓</span>';
        return `<div class="prog-step${isLast ? ' prog-step-current' : ''}">${prefix} ${escapeHtml(s)}</div>`;
      })
      .join("");
    scrollToLatest();
    syncAgentProcessingUi(true);
    patchAvatar({ mood: "thinking", caption: line, energy: 0.6 });
    return;
  }

  if (type === "tool.call") {
    const line = String(p.userStatusLine ?? p.assistantPreamble ?? p.toolName ?? "").trim();
    if (line) {
      patchAvatar({ mood: "thinking", caption: line, energy: 0.68 });
    }
    return;
  }

  if (type === "chat.assistant_chunk") {
    const id = String(p.messageId ?? "assistant-chunk");
    const row = ensureAssistant(id);
    row.text += String(p.chunk ?? "");
    paintAssistant(id);
    scrollToLatest();
    avatarSpeakingEnergy = Math.min(1, avatarSpeakingEnergy + 0.025);
    patchAvatar({ mood: "speaking", energy: avatarSpeakingEnergy });
    return;
  }

  if (type === "tool.result") {
    // 五子棋 playUrl 逻辑已移除，不再做卡片重绘。
    return;
  }

  if (type === "chat.assistant_done") {
    const prog = document.getElementById("progress-bubble");
    prog?.remove();
    syncAgentProcessingUi(false);
    setStatus("已连接");
    avatarSpeakingEnergy = 0.45;
    patchAvatar({ mood: "happy", energy: 0.55 });
    setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1800);
    const id = String(p.messageId ?? "assistant-final");
    const row = ensureAssistant(id);
    const finalText = String(p.finalText ?? "").trim();
    if (finalText) row.text = finalText;
    paintAssistant(id);
    dailyChatStorage.saveMessage('assistant', row.text, id);
    scrollToLatest();
    return;
  }

  if (type === "error.event") {
    document.getElementById("progress-bubble")?.remove();
    syncAgentProcessingUi(false);
    setStatus(String(p.message ?? "错误"));
    patchAvatar({ mood: "alert", caption: String(p.message ?? "错误"), energy: 0.85 });
    return;
  }

  if (type === "schedule.reminder_fired") {
    const reminderMsg = String(p.message ?? p.title ?? "提醒").trim();
    pushFocus(`提醒：${reminderMsg}`);
    patchAvatar({ mood: "alert", caption: reminderMsg, energy: 0.9 });
    return;
  }

  if (type === "schedule.agent_task_fired") {
    const title = String(p.title ?? "自动化任务").trim();
    patchAvatar({ mood: "thinking", caption: title, energy: 0.75, phase: "agent_task" });
    return;
  }

  if (type === "agent.peer_message") {
    const preview = String(p.preview ?? p.text ?? "新消息").slice(0, 40);
    patchAvatar({ mood: "alert", caption: preview, energy: 0.82 });
    return;
  }

  if (type === "agent.proactive_message") {
    // Agent 主动联系用户（2026-10-20）：管道直投的主动消息帧，与对话气泡同源
    // 渲染（此前完全没有 handler——服务端推了电脑端也不显示）。多段投递
    // （isPartial，无 deliveryId）各自成泡；带 title 的非默认标题前缀展示。
    const text = String(p.text ?? "").trim();
    if (!text) return;
    const title = String(p.title ?? "").trim();
    const id = String(p.deliveryId ?? `proactive-${Date.now().toString(36)}`);
    const row = ensureAssistant(id);
    // 标题去重：正文已包含主题核心（如「邮件：<主题>」而正文就是 <主题>…）时不加前缀
    const core = title.replace(/^邮件：/, "").trim();
    const prefix = title && title !== "Agent 主动联系" && core && !text.includes(core) ? `【${core}】` : "";
    row.text = row.text ? `${row.text}\n${text}` : `${prefix}${text}`;
    paintAssistant(id);
    dailyChatStorage.saveMessage("assistant", row.text, id);
    scrollToLatest();
    const importance = String(p.importance ?? "");
    pushFocus(`${prefix || "Agent 主动找你："}${text.slice(0, 40)}`);
    patchAvatar({
      mood: importance === "high" ? "alert" : "happy",
      caption: (prefix || text).slice(0, 24),
      energy: importance === "high" ? 0.85 : 0.68,
    });
    return;
  }
}

function sendUserMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const sid = sessionId();
  const messageId = `msg-${Date.now().toString(36)}`;
  appendBubble("user", escapeHtml(text), messageId);
  dailyChatStorage.saveMessage('user', text, messageId);
  inputEl.value = "";
  scrollToLatest();
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: sid,
        userId: sid,
        messageId,
        text,
        agentAccessMode: agentAccessMode(),
      },
    }),
  );
  setStatus("处理中…");
  syncAgentProcessingUi(true);
  patchAvatar({ mood: "listening", caption: "正在聆听…", energy: 0.65 });
}

sendBtn.addEventListener("click", sendUserMessage);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
});

function showPhoneIncoming(payload) {
  const direction = payload.direction ?? "agent_to_agent";
  const isFromAgent = direction === "agent_to_user";
  const fromLabel = isFromAgent
    ? (payload.fromPhone ? `Agent ${payload.fromPhone}` : "你的 Agent")
    : (payload.fromPhone ?? "未知号码");
  const transcript = payload.transcript ?? "";
  const ringLabel = payload.ringStyle === "reminder" ? "语音提醒" : "来电";

  const overlay = document.createElement("div");
  overlay.className = "phone-overlay";
  overlay.id = "phone-overlay";

  const ttsInfo = payload.tts;
  const hasAudio = ttsInfo && ttsInfo.format === "mp3" && ttsInfo.base64;

  overlay.innerHTML = `
    <div class="phone-dialog">
      <div class="phone-icon">📞</div>
      <h3 class="phone-title">${ringLabel}</h3>
      <p class="phone-from">${escapeHtml(fromLabel)}</p>
      <div class="phone-transcript">${escapeHtml(transcript) || "（无语音内容）"}</div>
      ${!hasAudio && ttsInfo?.skippedReason ? `<p class="phone-skip">未附带TTS音频：${escapeHtml(ttsInfo.skippedReason)}</p>` : ""}
      ${payload.replyEnabled ? `<div class="phone-reply-area"><textarea id="phone-reply-text" placeholder="输入回复内容（可选）…" rows="2"></textarea></div>` : ""}
      <div class="phone-actions">
        <button class="phone-btn phone-hangup" id="phone-hangup">挂断</button>
        ${hasAudio ? '<button class="phone-btn phone-answer" id="phone-play">▶ 接听播放</button>' : '<button class="phone-btn phone-answer" id="phone-dismiss">确认已读</button>'}
        ${payload.replyEnabled ? '<button class="phone-btn phone-reply-btn" id="phone-reply-send">回复</button>' : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const hangupBtn = overlay.querySelector("#phone-hangup");
  const playBtn = overlay.querySelector("#phone-play");
  const dismissBtn = overlay.querySelector("#phone-dismiss");
  const replyBtn = overlay.querySelector("#phone-reply-send");

  hangupBtn?.addEventListener("click", () => closePhoneOverlay());
  dismissBtn?.addEventListener("click", () => closePhoneOverlay());
  playBtn?.addEventListener("click", () => {
    if (hasAudio) {
      const binary = atob(ttsInfo.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(() => {});
      audio.onended = () => URL.revokeObjectURL(url);
      playBtn.textContent = "♪ 播放中…";
      playBtn.disabled = true;
    }
  });

  replyBtn?.addEventListener("click", () => {
    const textarea = document.getElementById("phone-reply-text");
    const replyText = textarea?.value.trim();
    if (replyText) {
      sendUserMessageDirect(replyText);
    }
    closePhoneOverlay();
  });
}

function handlePhoneCallStatus(payload) {
  const status = payload.status ?? "unknown";
  if (status === "ringing") {
    appendBubble("system", `📞 正在呼叫 Agent (${payload.toActorId ?? ""})…`, "phone-status");
    scrollToLatest();
    if (phoneCallWidgetState !== "ringing") {
      phoneCallWidgetState = "ringing";
      const widget = document.getElementById("phone-dialer");
      if (widget) updatePhoneCallWidgetContent(widget);
    }
  } else if (status === "connected") {
    appendBubble("system", "📞 已接通", "phone-status");
    scrollToLatest();
    phoneCallWidgetState = "connected";
    phoneCallSeconds = 0;
    const widget = document.getElementById("phone-dialer");
    if (widget) updatePhoneCallWidgetContent(widget);
  } else if (status === "ended") {
    appendBubble("system", "📞 通话已结束", "phone-status");
    scrollToLatest();
    setTimeout(() => closePhoneCallWidget(), 2000);
  }
}

function closePhoneOverlay() {
  const el = document.getElementById("phone-overlay");
  if (el) el.remove();
}

function sendUserMessageDirect(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const sid = sessionId();
  const messageId = `msg-${Date.now().toString(36)}`;
  appendBubble("user", escapeHtml(text), messageId);
  dailyChatStorage.saveMessage('user', text, messageId);
  scrollToLatest();
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: sid,
        userId: sid,
        messageId,
        text,
        agentAccessMode: agentAccessMode(),
      },
    }),
  );
  setStatus("思考中…");
  syncAgentProcessingUi(true);
}

function showPhoneDialer() {
  const existing = document.getElementById("phone-dialer");
  if (existing) {
    closePhoneCallWidget();
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("未连接到服务器");
    return;
  }

  ws.send(JSON.stringify({
    type: "phone.call_my_agent",
    payload: {},
  }));

  showPhoneCallWidget("ringing");
  appendBubble("system", "📞 正在呼叫你的 Agent…", "phone-status");
  scrollToLatest();
  patchAvatar({ mood: "alert", caption: "通话中", energy: 0.8 });
}

let phoneCallWidgetState = null;
let phoneCallTimer = null;
let phoneCallSeconds = 0;

function showPhoneCallWidget(status) {
  phoneCallWidgetState = status;
  phoneCallSeconds = 0;

  const existing = document.getElementById("phone-dialer");
  if (existing) existing.remove();

  const widget = document.createElement("div");
  widget.className = "phone-dialer";
  widget.id = "phone-dialer";

  updatePhoneCallWidgetContent(widget);

  widget.addEventListener("click", (e) => {
    if (e.target.closest(".phone-dialer-close") || e.target.closest(".phone-hangup")) {
      hangUpPhoneCall();
    }
  });

  document.body.appendChild(widget);

  if (phoneCallTimer) clearInterval(phoneCallTimer);
  phoneCallTimer = setInterval(() => {
    if (phoneCallWidgetState === "connected") {
      phoneCallSeconds++;
      const el = document.getElementById("phone-call-timer");
      if (el) el.textContent = formatPhoneCallTime(phoneCallSeconds);
    }
  }, 1000);
}

function updatePhoneCallWidgetContent(widget) {
  const statusText = {
    "ringing": "正在呼叫…",
    "connected": "通话中",
    "ended": "通话已结束"
  }[phoneCallWidgetState] || "通话中";

  const statusIcon = {
    "ringing": "📞",
    "connected": "📱",
    "ended": "✅"
  }[phoneCallWidgetState] || "📞";

  widget.innerHTML = `
    <div class="dialer-header">
      <h4>${statusIcon} ${statusText}</h4>
      <button class="dialer-close" id="dialer-close">×</button>
    </div>
    <div class="dialer-body">
      ${phoneCallWidgetState === "connected" ? `<div id="phone-call-timer" class="phone-call-timer">${formatPhoneCallTime(phoneCallSeconds)}</div>` : ""}
      <div class="phone-call-actions">
        <button class="phone-btn phone-hangup" id="phone-hangup">📞 挂断</button>
      </div>
    </div>
  `;
}

function formatPhoneCallTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function hangUpPhoneCall() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: "phone.hangup",
    payload: {},
  }));

  closePhoneCallWidget();
  appendBubble("system", "📞 通话已结束", "phone-status");
  scrollToLatest();
  patchAvatar({ mood: "idle", caption: undefined, energy: 0.5 });
}

function closePhoneCallWidget() {
  const el = document.getElementById("phone-dialer");
  if (el) el.remove();
  if (phoneCallTimer) {
    clearInterval(phoneCallTimer);
    phoneCallTimer = null;
  }
  phoneCallWidgetState = null;
  phoneCallSeconds = 0;
}

const phoneBtn = document.createElement("button");
phoneBtn.id = "phone-dialer-toggle";
phoneBtn.textContent = "📞";
phoneBtn.title = "网络电话";
phoneBtn.className = "phone-toggle-btn";

document.querySelector(".composer").insertBefore(phoneBtn, sendBtn);
phoneBtn.addEventListener("click", showPhoneDialer);

initAvatarFrame();
updateAgentNameDisplay();
loadFromStorage();
renderFocusPanel();
renderConfirmPanel();
connect();
dailyChatStorage.startAutoSync();
