import assert from "node:assert/strict";
import { test } from "node:test";

import { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";

test("closeAll 用 1001 + server_restart 关闭全部连接并清空登记", () => {
  const registry = new WsConnectionRegistry();
  const calls: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    send(): void {},
    readyState: 1,
    close(code?: number, reason?: string): void {
      calls.push({ code, reason });
    },
  };

  registry.register("actor-a", socket, { deviceClass: "mobile" });
  registry.register("actor-b", socket, { deviceClass: "desktop" });
  assert.equal(registry.connectedSessionIds().length, 2);

  const closed = registry.closeAll();

  assert.equal(closed, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call, { code: 1001, reason: "server_restart" });
  }
  assert.equal(
    registry.connectedSessionIds().length,
    0,
    "关闭后必须摘除登记，避免重启期间还把消息投给死连接",
  );
});
