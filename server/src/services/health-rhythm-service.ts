/**
 * 健康节奏档位（2026-10-23 第二版）：
 *
 * 演进：旧版给所有人一套「上班族健康指南」参数（久坐 50 / 喝水 45 / 护眼 20）；
 * 第一版重构删护眼、按身份定节奏；第二版按用户拍板**喝水也删除**——
 * 喝水频次因人而异太重（体质/场景/是否方便），定时弹窗打扰价值低，
 * 健康提醒只保留**久坐**这一项（连续在座太久起身，普适且低频）。
 *
 * 设计约束：
 * - 纯函数、零 LLM、零 IO：输入身份相关文本片段，输出节奏配置；
 * - 匹配顺序固定（student → driver → active → office），先命中先生效——
 *   「学生司机」这类复合身份按更特异的档位走；
 * - 久坐阈值是**默认节奏**，客户端可再被用户显式偏好覆盖（applyRhythm 口已留）。
 */

export type HealthRhythmKey = "default" | "office" | "student" | "driver" | "active";

export interface HealthRhythmProfile {
  key: HealthRhythmKey;
  label: string;
  /** 命中来源：identity-fact（事实库命中）/ default（未识别身份的保守默认） */
  source: "identity-fact" | "default";
  /** 命中的身份/职业原文（诊断/展示用，未命中为 null） */
  matched: string | null;
  /** 久坐提醒阈值（分钟）；null = 该身份不开久坐提醒（驾驶/体力站立等） */
  sedentaryAfterMinutes: number | null;
  /** 提醒生效时段 [startHour, endHour)，本地小时 */
  startHour: number;
  endHour: number;
}

/** 档位表：喝水/护眼均已删除，只调久坐阈值与时段。 */
const PROFILES: Record<HealthRhythmKey, Omit<HealthRhythmProfile, "source" | "matched">> = {
  // 未知身份：保守默认，连续在座 60 分钟起身一次。
  default: { key: "default", label: "通用", sedentaryAfterMinutes: 60, startHour: 9, endHour: 21 },
  // 久坐办公/屏幕工作：久坐是主要风险，阈值同默认但时段对齐工作日。
  office: { key: "office", label: "久坐办公", sedentaryAfterMinutes: 60, startHour: 9, endHour: 19 },
  // 学生：上课/自习时被弹窗很烦，阈值放宽。
  student: { key: "student", label: "学生", sedentaryAfterMinutes: 75, startHour: 8, endHour: 21 },
  // 驾驶：久坐是本分（提醒无意义）。驾驶该提醒的是疲劳，不属于本模块职责。
  driver: { key: "driver", label: "驾驶", sedentaryAfterMinutes: null, startHour: 8, endHour: 20 },
  // 体力/常站立：久坐不适用（关）。
  active: { key: "active", label: "体力/站立", sedentaryAfterMinutes: null, startHour: 7, endHour: 21 },
};

/** 匹配顺序即优先级：更特异的身份先判（复合身份如「学生司机」按特异档走）。 */
const MATCHERS: ReadonlyArray<readonly [HealthRhythmKey, RegExp]> = [
  ["student", /学生|考研|上课|高中|初中|大学|校园|课堂|年级|班级|高三|高三备考/],
  ["driver", /司机|驾驶|开车|网约车|出租车|货车|货运|卡车|代驾|跑长途|驾校/],
  ["active", /健身|教练|体力|工人|工地|厨师|护士|快递|外卖|服务员|搬运|教师|老师|站立|售货|导购|空乘|乘务/],
  ["office", /程序|开发|工程师|码农|后端|前端|算法|产品|运营|设计|文案|编辑|作家|会计|文员|白领|上班|办公|客服|翻译|律师|公务员|职员|数据分析|运维|测试|架构|自由职业|自媒体|居家办公|远程办公/],
];

/**
 * 从身份相关文本片段解析健康节奏档位。
 * @param texts 事实值 / 画像行等候选文本（如「职业:后端开发」「我是出租车司机」）
 */
export function resolveHealthRhythm(texts: readonly string[]): HealthRhythmProfile {
  for (const [key, re] of MATCHERS) {
    for (const raw of texts) {
      const t = (raw ?? "").trim();
      if (!t) continue;
      if (re.test(t)) {
        const p = PROFILES[key];
        return { ...p, source: "identity-fact", matched: t.slice(0, 40) };
      }
    }
  }
  const d = PROFILES.default;
  return { ...d, source: "default", matched: null };
}
