/**
 * 回复风格闸（Reply Style Gate，2026-09-22）：
 * 在 TurnFinalizer 收口对最终回复做**程序层**人格强制——不靠 prompt 求模型，
 * 直接对越形回复做确定性整形。动机（真机轨迹 3b22ae220b1a4a97）：
 * 模型在长上下文里无视【说话方式】的简短基准，产出 4 大段道歉式找补+
 * 连环让步收尾；prompt 加规则已被证伪（上下文太多模型不听），唯一可靠的是
 * 产出侧机械执法。
 *
 * 设计约束：
 * - 正常回复零接触：先检测、有越形才动刀——不动合格回复一个字节；
 * - 零 token / 零延迟：纯正则 + 句级手术，不加任何 LLM 调用；
 * - 协议块保真：NEXT_UP / 渲染标记 / 卡片块先摘出、整形后原样拼回，
 *   不破坏 ws 层（chat-user-message）的协议提取；
 * - 永不变差：整形结果为空时回退原文；只删句、不改写、不重排；
 * - 车道差异：overlong 只管 chat 面确认轮（2026-09-28 闲聊轮废除超长截断，
 *   task 交付天然长、由结构豁免）；人格检查（道歉/找补/连环让步）双车道同规。
 * - 确认轮（2026-09-24）：日历/提醒创建成功后的办妥确认不吃结构豁免——
 *   把废话预告排成列表也算 chat 超长（opts.confirmationRound，agent-core 传参）。
 *
 * 与 assistant-humanizer 的分工：humanizer（去重/口头禅清理）挂在认知快路径
 * 与工具结果处理器；本闸挂在主管道唯一收口 TurnFinalizer，主管在此前没有任何
 * 文本级执法。互不替代。
 */

export type ReplyStyleLane = "chat" | "task";

export type ReplyStyleViolation =
  | "apology_persona" // 道歉开场 / 道歉词堆积
  | "hedge_pileup" // 找补/自证堆积（"我不编""怕你糟心""实话讲"连环）
  | "offer_pileup" // 连环让步式收尾（"截图丢给我""或者你想让我""我帮你存"）
  | "self_explain" // 能力自诉句（"我的问题在于：我看不到…"——结论已给，这就是废话）
  | "meta_narration" // 元叙述段（（用户已通过 profile_update…本轮主任务…）——把注入的任务上下文复述给用户）
  | "overlong"; // chat 面纯文本超长（无结构却超过句数/字数上限）

/**
 * 闸的可选上下文（2026-09-24）：
 * - confirmationRound（确认轮）：本轮日历/提醒类创建工具刚成功（reminder.plan /
 *   calendar.create_*）。办妥确认天然是聊天不是交付——模型把"废话预告"排成
 *   bullet 列表就能吃结构豁免绕过 overlong（真机：订阅科技早报的确认轮写成了
 *   五段导购原样放行），所以确认轮不吃结构豁免，照走 chat 长度上限。
 *   结构化确认的确定性整形仍只做最小手术（保多条目信息），压缩交给隔离重写臂。
 */
export type ReplyStyleGateOptions = {
  confirmationRound?: boolean;
};

export type ReplyStyleGateResult = {
  text: string;
  changed: boolean;
  violations: ReplyStyleViolation[];
};

/** 总开关：REPLY_STYLE_GATE=off|0|false 时整闸旁路（默认开） */
function isGateDisabled(): boolean {
  const raw = (process.env.REPLY_STYLE_GATE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false";
}

// ── 协议块：先摘出、整形后原样拼回（与 reply-envelope 的剥离语义一致）──

const PROTOCOL_BLOCK_RE =
  /\[(?:NEXT_UP|AGENT_RESULT_CARD|DATA_BRIEF|VIDEO_MEDIA|CHAT_MEDIA|CONTENT_SUMMARY_V2|IMAGE_RESULT)_(?:START|END)\][\s\S]*?(?:\[(?:NEXT_UP|AGENT_RESULT_CARD|DATA_BRIEF|VIDEO_MEDIA|CHAT_MEDIA|CONTENT_SUMMARY_V2|IMAGE_RESULT)_(?:START|END)\]|$)/g;
const PROTOCOL_INLINE_MARKER_RE =
  /\[(?:RENDER_HINT|RENDER_AS)\]?\s*[:：]\s*[A-Za-z_]+\]?|\[(?:NEXT_UP|AGENT_RESULT_CARD|DATA_BRIEF|VIDEO_MEDIA|CHAT_MEDIA|CONTENT_SUMMARY_V2|IMAGE_RESULT)_(?:START|END)\]/g;

