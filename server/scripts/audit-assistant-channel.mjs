/**
 * assistant 通道纯净性真实数据审计（2026-10-13，一次性脚本）。
 *
 * 对真实落库线程做两层扫描：
 *   1) 原始落盘层：JSON 里 role==="assistant" 且 content 含内部帧标签的消息数
 *      （= 存量脏数据，等待运行时迁移）；
 *   2) 运行时恢复层：用真实 ChatThreadStore 走 restoreThreadFromPersistence
 *      迁移路径加载每个会话后再扫（= 模型真正看到的 prompt 内容，必须为 0）。
 *
 * 只读：restore 不触发 scheduleSave；且跑在临时副本上，绝不碰原文件。
 */
import { readFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERNAL_FRAME_TAGS } from "../src/external-model/internal-frames.ts";

const TAGS = INTERNAL_FRAME_TAGS;
if (!TAGS.includes("上一轮回复中断")) {
  console.error("TAG import failed");
  process.exit(1);
}

function scanRaw(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const sessions = raw.sessions ?? {};
  const report = { sessions: 0, assistantMsgs: 0, dirty: [], byTag: {} };
  for (const [sid, entry] of Object.entries(sessions)) {
    report.sessions++;
    const msgs = Array.isArray(entry) ? entry : entry?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      report.assistantMsgs++;
      const c = typeof m.content === "string" ? m.content : "";
      for (const tag of TAGS) {
        if (c.includes(`[${tag}`)) {
          report.dirty.push({ sid, tag, preview: c.slice(0, 60) });
          report.byTag[tag] = (report.byTag[tag] ?? 0) + 1;
        }
      }
    }
  }
  return report;
}

function scanRuntime(path, sessions) {
  return (async () => {
    const { ChatThreadStore } = await import("../src/external-model/chat-thread-store.ts");
    const { ChatThreadPersistence } = await import("../src/external-model/chat-thread-persist.ts");
    const persist = new ChatThreadPersistence(path, path.replace(".json", "-notes.json"));
    // 必须先等初始 load 完成，否则 thread() 走空线程分支（假阴性）
    await persist.load();
    const store = new ChatThreadStore(persist);
    let assistantMsgs = 0;
    const dirty = [];
    for (const sid of sessions) {
      const msgs = store.thread(sid, "sys");
      if (!Array.isArray(msgs) || msgs.length <= 1) continue;
      for (const m of msgs) {
        if (m.role !== "assistant") continue;
        assistantMsgs++;
        const c = typeof m.content === "string" ? m.content : "";
        for (const tag of TAGS) {
          if (c.includes(`[${tag}`)) {
            dirty.push({ sid, tag, preview: c.slice(0, 60) });
          }
        }
      }
    }
    return { assistantMsgs, dirty, sessionsScanned: sessions.length };
  })();
}

const sources = [
  ["server/data/chat-threads.json", "E:/ws-project/Private-Agent/server/data/chat-threads.json"],
  ["server/data/chat-threads-notes.json", "E:/ws-project/Private-Agent/server/data/chat-threads-notes.json"],
  ["root data/chat-threads.json", "E:/ws-project/Private-Agent/data/chat-threads.json"],
];

const dir = mkdtempSync(join(tmpdir(), "thread-audit-"));
try {
  for (const [label, src] of sources) {
    let raw;
    try {
      raw = readFileSync(src, "utf8");
    } catch {
      console.log(`\n[${label}] 文件不存在，跳过`);
      continue;
    }
    const copy = join(dir, label.replace(/[^\w.-]/g, "_"));
    copyFileSync(src, copy);
    const r1 = scanRaw(copy);
    console.log(`\n[${label}] 落盘层: sessions=${r1.sessions} assistant消息=${r1.assistantMsgs} 帧残留=${r1.dirty.length}`);
    if (r1.dirty.length) {
      console.log("  byTag:", JSON.stringify(r1.byTag));
      for (const d of r1.dirty.slice(0, 5)) console.log(`   - [${d.tag}] ${d.sid}: ${d.preview}`);
    }
    const sessionIds = Object.keys(JSON.parse(raw).sessions ?? {});
    const r2 = await scanRuntime(copy, sessionIds);
    console.log(`[${label}] 运行时恢复层(迁移后): assistant消息=${r2.assistantMsgs} 帧残留=${r2.dirty.length} ${r2.dirty.length === 0 ? "✅" : "❌"}`);
    if (r2.dirty.length) for (const d of r2.dirty.slice(0, 5)) console.log(`   - [${d.tag}] ${d.sid}: ${d.preview}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
