export type UserFactCategory =
  | "habit"
  | "interest"
  | "personality"
  | "communication_style"
  | "decision_style"
  | "privacy_preference"
  | "travel";

export type UserFact = {
  id: string;
  category: UserFactCategory;
  key: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  lastSeenAt: string;
  createdAt: string;
};

export type UserFactStore = {
  facts: UserFact[];
  updatedAt: string;
};

export type FactCandidate = {
  category: UserFactCategory;
  key: string;
  value: string;
};

const MAX_FACTS = 80;
const DECAY_DAYS = 90;
const MIN_CONFIDENCE = 0.15;

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultFactStore(): UserFactStore {
  return { facts: [], updatedAt: nowIso() };
}

export function toFactStore(v: unknown): UserFactStore {
  if (!v || typeof v !== "object") return defaultFactStore();
  const o = v as Record<string, unknown>;
  const facts = Array.isArray(o.facts) ? (o.facts as UserFact[]) : [];
  return {
    facts: facts
      .filter((f) => f && typeof f.key === "string" && typeof f.value === "string")
      .slice(0, MAX_FACTS),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso(),
  };
}

export function extractFactCandidates(userText: string): FactCandidate[] {
  const t = userText.trim();
  if (!t) return [];
  const out: FactCandidate[] = [];
  const push = (c: FactCandidate) => {
    if (c.value.length > 1) out.push(c);
  };

  const sleep = /(?:usually sleep at|sleep at|go to bed at)\s*([0-2]?\d:[0-5]\d|\d{1,2}\s*(?:am|pm))/i.exec(t);
  if (sleep?.[1]) push({ category: "habit", key: "sleep_time", value: sleep[1].trim() });

  const work = /(?:work schedule|working hours)\s*:?\s*([^\n,.!?]{2,24})/i.exec(t);
  if (work?.[1]) push({ category: "habit", key: "work_schedule", value: work[1].trim() });

  const like = /(?:i like|i love|i enjoy)\s*([^\n,.!?]{2,40})/i.exec(t);
  if (like?.[1]) push({ category: "interest", key: "likes", value: like[1].trim() });

  const dislike = /(?:i dislike|i hate)\s*([^\n,.!?]{2,40})/i.exec(t);
  if (dislike?.[1]) push({ category: "interest", key: "dislikes", value: dislike[1].trim() });

  if (/(introvert|extrovert)/i.test(t)) {
    push({ category: "personality", key: "social_style", value: t.slice(0, 40) });
  }
  if (/(anxious|calm|sensitive)/i.test(t)) {
    push({ category: "personality", key: "emotional_trait", value: t.slice(0, 40) });
  }

  if (/(be brief|short answer|concise|direct)/i.test(t)) {
    push({ category: "communication_style", key: "response_length", value: "brief" });
  }
  if (/(detailed|explain more|more detail)/i.test(t)) {
    push({ category: "communication_style", key: "response_length", value: "detailed" });
  }
  if (/(formal|professional)/i.test(t)) {
    push({ category: "communication_style", key: "tone", value: "formal" });
  }
  if (/(friendly|casual)/i.test(t)) {
    push({ category: "communication_style", key: "tone", value: "friendly" });
  }

  if (/(risk averse|conservative|low risk)/i.test(t)) {
    push({ category: "decision_style", key: "risk_preference", value: "conservative" });
  }
  if (/(aggressive|high risk)/i.test(t)) {
    push({ category: "decision_style", key: "risk_preference", value: "aggressive" });
  }

  if (/(privacy first|do not store|minimize data|private mode)/i.test(t)) {
    push({ category: "privacy_preference", key: "storage", value: "minimize_storage" });
  }

  // ── 旅行画像（travel-upgrade-plan 画像引擎）：偏好信号驱动，非性别标签 ──
  // 出片向：漂亮饭/网红打卡/拍照出片/氛围感是强信号
  if (/(出片|拍照好看|好出片|漂亮饭|网红打卡|打卡点|氛围感|机位|适合拍照|照片好看)/.test(t)) {
    push({ category: "travel", key: "travel_style", value: "photo_driven" });
  }
  // 体验向：项目/玩法/硬核体验优先于拍照
  if (/(体验感|好玩的项目|刺激|户外|徒步|露营|潜水|滑雪|钓鱼|垂钓|自驾穿越|越野|漂流|蹦极)/.test(t)) {
    push({ category: "travel", key: "travel_style", value: "experience_driven" });
  }
  // 躺平向：度假酒店/发呆/慢节奏
  if (/(躺平|泡酒店|度假村|发呆|慢节奏|不想赶|轻松点)/.test(t)) {
    push({ category: "travel", key: "travel_style", value: "relax_driven" });
  }
  // 打卡向：多去几个地方/特种兵
  if (/(特种兵|多去几个|把景点都逛|尽量多逛|紧凑一点)/.test(t)) {
    push({ category: "travel", key: "travel_style", value: "checkin_driven" });
  }
  // 饮食限制（影响漂亮饭/餐厅推荐）
  if (/(不吃辣|不能吃辣|忌口|吃素|素食|清真|过敏)/.test(t)) {
    const m = /(不吃辣|不能吃辣|吃素|素食|清真|[^，。！？\s]{1,6}过敏)/.exec(t);
    if (m?.[1]) push({ category: "travel", key: "diet", value: m[1].trim() });
  }
  // 交通方式：无自有交通工具（高铁/飞机出行）→ 需要接驳提醒
  if (/(自驾|自己开车|开车去)/.test(t)) {
    push({ category: "travel", key: "drives_own_car", value: "self_drive" });
  }
  if (/(没车|不会开车|不自驾|坐高铁|坐飞机|高铁去|飞机去|坐火车|火车去)/.test(t)) {
    push({ category: "travel", key: "drives_own_car", value: "no_car" });
  }
  // 同行人结构（影响节奏与项目类型）
  if (/(和男朋友|和女朋友|情侣|带娃|带孩子|带小孩|带爸妈|和爸妈|陪父母|闺蜜|一个人去|独自去|亲子|家庭出游)/.test(t)) {
    const m = /(和男朋友|和女朋友|情侣|带娃|带孩子|带小孩|带爸妈|和爸妈|陪父母|闺蜜|一个人去|独自去|亲子|家庭出游)/.exec(t);
    if (m?.[1]) push({ category: "travel", key: "travel_companion", value: m[1].trim() });
  }

  return out.slice(0, 8);
}

