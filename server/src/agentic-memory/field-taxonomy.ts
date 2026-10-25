/**
 * 画像字段 → 类目标签映射（field-taxonomy，画像 v2 P0 地基）。
 *
 * 定位：**类目标签的唯一映射表**。每条画像记录（structured_facts 行）写入时
 * 按此表打 category 标签，ProfileRouter 按标签动态路由取数——"要知道用户作息
 * 就去 rhythm 类取"，不再全量注入。
 *
 * 纪律：tag 是索引不是真相——打错标不影响 latest-wins 的值正确性，只影响召回面；
 * 未知字段归 "note"（杂记类，可被 snapshot 携带但不参与精确路由）。
 */

export const PROFILE_TAGS = [
  "identity", // 身份：称呼/职业/所在地/生日
  "rhythm", // 作息与节奏：入睡/起床/出门准备/工作时段
  "preference", // 偏好：饮食/咖啡/品牌/口味/兴趣
  "aversion", // 禁忌与反感：不吃的/不想被提的
  "relations", // 关系：家人/朋友/宠物（含 指代·role 字段）
  "comms", // 沟通偏好：语气/详细度/称呼习惯
  "goals", // 在办：进行中目标/盯梢/当前任务
  "health", // 健康：经期/用药/体检（敏感类，注入需用户主动提起）
  "spending", // 消费：预算/常购/订阅
  "note", // 杂记：未归类（兜底）
] as const;

export type ProfileTag = (typeof PROFILE_TAGS)[number];

/** 字段 → 类 的规则表（顺序敏感：先命中先得）。value 侧线索单独处理。 */
const FIELD_RULES: Array<{ tag: ProfileTag; re: RegExp }> = [
  // relations 最先：指代映射与亲属称谓（"老婆"会撞 identity 的称呼语义）
  { tag: "relations", re: /^(指代[·•]?\s*.+|妈妈|爸爸|老妈|老爸|老婆|老公|媳妇|丈夫|妻子|女朋友|男朋友|闺[蜜蜜]|发小|室友|老板|上司|导师|猫|狗|宠物|儿子|女儿|孩子|娃)/ },
  // rhythm：作息与节奏
  { tag: "rhythm", re: /(出门准备|收拾|起床|入睡|睡觉时间|作息|睡眠|工时|上班时间|下班时间|午休|通勤|起床闹钟)/ },
  // health：敏感类（先于 aversion 判定——过敏原是健康档案，不吃/忌口才是禁忌）
  { tag: "health", re: /(经期|生理期|用药|吃药|体检|血压|血糖|过敏原|病史|复诊)/ },
  // aversion：负向约束优先于 preference（"不吃香菜"是 aversion 不是 preference）
  { tag: "aversion", re: /^(不吃|不能吃|忌口|过敏(?!原)|别提|不要提|讨厌|反感|怕(?!风)|别推荐|别叫我)/ },
  // comms：沟通偏好
  { tag: "comms", re: /(沟通|语气|称呼习惯|叫我|说话方式|详细度|废话|直说|称呼偏好)/ },
  // spending：消费
  { tag: "spending", re: /(预算|常购|订阅|会员|月卡|花销|消费|账单|信用卡|花呗|白条)/ },
  // goals：在办（结构性字段由 goal-board 承载，这里兜画像文本里的"正在赶/在做"）
  { tag: "goals", re: /(正在赶|在做|在办|盯|进行中|当前任务|deadline|截止)/ },
  // preference：口味/品牌/兴趣
  { tag: "preference", re: /(喜欢|爱吃|爱喝|偏好|口味|咖啡|奶茶|品牌|爱好|兴趣|常点|爱用|球队|剧|游戏|音乐)/ },
  // identity：身份字段（放后面做兜底命中）
  { tag: "identity", re: /^(称呼|昵称|名字|姓名|职业|工作|居住地|所在地|城市|生日|出生|学历|公司|学校|专业|部门|籍贯|家乡|属相|星座)/ },
];

export function taxonomyTagFor(field: string): ProfileTag {
  const f = String(field ?? "").trim();
  if (!f) return "note";
  for (const rule of FIELD_RULES) {
    if (rule.re.test(f)) return rule.tag;
  }
  return "note";
}

/** 类 → 中文显示名（prompt/前端展示用） */
export const TAG_LABELS: Record<ProfileTag, string> = {
  identity: "身份",
  rhythm: "作息与节奏",
  preference: "偏好",
  aversion: "禁忌与反感",
  relations: "关系",
  comms: "沟通偏好",
  goals: "在办",
  health: "健康",
  spending: "消费",
  note: "杂记",
};
