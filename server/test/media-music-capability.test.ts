import assert from "node:assert/strict";
import test from "node:test";

import { MediaMusicService } from "../src/services/media-music-service.js";
import {
  clearClientCapabilities,
  clientSupportsCapability,
  declaredClientCapabilities,
  declareClientCapabilities,
} from "../src/services/client-capability-registry.js";

/**
 * 2026-09-12 诚实化回归锁：客户端未实现 agent.media.play 处理时（未声明
 * mediaPlayback 能力），media.play 不得假成功——历史上 push「成功」后模型向
 * 用户宣称「歌已经放上了」，实际什么都没响。
 */
function createServiceWithRecorder() {
  const sent: string[] = [];
  const service = new MediaMusicService({
    trySend: (_actorId: string, data: string) => {
      sent.push(data);
      return true;
    },
    isOnline: () => true,
  });
  return { service, sent };
}

test("media.play fails honestly when client did not declare mediaPlayback", async () => {
  const actorId = `cap-test-off-${Date.now()}`;
  const { service, sent } = createServiceWithRecorder();

  const result = await service.play("123456", actorId, { name: "影月" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /mediaPlayback/);
    assert.match(result.error, /desktop\.open/);
  }
  assert.equal(sent.length, 0, "不得向不支持播放的客户端推送播放事件");
});

test("media.play pushes normally after client declares mediaPlayback", async () => {
  const actorId = `cap-test-on-${Date.now()}`;
  declareClientCapabilities(actorId, { mediaPlayback: true });
  try {
    const { service, sent } = createServiceWithRecorder();

    const result = await service.play("123456", actorId, { name: "影月", artist: "李文佳" });

    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /agent\.media\.play|AgentMediaPlay/);
  } finally {
    clearClientCapabilities(actorId);
  }
});

test("capability declaration expires / clears back to honest failure", async () => {
  const actorId = `cap-test-clear-${Date.now()}`;
  declareClientCapabilities(actorId, { mediaPlayback: true });
  clearClientCapabilities(actorId);

  const { service } = createServiceWithRecorder();
  const result = await service.play("1", actorId);
  assert.equal(result.ok, false);
});

// 能力登记表：键名任意、只认严格 true；未声明键 fail-closed。
test("capability registry stores arbitrary declared keys and fails closed", () => {
  const actorId = `cap-test-reg-${Date.now()}`;
  declareClientCapabilities(actorId, {
    mediaPlayback: true,
    sharedBrowserPanel: true,
    someFutureThing: "yes",
    brokenFlag: false,
  });
  try {
    assert.equal(clientSupportsCapability(actorId, "mediaPlayback"), true);
    assert.equal(clientSupportsCapability(actorId, "sharedBrowserPanel"), true);
    assert.equal(clientSupportsCapability(actorId, "someFutureThing"), false, "非严格 true 不算声明");
    assert.equal(clientSupportsCapability(actorId, "brokenFlag"), false);
    assert.equal(clientSupportsCapability(actorId, "neverDeclared"), false);
    assert.deepEqual(
      declaredClientCapabilities(actorId).sort(),
      ["mediaPlayback", "sharedBrowserPanel"],
    );
    // 重连整体覆盖：新声明里没有的键即撤销
    declareClientCapabilities(actorId, { mediaPlayback: true });
    assert.equal(clientSupportsCapability(actorId, "sharedBrowserPanel"), false);
  } finally {
    clearClientCapabilities(actorId);
  }
});

test("undeclared actor has empty capability set", () => {
  assert.deepEqual(declaredClientCapabilities(`cap-test-none-${Date.now()}`), []);
  assert.equal(clientSupportsCapability(`cap-test-none-${Date.now()}`, "mediaPlayback"), false);
});