/** 摘出协议块/标记，返回（裸正文, 待拼回片段）。片段按原文出现顺序保序。 */
export function extractProtocolBlocks(text: string): { body: string; blocks: string[] } {
  const blocks: string[] = [];
  let body = text.replace(PROTOCOL_BLOCK_RE, (m) => {
    blocks.push(m);
    return "\n";
  });
  body = body.replace(PROTOCOL_INLINE_MARKER_RE, (m) => {
    blocks.push(m);
    return "";
  });
  return { body: body.trim(), blocks };
}

// ── 人格特征词面 ──

/** 道歉词：聊天回复里的道歉腔（用户 2026-09-22 定调：不要道歉人格） */
const APOLOGY_WORD_RE = /(抱歉|不好意思|对不起|恕我|请谅解|请见谅)/;
/** 事实词：句内含这些（或数字/链接）说明承载信息，删句手术要绕开 */
const FACT_MARKER_RE = /(查到|搜到|查不到|搜不到|知道|订好|已订|完成|失败|\d|https?:\/\/)/;
/** 找补/自证腔：单句出现 1 次是坦诚，连环出现就是道歉人格 */
const HEDGE_RE =
  /(怕给你|怕你(?:看|多想|嫌弃|介意)|反倒(?:糟心|添堵|闹心)|糟心|我不编|不瞎编|不敢乱说|不敢保证|实话(?:讲|说)|坦白(?:讲|说)|说句实话|丑话说在前|别嫌弃)/g;
/** 让步式收尾：主动递出一串补偿选项，正常人不这么说话 */
const OFFER_RE =
  /(或者你?想让我|你也可以|要不要我|你可以让我|丢给我|截图发|发给我，我|我帮你存|你就让我|需要的话我|我帮你盯着|我帮你留意|吱一声)/g;
/** 能力自诉·强标记：结论已经给过，这类句子是同义反复的废话本体，直接删 */
const SELF_EXPLAIN_STRONG_RE =
  /(我的问题(?:在于|是)|我看不到|我抓不着|我抓不到|我看不了|限于(?:能力|权限)|这(?:是|属于)我的(?:能力|局限)(?:问题|边界)?)/;
/** 能力自诉·弱标记：单看是正常说明，仅在找补/超长已定罪时一并删 */
const SELF_EXPLAIN_WEAK_RE = /(我只能|我搜不了|我无法|我这边看不到)/;

/**
 * 元叙述·强标记（2026-10-10 P0-2）：模型把注入的任务上下文（turnIntent/任务态/
 * 路由结果）复述进正文——真机实证（马尔代夫规划轮）：整段（用户已通过
 * profile_update 记录固定称呼"王哥"；…前置任务：…本轮主任务：…）原样流给用户。
 * 词表与 agentic-memory/ltm-write-gate.ts 的 TASK_STATE_RE 同源（记忆写入侧早有
 * 同款闸，回复出口此前没有——「只建了一半」的闸家族）。
 */
const META_NARRATION_TERM_RE =
  /本轮主任务|前置任务[：:]|本轮目标|本轮用户(?:从|已)|活跃目标|profile_update|EvolutionLoop|优先级\s*[=＝]|路由[：:]|turnIntent|routeConfidence|截至(?:本|该)轮|该轮次|任务态/;
/** 元叙述段最小长度：短括注（"（预算档位）"）即使碰巧含词也不动刀 */
const META_NARRATION_MIN_CHARS = 10;

// ── 句级手术 ──

/** 分句（含句末标点；；与换行同作边界，让"；或者…"式连环让步能被切开） */
function splitSentences(text: string): string[] {
  return [...text.matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu)]
    .map((m) => m[0]?.trim() ?? "")
    .filter(Boolean);
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(new RegExp(re.source, "gu"))].length;
}

