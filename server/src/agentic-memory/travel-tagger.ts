/**
 * 旅游主题打标（v3 旅游界面定调：旅游记忆不上 UI，后台画好「旅游」标签
 * 写入统一记忆，与工作/娱乐同人脑式分类）。
 *
 * 写入路径挂接：Mem0 落库（unified infer:false 直存 + infer:true 两条路）
 * 的 metadata 注入 `topicTags`。词表命中即打标，零额外 LLM 调用——
 * 旅游语料（行程/景点/酒店/机票/租车…）词汇特征极强，词表足够可靠，
 * 检索侧（按 tag 过滤/加权）与后续分析按需消费该字段。
 */

/** 旅游语料词表（覆盖行程规划、出行预订、目的地讨论的高频表达） */
const TRAVEL_LEXICON = [
  "旅游", "旅行", "行程", "出游", "出行", "攻略", "景点", "景区",
  "酒店", "民宿", "机票", "航班", "高铁", "火车票", "租车", "自驾",
  "签证", "护照", "海关", "行李", "假期去", "去玩", "去哪儿玩",
  "海岛", "自由行", "跟团", "目的地", "门票", "登机", "行李箱",
];

/** 判断一条记忆文本是否带旅游主题 */
export function isTravelMemory(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return TRAVEL_LEXICON.some((k) => t.includes(k));
}

/**
 * 记忆 metadata 的 topicTags 字段取值（无标签返回 undefined，展开时零污染）。
 * 当前仅「旅游」一个主题域；后续工作/娱乐等主题在此扩展。
 */
export function topicTagsFor(text: string): string[] | undefined {
  return isTravelMemory(text) ? ["旅游"] : undefined;
}
