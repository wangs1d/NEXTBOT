/**
 * 记忆质量 & 召回质量评测（真实生产数据，只读副本）。
 *
 * 与 eval-memory-recall.ts 的分工：那个看线上召回锚点的统计画像；本脚本回答
 * 「已经存下来的记忆，问起来能不能被找回来」，用真实账号数据跑确定性通道：
 *   1. 档案事实寻址（结构化事实 → 当前状态块）
 *   2. 长尾偏好寻址（tail:* 事实 → 按需回忆块）
 *   3. 理解档案命中（user_understanding → 当前状态块）
 *   4. 原话重述召回（诊断项：记忆是加工品，不要求复述原句，不计入合计）
 *   5. 事件线索召回（memory_events → 按需回忆块）
 * 外加写入卫生：片段重复率、FTS 助手角色占比、长尾存量位置、经历沉淀闸门。
 *
 * 语义向量路：只读统计认知图（human-memory.sqlite）的向量覆盖与近邻建边情况，
 * 不在本进程里做推理或外网 embedding；因此这里给的是「图侧结构是否就绪」，
 * 不是端到端向量召回率——那需要线上进程持有引擎时实测。
 *
 * 运行：cd server && npx tsx scripts/eval-memory-quality.ts --actor 2378709729@qq.com
 * 输出：控制台摘要 + data/eval-memory-quality-latest.json（--no-save 跳过写盘）。
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { loadServerEnv } from "../src/config/load-server-env.js";
import { getDataDir } from "../src/config/data-dir.js";

loadServerEnv();

import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { StructuredFactStore } from "../src/agentic-memory/structured-fact-store.js";
import { UserUnderstandingStore } from "../src/agentic-memory/user-understanding-store.js";
import { AgenticMemoryFtsStore } from "../src/agentic-memory/fts-store.js";
import { EventMemoryStore } from "../src/agentic-memory/event-store.js";
import { formatEventLine } from "../src/agentic-memory/event-recall.js";
import { compileMemoryContext } from "../src/agent/memory-context-compiler.js";
import { classifyMemorySourceRole } from "../src/services/memory-source-role.js";
import { semanticFingerprint } from "../src/services/memory-record-utils.js";
import { sedimentEpisodesToFacts } from "../src/services/nightly-memory-task-service.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

const SNAPSHOT_CONSTANT_FIELDS = ["称呼"] as const;
/** 与用户历史偏好无关的日常问句：长尾召回在这一组上应保持零注入。 */
const TAIL_NEGATIVE_QUERIES = [
  "明天北京天气怎么样",
  "帮我设一个明天九点的闹钟",
  "今天好累啊",
  "把这份报表导出成 Excel",
  "帮我写一段周报",
  "午饭吃什么好",
  "讲个笑话",
  "帮我查一下顺丰快递",
  "推荐个电影",
  "今天几号",
];
const FTS_TOP_K = 8;
const EVENT_LOOKBACK_DAYS = 365;
const DEFAULT_ACTOR = "2378709729@qq.com";

type ProbeSource = "fact" | "tail" | "understanding" | "reutterance" | "episode";

type Probe = {
  source: ProbeSource;
  id: string;
  /** 模拟用户本轮的提问/重述 */
  query: string;
  /** 命中判定签名：真值内容里一段可辨识的连续文本 */
  signature: string;
};

type ChannelResult = {
  facts: boolean;
  tails: boolean;
  understanding: boolean;
  fts: boolean;
  events: boolean;
  final: boolean;
};

type ProbeResult = Probe & ChannelResult & {
  ftsAssistantShare: number;
  compileChars: number;
  candidateLines: number;
  duplicateLines: number;
};

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function normalizeText(text: string): string {
  return (text ?? "")
    .replace(/\[日志固化[^\]]*\]/g, "")
    .replace(/[\s，。！？、；：""''（）()\[\]【】~～·,.;:!?'"]+/g, "")
    .trim();
}

/** 真值签名：去掉角色前缀/标点密度后取前 14 个非空白字符。 */
function signatureOf(text: string, max = 14): string {
  const cleaned = (text ?? "")
    .replace(/\[日志固化[^\]]*\]/g, "")
    .replace(/[\s，。！？、；：""''（）()\[\]【】]+/g, "")
    .trim();
  return cleaned.slice(0, max);
}

