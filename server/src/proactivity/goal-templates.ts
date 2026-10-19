/**
 * 目标模板库（2026-10-19，docs/goal-hybrid-architecture.md §4.4 / §8）。
 *
 * 这不是「少写 if-else」的便利层，是**把成功的路径变成资产**：
 *  - 成功流程：同类目标直接套步骤，省一次 pro 拆步调用，且比现拆更稳
 *  - 失败规避：把反复踩的坑写成前置条件（"直接比价"总因缺日期失败 → 先确认日期）
 *  - 操作偏好：结果形态（一页纸 / Excel / 先给结论）不再反复问
 *
 * 验收口径：**新增一类场景 = 在 BUILTIN_GOAL_TEMPLATES 加一条，零代码改动**。
 * 运行期沉淀（达成过的 plan 写回模板）是后续增量，不需要改结构。
 */
export type GoalTemplatePitfall = {
  /** 命中该模式的原步骤 */
  when: RegExp;
  /** 改写成的步骤（前置条件补在这句里） */
  instead: string;
};

export type GoalTemplate = {
  id: string;
  /** 模板名（诊断/成本报告里显示） */
  label: string;
  /** 标题命中任一关键词即匹配 */
  keywords: string[];
  /** 命中任一排除词则不匹配（防误吸） */
  negative?: string[];
  /** 有序主干步骤 */
  steps: string[];
  /** 达成判据（一句话，用户能听懂、verifier 能判） */
  successCriteria: string;
  /** 失败规避：步骤改写 */
  pitfalls?: GoalTemplatePitfall[];
  /** 操作偏好：结果形态（注入 prompt / 步骤备注） */
  preferences?: string[];
};

export const BUILTIN_GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: "travel",
    label: "出行安排",
    keywords: ["旅行", "旅游", "行程", "出游", "度假", "机票", "酒店", "三亚", "自驾", "接机"],
    negative: ["出差报销", "行程回顾"],
    steps: [
      "确认日期、人数、预算（缺哪项先问清，别猜）",
      "查目的地天气与合适时段",
      "比价往返交通并给出 2-3 个候选",
      "挑酒店（位置、价格、退改政策一起看）",
      "排每日行程（含用餐与交通衔接）",
      "确定接驳方式（接机/租车/地铁）",
    ],
    successCriteria: "日期、交通、住宿、每日安排都定下来，且总花费在预算内",
    pitfalls: [
      { when: /比价|查机票/, instead: "确认日期与人数后，再比价往返交通并给 2-3 个候选" },
      { when: /订酒店|挑酒店/, instead: "确认入住区域与预算后，再挑酒店（位置、价格、退改一起看）" },
    ],
    preferences: ["先给结论（总花费与推荐方案），细节折叠在后面", "候选不超过 3 个，标清差价"],
  },
  {
    id: "move",
    label: "搬家租房",
    keywords: ["搬家", "租房", "找房", "换房", "房源", "合租"],
    steps: [
      "明确预算、通勤半径、入住时间",
      "筛房源并整理 5 个候选（租金/面积/通勤）",
      "安排看房并记录问题（采光/噪音/水电）",
      "比价搬家服务与时间档",
      "确认合同条款（押付方式、退租、维修责任）",
      "列搬家清单与打包顺序",
    ],
    successCriteria: "房源定下来、合同条款确认无坑、搬家时间与费用都落实",
    pitfalls: [
      { when: /看房/, instead: "先列看房清单（采光/噪音/水电/通勤实测），再约看房" },
    ],
    preferences: ["候选房源用表格对比，别写成大段文字"],
  },
  {
    id: "exam",
    label: "备考冲刺",
    keywords: ["备考", "考试", "雅思", "托福", "考研", "公考", "刷题", "证书"],
    steps: [
      "确认考试日期与目标分数",
      "摸底测一次，定位弱项",
      "按弱项排每周计划（每周可执行，别排满）",
      "定每周复盘时间与判断标准",
      "临考前两周安排模考节奏",
    ],
    successCriteria: "每周计划可执行、弱项有专项练习、临考有模考安排",
    preferences: ["计划按周给，不要按天排满", "复盘只看三个数字：完成率、正确率、最弱项"],
  },
  {
    id: "decorate",
    label: "装修",
    keywords: ["装修", "改造", "翻新", "硬装", "软装", "定制柜"],
    steps: [
      "明确预算上限与不可妥协项",
      "定风格与主材清单（瓷砖/地板/柜体）",
      "比价 2-3 家装修公司或施工队",
      "确认水电改造与隐蔽工程验收节点",
      "排施工顺序与入住时间",
      "列软装与家电采购清单",
    ],
    successCriteria: "预算、主材、施工方都定下来，隐蔽工程有验收节点",
    pitfalls: [
      { when: /比价|装修公司/, instead: "先写清主材清单与工艺要求，再比价 2-3 家（否则报价不可比）" },
    ],
    preferences: ["报价对比必须同口径（含不含辅材、增项怎么算）"],
  },
  {
    id: "job",
    label: "求职转岗",
    keywords: ["求职", "找工作", "转岗", "面试", "简历", "跳槽", "答辩"],
    steps: [
      "明确目标岗位与时间窗口",
      "按目标岗位改一版简历（对齐 JD 关键词）",
      "整理 3-5 个可讲的项目案例（问题-动作-结果）",
      "投递并记录进展（公司/岗位/状态）",
      "准备高频问题与反问清单",
      "面试后复盘并更新案例库",
    ],
    successCriteria: "简历对齐目标岗位、有可讲案例、投递有记录、面试有复盘",
    preferences: ["简历按 JD 改，不通用投递"],
  },
];

/** 标题匹配：关键词命中且未命中排除词；多个命中时取最长关键词（更具体者优先） */
export function matchGoalTemplate(title: string): GoalTemplate | null {
  const text = String(title ?? "").trim();
  if (!text) return null;
  let best: { tpl: GoalTemplate; score: number } | null = null;
  for (const tpl of BUILTIN_GOAL_TEMPLATES) {
    if (tpl.negative?.some((n) => text.includes(n))) continue;
    let score = 0;
    for (const kw of tpl.keywords) if (text.includes(kw)) score = Math.max(score, kw.length);
    if (score > 0 && (!best || score > best.score)) best = { tpl, score };
  }
  return best?.tpl ?? null;
}

/**
 * 按模板生成步骤（应用失败规避改写）。
 * 返回新数组，不改模板本体。
 */
export function buildStepsFromTemplate(tpl: GoalTemplate, hint?: string): string[] {
  const steps = tpl.steps.map((step) => {
    const pitfall = tpl.pitfalls?.find((p) => p.when.test(step));
    return pitfall ? pitfall.instead : step;
  });
  // 用户原话里的额外约束（预算/时间）挂到第一步，避免丢
  if (hint && hint.trim()) {
    steps[0] = `${steps[0]}（用户补充：${hint.trim().slice(0, 80)}）`;
  }
  return steps;
}

/** 模板的操作偏好 → 一句话（注入 prompt 或落 step note） */
export function formatTemplatePreferences(tpl: GoalTemplate): string | undefined {
  if (!tpl.preferences?.length) return undefined;
  return tpl.preferences.join("；");
}
