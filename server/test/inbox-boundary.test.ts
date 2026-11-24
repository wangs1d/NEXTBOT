/**
 * 站内信边界回归闸（2026-11-24 用户定调）。
 *
 * 站内信（InboxService）只承载「平台/运营 → 用户」的消息：后台群发、管理台
 * 通知、反馈回执、电话代办回执。提醒一律不走站内信——日程到点走灵动岛（桌面）
 * /系统通知（手机），离线兜底只面向手机（厂商推送 + WS 重连补投）。这条链路
 * 已被误加回来过一次（2026-11-23「第二次删除」），本测试从源码引用面锁死边界：
 * 任何非白名单文件（含全部提醒链路）一旦引用 InboxService 即失败。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SRC = join(process.cwd(), "src");

// 真正的站内信引用判定。排除 ApprovalInboxService（审批收件箱，另一个服务）：
// 其类名内嵌 "InboxService" 字样、import 路径内嵌 "inbox-service.js"，
// 分别靠「前一个字符不是字母」和「路径前缀不是 approval-」区分。
const INBOX_REF = /(?<!approval-)inbox-service\.js|[^A-Za-z]InboxService|[^A-Za-z]inboxService/;

// 平台/运营 → 用户的全部出口 + 装配/类型收口。提醒链路文件不在此列。
const ALLOWLIST = new Set([
  "services/inbox-service.ts",
  "services/inbox-templates.ts",
  "services/phone-call-coordinator.ts",
  "bootstrap/create-app-services.ts",
  "routes/http/index.ts",
  "routes/http/types.ts",
  "routes/http/inbox.ts",
  "routes/http/admin-inbox.ts",
  "routes/http/admin-console.ts",
  "routes/http/feedback.ts",
]);

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function relPath(abs: string): string {
  return abs.slice(SRC.length + 1).replace(/\\/g, "/");
}

test("站内信边界：提醒链路零接触，InboxService 只出现在平台/运营出口", () => {
  const offenders: string[] = [];
  for (const abs of walkTs(SRC)) {
    const rel = relPath(abs);
    if (ALLOWLIST.has(rel)) continue;
    if (INBOX_REF.test(readFileSync(abs, "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "站内信只承载平台/运营 → 用户的消息，提醒（日程/闹钟/主动触达/健康）绝不落站内信。" +
      "以下文件新引用了 InboxService——请改走 WS 直投（桌面灵动岛）/手机系统推送/重连补投：\n  " +
      offenders.join("\n  "),
  );
});

test("站内信边界：允许清单与实际引用面一致（清单即真相，防腐烂）", () => {
  const referencing = walkTs(SRC)
    .map(relPath)
    .filter((rel) => INBOX_REF.test(readFileSync(join(SRC, rel), "utf8")));
  const stale = [...ALLOWLIST].filter((f) => !referencing.includes(f));
  assert.deepEqual(
    stale,
    [],
    "允许清单里这些文件已不再引用站内信，请同步移除保持清单与真实引用面一致：\n  " +
      stale.join("\n  "),
  );
});