function hasStructure(text: string): boolean {
  return (
    /(^|\n)\s*(?:#{1,3}\s|[-*•]\s|\d+[.)、]\s)/.test(text) ||
    text.split("\n").some((l) => l.split("|").length >= 3) ||
    /```|https?:\/\/|\[[^\]]+\]\(/.test(text)
  );
}

function isDroppableApology(sentence: string): boolean {
  return APOLOGY_WORD_RE.test(sentence) && !FACT_MARKER_RE.test(sentence);
}

function isHedgeOnlySentence(sentence: string): boolean {
  return countMatches(sentence, HEDGE_RE) >= 2 && !FACT_MARKER_RE.test(sentence);
}

function isOfferSentence(sentence: string): boolean {
  return countMatches(sentence, OFFER_RE) >= 1 && !FACT_MARKER_RE.test(sentence);
}

/** 除本句外，是否还有别的句子承载搜索结论（查到/搜到/没有结果类事实） */
function factCarriedElsewhere(sentences: string[], exclude: string): boolean {
  return sentences.some((s) => s !== exclude && FACT_MARKER_RE.test(s));
}

// ── 元叙述段剥离（2026-10-10 P0-2）──

/** 摘出顶层括号段（支持一层嵌套；全角/半角括号混算），返回内容与原文区间 */
function extractParenSegments(
  text: string,
): { content: string; start: number; end: number }[] {
  const out: { content: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "（" || ch === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === "（" || c === "(") depth++;
        else if (c === "）" || c === ")") depth--;
        j++;
      }
      if (depth === 0) {
        out.push({ content: text.slice(i + 1, j - 1), start: i, end: j });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * 元叙述段判定：括号包裹 + 含强标记元词 + 达到最小长度。
 * 只删段不改写——正文其余部分一个字节不动。
 */
function isMetaNarrationSegment(content: string): boolean {
  return content.length >= META_NARRATION_MIN_CHARS && META_NARRATION_TERM_RE.test(content);
}

/**
 * 确定性剥离正文中的元叙述括号段（含同段重复出现——真机那轮同一段自述落了两遍）。
 * 剥离后空白塌缩（段间残留空行收敛到双换行）。
 */
export function stripMetaNarration(body: string): { body: string; removed: string[] } {
  const segments = extractParenSegments(body).filter((s) => isMetaNarrationSegment(s.content));
  if (segments.length === 0) return { body, removed: [] };
  const removed = segments.map((s) => s.content);
  let out = "";
  let cursor = 0;
  for (const s of segments) {
    out += body.slice(cursor, s.start);
    cursor = s.end;
  }
  out += body.slice(cursor);
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return { body: out, removed };
}

/**
 * 能力自诉句删除判定：强标记句（"我的问题在于：我看不到…"）在已有别句承载
 * 事实时是纯废话；弱标记句（"我只能…"）仅在找补/超长已定罪时随案删除。
 */
function isDroppableSelfExplain(
  sentence: string,
  violations: ReplyStyleViolation[],
  factCarriedElsewhere: boolean,
): boolean {
  if (SELF_EXPLAIN_STRONG_RE.test(sentence)) {
    return factCarriedElsewhere || violations.includes("hedge_pileup");
  }
  if (SELF_EXPLAIN_WEAK_RE.test(sentence)) {
    return (
      factCarriedElsewhere &&
      (violations.includes("hedge_pileup") ||
        violations.includes("overlong") ||
        violations.includes("offer_pileup"))
    );
  }
  return false;
}

// chat 面纯文本上限：超过即砍。正常人微信式回复到不了这个量级。
const CHAT_MAX_SENTENCES = 3;
const CHAT_MAX_PLAIN_CHARS = 160;
const CHAT_KEEP_SENTENCES = 2;
const CHAT_KEEP_PLAIN_CHARS = 120;

/**
 * 执法入口：检测 + 越形才整形。
 * 检测在协议块摘出后的裸正文上做；整形只做句级删除，绝不改写、不重排。
 * meta_narration（2026-10-10 P0-2）在句级手术**之前**做整段确定性剥离：
 * 元叙述段是括号包裹的多句长段，句级手术切不开它，必须整段摘除。
 */
export function enforceReplyStyle(
  rawText: string,
  lane: ReplyStyleLane = "chat",
  opts?: ReplyStyleGateOptions,
): ReplyStyleGateResult {
  if (!rawText || isGateDisabled()) return { text: rawText, changed: false, violations: [] };

  const { body: protocolBody, blocks } = extractProtocolBlocks(rawText);
  if (!protocolBody) return { text: rawText, changed: false, violations: [] };
  const suffix = blocks.length > 0 ? `\n\n${blocks.join("")}` : "";

  // ── meta_narration 剥离（先于句级手术）──
  const meta = stripMetaNarration(protocolBody);
  if (meta.removed.length > 0) {
    if (!meta.body) {
      // 永不变差：整段都是元叙述、剥完为空 → 回退原文（宁漏勿残）
      return { text: rawText, changed: false, violations: ["meta_narration"] };
    }
    const violations = detectViolations(meta.body, lane, opts?.confirmationRound ?? false);
    if (violations.length === 0) {
      return { text: `${meta.body}${suffix}`, changed: true, violations: ["meta_narration"] };
    }
    const trimmedBody = trimBody(meta.body, violations, lane, opts);
    if (!trimmedBody || trimmedBody === meta.body) {
      return {
        text: `${meta.body}${suffix}`,
        changed: true,
        violations: ["meta_narration", ...violations],
      };
    }
    return {
      text: `${trimmedBody}${suffix}`,
      changed: true,
      violations: ["meta_narration", ...violations],
    };
  }

  const violations = detectViolations(protocolBody, lane, opts?.confirmationRound ?? false);
  if (violations.length === 0) return { text: rawText, changed: false, violations: [] };

  const trimmedBody = trimBody(protocolBody, violations, lane, opts);
  if (!trimmedBody || trimmedBody === protocolBody) {
    return { text: rawText, changed: trimmedBody !== protocolBody, violations };
  }
  return { text: `${trimmedBody}${suffix}`, changed: true, violations };
}

function detectViolations(
  body: string,
  lane: ReplyStyleLane,
  confirmationRound: boolean,
): ReplyStyleViolation[] {
  const out: ReplyStyleViolation[] = [];
  const sentences = splitSentences(body);
  const apologyCount = countMatches(body, APOLOGY_WORD_RE);
  const firstSentence = sentences[0] ?? "";
  const apologyOpening =
    APOLOGY_WORD_RE.test(firstSentence.replace(/^[\s\p{Extended_Pictographic}*#\-—－]*/u, "")) &&
    sentences.length >= 2;
  if (apologyOpening || apologyCount >= 2) out.push("apology_persona");
  if (countMatches(body, HEDGE_RE) >= 2) out.push("hedge_pileup");
  if (countMatches(body, OFFER_RE) >= 2) out.push("offer_pileup");
  if (
    sentences.length >= 2 &&
    sentences.some((s) => SELF_EXPLAIN_STRONG_RE.test(s) || SELF_EXPLAIN_WEAK_RE.test(s))
  ) {
    out.push("self_explain");
  }
  if (
    lane === "chat" &&
    // 2026-09-28 用户拍板：闲聊轮废除超长截断/重写——分泡形态下多句连发就是
    // 微信式正常回复，硬压短毁人设（「怕我跑了？」被重写成一句话），且触发
    // 客户端塌缩（finalTextReplacesStream）造成回复混乱。overlong 收窄为
    // 仅确认轮生效：订阅/定时任务的废话确认（五段导购腔）仍靠这条砍
    // （见 confirm-round-style-gate 真机校准），闲聊轮不再有句数/字数上限。
    confirmationRound === true &&
    (sentences.length > CHAT_MAX_SENTENCES ||
      body.replace(/[\s*#>`~|]/g, "").length > CHAT_MAX_PLAIN_CHARS)
  ) {
    out.push("overlong");
  }
  return out;
}

