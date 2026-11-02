/**
 * 每轮 prompt 注入账本（只读，零行为变更）。
 *
 * 记录 assembleSystemPrompt 实际拼出去的每个块：标题、字符数、所在层、占整轮
 * system 的比例。用来回答三个问题——这轮到底注入了什么、各块占多少、哪块在
 * 每轮重复付费。开关：PROMPT_LEDGER=1（缺省关，不落盘、不影响装配）。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getDataDir } from "../config/data-dir.js";

export type PromptLedgerBlock = {
  /** 块标题：首行方括号标题，取不到则首 16 字 */
  name: string;
  chars: number;
  layer: "stable" | "dynamic";
};

export type PromptLedgerRecord = {
  t: string;
  pid: number;
  /** 渲染协议本轮是否注入 */
  renderProtocol: boolean;
  baseChars: number;
  stableChars: number;
  dynamicChars: number;
  totalChars: number;
  blocks: PromptLedgerBlock[];
};

function ledgerPath(): string {
  const base = process.env.PA_DATA_DIR?.trim() || getDataDir();
  return join(base, "prompt-ledger.ndjson");
}

function blockName(block: string): string {
  const first = block.trimStart().split("\n", 1)[0]!.trim();
  const title = /^\u3010[^\u3011]{1,24}\u3011/.exec(first)?.[0];
  return title || first.slice(0, 16) || "(空块)";
}

function toBlocks(blocks: string[], layer: "stable" | "dynamic"): PromptLedgerBlock[] {
  return blocks.map((b) => ({ name: blockName(b), chars: b.length, layer }));
}

/** 装配出口调用；异常一律吞掉——账本是观测面，不能反过来影响回复。 */
export function recordPromptInjection(input: {
  baseSystem: string;
  stablePrefix: string[];
  dynamicContext: string[];
  renderProtocol: boolean;
}): void {
  if (process.env.PROMPT_LEDGER !== "1") return;
  try {
    const blocks = [
      { name: "[base] 薄身份+后缀", chars: input.baseSystem.length, layer: "stable" as const },
      ...toBlocks(input.stablePrefix, "stable"),
      ...toBlocks(input.dynamicContext, "dynamic"),
    ];
    const stableChars = input.stablePrefix.reduce((n, b) => n + b.length, 0);
    const dynamicChars = input.dynamicContext.reduce((n, b) => n + b.length, 0);
    const record: PromptLedgerRecord = {
      t: new Date().toISOString(),
      pid: process.pid,
      renderProtocol: input.renderProtocol,
      baseChars: input.baseSystem.length,
      stableChars,
      dynamicChars,
      totalChars: input.baseSystem.length + stableChars + dynamicChars,
      blocks,
    };
    const path = ledgerPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* 观测失败不影响主链路 */
  }
}