export function mergeFactCandidates(store: UserFactStore, candidates: FactCandidate[]): UserFactStore {
  if (candidates.length === 0) return store;
  const facts = [...store.facts];
  const now = nowIso();

  for (const c of candidates) {
    const idx = facts.findIndex((f) => f.category === c.category && f.key === c.key && f.value === c.value);
    if (idx >= 0) {
      const f = facts[idx];
      facts[idx] = {
        ...f,
        confidence: Math.min(0.99, f.confidence + 0.08),
        evidenceCount: f.evidenceCount + 1,
        lastSeenAt: now,
      };
      continue;
    }
    const conflictIdx = facts.findIndex((f) => f.category === c.category && f.key === c.key && f.value !== c.value);
    if (conflictIdx >= 0) {
      const old = facts[conflictIdx];
      facts[conflictIdx] = { ...old, confidence: Math.max(0.2, old.confidence - 0.12) };
      facts.push({
        id: `${c.category}:${c.key}:${Date.now()}`,
        category: c.category,
        key: c.key,
        value: c.value,
        confidence: 0.55,
        evidenceCount: 1,
        lastSeenAt: now,
        createdAt: now,
      });
      continue;
    }
    facts.push({
      id: `${c.category}:${c.key}:${Date.now()}`,
      category: c.category,
      key: c.key,
      value: c.value,
      confidence: 0.62,
      evidenceCount: 1,
      lastSeenAt: now,
      createdAt: now,
    });
  }

  const sorted = facts.sort((a, b) => b.confidence - a.confidence || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { facts: sorted.slice(0, MAX_FACTS), updatedAt: now };
}

export function decayFactStore(store: UserFactStore, now = new Date()): UserFactStore {
  const next = store.facts
    .map((f) => {
      const days = (now.getTime() - new Date(f.lastSeenAt).getTime()) / (1000 * 60 * 60 * 24);
      if (days <= DECAY_DAYS) return f;
      const extra = Math.floor((days - DECAY_DAYS) / 14) + 1;
      return { ...f, confidence: Math.max(0, f.confidence - extra * 0.05) };
    })
    .filter((f) => f.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);
  return { facts: next, updatedAt: nowIso() };
}

/** 取某 key 的最高置信 travel 画像值（无则 undefined）。规划层取数口。 */
export function travelFactOf(store: UserFactStore, key: string): string | undefined {
  return store.facts
    .filter((f) => f.category === "travel" && f.key === key)
    .sort((a, b) => b.confidence - a.confidence)[0]?.value;
}

export function buildFactPromptSummary(store: UserFactStore, limit = 10): string | undefined {
  if (!store.facts.length) return undefined;
  const lines = store.facts.slice(0, limit).map(
    (f) => `- [${f.category}] ${f.key}=${f.value} (confidence=${f.confidence.toFixed(2)}, evidence=${f.evidenceCount})`,
  );
  return `User profile facts:\n${lines.join("\n")}`;
}