/** 供隔离重写产物复检：越形产物不合格时回退确定性整形结果 */
export function detectReplyStyleViolations(
  text: string,
  lane: ReplyStyleLane = "chat",
  opts?: ReplyStyleGateOptions,
): ReplyStyleViolation[] {
  const { body } = extractProtocolBlocks(text);
  if (!body) return [];
  const out = detectViolations(body, lane, opts?.confirmationRound ?? false);
  // 元叙述段与句级特征正交（多句括号长段，句级检测覆盖不到），单独补检
  if (extractParenSegments(body).some((s) => isMetaNarrationSegment(s.content))) {
    return ["meta_narration", ...out];
  }
  return out;
}

function trimBody(
  body: string,
  violations: ReplyStyleViolation[],
  lane: ReplyStyleLane,
  opts?: { confirmationRound?: boolean },
): string {
  const sentences = splitSentences(body);
  const structured = hasStructure(body);

  // 结构化正文（交付/表格/链接）：人格词只做最小手术（删道歉句），不做长度/找补大手术，
  // 避免破坏交付结构。
  // 确认轮的结构化正文（废话确认排成列表）连道歉句手术都不做：句级 join 会丢掉
  // 换行排版，而确认轮的压缩本来就该交给隔离重写臂（保事实压缩）——这里原地
  // 放行，靠 violations 触发重写臂；重写不可用时原文出门（宁长勿残）。
  if (structured) {
    if (opts?.confirmationRound) return body;
    const kept = sentences.filter((s) => !isDroppableApology(s));
    return kept.length > 0 ? kept.join("") : body;
  }

  let kept = sentences.filter((s) => {
    if (isDroppableApology(s)) return false;
    if (violations.includes("hedge_pileup") && isHedgeOnlySentence(s)) return false;
    if (violations.includes("offer_pileup") && isOfferSentence(s)) return false;
    if (
      violations.includes("self_explain") &&
      isDroppableSelfExplain(s, violations, factCarriedElsewhere(sentences, s))
    ) {
      return false;
    }
    return true;
  });

  // overlong：正文没有结构却超过上限 → 只保留前若干句（信息密度最高的开头）。
  if (violations.includes("overlong")) {
    const capped: string[] = [];
    let plain = 0;
    for (const s of kept) {
      const sPlain = s.replace(/[\s*#>`~|]/g, "").length;
      if (capped.length >= CHAT_KEEP_SENTENCES || plain + sPlain > CHAT_KEEP_PLAIN_CHARS) break;
      capped.push(s);
      plain += sPlain;
    }
    if (capped.length > 0) kept = capped;
  }

  // 永不变差：删空了就不如不删——回退原正文
  if (kept.length === 0) return body;
  return kept.join("");
}
