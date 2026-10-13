/**
 * 宣称-证据一致性判定（2026-10-12 写侧通用纠错闸的词面半边）。
 *
 * 设计定位（对齐业界 + 吸取本项目词表教训）：
 *   - 这不是「意图识别词表」（那类词表 2026-09-05 已被根治性删除，2026-10-12
 *     reminder-intent 补丁又复辟了一次、随即再次删除）。它只识别**违约行为
 *     本身**：回复向用户宣称「写操作已完成/承诺会完成」，而服务端事实是本轮
 *     零个有副作用的工具执行。词面只负责识别「宣称」，与 claimsWebSearch
 *     （2026-09-13 上线，稳定运行）同构——系统知道自己有没有执行过工具，
 *     词面只负责识别宣称，话题判定不归它管。
 *   - 覆盖面：所有有副作用的工具（设置/创建/发送/下单/预订/提醒……）共用
 *     这一个闸——「以后每个工具不被调用都打一个补丁」的问题由此终结：工具
 *     没被调的统一兜底在这里，不再按意图长新文件。
 *   - 两档区分：**完成宣称**（「已设置好提醒」——宣称过去时完成，零工具即
 *     结构性违约，无条件触发）；**未来承诺**（「到点我会提醒你」——可能指
 *     上一轮已创建的任务，仅当当前用户消息带写请求信号时才触发，防「你会
 *     提醒我吗」确认轮误伤）。
 */

/** 完成宣称：宣称写操作已经发生（过去时/完成态）。 */
const COMPLETION_CLAIM_RE =
  /已(?:经)?(?:帮你|给你|替你)?(?:设置|创建|建好|加入|写[入到]|添加|定好|订好|订下|安排好|下单|提交|发送|发出|存好|记录在案)|设置好了|创建好了|定好了|订好了|添加到日程|加入日程了|已经?提醒过你|提醒已?经?设好|闹钟已?经?定好/;

/** 未来承诺：承诺将来会执行写操作（「到点我会提醒你」）。 */
const FUTURE_PROMISE_RE =
  /会准时提醒你|到时候(?:会)?(?:提醒|叫)你|我会提醒你|我会(?:帮你)?(?:设置|创建|订|定)|回头我(?:帮你)?(?:设置|创建|定)/;

/** 写请求信号：当前用户消息带这类词时，未来承诺才视为本轮诉求的回应。 */
const WRITE_REQUEST_SIGNAL_RE =
  /提醒|闹钟|日程|创建|设置|下单|发送|发送给|预订|订一?个|加个|安排一?下|帮我(?:订|买|发|设置|创建|加)/;

/** 能力确认问句：用户在问「你会不会/行不行」，不是在下写请求。 */
const CAPABILITY_QUESTION_RE =
  /(?:会不会|能不能|要不要|可不可以)|(?:[吗嘛]|么)\s*[?？!！。~]?\s*$/;

/** 诚实失败/否定形态：同一回复里出现即不算违约宣称（模型如实说明卡点）。 */
const HONEST_FAILURE_RE =
  /无法|办不到|不能帮你|失败了?|没成功|设置失败|创建失败|还没(?:设置|创建|法)|尚未|没能/;

function clean(text: string): string {
  const t = (text ?? "").trim();
  if (!t || t.length > 2000) return "";
  return t;
}

/** 回复是否宣称「写操作已完成」（过去时完成态）。 */
export function claimsSideEffectCompletion(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (HONEST_FAILURE_RE.test(t)) return false;
  return COMPLETION_CLAIM_RE.test(t);
}

/** 回复是否承诺「将来会执行写操作」（仅当用户消息带写请求信号时消费）。 */
export function promisesSideEffectCompletion(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (HONEST_FAILURE_RE.test(t)) return false;
  return FUTURE_PROMISE_RE.test(t);
}

/** 当前用户消息是否带写请求信号（未来承诺的触发条件之一；能力确认问句排除）。 */
export function messageHasWriteRequestSignal(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (CAPABILITY_QUESTION_RE.test(t)) return false;
  return WRITE_REQUEST_SIGNAL_RE.test(t);
}
