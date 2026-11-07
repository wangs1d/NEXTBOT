/**
 * StreamSegmenter 放流行为测试（2026-09-28 配套）：
 * - holdFirstSentence=false：首个完整句随到随发（不按住等第二块）
 * - pauseMs/interimReplyGapMs=0：无人工 sleep，feed 链路无额外延迟
 * - flushFinal 残差补推不重复（句级去重兜底）
 */
import assert from "node:assert/strict";
import test from "node:test";

import { StreamSegmenter } from "../src/agent/stream-segmenter.js";

function createRecorder(): {
  seg: InstanceType<typeof StreamSegmenter>;
  blocks: Array<{ text: string; phase: "interim" | "stream" }>;
} {
  const blocks: Array<{ text: string; phase: "interim" | "stream" }> = [];
  const seg = new StreamSegmenter((text, phase) => {
    blocks.push({ text, phase });
  }, {
    pauseMs: 0,
    interimReplyGapMs: 0,
    holdFirstSentence: false,
    blockCharTarget: 56,
    minSegmentChars: 6,
    segmentationEnabled: true,
    maxStreamSegments: 24,
  });
  return { seg, blocks };
}

test("首句直出：首个完整句不等第二块/目标长度，立即成块发出", async () => {
  const { seg, blocks } = createRecorder();
  seg.feed("好的。");
  await seg.chain;
  assert.equal(blocks.length, 1, "首个完整句应立即发出");
  assert.equal(blocks[0].text, "好的。");
  assert.equal(blocks[0].phase, "stream");
  // 后续同话题短句累积，不逐句切块
  seg.feed("今天天气不错，");
  seg.feed("适合出门走走。");
  await seg.chain;
  assert.equal(blocks.length, 1, "未达 blockCharTarget 的同话题内容不切块");
  await seg.flushFinal();
  assert.equal(blocks.length, 2, "flushFinal 推出剩余正文");
  assert.ok(blocks[1].text.includes("出门走走"));
});

test("短回复单句：流中直出，flushFinal 不再重复推", async () => {
  const { seg, blocks } = createRecorder();
  seg.feed("在呢，怎么了？");
  await seg.chain;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "在呢，怎么了？");
  await seg.flushFinal();
  assert.equal(blocks.length, 1, "flushFinal 对已发完的短回复不重复推送");
});

test("长回复多块：块间零停顿顺序推出，句级去重保证不重复", async () => {
  const { seg, blocks } = createRecorder();
  const t0 = Date.now();
  seg.feed("这是第一句话，直接回应你的问题。");
  seg.feed("其次，关于细节我想补充说明一下，这里有比较多可以展开的内容。");
  seg.feed("另外，还有一个相关的话题值得一提，就是信息块的话题切换规则。");
  await seg.chain;
  const elapsed = Date.now() - t0;
  // 首句直出 + 话题切换块在流中已推出；末句（未闭合块）留待 flushFinal
  assert.ok(blocks.length >= 2, `流中应至少推出 2 块（实际 ${blocks.length}）`);
  assert.ok(elapsed < 200, `零停顿下发不应引入 sleep（实际 ${elapsed}ms）`);
  const joined = blocks.map((b) => b.text).join("");
  assert.ok(!joined.includes("这是第一句话，直接回应你的问题。。"), "无重复标点堆积");
  await seg.flushFinal();
  assert.ok(blocks.length >= 3, `flushFinal 后应至少 3 块（实际 ${blocks.length}）`);
  const total = blocks.map((b) => b.text).join("");
  for (const sentence of [
    "直接回应你的问题",
    "补充说明",
    "话题切换规则",
  ]) {
    const first = total.indexOf(sentence);
    assert.ok(first >= 0, `正文应包含「${sentence}」`);
    assert.equal(total.indexOf(sentence, first + 1), -1, `「${sentence}」不应重复出现`);
  }
});

test("弃用（discard）后不再推送", async () => {
  const { seg, blocks } = createRecorder();
  seg.feed("第一句会被丢弃。");
  seg.discard();
  await seg.flushFinal();
  assert.equal(blocks.length, 0);
});

