/**
 * 轮内脚手架消息（turn scaffold）：只在**本轮请求**里有效、轮次结束即无意义的
 * system 注入块。标记后由 {@link AbstractChatProvider} 的写回逻辑排除，
 * 绝不进入持久线程。
 *
 * 背景（2026-10-22 实测定位）：工具循环把「能力域目录 + 工具调用原则」、
 * 时间轴块、请求卡/出口闸的转向指令都 push 进同一个 message 数组，而轮末
 * 写回是「边界之后的、非活对象的消息全部入线程」——这些注入块因此被当成
 * 对话历史落库。后果有两个，都很贵：
 *  1) 线程里常驻一份 8,266 字符的域卡（≈3,200 real tokens），**每轮重发**；
 *  2) 它们每轮以新对象重生成、位置随历史增长而漂移，跨轮前缀缓存从注入点
 *     起整段作废（实测历史段 0 命中）。
 *
 * 用 WeakSet 按对象身份标记，零字段污染（不会随 JSON 序列化漏给 provider），
 * 也不会影响任何按内容判断的逻辑。
 */
const TURN_SCAFFOLD = new WeakSet<object>();

/** 标记一条消息为轮内脚手架（返回原对象，便于内联在 push 里）。 */
export function markTurnScaffold<T extends object>(message: T): T {
  TURN_SCAFFOLD.add(message);
  return message;
}

/** 是否为轮内脚手架（轮末写回时应跳过）。 */
export function isTurnScaffold(message: unknown): boolean {
  return typeof message === "object" && message !== null && TURN_SCAFFOLD.has(message as object);
}
