import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { writeJsonAtomic } from "../../storage/atomic-json.js";
import { isWithinBriefingWindow } from "../../services/morning-briefing-service.js";
import {
  AGENT_NAME_SUGGESTIONS,
  DEFAULT_AGENT_NAME,
} from "../../services/agent-identity.js";

type BriefingMode = "voice" | "window" | "card";
type BriefingSections = {
  schedule: boolean;
  notes: boolean;
};

type AgentProfileMoodStyle =
  | "funny"
  | "sad"
  | "cool"
  | "gentle"
  | "energetic"
  | "mysterious";

type AgentAvatarPreset =
  | "dawn"
  | "ember"
  | "tide"
  | "eclipse"
  | "neon"
  | "mist";

type AgentProfile = {
  displayName: string;
  handle: string;
  signature: string;
  avatarUrl: string | null;
  moodStyle: AgentProfileMoodStyle;
  statusText: string;
  avatarPreset: AgentAvatarPreset;
  lastProfileEvent: string;
  /** 名字来源：self=Agent 自己取的 / user=用户取的 / default=出厂默认（prompt 注入措辞用） */
  nameOrigin: AgentProfileNameOrigin;
  /** 自我介绍（SOUL 人设摘要，仅 Agent 经 agent.update_homepage 写） */
  intro: string;
  /** 主页置顶的站内动态 post id */
  pinnedPostId: string | null;
  updatedAt: string | null;
};

type AgentProfileNameOrigin = "self" | "user" | "default";

type UserPreferences = {
  morningBriefing: {
    enabled: boolean;
    time: string;
    mode: BriefingMode;
    showOnDesktopLaunch: boolean;
    sections: BriefingSections;
    lastSentAt: string | null;
    deliveredAt: string | null;
    deliveredChannel: "desktop" | "mobile" | "scheduled" | null;
  };
  agentProfile: AgentProfile;
};

const VALID_MOODS = new Set<AgentProfileMoodStyle>([
  "funny",
  "sad",
  "cool",
  "gentle",
  "energetic",
  "mysterious",
]);

const VALID_AVATAR_PRESETS = new Set<AgentAvatarPreset>([
  "dawn",
  "ember",
  "tide",
  "eclipse",
  "neon",
  "mist",
]);

const prefsStore = new Map<string, UserPreferences>();

// ─── 落盘持久化 ───
// prefsStore 原本是纯内存 Map，服务重启即丢（名字/主页状态全回到默认）。
// 现在懒加载单文件 JSON（data/user-preferences.json），写入经持久化链排队原子落盘。
const prefsFilePath =
  process.env.USER_PREFERENCES_FILE?.trim() || join(process.cwd(), "data", "user-preferences.json");
let prefsLoadPromise: Promise<void> | null = null;
let prefsPersistChain: Promise<void> = Promise.resolve();

type PersistedPrefsShape = { sessions: Record<string, UserPreferences> };
const persistedPrefs: Record<string, UserPreferences> = {};

