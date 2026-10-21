/**
 * 提醒展示文案的确定性规整：subject 抽取、到点文案生成、回声判定。
 *
 * 被 schedule-intent-service（规则路径解析）与 schedule-task-service
 * （createTask 落库闸口）共用——后者是所有写入方（reminder.plan /
 * calendar.create_* / HTTP 直写）的唯一落库点，模型自己填的
 * shortTitle/reminderMessage 在这里统一过契约（2026-10-21 根修
 * 「的11点03分提醒我吃饭」类原句回声）。
 */

/** 用户对助手的口语称呼（如「五分钟后提醒我睡觉 小弟」的「小弟」）：是称呼不是事项，须从主题中剥离。 */
const VOCATIVE_WORDS =
  "小弟|老弟|大哥|老哥|哥哥|姐姐|哥们|兄弟|老铁|老板|大佬|帅哥|美女|亲爱的|宝贝|师傅|师父|老师|同学";
const LEADING_VOCATIVE_RE = new RegExp(`^(?:${VOCATIVE_WORDS})[\\s，,、；;。：:！!？?]+`);
// 称呼须与事项有空格/标点分隔才剥离：「睡觉 小弟」剥，「打电话给大哥」不剥（大哥是宾语）。
const TRAILING_VOCATIVE_RE = new RegExp(
  `[\\s，,、；;。：:！!？?]+(?:${VOCATIVE_WORDS})[呀啊啦哟哦呗呢吧。！!？?]*$`,
);

const LEADING_PUNCT_RE = /^[，,、；;。．：:！!？?（()）\s]+/;

/** 相对时间（X 分钟后 / 半小时后）前缀。第二个分支处理「半小时」不带重复
 * 单位词的独立用法；整体锚定句首（原版分支未锚定，会误匹配句中片段）。 */
const RELATIVE_TIME_PREFIX_RE =
  /^(?:(?:半(?:个)?(?:小时|钟头)|\d+\s*秒(?:钟)?|[一二两三四五六七八九十]{1,3}|\d+)\s*(?:个)?(?:分钟|小时|钟头)(?:后|之后|以内)?|半(?:个)?(?:小时|钟头)(?:后|之后)?)\s*/;
/** 绝对时间（今晚8点 / 11点03分 / 明天 09:00）前缀。日期词表与解析端
 * parseHourMinuteFromPrompt 认得的时段词对齐（今晚/明晚/傍晚…此前漏「今晚8点」）。 */
const ABSOLUTE_TIME_PREFIX_RE =
  /^(?:(?:每天|每日|明天|今天|后天|大后天|今晚|明晚|今早|明早|昨夜|昨晚|前天|大前天)\s*)?(?:(?:早上|上午|中午|下午|晚上|夜间|凌晨|半夜|傍晚)\s*)?(?:\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十廿]{1,4}\s*点(?:\s*\d{1,2}\s*分?|半)?|\d{1,2}\s*点(?:\s*\d{1,2}\s*分?|半)?)\s*/;

/** 从用户句中提取提醒事项。时间段/指令词/标点可能交错出现
 * （「帮我明天9点提醒我开会」「提醒我（17:40）去游泳」），单遍定序剥离会漏——
 * 循环剥到不再变化为止（输入是短句，迭代有界）。相对与绝对时间连用时逐段剥净。 */
export function extractReminderSubject(userText: string): string {
  const normalized = userText.trim();
  let rest = normalized.replace(LEADING_VOCATIVE_RE, "");
  for (let i = 0; i < 6; i += 1) {
    const prev = rest;
    rest = stripLeadingTimeExpression(rest);
    rest = rest.replace(LEADING_PUNCT_RE, "");
    rest = rest.replace(/^(请|帮我|把我)\s*/, "");
    rest = rest.replace(/^(喊我|叫我)\s*/, "");
    rest = rest.replace(/^提醒我\s*/, "");
    rest = rest.replace(/^提醒一下\s*/, "");
    rest = rest.replace(/^提醒\s*/, "");
    if (rest === prev) break;
  }
  rest = rest.replace(/\s*提醒我\s*$/, "");
  rest = rest.replace(TRAILING_VOCATIVE_RE, "");
  rest = rest.replace(/\s+/g, " ").trim();
  return rest || "到点提醒";
}

function stripLeadingTimeExpression(text: string): string {
  let rest = text;
  for (;;) {
    // 括号包裹的时间段（「4分钟后（17:40）提醒我…」剥掉相对段后剩「（17:40）…」）：
    // 时间正则锚定句首，左括号不先剥掉会把它整个挡死，链式剥离在这里断链。
    const unwrapped = rest.replace(/^[（(]\s*/, "");
    const rel = unwrapped.match(RELATIVE_TIME_PREFIX_RE);
    const abs = rel ? null : unwrapped.match(ABSOLUTE_TIME_PREFIX_RE);
    const matched = rel ?? (abs && abs[0] ? abs : null);
    if (!matched) return rest;
    rest = unwrapped.slice(matched[0].length);
    rest = rest.replace(/^[）)]\s*/, "");
    // 结构助词紧跟时间段（「一分钟后的11点03分…」）：不剥会挡住下一段
    // 时间前缀的匹配，链式剥离在这里断链。剥完再继续循环。
    rest = rest.replace(/^的\s*/, "");
  }
}

/** 将提醒事项转为到点时展示的友好文案。 */
export function formatReminderMessage(subject: string): string {
  const s = subject.trim();
  if (!s || s === "到点提醒") return "到点提醒";
  if (s === "起床") return "该起床啦！";
  if (s === "吃药" || s === "用药") return "该吃药啦";
  if (/[啦啊哦哟！!]$/.test(s)) return s;
  if (s.length <= 8) return `该${s}啦`;
  return s;
}

// ───────────────────── 回声判定（模型输出契约） ─────────────────────

/** 回声特征一：文案里还带着时间表述（时刻会单独展示，进文案即原句回声）。 */
const ECHO_CLOCK_RE =
  /\d{1,2}[:：]\d{2}|\d{1,2}\s*点(?:\d{1,2}\s*分?)?|[零一二两三四五六七八九十]{1,4}\s*点|今天|明天|后天|今晚|明晚|今早|明早|昨晚|前天|大后天|每天|每周|每年/;
/** 回声特征二：还带着「提醒我」类指令词（事项里不会出现的话）。 */
const ECHO_INSTRUCTION_RE = /提醒我|提醒一下|叫我|喊我/;
/** 回声特征三：以悬空助词/标点开头（「一分钟后的…」被模型掐头的典型残迹）。 */
const ECHO_DANGLING_PREFIX_RE = /^[的了吗呢吧呀啊哦哈，,。．、；;：:！!？?]/;
/** 回声特征四：「到点提醒」是无事项词时的兜底标记，它的任何包装（「该到点提醒啦」）
 * 都是垃圾文案，原样落库会在到点时展示无意义的「到点提醒你」。 */
const ECHO_FALLBACK_RE = /到点提醒/;

/**
 * 是否为「原句回声」型坏文案。命中任一特征即视为解析污染，调用方应从
 * 原句重推导（extractReminderSubject + formatReminderMessage）。
 * 注意「记得/别忘了」是合法的文案用语（如「该吃药啦！记得按时服药」），不判回声。
 */
export function isEchoLikeReminderCopy(text: string): boolean {
  if (!text) return false;
  return (
    ECHO_CLOCK_RE.test(text) ||
    ECHO_INSTRUCTION_RE.test(text) ||
    ECHO_DANGLING_PREFIX_RE.test(text) ||
    ECHO_FALLBACK_RE.test(text)
  );
}
