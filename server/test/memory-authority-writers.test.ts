/**
 * 记忆写入口静态审计（2026-11-13 重切）
 *
 * 存在的理由：memory-authority.ts 的运行时断言只能拦住"已经被登记的写点
 * 越权"，拦不住**新增**的写点——有人新开一条直写 structured_facts 的 SQL、
 * 或者换个模块调 memory.add，契约根本不会响。这正是「记忆被到处写」的
 * 结构性成因：规则只写在文档里，没有机制守住。
 *
 * 本测试把规则变成 CI 可执行的事实：
 *   1. 每类存储的写入口有且只有已登记的文件（白名单**从注册表派生**，不另抄一份）；
 *   2. 注册表里登记的每个生产者都对应真实存在的文件（登记不是幻觉）；
 *   3. 直接 SQL 写权威表只允许权威模块自己（绕过 store API = bug）。
 *
 * 新增写点时，正确做法是在对应 store 的 API 上加 writer 参数并登记 producer，
 * 然后在注册表里加一行——而不是直接写 SQL 绕过。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MEMORY_AUTHORITY, type MemorySlotId } from "../src/memory/memory-authority.js";

const SRC_ROOT = path.resolve(fileURLToPath(new URL("../src", import.meta.url)));

/** 递归收集 src 下所有 .ts 源文件（相对 SRC_ROOT 的 posix 路径） */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(path.relative(SRC_ROOT, full).split(path.sep).join("/"));
  }
  return acc;
}

const SOURCES = collectSources(SRC_ROOT);
const SOURCE_SET = new Set(SOURCES);

/** 扫描所有源文件，返回命中规则的文件集合 */
function filesMatching(pattern: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const rel of SOURCES) {
    const text = fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
    // 跳过纯注释行（契约文档里会写到这些存储名，不能算写点）
    const code = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    const n = pattern.test(code) ? (code.match(new RegExp(pattern.source, "g")) ?? []).length : 0;
    if (n > 0) out.set(rel, n);
  }
  return out;
}

type WriteRule = {
  /** 注册表里的槽位（白名单从注册表派生） */
  slot?: MemorySlotId;
  /** 不在权威契约里的存储（单写者 / 已登记的历史例外）——显式列出文件 */
  allowedFiles?: readonly string[];
  /**
   * 白名单范围：
   * - producers：槽位登记的全部生产者文件（谁都可以经 owner 写）
   * - owner：只有权威模块自己（用于「直写 SQL / 绕过 store API」这类窄规则）
   */
  scope: "producers" | "owner";
  /** 命中即视为写点 */
  pattern: RegExp;
  /** 说明为什么这些文件有权写 */
  why: string;
};

/** 槽位白名单（从注册表派生） */
function allowedFor(rule: WriteRule): string[] {
  if (rule.allowedFiles) return [...rule.allowedFiles];
  const spec = MEMORY_AUTHORITY[rule.slot!];
  if (rule.scope === "owner") return [spec.owner];
  return [...new Set(spec.producers.map((p) => p.file))];
}