function coreQuery(text: string, max = 60): string {
  return (text ?? "")
    .replace(/\[日志固化[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 用户原话里的高信息片段（去掉寒暄/语气词开头）。 */
function probeQueryFromUtterance(text: string): string {
  return coreQuery(
    text
      .replace(/^用户(?:说|问|要求|想|希望)?[：:]?\s*/u, "")
      .replace(/^(嗯+|哦+|啊+|好的|行|那个|然后)[，,。\s]*/u, ""),
  );
}

function factQueryFor(field: string, value: string): string {
  if (field === "称呼") return `你还记得我让你怎么称呼我吗（我叫${value}）`;
  if (field === "姓名") return `你还记得我叫什么吗（我叫${value}）`;
  if (field === "居住地") return `我现在住在哪里？`;
  return `我的${field}是什么`;
}

function tailQueryFor(subject: string, value: string): string {
  const subjectText = coreQuery(subject, 24);
  const valueText = coreQuery(
    value.replace(/^用户(?:喜欢|习惯|偏好|关注|是|称|从)/u, "").replace(/[，。].*$/u, ""),
    18,
  );
  const key = subjectText.length >= 2 ? subjectText : valueText;
  if (!key) return valueText;
  return `${key} ${valueText}`.trim();
}

function resultOf(probe: Probe): ChannelResult & { ftsAssistantShare: number } {
  return {
    facts: false,
    tails: false,
    understanding: false,
    fts: false,
    events: false,
    final: false,
    ftsAssistantShare: 0,
  };
}

/** 与 HumanLikeMemoryService.rebuildLinksForNode 同口径：同域 0.24 / 跨域 0.36。 */
const GRAPH_SAME_DOMAIN_SIM = 0.24;
const GRAPH_CROSS_DOMAIN_SIM = 0.36;
const GRAPH_VECTOR_SAMPLE = 240;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

function parseRealVector(raw: unknown): number[] | null {
  if (!raw) return null;
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) && arr.length > 8 && arr.every((x) => typeof x === "number")
      ? (arr as number[])
      : null;
  } catch {
    return null;
  }
}

/**
 * 认知图侧的联想/向量路体检：节点是否入图、向量是否真落地、够不够得到关联
 * 阈值、以及够到阈值的点对是否已有边。只读，读不到库或没有真向量时返回 null。
 */
function measureGraphRoute(
  graphDbPath: string,
  actorId: string,
  tailFactIds: string[],
): {
  nodes: number;
  edges: number;
  nodesWithVector: number;
  vectorCoverage: number;
  tailLinked: number;
  tailCoverage: number;
  isolated: number;
  avgDegree: number;
  nearBuckets: { strong: number; cross: number; same: number; none: number };
  linkedAmongNearPairs: number;
  nearPairs: number;
  associationGap: number | null;
} | null {
  if (!existsSync(graphDbPath)) return null;
  let db: Database.Database;
  try {
    db = new Database(graphDbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const nodes: any[] = [];
    for (const row of db.prepare("select json from hm_nodes").all()) {
      try {
        const n = JSON.parse(String(row.json));
        if (n?.actorId === actorId && !n.isArchived) nodes.push(n);
      } catch {
        /* 跳过坏行 */
      }
    }
    if (!nodes.length) return null;
    const edges: any[] = [];
    for (const row of db.prepare("select json from hm_edges").all()) {
      try {
        const e = JSON.parse(String(row.json));
        if (e?.actorId === actorId) edges.push(e);
      } catch {
        /* 跳过坏行 */
      }
    }

    const degree = new Map<string, number>();
    const linked = new Set<string>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
      linked.add(`${e.from}\u0000${e.to}`);
      linked.add(`${e.to}\u0000${e.from}`);
    }

    const vectored = nodes
      .map((n) => ({ id: n.id, domainId: n.domainId, vec: parseRealVector(n.vectorFingerprint) }))
      .filter((n) => n.vec);
    const tailIds = new Set(tailFactIds);
    const tailLinked = nodes.filter((n) => tailIds.has(String(n.metadata?.tailFactId ?? ""))).length;
    const isolated = nodes.filter((n) => !degree.get(n.id)).length;

    const sample = vectored.slice(0, GRAPH_VECTOR_SAMPLE);
    const nearBuckets = { strong: 0, cross: 0, same: 0, none: 0 };
    let nearPairs = 0;
    let linkedNearPairs = 0;
    for (const a of sample) {
      let best = 0;
      for (const b of vectored) {
        if (b.id === a.id || !b.vec || b.vec.length !== a.vec.length) continue;
        const sim = cosine(a.vec!, b.vec);
        if (sim > best) best = sim;
        if (sim >= GRAPH_CROSS_DOMAIN_SIM) {
          nearPairs += 1;
          if (linked.has(`${a.id}\u0000${b.id}`)) linkedNearPairs += 1;
        }
      }
      if (best >= 0.5) nearBuckets.strong += 1;
      else if (best >= GRAPH_CROSS_DOMAIN_SIM) nearBuckets.cross += 1;
      else if (best >= GRAPH_SAME_DOMAIN_SIM) nearBuckets.same += 1;
      else nearBuckets.none += 1;
    }

    return {
      nodes: nodes.length,
      edges: edges.length,
      nodesWithVector: vectored.length,
      vectorCoverage: Number((vectored.length / nodes.length).toFixed(4)),
      tailLinked,
      tailCoverage: tailFactIds.length ? Number((tailLinked / tailFactIds.length).toFixed(4)) : 0,
      isolated,
      avgDegree: Number(((edges.length * 2) / nodes.length).toFixed(2)),
      nearBuckets,
      // 每条近邻点对在统计里被正反各数一次，折半后才和实际边数同量纲
      linkedAmongNearPairs: Math.round(linkedNearPairs / 2),
      nearPairs: Math.round(nearPairs / 2),
      associationGap: nearPairs > 0 ? Number((linkedNearPairs / nearPairs).toFixed(4)) : null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const actorId = argValue("actor") ?? process.env.EVAL_ACTOR ?? DEFAULT_ACTOR;
  const dataDir = argValue("data-dir") ?? getDataDir();
  const dbPath = argValue("db") ?? join(dataDir, "agentic_memory", "agentic-memory.db");
  const saveReport = !process.argv.includes("--no-save");

  if (!existsSync(dbPath)) {
    console.error(`[eval-quality] 数据库不存在: ${dbPath}`);
    process.exit(1);
  }

  // 只读副本：backup API 会带上 WAL 内容，写测试不改生产库。
  const tmpDir = await mkdtemp(join(tmpdir(), "mem-quality-"));
  const tmpDb = join(tmpDir, "agentic-memory.db");
  const src = new Database(dbPath, { readonly: true });
  await src.backup(tmpDb);
  src.close();
  const db = openAgenticSqlite(tmpDb);

  const factsStore = new StructuredFactStore(db);
  const undStore = new UserUnderstandingStore(db);
  const fts = new AgenticMemoryFtsStore(db);
  // 事件召回取数口与线上一致（recallEvents），这里用同一份副本建 store。
  const events = new EventMemoryStore(db);

  try {
    // ---------- 真值池 ----------
    const activeFacts = factsStore.getActiveFacts(actorId, "user");
    const tailFacts = factsStore.getTailFacts(actorId);

    const legacyTailPath = join(dataDir, "user-facts", `${actorId.replace(/[@.]/g, "_")}.json`);
    const legacyTails: Array<{ kind: string; subject: string; value: string }> = [];
    if (existsSync(legacyTailPath)) {
      try {
        const parsed = JSON.parse(await readFile(legacyTailPath, "utf-8")) as {
          facts?: Array<{ kind?: string; subject?: string; value?: string }>;
        };
        for (const f of parsed.facts ?? []) {
          if (typeof f?.value === "string" && f.value.trim()) {
            legacyTails.push({
              kind: String(f.kind ?? "fact"),
              subject: String(f.subject ?? ""),
              value: f.value.trim(),
            });
          }
        }
      } catch {
        /* 文件损坏时按无存量处理 */
      }
    }

    const noteRows = undStore.getActiveUnderstandings(actorId);
    const ledgerRows = db
      .prepare(
        `SELECT claim, created_at FROM ledger_records
         WHERE actor_id = ? AND superseded_by IS NULL
         ORDER BY created_at DESC LIMIT 400`,
      )
      .all(actorId) as Array<{ claim: string; created_at: string }>;
    const episodeRows = db
      .prepare(
        `SELECT id, observation, source_kind, created_at FROM life_episodes
         WHERE actor_id = ? ORDER BY created_at DESC LIMIT 300`,
      )
      .all(actorId) as Array<{
      id: string;
      observation: string;
      source_kind: string | null;
      created_at: string;
    }>;

    // ---------- 探针 ----------
    const probes: Probe[] = [];

    for (const f of activeFacts) {
      probes.push({
        source: "fact",
        id: `fact:${f.field}`,
        query: factQueryFor(f.field, f.value),
        signature: signatureOf(f.value),
      });
    }

    for (const t of tailFacts) {
      probes.push({
        source: "tail",
        id: `tail:${t.field}`,
        query: tailQueryFor(t.field, t.value),
        signature: signatureOf(t.value),
      });
    }
    // 结构化库已有长尾时不再探 JSON 副本（迁移后 JSON 只是只读历史，
    // 同一内容二次探针会重复计数）；结构化为空时才用 JSON 存量做基线。
    for (const t of tailFacts.length === 0 ? legacyTails : []) {
      probes.push({
        source: "tail",
        id: `tail-json:${t.kind}:${t.subject}`,
        query: tailQueryFor(t.subject, t.value),
        signature: signatureOf(t.value),
      });
    }

    for (const n of noteRows) {
      probes.push({
        source: "understanding",
        id: `und:${n.topic}`,
        query: `关于${n.topic}的事你还记得吗`,
        signature: signatureOf(n.note),
      });
    }

    const seenUtterance = new Set<string>();
    for (const row of ledgerRows) {
      if (classifyMemorySourceRole(row.claim) !== "user") continue;
      const query = probeQueryFromUtterance(row.claim);
      const signature = signatureOf(row.claim);
      if (!query || !signature || seenUtterance.has(signature)) continue;
      seenUtterance.add(signature);
      probes.push({
        source: "reutterance",
        id: `utt:${signature.slice(0, 8)}`,
        query,
        signature,
      });
    }

    const seenEpisode = new Set<string>();
    for (const row of episodeRows) {
      const m = row.observation.match(/userRequest="([^"]{2,80})"/);
      const request = m?.[1] ?? "";
      if (!request) continue;
      const signature = signatureOf(request);
      if (!signature || seenEpisode.has(signature)) continue;
      seenEpisode.add(signature);
      probes.push({
        source: "episode",
        id: `ep:${signature.slice(0, 8)}`,
        query: request,
        signature,
      });
    }

    // ---------- 逐探针跑通道 + 编译 ----------
    const now = Date.now();
    const from = new Date(now - EVENT_LOOKBACK_DAYS * 86_400_000).toISOString();
    const results: ProbeResult[] = [];
    let ftsCandidateRows = 0;
    let ftsAssistantRows = 0;

    for (const probe of probes) {
      const r = resultOf(probe);
      const sigNorm = normalizeText(probe.signature);

      // 1) 档案事实：与 prompt-context-builder 同口径（T2 命中 + 恒带称呼）。
      const t2 = factsStore.matchFactsInText(actorId, probe.query, "user");
      const whitelist = new Set<string>(SNAPSHOT_CONSTANT_FIELDS);
      for (const f of t2) whitelist.add(f.field);
      const factsBlock = factsStore.renderForPrompt(
        actorId,
        new Set(t2.map((f) => f.field)),
        "user",
        { fields: whitelist },
      );

      // 2) 长尾事实：按需召回（未接入该通道时为 undefined）。
      const tailBlock = (
        factsStore as unknown as {
          renderTailRecallBlock?: (a: string, q: string) => string | undefined;
        }
      ).renderTailRecallBlock?.(actorId, probe.query);

      // 3) 理解档案：onlyMatched 与线上一致。
      const matchedTopics = undStore.matchTopicsInText(actorId, probe.query);
      const undBlock = undStore.renderForPrompt(
        actorId,
        new Set(matchedTopics.map((n) => n.topic.trim())),
        { onlyMatched: true },
      );

      // 4) 词法通道（FTS）。
      const ftsHits = fts.search(actorId, probe.query, { context: "main", topK: FTS_TOP_K });
      let assistantInTopK = 0;
      for (const hit of ftsHits) {
        ftsCandidateRows += 1;
        if (classifyMemorySourceRole(hit.content) === "assistant") {
          ftsAssistantRows += 1;
          assistantInTopK += 1;
        }
      }
      r.ftsAssistantShare = ftsHits.length > 0 ? assistantInTopK / ftsHits.length : 0;

      // 5) 事件线索（与 buildEventRecallBlock 的取数同一口）。
      const eventHits = events.recallEvents({
        actorId,
        from,
        query: probe.query,
        limit: 8,
      });
      const eventBlock =
        eventHits.length > 0
          ? [
              "【事件回忆】",
              ...eventHits.slice(0, 6).map((e) => `- ${formatEventLine(e, now)}`),
            ].join("\n")
          : undefined;

      // 6) 词法召回文本（模拟 narrativeRecall 候选；Mem0 路不在脚本内）。
      const recallBlock =
        ftsHits.length > 0
          ? [
              `NR|hits=${ftsHits.length}`,
              ...ftsHits.map((h, i) => `- r${i + 1}|${h.content}`),
            ].join("\n")
          : undefined;

      // 通道命中
      r.facts = Boolean(factsBlock && normalizeText(factsBlock).includes(sigNorm));
      r.tails = Boolean(tailBlock && normalizeText(tailBlock).includes(sigNorm));
      r.understanding = Boolean(undBlock && normalizeText(undBlock).includes(sigNorm));
      r.fts = ftsHits.some((h) => normalizeText(h.content).includes(sigNorm));
      r.events = Boolean(eventBlock && normalizeText(eventBlock).includes(sigNorm));

      // 7) 编译：与 PromptContextBuilder 相同的候选字段语义。
      const memory = {
        currentTime: "2026-11-20 20:00",
        ...(factsBlock ? { userFacts: factsBlock } : {}),
        ...(undBlock ? { userUnderstanding: undBlock } : {}),
        ...(tailBlock ? { tailFactsRecall: tailBlock } : {}),
        ...(eventBlock ? { eventRecall: eventBlock } : {}),
        ...(recallBlock ? { narrativeRecall: recallBlock } : {}),
      } as unknown as AgentPromptMemoryContext;
      const compiled = compileMemoryContext(memory, now);
      const finalText = normalizeText(
        [compiled.memory.memoryCurrentState, compiled.memory.memoryPending, compiled.memory.memoryRecall]
          .filter(Boolean)
          .join("\n"),
      );
      r.final = finalText.includes(sigNorm);

      // 冗余度量：候选行指纹重复数（编译前去重压力）。
      const candidateLines = [factsBlock, undBlock, tailBlock, eventBlock, recallBlock]
        .filter((b): b is string => Boolean(b))
        .flatMap((b) => b.split("\n"))
        .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
        .filter((l) => l.length >= 4 && !/^【/.test(l) && !/^[（(]/.test(l));
      const seenFp = new Set<string>();
      let duplicates = 0;
      for (const line of candidateLines) {
        const fp = semanticFingerprint(line) || line;
        if (seenFp.has(fp)) duplicates += 1;
        else seenFp.add(fp);
      }

      results.push({
        ...probe,
        ...r,
        compileChars: compiled.chars,
        candidateLines: candidateLines.length,
        duplicateLines: duplicates,
      });
    }

    // ---------- 经历沉淀（写侧能力验证；只写临时副本） ----------
    const sediment = sedimentEpisodesToFacts(
      factsStore,
      actorId,
      episodeRows.map((r) => ({
        id: r.id,
        observation: r.observation,
        sourceKind: r.source_kind,
        createdAt: r.created_at,
      })),
      "NightlyMemoryTaskService",
    );
    const sedimentByReason: Record<string, number> = {};
    for (const d of sediment.decisions) {
      sedimentByReason[d.reason] = (sedimentByReason[d.reason] ?? 0) + 1;
    }
    const sedimentProbes = sediment.decisions.filter((d) => d.accepted);
    const sedimentHits = sedimentProbes.filter((d) => {
      const block = factsStore.renderTailRecallBlock(actorId, d.text);
      const wanted = d.core;
      return Boolean(block && normalizeText(block).includes(normalizeText(wanted)));
    }).length;

    // ---------- 汇总 ----------
    const bySource = (source: ProbeSource) => {
      const list = results.filter((r) => r.source === source);
      const hit = list.filter((r) => r.final).length;
      const channel = (key: keyof ChannelResult) => list.filter((r) => r[key]).length;
      return {
        probes: list.length,
        finalHit: hit,
        finalRate: list.length ? Number((hit / list.length).toFixed(4)) : null,
        facts: channel("facts"),
        tails: channel("tails"),
        understanding: channel("understanding"),
        fts: channel("fts"),
        events: channel("events"),
      };
    };

    const episodeTotal = episodeRows.length;
    const episodeUnique = new Set(
      episodeRows.map((r) => `${r.source_kind ?? ""}\u0000${normalizeText(r.observation)}`),
    ).size;

    // ── 联想/向量路（认知图，只读打开生产库的 WAL 快照，零写入零外网）──
    // 这一路过去完全没有数据：长尾事实根本不入图，向量近邻也没人量过。
    const graph = measureGraphRoute(
      join(dataDir, "human-memory.sqlite"),
      actorId,
      tailFacts.map((t) => t.id),
    );

    const tailRenderer = factsStore as unknown as {
      renderTailRecallBlock?: (a: string, q: string) => string | undefined;
    };
    const falseTailHits = TAIL_NEGATIVE_QUERIES.filter((q) =>
      Boolean(tailRenderer.renderTailRecallBlock?.(actorId, q)),
    ).length;

    // 合计口径（2026-11-20 定）：记忆是加工品，原话复述不参与评分，只留作
    // 词法通道诊断——字面找回率低不等于记忆缺失。
    const RATED_SOURCES: ProbeSource[] = ["fact", "tail", "understanding", "episode"];
    const ratedResults = results.filter((r) => RATED_SOURCES.includes(r.source));
    const totalFinal = ratedResults.filter((r) => r.final).length;
    const avgChars = results.length
      ? Math.round(results.reduce((s, r) => s + r.compileChars, 0) / results.length)
      : 0;
    const candidateTotal = results.reduce((s, r) => s + r.candidateLines, 0);
    const duplicateTotal = results.reduce((s, r) => s + r.duplicateLines, 0);

    const report = {
      generatedAt: new Date().toISOString(),
      actorId,
      dbPath,
      memoryScale: {
        profileFacts: activeFacts.length,
        tailFactsStructured: tailFacts.length,
        tailFactsLegacyJson: legacyTails.length,
        understandings: noteRows.length,
        ledgerUserLines: results.filter((r) => r.source === "reutterance").length,
        episodes: episodeTotal,
      },
      writeHygiene: {
        episodeDuplicateRate:
          episodeTotal > 0 ? Number(((episodeTotal - episodeUnique) / episodeTotal).toFixed(4)) : 0,
        ftsRows: fts.stats().rows,
        ftsAssistantShareInTopK:
          ftsCandidateRows > 0 ? Number((ftsAssistantRows / ftsCandidateRows).toFixed(4)) : 0,
        tailFalseInjectionRate: Number((falseTailHits / TAIL_NEGATIVE_QUERIES.length).toFixed(4)),
      },
      recall: {
        probes: ratedResults.length,
        finalHit: totalFinal,
        finalRate: ratedResults.length
          ? Number((totalFinal / ratedResults.length).toFixed(4))
          : null,
        ratedSources: RATED_SOURCES,
        avgCompiledChars: avgChars,
        candidateLines: candidateTotal,
        duplicateCandidateLines: duplicateTotal,
        duplicateRate:
          candidateTotal > 0 ? Number((duplicateTotal / candidateTotal).toFixed(4)) : 0,
        bySource: {
          fact: bySource("fact"),
          tail: bySource("tail"),
          understanding: bySource("understanding"),
          reutterance: bySource("reutterance"),
          episode: bySource("episode"),
        },
      },
      graph,
      sediment: {
        episodes: episodeRows.length,
        applied: sediment.applied,
        covered: sediment.covered,
        rejected: sediment.rejected,
        deferred: sediment.deferred,
        byReason: sedimentByReason,
        recallProbe: {
          probes: sedimentProbes.length,
          hit: sedimentHits,
          rate: sedimentProbes.length
            ? Number((sedimentHits / sedimentProbes.length).toFixed(4))
            : null,
        },
      },
    };

    console.log("════════════════════════════════════════════════════════");
    console.log(` 记忆质量评测 · ${report.generatedAt}`);
    console.log(` actor=${actorId}`);
    console.log("════════════════════════════════════════════════════════");
    console.log(
      ` 规模: 档案事实 ${activeFacts.length} · 长尾(结构化) ${tailFacts.length} · 长尾(JSON) ${legacyTails.length}` +
        ` · 理解 ${noteRows.length} · 事件 ${eventHitsTotal(events, actorId, from)} · 片段 ${episodeTotal}`,
    );
    console.log(
      ` 写入卫生: 片段重复率 ${(report.writeHygiene.episodeDuplicateRate * 100).toFixed(1)}%` +
        ` · FTS 助手行占比 ${(report.writeHygiene.ftsAssistantShareInTopK * 100).toFixed(1)}%` +
        ` · 长尾误注入 ${(report.writeHygiene.tailFalseInjectionRate * 100).toFixed(1)}%`,
    );
    console.log("────────────────────────────────────────────────────────");
    const rated = (name: string): boolean =>
      (RATED_SOURCES as string[]).includes(name);
    for (const [name, s] of Object.entries(report.recall.bySource)) {
      if (!s.probes) continue;
      console.log(
        ` ${name.padEnd(14)} 探针 ${String(s.probes).padStart(3)} · 最终命中 ${String(s.finalHit).padStart(3)}` +
          ` (${((s.finalRate ?? 0) * 100).toFixed(1)}%)` +
          (rated(name) ? "" : "（诊断项，不计入合计）"),
      );
    }
    console.log(
      ` 合计: ${totalFinal}/${ratedResults.length}` +
        ` (${((report.recall.finalRate ?? 0) * 100).toFixed(1)}%)` +
        ` · 平均编译 ${avgChars} 字 · 候选行重复率 ${(report.recall.duplicateRate * 100).toFixed(1)}%`,
    );
    console.log(
      ` 经历沉淀: 片段 ${episodeRows.length} · 新增 ${sediment.applied} · 已覆盖 ${sediment.covered}` +
        ` · 未采纳 ${sediment.rejected} · 沉淀事实召回 ${sedimentHits}/${sedimentProbes.length}`,
    );
    if (graph) {
      console.log(
        ` 联想/向量路: 图节点 ${graph.nodes} · 边 ${graph.edges} · 真向量 ${graph.nodesWithVector}` +
          ` (${(graph.vectorCoverage * 100).toFixed(1)}%) · 平均度 ${graph.avgDegree} · 孤立 ${graph.isolated}` +
          ` · 长尾入图 ${graph.tailLinked}/${tailFacts.length}`,
      );
      console.log(
        ` 向量近邻(样本 ${GRAPH_VECTOR_SAMPLE}): ≥0.50 ${graph.nearBuckets.strong}` +
          ` · ≥0.36 ${graph.nearBuckets.cross} · ≥0.24 ${graph.nearBuckets.same}` +
          ` · 无近邻 ${graph.nearBuckets.none}` +
          ` · 够到阈值的点对已建边 ${graph.linkedAmongNearPairs}/${graph.nearPairs}` +
          (graph.associationGap === null
            ? ""
            : ` (${(graph.associationGap * 100).toFixed(1)}%)`),
      );
    } else {
      console.log(" 联想/向量路: 认知图库不可读，跳过");
    }

    if (saveReport) {
      const outPath = join(dataDir, "eval-memory-quality-latest.json");
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify({ ...report, results }, null, 2)}\n`, "utf-8");
      console.log(`\n[eval-quality] 报告已写入 ${outPath}`);
    }
  } finally {
    db.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function eventHitsTotal(events: EventMemoryStore, actorId: string, from: string): number {
  try {
    return events.recallEvents({ actorId, from, limit: 200 }).length;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error("[eval-quality] 运行失败:", err);
  process.exit(1);
});