// ---------------------------------------------------------------------------
// 真·分绿泡（bubbleMode，2026-09-28）：信息块升级为独立气泡
// ---------------------------------------------------------------------------

type BubbleRecord = {
  text: string;
  phase: "interim" | "stream";
  bubble?: "new" | "continue";
  at: number;
};

function createBubbleRecorder(
  opts: Partial<ConstructorParameters<typeof StreamSegmenter>[1]> = {},
): {
  seg: InstanceType<typeof StreamSegmenter>;
  bubbles: BubbleRecord[];
  enable: () => void;
} {
  const bubbles: BubbleRecord[] = [];
  const seg = new StreamSegmenter((text, phase, meta) => {
    bubbles.push({ text, phase, bubble: meta?.bubble, at: Date.now() });
  }, {
    pauseMs: 0,
    interimReplyGapMs: 0,
    holdFirstSentence: false,
    segmentationEnabled: true,
    bubbleGapMinMs: 0,
    bubbleGapMaxMs: 0,
    ...opts,
  });
  return { seg, bubbles, enable: () => seg.enableBubbleMode() };
}

test("分泡：用户样例「哎，在呢。有什么事？」切成两泡，首句强边界即切", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("哎，在呢。有什么事？");
  await seg.chain;
  // 首泡细粒度即切；"有什么事？"仅 4 可见字（后续泡粗粒度）留缓冲
  assert.equal(bubbles.length, 1, "首句应立即成泡");
  assert.equal(bubbles[0].text, "哎，在呢。");
  assert.equal(bubbles[0].bubble, "new");
  await seg.flushFinal();
  assert.equal(bubbles.length, 2, "完整句残差开新泡成第二泡");
  assert.equal(bubbles[1].bubble, "new");
  assert.equal(bubbles[1].text, "有什么事？");
});

test("分泡：逗号句中不切，整句讲完才发（2026-09-29 用户反馈）", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("今天下午三点有个会，别忘了。");
  await seg.chain;
  assert.equal(bubbles.length, 1, "逗号处不切，整句一个泡");
  assert.equal(bubbles[0].text, "今天下午三点有个会，别忘了。");
  await seg.flushFinal();
  assert.equal(bubbles.length, 1, "flushFinal 无残差");
});

test("分泡：截图回归——「这是定律，躲不掉的。」不再被逗号拦腰截断", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("国庆哪都人多，这是定律，躲不掉的。");
  await seg.chain;
  assert.equal(bubbles.length, 1, "首泡=完整句，不在逗号处切");
  assert.equal(bubbles[0].text, "国庆哪都人多，这是定律，躲不掉的。");
  seg.feed("但能躲掉“最挤的那几个地方”。");
  await seg.chain;
  assert.equal(bubbles.length, 2, "下一完整句 ≥12 可见字即切第二泡");
  assert.equal(bubbles[1].text, "但能躲掉“最挤的那几个地方”。");
  assert.equal(bubbles[1].bubble, "new");
  await seg.flushFinal();
  assert.equal(bubbles.length, 2, "无残差");
});

test("分泡：单字句不足 2 可见字不单独成泡，向后并入", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("嗯。好的。");
  await seg.chain;
  assert.equal(bubbles.length, 1, "「嗯。」不切，整段成单泡");
  assert.equal(bubbles[0].text, "嗯。好的。");
});

test("分泡：无切泡点的短回复由 flushFinal 以 new 兜底成泡", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("嗯。");
  await seg.chain;
  assert.equal(bubbles.length, 0, "流中不推");
  await seg.flushFinal();
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].bubble, "new");
  assert.equal(bubbles[0].text, "嗯。");
});

test("分泡：flushFinal 完整句残差开新泡，碎片残差才并末泡", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("在呢。");
  await seg.chain;
  assert.equal(bubbles.length, 1);
  // 碎片残差（无句末边界）→ continue 追加
  seg.feed("末尾半截");
  await seg.flushFinal();
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[1].bubble, "continue");
  assert.equal(bubbles[1].text, "末尾半截");
});

