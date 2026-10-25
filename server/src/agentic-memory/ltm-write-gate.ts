/**
 * 长期记忆写入门（记忆架构 v3）
 *
 * v2 的教训（见 memory-isolation-recall-diagnosis）：长期库没有统一入口，
 * journal / fast-path / evolution / goalBoard / tool 五路直写，任务态快照、
 * 一次性提醒、逐字聊天、协议文本、内部标记全部化石进 LTM，再被召回注入
 * prompt 形成自喂循环。然后在读取侧叠闸补救——闸越叠越多，召回被杀死。
 *
 * v3 定调：串台的病根在写入侧，出口收口于一扇门。所有进 Mem0 / 叙事库 /
 * KV 记忆字段的候选文本都过本门：
 *   - 硬黑名单（零 token）：任务态/工具执行快照、一次性提醒（日程域已接管）、
 *     协议残留、回声体/机器自述、世界经济事件、逐字对话行——命中即拒。
 *   - 格式契约（清洗）：内部决策标记（[fast-path][decay] 等）剥离，空白折叠。
 *
 * 门只做「拒绝 + 清洗」，不做语义分类——profile/episode 的路由由统一抽取器
 * 的 semanticClass 与各库自身定位承担（Mem0=画像事实，narrative=情节）。
 */

/** 门裁决结果 */
export interface LtmGateVerdict {
  /** false = 拒绝进入任何长期记忆库 */
  admit: boolean;
  /** 拒绝/放行的简短原因（诊断日志用） */
  reason: string;
  /** 清洗后的文本（标记剥离 + 空白折叠）；拒绝时为空串 */
  cleaned: string;
}

/** 任务态 / 工具执行快照：属于工作记忆与 turn-wal，永不进 LTM */
const TASK_STATE_RE =
  /执行了?\s*\d*\s*次|search_web|[设列标记]为活跃目标|活跃目标[：:]|^待办[：:]|尚未产出|截至该轮|该轮次|EvolutionLoop|优先级\s*[=＝]|优先级为\s*\S|路由[：:]|（路由|目标（优先级|工具调用.*成功|子 ?Agent 已通过/;

