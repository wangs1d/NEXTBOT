/**
 * 旁聊复用（2026-11-24）：侧边栏「新建旁聊」在已有零内容旁聊时不再重复新建，
 * 再次点击路由回之前那条没用过的会话。
 *
 * 覆盖：
 *  1. 新建后零内容，再次 POST 复用同一条（reused:true），注册表仍只有一条；
 *  2. 旁聊已有消息（视为已使用）后 POST，正常开出新会话；
 *  3. 显式传 title = 明确要新开，即使存在零内容旁聊也不复用。
 *
 * 注册表与线程落盘都钉到临时目录，绝不碰真实数据根。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "side-chat-reuse-test-"));
process.env.NEXTBOT_DATA_DIR = tmpDir;
process.env.SIDE_CHAT_DIR = path.join(tmpDir, "side-chats");
process.env.AGENT_CHAT_THREAD_PERSIST_FILE = path.join(tmpDir, "chat-threads.json");
process.env.AGENT_CHAT_THREAD_PERSIST_NOTES_FILE = path.join(tmpDir, "chat-threads-notes.json");

const { registerSideChatRoutes } = await import("../src/routes/http/side-chats.js");
const { getChatThreadStore } = await import("../src/external-model/chat-thread-store.js");
const { sideChatSessionId } = await import("../src/agent/master-chat-session.js");
const { getSideChatRegistry } = await import("../src/services/side-chat-registry.js");
const { default: Fastify } = await import("fastify");

const ACTOR = "reuse-actor-1";

const app = Fastify({ logger: false });
registerSideChatRoutes(app);

interface CreatedChat {
  reused?: boolean;
  chat: { id: string; sessionId: string; title: string };
}

async function postCreate(title?: string): Promise<CreatedChat> {
  const res = await app.inject({
    method: "POST",
    url: "/api/side-chats",
    payload: { actorId: ACTOR, ...(title ? { title } : {}) },
  });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body) as CreatedChat;
}

async function registryCount(): Promise<number> {
  return (await getSideChatRegistry().list(ACTOR)).length;
}

test("零内容旁聊复用：再次新建路由回同一条，不重复创建", async () => {
  const first = await postCreate();
  assert.notEqual(first.reused, true);

  const second = await postCreate();
  assert.equal(second.reused, true);
  assert.equal(second.chat.id, first.chat.id);
  assert.equal(second.chat.sessionId, sideChatSessionId(ACTOR, first.chat.id));
  assert.equal(await registryCount(), 1);
});

test("旁聊已有消息（已使用）后新建：正常开出新会话", async () => {
  const entries = await getSideChatRegistry().list(ACTOR);
  const store = getChatThreadStore();
  for (const entry of entries) {
    store.appendTurn(sideChatSessionId(ACTOR, entry.id), "sys", { text: "你好" }, "回复");
  }

  const created = await postCreate();
  assert.notEqual(created.reused, true);
  assert.notEqual(created.chat.id, entries[0]?.id);
  assert.equal(await registryCount(), entries.length + 1);
});

test("显式传 title 新建：即使存在零内容旁聊也不复用", async () => {
  const before = await registryCount();

  const created = await postCreate("开会备忘");
  assert.notEqual(created.reused, true);
  assert.equal(created.chat.title, "开会备忘");
  assert.equal(await registryCount(), before + 1);
});