test("分泡：完整句残差在 flushFinal 开新泡（后续泡粗粒度下不再逐句碎裂）", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("在呢。");
  await seg.chain;
  assert.equal(bubbles.length, 1);
  // "你说。"仅 2 可见字 < 12（后续泡粗粒度），流中不切，留到 flushFinal
  seg.feed("你说。");
  await seg.chain;
  assert.equal(bubbles.length, 1, "后续泡不足 12 字不在流中切");
  await seg.flushFinal();
  assert.equal(bubbles.length, 2, "完整句残差开新泡");
  assert.equal(bubbles[1].bubble, "new");
  assert.equal(bubbles[1].text, "你说。");
});

test("分泡：后续泡 ≥12 字才切，短句合并成饱满的泡", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("第一句。短句甲。短句乙。这句足够长足够长足够长了。");
  await seg.chain;
  // 首泡细粒度："第一句。"（3 可见字 ≥2）即切；随后短句攒不够 12 字不切，
  // 与后面的长句合并成一个饱满的泡
  assert.equal(bubbles.length, 2, `应两泡（实际 ${bubbles.length}）`);
  assert.equal(bubbles[0].text, "第一句。");
  assert.equal(
    bubbles[1].text,
    "短句甲。短句乙。这句足够长足够长足够长了。",
    "短句合并进后续泡，不逐条碎裂",
  );
});

test("分泡：泡数封顶，超出内容以 continue 并入末泡", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder({ maxBubbles: 2 });
  enable();
  seg.feed("第一句相当长足够过线了。第二句也足够长足够过线了。第三句还是足够长足够过线。第四句依旧足够长足够过线。");
  await seg.chain;
  assert.equal(bubbles.length, 2, `封顶 2 泡（实际 ${bubbles.length}）`);
  await seg.flushFinal();
  assert.equal(bubbles.length, 3, "超出内容以 continue 标记推出");
  assert.equal(bubbles[2].bubble, "continue", "封顶后不开新泡，客户端并入末泡");
  assert.ok(bubbles[2].text.includes("第三句"), "超出内容并入末泡");
});

test("分泡：泡间停顿真实生效且只发生在泡与泡之间", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder({
    bubbleGapMinMs: 40,
    bubbleGapMaxMs: 60,
  });
  enable();
  const t0 = Date.now();
  seg.feed("先应一句。再说细节，补一点。");
  await seg.chain;
  // 首泡零停顿直出；第二泡（完整句残差）在 flushFinal 开新泡前带泡间停顿
  assert.ok(bubbles.length >= 1, `首泡应已发出（实际 ${bubbles.length}）`);
  assert.ok(bubbles[0].at - t0 < 35, "首泡零停顿直出");
  await seg.flushFinal();
  assert.equal(bubbles.length, 2);
  const gap = bubbles[1].at - bubbles[0].at;
  assert.ok(gap >= 35, `第二泡前应有泡间停顿（实际 ${gap}ms）`);
  assert.ok(gap < 500, `停顿不应失控（实际 ${gap}ms）`);
});

test("分泡：句级去重不丢新句、不重复旧句", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("在呢。怎么了？");
  await seg.chain;
  seg.feed("在呢。又说了一遍。");
  await seg.chain;
  await seg.flushFinal();
  const total = bubbles.map((b) => b.text).join("");
  assert.equal(total.split("在呢").length - 1, 1, "重复句只保留一次");
  assert.ok(total.includes("又说了一遍"), "新句不丢");
});

test("分泡：enableBubbleMode 运行时置位（WS 门禁路径）", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  seg.feed("这句走信息块路径。");
  await seg.chain;
  assert.equal(bubbles[0].bubble, undefined, "未开启时 emit 不带 meta");
  enable();
  seg.feed("开启后。这句会切泡。");
  await seg.chain;
  // 首泡细粒度即切；第二句不足 12 字留缓冲
  const after = bubbles.slice(1);
  assert.equal(after.length, 1);
  assert.equal(after[0].bubble, "new");
  await seg.flushFinal();
  assert.equal(bubbles.length - 1, 2, "完整句残差在 flushFinal 开新泡");
  assert.equal(bubbles[2].bubble, "new");
});

