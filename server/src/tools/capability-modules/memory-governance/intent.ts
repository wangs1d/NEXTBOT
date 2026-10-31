import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const MEMORY_GOVERNANCE_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "memory.forget",
    metadata: {
      aliases: [
        "forget", "delete memory", "stop watching", "remove from memory",
        "忘掉", "忘了它", "删除记忆", "把我忘了", "别记了", "不要再关注",
        "别再盯", "取消监控这个", "把这事忘了", "清掉关于",
      ],
      negativeAliases: [
        "我想不起来", "我忘了带钥匙", "记性不好", "忘了说什么",
        "记住", "记一下", "别忘了提醒我",
      ],
      examples: [
        "把关于前公司的记忆都删了吧",
        "别再帮我盯戴森吹风机的价格了",
        "我不再喜欢那个明星了，把关注取消",
        "把我答应小李的那事忘了，不做了",
        "删掉关于健身房的记录",
      ],
      negativeExamples: [
        "糟糕我忘了带手机",
        "帮我记一下这事别忘了",
        "我刚才想说什么来着",
      ],
    },
  },
  {
    exact: "activity.timeline",
    metadata: {
      aliases: [
        "what did you do", "activity log", "audit trail", "status report",
        "你都干了什么", "你做了什么", "最近帮我办了什么", "在忙什么",
        "有什么在等我确认", "行动记录", "工作汇报",
      ],
      negativeAliases: ["代办足迹上传", "上报结果", "帮我办一件事"],
      examples: [
        "你最近都帮我干了些什么",
        "你现在手上在忙什么",
        "有没有什么事在等我确认",
        "汇报一下最近的工作",
      ],
      negativeExamples: ["帮我订个餐厅", "这事办得怎么样了（单件事查进度）"],
    },
  },
  {
    exact: "memory.recall",
    metadata: {
      aliases: [
        "recall", "remember when", "history", "last time", "previous",
        "上次", "之前", "上回", "那天", "哪天", "上个月", "上周",
        "以前做过", "查过", "比过价", "回忆一下", "历史记录",
      ],
      negativeAliases: [
        "记住我", "记一下", "别再提醒", "忘了它", "删除记忆",
        "明天", "待会儿", "现在几点",
      ],
      examples: [
        "上次比价小米18 Pro是什么时候？结果怎么样",
        "我什么时候让你查过天气",
        "这周你都帮我办过几件事？哪些没成",
        "上个月我提过哪些旅行目的地",
      ],
      negativeExamples: [
        "记住我喜欢喝美式（写入画像，非回忆）",
        "明天下午三点提醒我开会",
      ],
    },
  },
  {
    prefix: "profile.update",
    metadata: {
      aliases: [
        "update profile", "remember about me", "my profile",
        "记住我", "记一下", "记到档案", "存到档案", "我的档案", "用户画像",
        "更新对我的了解", "你对我的了解",
      ],
      negativeAliases: [
        "别忘了提醒我", "设个提醒", "定个闹钟", "加个日程", "订个闹钟", "定时提醒",
      ],
      examples: [
        "我叫周明远，记一下",
        "我对花生过敏，这条记到你的档案里",
        "我换工作了，现在在做产品经理，更新一下对我的了解",
        "你都知道我哪些事？顺便补一条：我家猫不吃鱼",
      ],
      negativeExamples: [
        "提醒我明天开会（要的是提醒/日程，非画像）",
        "帮我记一下这事别忘了（同上）",
      ],
    },
  },
];

export const MEMORY_GOVERNANCE_CATEGORY_MAPPING: { name: string; keywords: string[] } = {
  name: "memory_governance",
  keywords: [
    "forget", "delete memory", "activity", "audit", "timeline",
    "忘掉", "忘了它", "删除记忆", "别再关注", "取消关注", "别再盯",
    "你都干了什么", "你做了什么", "最近办了什么", "在忙什么", "等我确认", "行为记录",
    "记到档案", "我的档案", "用户画像", "记住我",
    "上次", "之前", "上回", "回忆", "比过价", "查过", "历史记录",
  ],
};