const WRITE_RULES: readonly WriteRule[] = [
  {
    slot: "mem0",
    scope: "owner",
    pattern: /\bmemory\.add\(/g,
    why: "Mem0 的唯一物理写入口。其它模块要写必须经 ingest 的 writer 契约参数，不得直接调 memory.add",
  },
  {
    slot: "structured_facts",
    scope: "producers",
    pattern: /\bapplyFact\(/g,
    why: "档案字段写入口：统一抽取写钩子、夜间画像批钩子、画像聚合器、画像管理接口、引导流程",
  },
  {
    slot: "structured_facts",
    scope: "owner",
    pattern: /(?:INSERT INTO|UPDATE|DELETE FROM)\s+structured_facts/g,
    why: "structured_facts 表的直接 SQL 写只允许权威 store 自己；其它模块必须走 applyFact",
  },
  {
    slot: "user_understanding",
    scope: "owner",
    pattern: /(?:INSERT INTO|UPDATE|DELETE FROM)\s+user_understanding/g,
    why: "理解档案表的直接 SQL 写只允许权威 store 自己",
  },
  {
    slot: "life_models",
    scope: "owner",
    pattern: /(?:INSERT INTO|UPDATE|DELETE FROM)\s+life_/g,
    why: "生活模型表的直接 SQL 写只允许权威 store 自己",
  },
  {
    allowedFiles: ["agentic-memory/ledger.ts"],
    scope: "owner",
    pattern: /(?:INSERT INTO|UPDATE|DELETE FROM)\s+ledger_records/g,
    why:
      "声明账本表：单写者存储（AgenticLedger），无竞争写点，因此不进权威契约；" +
      "直接 SQL 写只允许它自己",
  },
  {
    slot: "memory_events",
    scope: "owner",
    pattern: /(?:INSERT INTO|UPDATE|DELETE FROM)\s+memory_events/g,
    why: "事件流水表的直接 SQL 写只允许权威 store 自己",
  },
  {
    slot: "commitments",
    scope: "owner",
    pattern: /(?:INSERT INTO|UPDATE|DELETE FROM)\s+commitments/g,
    why: "承诺表的直接 SQL 写只允许权威 store 自己",
  },
  {
    slot: "memory_summary",
    scope: "producers",
    pattern: /\b(?:replaceSummaryLines|appendMemorySummaryLine)\(/g,
    why: "KV memory_summary 的写入口（都经 AgentMemorySyncService 这唯一 owner）",
  },
  {
    allowedFiles: ["services/user-fact-store.ts", "services/nightly-memory-task-service.ts"],
    scope: "owner",
    pattern: /\bupsertFact\(/g,
    why:
      "行式 JSON 事实库的写入口。该库是档案字段的**遗留投影面**（契约里 structured_facts " +
      "的 forbiddenWrites 已登记它），当前仅夜间巩固在写——迁移到权威库后应只剩定义处。",
  },
];

test("写入口白名单：每类存储的写点都在已登记文件内", () => {
  const violations: string[] = [];
  for (const rule of WRITE_RULES) {
    const hits = filesMatching(rule.pattern);
    const allowed = allowedFor(rule);
    for (const [file] of hits) {
      if (!allowed.includes(file)) {
        violations.push(
          `${rule.slot ?? rule.allowedFiles?.join(",")}: ${file} 直接写了受管存储（规则：${rule.why}）。` +
            `合法写者：${allowed.join(", ")}`,
        );
      }
    }
    // 反向：白名单里的文件必须真的有写点（否则白名单过期了）
    if (rule.scope === "producers") {
      for (const file of allowed) {
        if (!hits.has(file)) {
          violations.push(
            `${rule.slot}: 白名单里的 ${file} 已无写点（规则过期，请同步删除）`,
          );
        }
      }
    }
  }
  assert.deepEqual(violations, [], `写入口白名单被突破:\n${violations.join("\n")}`);
});

test("写入口白名单：没有存储被完全绕过 store API 直写 SQL", () => {
  // 权威表必须只有一个文件能直写 SQL。若将来拆表，这里要同步扩展。
  const sqlOwners = new Map<string, string[]>();
  for (const rule of WRITE_RULES) {
    if (!rule.pattern.source.includes("INSERT INTO")) continue;
    const files = [...filesMatching(rule.pattern).keys()];
    sqlOwners.set(rule.slot ?? rule.allowedFiles?.join(",") ?? "?", files);
  }
  for (const [slot, files] of sqlOwners) {
    assert.ok(files.length <= 1, `${slot} 的直接 SQL 写出现在 ${files.length} 个文件：${files.join(", ")}`);
  }
});

test("注册表：登记的每个生产者都对应真实存在的文件（登记不是幻觉）", () => {
  const missing: string[] = [];
  for (const [slot, spec] of Object.entries(MEMORY_AUTHORITY)) {
    if (!SOURCE_SET.has(spec.owner)) {
      missing.push(`${slot} 的 owner 文件不存在：${spec.owner}`);
    }
    for (const producer of spec.producers) {
      if (!SOURCE_SET.has(producer.file)) {
        missing.push(`${slot} 的 producer「${producer.id}」文件不存在：${producer.file}`);
      }
    }
  }
  assert.deepEqual(missing, [], `注册表登记了不存在的文件:\n${missing.join("\n")}`);
});

test("注册表：每个槽位都有 owner、authority、至少一个 producer，且 owner 在其中", () => {
  for (const [slot, spec] of Object.entries(MEMORY_AUTHORITY)) {
    assert.ok(spec.owner.trim().length > 0, `${slot} 缺 owner`);
    assert.ok(spec.authority.trim().length > 0, `${slot} 缺 authority`);
    assert.ok(spec.producers.length > 0, `${slot} 缺 producer`);
    assert.ok(
      spec.producers.some((p) => p.file === spec.owner),
      `${slot} 的 owner「${spec.owner}」不在 producers 里`,
    );
    for (const forbidden of spec.forbiddenWrites ?? []) {
      assert.notEqual(forbidden, spec.authority, `${slot} 权威源被列进禁止清单`);
    }
  }
});

test("注册表：只登记有竞争写点的存储（单写者不进契约）", () => {
  for (const [slot, spec] of Object.entries(MEMORY_AUTHORITY)) {
    const hasCompetition =
      spec.producers.length > 1 || (spec.forbiddenWrites?.length ?? 0) > 0;
    assert.ok(
      hasCompetition,
      `${slot} 只有一个生产者且没有禁止写入清单——它不可能违反「唯一 owner」契约，` +
        `登记进去只是维护面`,
    );
  }
});

test("注册表：knownViolations 必须是 forbiddenWrites 的子集（例外不能凭空开洞）", () => {
  for (const [slot, spec] of Object.entries(MEMORY_AUTHORITY)) {
    for (const violation of spec.knownViolations ?? []) {
      assert.ok(
        (spec.forbiddenWrites ?? []).includes(violation),
        `${slot} 的 knownViolations「${violation}」不在 forbiddenWrites 里`,
      );
    }
  }
});

test("注册表：语义域收敛（域只是分组，断言单位是槽位）", () => {
  const domains = new Set(Object.values(MEMORY_AUTHORITY).map((s) => s.domain));
  assert.ok(domains.size <= 8, `语义域不应无限膨胀，当前 ${domains.size} 个`);
  assert.ok(Object.keys(MEMORY_AUTHORITY).length <= 12, "存储槽位数量应保持在可维护范围");
});
