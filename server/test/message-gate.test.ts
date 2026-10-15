// 消息入口闸测试（2026-10-14）：与用户内容无关的垃圾在 ingestInbound 入口
// 直接挡住——不落库、不计未读、不触发 onInbound；人际触达/日程变动/财务白名单豁免。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { MessageHubService } from "../src/services/message-hub-service.js";
import { gateInboundMessage } from "../src/services/message-gate.js";
import type { MessageHubInboundInput } from "../src/services/message-hub-service.js";

function tmpHub(): { hub: MessageHubService; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pa-msg-gate-"));
  const hub = new MessageHubService(join(dir, "legacy.json"), join(dir, "hub.db"));
  // Windows 下 SQLite 文件句柄释放有延迟，删不掉就留给系统临时目录，不阻塞测试
  return { hub, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄未释放，忽略 */ } } };
}

const baseInput = (overrides: Partial<MessageHubInboundInput> = {}): MessageHubInboundInput => ({
  actorId: "user@test.com",
  platform: "sms",
  channelId: "10086",
  text: "你好，明天下午3点开会记得带上材料",
  participantName: "李雷",
  ...overrides,
});

describe("message-gate 判定", () => {
  it("验证码/取件码/退订指令：强模板特征命中即挡", () => {
    for (const text of [
      "【美团】验证码 824610，5分钟内有效",
      "您的取件码 3-2-1008，凭码到驿站取件",
      "退订回T 拒收请回复R",
    ]) {
      const v = gateInboundMessage(baseInput({ text }));
      assert.equal(v.gated, true, `应挡: ${text}`);
    }
  });

  it("营销群发：商业词密度 ≥2 挡", () => {
    const v = gateInboundMessage(
      baseInput({ text: "【旗舰店】双11大促！全场优惠券限时领取，满减叠加包邮到家" }),
    );
    assert.equal(v.gated, true);
    assert.equal(v.reason, "commercial_density");
  });

  it("单个商业词不挡（误杀率高的词不做单独判定）", () => {
    const v = gateInboundMessage(baseInput({ text: "帮我把这个包裹寄了，记得选包邮的" }));
    assert.equal(v.gated, false);
  });

  it("人际触达信号豁免：请尽快回复/速回放行", () => {
    const v = gateInboundMessage(baseInput({ text: "合同出问题了，请尽快回复我一下" }));
    assert.equal(v.gated, false);
  });

  it("日程变动信号豁免：航班取消/会议改期放行", () => {
    for (const text of [
      "【航司】您乘坐的 MU5137 航班已取消，请改签",
      "王总说明天下午的会议改期到周四了",
    ]) {
      const v = gateInboundMessage(baseInput({ text }));
      assert.equal(v.gated, false, `应放: ${text}`);
    }
  });

  it("财务白名单平台（alipay）豁免", () => {
    const v = gateInboundMessage(
      baseInput({ platform: "alipay", text: "优惠券到期提醒，验证码 1234" }),
    );
    assert.equal(v.gated, false);
  });

  it("MESSAGE_HUB_GATE=off 全局关闸", () => {
    process.env.MESSAGE_HUB_GATE = "off";
    try {
      const v = gateInboundMessage(baseInput({ text: "验证码 0000" }));
      assert.equal(v.gated, false);
    } finally {
      delete process.env.MESSAGE_HUB_GATE;
    }
  });

  it("正常人际消息放行", () => {
    const v = gateInboundMessage(
      baseInput({ text: "中午一起吃饭吗？楼下新开了家面馆" }),
    );
    assert.equal(v.gated, false);
  });
});

describe("message-gate × ingestInbound 集成", () => {
  const { hub, cleanup } = tmpHub();
  after(() => cleanup());

  it("gated 消息：不落库、不计未读、不触发 onInbound", async () => {
    await hub.load();
    let inboundCalls = 0;
    hub.onInbound = () => {
      inboundCalls += 1;
    };

    const gated = await hub.ingestInbound(
      baseInput({ text: "【银行】验证码 998877，切勿泄露", externalMessageId: "g1" }),
    );
    assert.equal(gated.gated, true);
    assert.equal(gated.conversation.unreadCount, 0);

    // 库里查不到：会话/消息都不存在，overview 无未读
    assert.equal(hub.listConversations(gated.conversation.actorId).length, 0);
    assert.equal(hub.overview(gated.conversation.actorId).totalUnread, 0);
    assert.equal(inboundCalls, 0);
    assert.equal(hub.gateStats().gatedTotal, 1);
  });

  it("放行消息：正常落库并触发 onInbound", async () => {
    let inboundCalls = 0;
    hub.onInbound = () => {
      inboundCalls += 1;
    };
    const ok = await hub.ingestInbound(
      baseInput({ text: "晚上一起打球吗？老地方", externalMessageId: "ok1" }),
    );
    assert.equal(ok.gated, undefined);
    assert.equal(hub.listMessages(ok.conversation.actorId, ok.conversation.conversationId).length, 1);
    assert.equal(inboundCalls, 1);
    assert.equal(hub.gateStats().gatedTotal, 1);
  });
});