test("分泡：disableBubbleMode 流中途关泡（信息域工具轮），后续段不带泡标记", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("第一句切泡正常。第二句也足够长足够过线了。");
  await seg.chain;
  const newCount = bubbles.filter((b) => b.bubble === "new").length;
  assert.ok(newCount >= 1, `关泡前应已切出新泡（实际 ${newCount}）`);
  // 模拟信息类工具（search/weather/market/clock 域）开始执行：WS 层关泡
  seg.disableBubbleMode();
  seg.feed("关泡后这段照常成段发出，但绝不再开新泡。资料一次展示完。");
  await seg.chain;
  await seg.flushFinal();
  const after = bubbles.slice(newCount);
  assert.ok(after.length >= 1, "关泡后内容仍要发出（不丢正文）");
  assert.ok(
    after.every((b) => b.bubble === undefined),
    `关泡后不得再带 new/continue 标记（实际 ${JSON.stringify(after.map((b) => b.bubble))}）`,
  );
  // WS 层 BubbleTracker 把无 meta 段并回当前泡 → 信息类轮整轮一个绿泡
});

test("分泡：discard 后不再推送任何泡", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed("第一泡。");
  seg.discard();
  await seg.chain;
  await seg.flushFinal();
  assert.equal(bubbles.length, 0);
});

// ---------------------------------------------------------------------------
// 表格原子性（2026-11-06）：markdown 表格永不逐行撕泡，整表独立成泡
// ---------------------------------------------------------------------------

const MARKET_TABLE = [
  "| 指数 | 收盘点位 | 涨跌 |",
  "|---|---|---|",
  "| 道琼斯 | 51,523.06 | -3.44% |",
  "| 纳斯达克 | 24,315.00 | -5.52% |",
  "| 标普500 | 7,353.73 | -4.36% |",
].join("\n");

test("分泡：表格原子性——整表成单泡，不逐行撕碎", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed(`昨晚美股收盘情况如下：\n${MARKET_TABLE}\n整体跌得比较重。`);
  await seg.chain;
  await seg.flushFinal();
  // 没有任何一泡只含表格的一部分：含表头的泡必须含末行
  const tableBubbles = bubbles.filter((b) => b.text.includes("|---|"));
  assert.equal(tableBubbles.length, 1, "表格恰好出现在一个泡里");
  assert.ok(
    tableBubbles[0].text.includes("标普500"),
    "该泡包含表格末行（整表完整）",
  );
  // 表格行不会单独成泡（孤行渲染不出表）
  for (const b of bubbles) {
    const rowLines = b.text.split("\n").filter((l) => l.trimStart().startsWith("|"));
    assert.ok(
      rowLines.length === 0 || rowLines.length >= 3,
      `泡内表格行要么为 0 要么整表（≥3 行），实际 ${rowLines.length}：${b.text.slice(0, 60)}`,
    );
  }
});

test("分泡：表格单元格里的句末标点不切泡", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  const table = [
    "| 板块 | 备注 |",
    "|---|---|",
    "| 半导体 | 跌超8%。恐慌蔓延。 |",
    "| 银行 | 相对抗跌。 |",
  ].join("\n");
  seg.feed(`今日板块：\n${table}`);
  await seg.chain;
  await seg.flushFinal();
  const tableBubble = bubbles.find((b) => b.text.includes("|---|"));
  assert.ok(tableBubble, "表格成泡");
  assert.ok(
    tableBubble!.text.includes("银行"),
    "单元格内的「。」未把表格拦腰切断（末行仍在同泡）",
  );
});

test("分泡：表格前的引子独立成泡，表格不被并进散文", async () => {
  const { seg, bubbles, enable } = createBubbleRecorder();
  enable();
  seg.feed(`刚查了下，收盘数据都在这张表里：\n${MARKET_TABLE}`);
  await seg.chain;
  await seg.flushFinal();
  assert.ok(bubbles.length >= 2, `引子与表格分开成泡，实际 ${bubbles.length} 泡`);
  assert.ok(!bubbles[0].text.includes("|"), "首泡是引子散文，不含表格行");
  const tableBubble = bubbles.find((b) => b.text.includes("|---|"));
  assert.ok(tableBubble, "表格在自己的泡里");
});