/** 渲染协议 / NEXT_UP / 话题标签等出口协议残留（见 render-protocol-ephemeral-gate） */
const PROTOCOL_RESIDUE_RE =
  /\[RENDER_HINT|\[NEXT_UP|RENDER协议|\[话题切换|\[FU\|/;

/**
 * 一次性提醒 / 定时执行回执：日程系统已接管，长期记忆里只是化石。
 *
 * 2026-10-23 补洞：中文数字（「一分钟后」「三分钟内」）此前不认，实测
 * 「提醒已经设好了，一分钟后就会提醒你：该睡觉啦」全量落库成"事实"。
 */
const ONE_SHOT_REMINDER_RE =
  /((?:\d+|[一二两三四五六七八九十半]+)\s*(?:秒|分钟|小时|天))\s*(?:之?后|内)?\s*(?:就|会|马上|立刻|我|再|准)*\s*(?:提醒|喊|叫|叫我|提醒我|叫你|提醒你)|准时\s*(?:喊|叫|提醒|叫你|提醒你)|到点(?:我)?(?:会|就|直接)?(?:喊|叫|提醒)/;

/** 回声体 / 机器自述 / 实体抽取碎片（召回结果回写、仲裁器输出、图导出自喂） */
const MACHINE_ECHO_RE =
  /^记忆重构结果|^联想记忆[：:]|^dream:replay|^Tool interaction|^世界入账|^购买技能|^用户画像\s*v?\d|^(?:主题|数量|地点|人名|时间|事件)_[^：:]{1,12}[：:]|^Evolution 目标|^WorldBoard/;

/** 逐字对话行（"用户: xxx" / "Agent: xxx"）：对话原文属于 turn-wal/journal，不进 LTM */
const VERBATIM_DIALOG_RE = /^\s*(?:用户|user|assistant|助手|Agent|AI|U|A)\s*[:：]\s*/i;

/**
 * 行首时间标签（2026-10-23 补洞）：`[11:15]` / `[2026-10-21T02:08:12.663Z]` /
 * `[2026/10/08 周四 22:07]` / `[10-21 11:15]`。
 *
 * 事故形态：`[11:15] Agent: 提醒已经设好了…` —— 逐字对话行只要带了行首时间标签，
 * VERBATIM_DIALOG_RE 的 `^` 锚点就失效，整行（含角色与时刻）原样穿过本门，
 * 成为「只有钟点、没有日期」的伪事实：新对话一开场就把它当今天的事引用
 * （用户反馈「新对话把上次的对话算进去了」「锚点只存在今天」的直接来源）。
 */
const LEADING_TIME_LABEL_RE =
  /^\s*\[\s*(?:\d{1,2}[:：]\d{2}(?:[:：]\d{2})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}[^\]]{0,16}|\d{1,2}[-/]\d{1,2}\s+\d{1,2}[:：]\d{2})\s*\]\s*/;

/**
 * 通用行首方括号标记：`[客户端同步]` / `[topic:x]` / `[Agent 承诺/结论]` 等。
 * 仅用于「角色判定前的装饰剥离」——时间标签 + 若干标记 + 角色前缀的组合
 * （`[11:15] [客户端同步] Agent: …`，daily-chat-sync 的历史形态）同样要识别为对话行。
 */
const LEADING_BRACKET_TOKEN_RE = /^\s*\[[^\]]{1,20}\]\s*/;

function stripDialogDecorations(text: string): string {
  let t = text;
  for (let i = 0; i < 4; i++) {
    const next = t.replace(LEADING_BRACKET_TOKEN_RE, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

/** 内部决策标记：可剥离（剥离后若内容仍有效则放行清洗版） */
const INTERNAL_MARKER_RE =
  /\[(?:fast-path|decay|reject|remember|commitment_or_todo|temporary_context|small_talk|topic:[^\]]*)\]/g;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 长期记忆写入门主入口。
 * @param raw 候选文本（一行或一段）
 * @param source 写入来源标签（诊断用，如 "chat:fast_path"）
 */
export function gateLtmWrite(raw: string, source = ""): LtmGateVerdict {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length < 4) {
    return { admit: false, reason: "too_short", cleaned: "" };
  }

  // 第一步：剥离内部决策标记（KV 行自带 [fast-path][decay][topic:xxx] 等前缀，
  // 剥离后再判内容本身是否值得长期保存）
  const stripped = normalizeWhitespace(trimmed.replace(INTERNAL_MARKER_RE, " "));
  const body0 = stripped.length >= 4 ? stripped : normalizeWhitespace(trimmed);
  if (body0.length < 4) {
    return { admit: false, reason: "marker_only", cleaned: "" };
  }

  // 第二步：剥行首时间标签再判定（2026-10-23）。带标签 + 角色前缀的整行是
  // 从日摘要/会话摘要块抄来的逐字对话，且标签只有钟点、没有日期——这种行既
  // 不是事实也不可定位，一律拒绝（`[11:15] Agent: …` 事故形态）。
  // 角色判定前再剥一层通用方括号标记：`[11:15] [客户端同步] Agent: …`
  // （daily-chat-sync 客户端历史同步的历史形态）同样命中。
  const hadTimeLabel = LEADING_TIME_LABEL_RE.test(body0);
  const body = hadTimeLabel ? normalizeWhitespace(body0.replace(LEADING_TIME_LABEL_RE, "")) : body0;
  if (body.length < 4) {
    return { admit: false, reason: "time_label_only", cleaned: "" };
  }
  if (hadTimeLabel && VERBATIM_DIALOG_RE.test(stripDialogDecorations(body))) {
    return { admit: false, reason: "stamped_dialog_line", cleaned: "" };
  }

  // 角色前缀先剥再判内容：`用户: 一分钟后提醒我洗漱` 的提醒语义在正文里，
  // 不剥前缀就判会漏（前缀不是语义豁免）。
  const dialogStripped = body.replace(VERBATIM_DIALOG_RE, "").trim();
  const looksVerbatim =
    dialogStripped !== body && dialogStripped.length >= 4 && !VERBATIM_DIALOG_RE.test(dialogStripped);
  const probe = looksVerbatim ? dialogStripped : body;
  if (probe.length < 4) {
    return { admit: false, reason: "verbatim_dialog_noise", cleaned: "" };
  }

  if (PROTOCOL_RESIDUE_RE.test(probe)) {
    return { admit: false, reason: "protocol_residue", cleaned: "" };
  }
  if (TASK_STATE_RE.test(probe)) {
    return { admit: false, reason: "task_state", cleaned: "" };
  }
  if (ONE_SHOT_REMINDER_RE.test(probe)) {
    return { admit: false, reason: "one_shot_reminder", cleaned: "" };
  }
  if (MACHINE_ECHO_RE.test(probe)) {
    return { admit: false, reason: "machine_echo", cleaned: "" };
  }
  // 逐字对话行：剥掉 "用户:"/"Agent:" 前缀后若仍是普通句子（如日程/事实陈述），
  // 保留清洗版放行——journal 行里有价值的用户事实不该因前缀被一票否决。
  if (looksVerbatim && dialogStripped.length < 8) {
    return { admit: false, reason: "verbatim_dialog_noise", cleaned: "" };
  }

  return { admit: true, reason: "ok", cleaned: probe };
}

/** 批量便捷判断：文本是否允许进长期记忆（不取清洗版时用） */
export function isLtmAdmitted(raw: string, source = ""): boolean {
  return gateLtmWrite(raw, source).admit;
}
