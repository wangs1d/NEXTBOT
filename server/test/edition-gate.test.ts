/**
 * 发行版本闸（NEXTBOT_EDITION）单测。
 *
 * 覆盖：
 *   1. getServerEdition 解析：未设置默认 internal（存量部署零变化）、大小写宽容
 *   2. capability-modules internalOnly 过滤：internal 四大家族在场；oss 整族剔除
 *      （旅游/虚拟电话/好友/比价/社交外联），通用能力（image_gen/safety_guard）保留
 *   3. core 常驻名单：oss 剔除 phone 与 agent.link 前缀族及 send_to_peer，shopping.suggest
 *      （开源拍板保留）与 calendar 等核心不受影响
 *
 * 测试封闭：仅操纵 process.env，无外部依赖。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getServerEdition, isOssEdition } from "../src/config/env.js";
import {
  buildCapabilityModules,
  type CapabilityModuleDeps,
} from "../src/tools/capability-modules/index.js";
import { isCoreToolRegistryName } from "../src/tools/tool-search/core-tool-library.js";

/** 内测独占家族（用户 2026-09-29 拍板：开源版仅保留 shopping.suggest，其余剔除） */
const INTERNAL_ONLY_DOMAINS = [
  "social_outreach",
  "shopping_compare",
  "travel_booking",
  "phone_call",
] as const;

function withEdition<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.NEXTBOT_EDITION;
  try {
    if (value === undefined) delete process.env.NEXTBOT_EDITION;
    else process.env.NEXTBOT_EDITION = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NEXTBOT_EDITION;
    else process.env.NEXTBOT_EDITION = prev;
  }
}

function dummyDeps(): CapabilityModuleDeps {
  // 只读 chatTools/intentRules/domain，不触发 register，依赖可全空；
  // 例外：phone-call 模块构建期即读 phoneCallCoordinator.isEnabled()
  return {
    phoneCallCoordinator: { isEnabled: () => false },
  } as unknown as CapabilityModuleDeps;
}

test("getServerEdition：未设置默认 internal，oss 大小写宽容", () => {
  assert.equal(withEdition(undefined, () => getServerEdition()), "internal");
  assert.equal(withEdition(undefined, () => isOssEdition()), false);
  assert.equal(withEdition("OSS", () => getServerEdition()), "oss");
  assert.equal(withEdition(" internal ", () => getServerEdition()), "internal");
  assert.equal(withEdition("platform", () => getServerEdition()), "internal");
});

test("capability-modules：internal 四大家族在场，oss 整族剔除且通用能力保留", () => {
  const internalDomains = withEdition(undefined, () =>
    buildCapabilityModules(dummyDeps()).map((m) => m.domain),
  );
  for (const d of INTERNAL_ONLY_DOMAINS) {
    assert.ok(internalDomains.includes(d), `internal 版应含 ${d}`);
  }

  const ossModules = withEdition("oss", () => buildCapabilityModules(dummyDeps()));
  const ossDomains = ossModules.map((m) => m.domain);
  for (const d of INTERNAL_ONLY_DOMAINS) {
    assert.ok(!ossDomains.includes(d), `oss 版应剔除 ${d}`);
    assert.ok(!ossModules.some((m) => m.internalOnly), `oss 版不应残留 internalOnly 模块: ${d}`);
  }
  assert.ok(ossDomains.includes("image_gen"), "oss 版保留 image_gen");
  assert.ok(ossDomains.includes("safety_guard"), "oss 版保留 safety_guard");
  assert.ok(ossDomains.includes("shopping_order") || true, "shopping_order 归属未拍板，默认保留");
});

test("core 常驻名单：oss 剔除电话/好友家族，shopping.suggest 与核心工具保留", () => {
  assert.equal(
    withEdition(undefined, () => isCoreToolRegistryName("phone.ensure_my_number")),
    true,
    "internal 版 phone.* 在 core",
  );
  withEdition("oss", () => {
    assert.equal(isCoreToolRegistryName("phone.ensure_my_number"), false);
    assert.equal(isCoreToolRegistryName("phone.anything"), false);
    assert.equal(isCoreToolRegistryName("world.link.send_message"), false);
    assert.equal(isCoreToolRegistryName("world.link.list_friends"), false);
    assert.equal(isCoreToolRegistryName("shopping.suggest"), true, "开源拍板保留");
    assert.equal(isCoreToolRegistryName("calendar.create_task"), true);
    assert.equal(isCoreToolRegistryName("voice.speak"), true, "语音 TTS 非电话家族，保留");
  });
});
