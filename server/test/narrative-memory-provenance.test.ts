/**
 * LTM 派生溯源：来源事件（event id / 事件时间）随 writeDecided 进入 Mem0 metadata。
 * 测试封闭：fake ingest 捕获 metadata，无真实 Mem0 / LLM。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createNarrativeMemoryPort } from "../src/services/narrative-memory-port.js";

type MetadataCalls = Array<Record<string, unknown> | undefined>;

function makePort(metadataCalls: MetadataCalls) {
  const ingest = {
    async persistUnifiedExtraction(
      _actorId: string,
      _sourceId: string,
      _extraction: unknown,
      _context: string,
      _highSignal: boolean,
      _fallbackText?: string,
      extraMetadata?: Record<string, unknown>,
    ) {
      metadataCalls.push(extraMetadata);
      return [];
    },
    async writeDecided(
      _actorId: string,
      _sourceId: string,
      _text: string,
      _context: string,
      _highSignal: boolean,
      extraMetadata?: Record<string, unknown>,
    ) {
      metadataCalls.push(extraMetadata);
    },
  };
  return createNarrativeMemoryPort({
    agenticIngest: ingest as never,
    agenticRetrieval: null,
    compressor: null,
    humanLikeMemory: null,
  })!;
}

const UNIFIED = {
  decision: "remember" as const,
  memories: ["用户比价过小米18 Pro"],
  corrections: [],
  understandings: [],
  facts: [],
  forget: [],
  referents: [],
};

test("writeDecided: 单事件来源进入 Mem0 metadata（unified 与旧路径一致）", async () => {
  const calls: MetadataCalls = [];
  const port = makePort(calls);

  await port.writeDecided(
    "u1",
    "text",
    "chat:fast_path",
    {
      context: "main",
      highSignal: true,
      sourceEventId: "evt:u1:m-1",
      eventTime: "2026-10-30T10:00:00.000Z",
    },
    UNIFIED,
  );
  await port.writeDecided("u1", "text", "chat:fast_path", {
    context: "main",
    highSignal: true,
    sourceEventId: "evt:u1:m-2",
    eventTime: "2026-10-30T11:00:00.000Z",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.sourceEventId, "evt:u1:m-1");
  assert.equal(calls[0]!.eventTime, "2026-10-30T10:00:00.000Z");
  assert.equal(calls[1]!.sourceEventId, "evt:u1:m-2");
  assert.equal(calls[1]!.eventTime, "2026-10-30T11:00:00.000Z");
});

test("writeDecided: 无来源时不写空字段；批量来源保留 id 列表", async () => {
  const calls: MetadataCalls = [];
  const port = makePort(calls);

  await port.writeDecided("u1", "text", "chat:low_signal_summary", {
    context: "main",
    highSignal: false,
  });
  assert.deepEqual(calls[0], {});

  await port.writeDecided(
    "u1",
    "text",
    "event:consolidate",
    {
      context: "main",
      highSignal: false,
      sourceEventIds: ["evt:u1:a", "evt:u1:b"],
      eventTime: "2026-10-30T12:00:00.000Z",
    },
    UNIFIED,
  );
  assert.deepEqual(calls[1]!.sourceEventIds, ["evt:u1:a", "evt:u1:b"]);
  assert.equal(calls[1]!.eventTime, "2026-10-30T12:00:00.000Z");
});
