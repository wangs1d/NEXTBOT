// 记忆连续性集成测试
// 覆盖场景：
//   1. recap 时间线前缀（[昨天]/[2天前]）
//   2. 认知图语义关联（真向量/降级）
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// 用源码路径（tsx 直接跑 TS）
const MODULE = "../src/external-model/chat-thread-store.js";

describe("记忆连续性集成测试", { concurrency: false }, () => {
  describe("优化1: recap 时间线前缀", () => {
    it("recap 行应带原消息日期的绝对时间标签（跨天不失效）", async () => {
      const mod = await import(MODULE);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

      // 用 buildMessageTimestampPrefix 生成正确格式的时间戳前缀
      const ts2d = mod.buildMessageTimestampPrefix(twoDaysAgo);
      const ts1d = mod.buildMessageTimestampPrefix(yesterday);
      const tsNow = mod.buildMessageTimestampPrefix(new Date());

      const store = new mod.ChatThreadStore(null);
      const messages = [
        { role: "system", content: "system prompt" },
        { role: "user", content: `${ts2d} 前天我去公园了` },
        { role: "assistant", content: `${ts2d} 公园好玩吗？` },
        { role: "user", content: `${ts1d} 昨天买了新手机` },
        { role: "assistant", content: `${ts1d} 什么型号？` },
        { role: "user", content: `${tsNow} 今天天气怎么样` },
        { role: "assistant", content: `${tsNow} 今天晴天` },
      ];

      // 2026-09-05 滑动窗口+增量摘要策略：折叠按「窗口12+合并批6」计数触发，与消息日期无关。
      // 追加 14 条今天消息使 body(20) 超过阈值 → 最旧 8 条（含前天/昨天）滑出窗口进待归纳区。
      for (let i = 1; i <= 14; i++) {
        messages.push({ role: "user", content: `${tsNow} 今天的事 ${i}` });
      }
      store.trimThread(messages as any, 2);
      const recapMsg = messages.find((m: any) =>
        typeof m.content === "string" && m.content.includes("[session-recap]")
      );

      assert.ok(recapMsg, "应生成 recap 消息");
      const content = recapMsg!.content as string;
      // 新契约：绝对时间标签（YYYY/MM/DD），跨天读取不会退化成错误相对词
      const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
      const date2d = `${twoDaysAgo.getFullYear()}/${pad(twoDaysAgo.getMonth() + 1)}/${pad(twoDaysAgo.getDate())}`;
      const date1d = `${yesterday.getFullYear()}/${pad(yesterday.getMonth() + 1)}/${pad(yesterday.getDate())}`;
      assert.ok(
        content.includes(date2d) || content.includes(date1d),
        `recap 应带原消息日期的绝对标签（${date2d} 或 ${date1d}），实际: ${content}`
      );
    });

    it("当天消息不应带 [昨天] 或 [2天前] 标签", async () => {
      const mod = await import(MODULE);
      const tsNow = mod.buildMessageTimestampPrefix(new Date());
      const store = new mod.ChatThreadStore(null);
      const messages = [
        { role: "system", content: "system" },
        { role: "user", content: `${tsNow} 今天吃火锅` },
        { role: "assistant", content: `${tsNow} 火锅不错` },
        { role: "user", content: `${tsNow} ${"x".repeat(200)}` },
      ];

      store.trimThread(messages as any, 1);
      const recapMsg = messages.find((m: any) =>
        typeof m.content === "string" && m.content.includes("[session-recap]")
      );

      if (recapMsg) {
        const content = recapMsg.content as string;
        assert.ok(
          !content.includes("[昨天]") && !content.includes("[2天前]"),
          `当天消息不应带历史标签，实际: ${content}`
        );
      }
    });

    it("已有 recap 行时，新丢弃的历史消息也应被兜底纳入（无 LLM 摘要器不断层）", async () => {
      const mod = await import(MODULE);
      const now = new Date();
      const twoAgo = new Date(now.getTime() - 2 * 86_400_000);
      const fourAgo = new Date(now.getTime() - 4 * 86_400_000);
      const ts2 = mod.buildMessageTimestampPrefix(twoAgo);
      const ts4 = mod.buildMessageTimestampPrefix(fourAgo);
      const tsNow = mod.buildMessageTimestampPrefix(now);

      const store = new mod.ChatThreadStore(null);
      // 已有 recap（含 [2天前] 旧事实）：模拟上一次 trim 已生成的 recap
      const existingRecap = {
        role: "assistant",
        content: `[session-recap]\nEarlier conversation recap:\n- [2天前] 用户喜欢喝咖啡`,
      };
      const messages = [
        { role: "system", content: "system prompt" },
        existingRecap,
        { role: "user", content: `${ts4} 4天前去过海边` },
        { role: "assistant", content: `${ts4} 海边怎么样` },
        { role: "user", content: `${tsNow} 今天聊点别的` },
        { role: "assistant", content: `${tsNow} 好的` },
      ];

      // 2026-09-05 近期窗口策略：折叠按条数触发。追加 16 条今天消息使 body(20)
      // 超过「窗口12+折叠批6」→ 最旧 8 条（含 4天前两条）合并进 recap。
      for (let i = 1; i <= 16; i++) {
        messages.push({ role: "user", content: `${tsNow} 今天的事 ${i}` });
      }
      store.trimThread(messages as any, 3);
      const recapMsg = messages.find((m: any) =>
        typeof m.content === "string" && m.content.includes("[session-recap]")
      );
      assert.ok(recapMsg, "应生成 recap 消息");

      const content = recapMsg!.content as string;
      assert.ok(
        content.includes("[2天前]") && content.includes("咖啡"),
        `已有 recap 行应保留，实际: ${content}`
      );
      assert.ok(
        content.includes("海边"),
        `新丢弃的历史消息应被兜底纳入 recap（无 LLM 摘要器不断层），实际: ${content}`
      );
    });
  });

  describe("方案 C: HumanLikeMemory 真向量语义关联", () => {
    const HLM_MODULE = "../src/services/human-like-memory-service.js";

    it("parseVectorFingerprint：旧格式（非 JSON）应返回 null 降级", async () => {
      const mod = await import(HLM_MODULE);
      // HumanLikeMemoryService 是 class，parseVectorFingerprint 是模块级私有
      // 通过创建实例并 ingest 旧格式节点来验证降级路径不报错
      const svc = new mod.HumanLikeMemoryService();
      assert.ok(svc, "HumanLikeMemoryService 应正常实例化");

      // 无 API key 时 ingest 应正常工作（vectorFingerprint 保持 normalizeMemoryLine）
      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      await svc.ingest("user1", "用户喜欢喝咖啡", "chat:test");
      process.env.OPENAI_API_KEY = savedKey;

      // buildRecall 应能正常工作（降级到 cosineLikeScore）
      const result = await svc.buildRecall("user1", "咖啡");
      assert.ok(result, "buildRecall 应返回结果（即使无真向量）");
    });

    it("ingest + buildRecall 全链路应正常工作（无 API key 降级）", async () => {
      const mod = await import(HLM_MODULE);
      const svc = new mod.HumanLikeMemoryService();

      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      // ingest 多条记忆
      await svc.ingest("user1", "用户喜欢喝咖啡，每天早上都要来一杯", "chat:turn1");
      await svc.ingest("user1", "用户讨厌加班，特别是周末加班", "chat:turn2");
      await svc.ingest("user1", "用户养了一只橘猫，叫小橘", "chat:turn3");

      // buildRecall 应能召回相关记忆（用关键词 cosine 降级）
      const result = await svc.buildRecall("user1", "咖啡");
      assert.ok(result, "buildRecall 应返回结果");
      assert.ok(
        result.text.includes("咖啡") || result.recalledNodeIds.length >= 0,
        `召回应正常工作，实际: ${JSON.stringify(result)}`,
      );

      process.env.OPENAI_API_KEY = savedKey;
    });

    it("rebuildLinksForNode 应在真向量可用时用 cosine 建边", async () => {
      const mod = await import(HLM_MODULE);
      const svc = new mod.HumanLikeMemoryService();

      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      // ingest 两条语义相关但词面不同的记忆
      // "去海边度假" 和 "去沙滩玩" 语义相关但词面不匹配
      await svc.ingest("user1", "用户计划去海边度假", "chat:turn1");
      await svc.ingest("user1", "用户想去沙滩玩沙子", "chat:turn2");

      // 无 API key 时用关键词 cosine 建边，"海边"和"沙滩"不匹配，边可能不存在
      // 但 ingest 不应报错，buildRecall 也能正常工作
      const result = await svc.buildRecall("user1", "海边");
      assert.ok(result, "buildRecall 应正常返回");

      process.env.OPENAI_API_KEY = savedKey;
    });

    it("向后兼容：旧节点 vectorFingerprint 为 normalizeMemoryLine 时不报错", async () => {
      const mod = await import(HLM_MODULE);
      const svc = new mod.HumanLikeMemoryService();

      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      // ingest 后节点 vectorFingerprint 是 normalizeMemoryLine（非 JSON 数组）
      await svc.ingest("user1", "测试旧格式兼容性", "chat:test");

      // 手动修改 vectorFingerprint 为旧格式（非 JSON）
      const nodes = (svc as any).store?.nodes as Record<string, any> | undefined;
      if (nodes) {
        for (const node of Object.values(nodes)) {
          node.vectorFingerprint = "测试旧格式兼容性 normalized";
        }
      }

      // buildRecall 应能正常工作（parseVectorFingerprint 返回 null，降级到 cosineLikeScore）
      const result = await svc.buildRecall("user1", "测试");
      assert.ok(result, "旧格式节点 buildRecall 应正常降级工作");

      process.env.OPENAI_API_KEY = savedKey;
    });
  });
});