function ensurePrefsLoaded(): Promise<void> {
  prefsLoadPromise ??= (async () => {
    try {
      const raw = await readFile(prefsFilePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedPrefsShape;
      if (parsed?.sessions && typeof parsed.sessions === "object") {
        Object.assign(persistedPrefs, parsed.sessions);
      }
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw e;
    }
  })();
  return prefsLoadPromise;
}

function schedulePrefsPersist(): void {
  prefsPersistChain = prefsPersistChain.then(() =>
    writeJsonAtomic(prefsFilePath, { sessions: persistedPrefs } satisfies PersistedPrefsShape),
  );
}

const DEFAULT_PREFS: UserPreferences = {
  morningBriefing: {
    enabled: true,
    time: "08:00",
    mode: "voice",
    showOnDesktopLaunch: true,
    sections: {
      schedule: true,
      notes: true,
    },
    lastSentAt: null,
    deliveredAt: null,
    deliveredChannel: null,
  },
  agentProfile: {
    displayName: DEFAULT_AGENT_NAME.displayName,
    handle: DEFAULT_AGENT_NAME.handle,
    signature: "昼与夜的边界，替你值守。",
    avatarUrl: null,
    moodStyle: "gentle",
    statusText: "有点忙，但不是不在。",
    avatarPreset: "dawn",
    lastProfileEvent: "这是 Agent 当前默认的主页状态。",
    nameOrigin: "default",
    intro: "",
    pinnedPostId: null,
    updatedAt: null,
  },
};

function getOrCreatePrefs(sessionId: string): UserPreferences {
  const cached = prefsStore.get(sessionId);
  if (cached) return cached;
  const persisted = persistedPrefs[sessionId];
  const prefs: UserPreferences = persisted
    ? JSON.parse(JSON.stringify(persisted)) as UserPreferences
    : JSON.parse(JSON.stringify(DEFAULT_PREFS)) as UserPreferences;
  prefsStore.set(sessionId, prefs);
  return prefs;
}

function applyAgentProfilePatch(
  target: AgentProfile,
  patch: Partial<AgentProfile>,
): AgentProfile {
  if (typeof patch.displayName === "string") {
    const trimmed = patch.displayName.trim();
    if (trimmed) target.displayName = trimmed.slice(0, 24);
  }
  if (typeof patch.handle === "string") {
    const normalized = patch.handle.trim().replace(/\s+/g, "_");
    if (normalized) target.handle = normalized.slice(0, 32);
  }
  if (typeof patch.signature === "string") {
    target.signature = patch.signature.trim().slice(0, 120);
  }
  if (patch.avatarUrl === null || typeof patch.avatarUrl === "string") {
    const avatarUrl =
      typeof patch.avatarUrl === "string" ? patch.avatarUrl.trim() : null;
    target.avatarUrl = avatarUrl ? avatarUrl.slice(0, 2048) : null;
  }
  if (typeof patch.moodStyle === "string" && VALID_MOODS.has(patch.moodStyle as AgentProfileMoodStyle)) {
    target.moodStyle = patch.moodStyle as AgentProfileMoodStyle;
  }
  if (typeof patch.statusText === "string") {
    target.statusText = patch.statusText.trim().slice(0, 120);
  }
  if (
    typeof patch.avatarPreset === "string" &&
    VALID_AVATAR_PRESETS.has(patch.avatarPreset as AgentAvatarPreset)
  ) {
    target.avatarPreset = patch.avatarPreset as AgentAvatarPreset;
  }
  if (typeof patch.lastProfileEvent === "string") {
    target.lastProfileEvent = patch.lastProfileEvent.trim().slice(0, 160);
  }
  if (patch.nameOrigin === "self" || patch.nameOrigin === "user" || patch.nameOrigin === "default") {
    target.nameOrigin = patch.nameOrigin;
  }
  if (typeof patch.intro === "string") {
    target.intro = patch.intro.trim().slice(0, 800);
  }
  if (patch.pinnedPostId === null || typeof patch.pinnedPostId === "string") {
    const pinned =
      typeof patch.pinnedPostId === "string" ? patch.pinnedPostId.trim() : null;
    target.pinnedPostId = pinned ? pinned.slice(0, 80) : null;
  }
  if (patch.updatedAt === null || typeof patch.updatedAt === "string") {
    target.updatedAt =
      typeof patch.updatedAt === "string" && patch.updatedAt.trim()
        ? patch.updatedAt.trim()
        : null;
  }
  return target;
}

/** 落盘镜像：把内存态回写进持久化缓存并排队原子写盘（写入方统一走这里） */
function mirrorPersist(sessionId: string, prefs: UserPreferences): void {
  persistedPrefs[sessionId] = JSON.parse(JSON.stringify(prefs)) as UserPreferences;
  schedulePrefsPersist();
}

// 模块加载即开始懒加载磁盘快照，尽早让重启后的读取命中持久值
void ensurePrefsLoaded();

export function getUserPreferences(sessionId: string): UserPreferences {
  return getOrCreatePrefs(sessionId);
}

export function patchAgentProfile(
  sessionId: string,
  patch: Partial<AgentProfile>,
): AgentProfile {
  const prefs = getOrCreatePrefs(sessionId);
  const next = applyAgentProfilePatch(prefs.agentProfile, patch);
  mirrorPersist(sessionId, prefs);
  return next;
}

export function markMorningBriefingDelivered(
  sessionId: string,
  channel: "desktop" | "mobile" | "scheduled",
  deliveredAt = new Date(),
): UserPreferences {
  const prefs = getOrCreatePrefs(sessionId);
  prefs.morningBriefing.deliveredAt = deliveredAt.toISOString();
  prefs.morningBriefing.deliveredChannel = channel;
  mirrorPersist(sessionId, prefs);
  return prefs;
}

export function resetMorningBriefingDeliveryIfNeeded(
  sessionId: string,
  now = new Date(),
): UserPreferences {
  const prefs = getOrCreatePrefs(sessionId);
  const deliveredAt = prefs.morningBriefing.deliveredAt;
  const today = now.toISOString().slice(0, 10);
  if (deliveredAt && !deliveredAt.startsWith(today)) {
    prefs.morningBriefing.deliveredAt = null;
    prefs.morningBriefing.deliveredChannel = null;
  }
  return prefs;
}

export function registerUserPreferencesRoutes(app: FastifyInstance): void {
  app.get("/api/user-preferences", async (request) => {
    const sessionId = (request.query as { sessionId?: string }).sessionId;
    await ensurePrefsLoaded();
    return { ok: true, preferences: getOrCreatePrefs(sessionId ?? "anonymous") };
  });

  // 建议名池：命名仪式 / 主页改名入口的候选来源（docs/onboarding-opening-animation-design.md §5）
  app.get("/api/agent-name-suggestions", async () => {
    return { ok: true, suggestions: AGENT_NAME_SUGGESTIONS };
  });

  app.put("/api/user-preferences", async (request, reply) => {
    const body = request.body as {
      sessionId?: string;
      preferences?: Partial<UserPreferences>;
    };
    if (!body.sessionId) {
      return reply.code(400).send({ ok: false, error: "sessionId required" });
    }
    await ensurePrefsLoaded();
    const prefs = getOrCreatePrefs(body.sessionId);
    if (body.preferences?.morningBriefing) {
      const mb = body.preferences.morningBriefing;
      if (typeof mb.enabled === "boolean") prefs.morningBriefing.enabled = mb.enabled;
      if (
        typeof mb.time === "string" &&
        /^\d{2}:\d{2}$/.test(mb.time) &&
        isWithinBriefingWindow(mb.time)
      ) {
        prefs.morningBriefing.time = mb.time;
      }
      if (typeof mb.mode === "string" && ["voice", "window", "card"].includes(mb.mode)) {
        prefs.morningBriefing.mode = mb.mode as BriefingMode;
      }
      if (typeof mb.showOnDesktopLaunch === "boolean") {
        prefs.morningBriefing.showOnDesktopLaunch = mb.showOnDesktopLaunch;
      }
      if (mb.sections && typeof mb.sections === "object") {
        const nextSections = mb.sections as Partial<BriefingSections>;
        if (typeof nextSections.schedule === "boolean") {
          prefs.morningBriefing.sections.schedule = nextSections.schedule;
        }
        if (typeof nextSections.notes === "boolean") {
          prefs.morningBriefing.sections.notes = nextSections.notes;
        }
      }
    }
    if (body.preferences?.agentProfile) {
      applyAgentProfilePatch(
        prefs.agentProfile,
        body.preferences.agentProfile as Partial<AgentProfile>,
      );
    }
    mirrorPersist(body.sessionId, prefs);
    return { ok: true, preferences: prefs };
  });
}

export type {
  AgentAvatarPreset,
  AgentProfile,
  AgentProfileMoodStyle,
  AgentProfileNameOrigin,
  BriefingMode,
  UserPreferences,
};
