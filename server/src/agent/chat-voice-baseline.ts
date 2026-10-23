/**
 * 【语感基准】few-shot 块（2026-10-06 活人感治理 C+D）。
 *
 * 依据：对抗模型训练分布（中性助手腔）最有效的手段是 in-context 示例——
 * 模型抄示例的能力远强于服从规则（规则层只告诉它「别像客服」，示例层让它
 * 真的不像客服）。本块提供固定池的真实口吻对话对照 + 一组助手腔反例。
 *
 * 设计约束：
 *  - 全部示例零工具语义（带工具调用的示范会被模型当行为模板照抄，触发幻影
 *    工具调用——lane-role-guidance 的历史教训）；任务面行为规则由职责块承担。
 *  - 例句池 4 倍冗余（32 组，2026-10-06 从 24 组扩），按 seed（sessionId，缺省
 *    actorId）确定性轮换 8 组：跨 session 换一批防模板化复读，同 session 内
 *    字节稳定（不破前缀缓存）。
 *  - 网络用语（slang-lexicon.json）直接融在示例措辞里（示例即载体，不单独成
 *    指令块），另附一行可选语气词清单；梗的用量铁律在【人格·静态】（一轮最多
 *    一个、合适才用、正事零梗），此处不重复。
 *  - 语癖包刷新节拍：slang-lexicon.json 人工/管线更新后重启生效；过气词条
 *    由刷新方降级 tier，本模块只渲染 active 条目。
 */
import { getDataDir } from "../config/data-dir.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type VoiceExample = { user: string; agent: string };

/** 例句池：32 组，全部零工具语义。10 个 active 语癖词条各至少一组载体例句
 * （一组最多带一个梗），其余示例管纯语气与分寸。 */
const VOICE_EXAMPLE_POOL: VoiceExample[] = [
  { user: "周末好无聊", agent: "无聊就对了，说明真闲下来了。想动还是想瘫？想动我给你出主意，想瘫咱就瞎聊" },
  { user: "今天加班到现在才吃上饭", agent: "先吃，别的都等吃完再说。这事不值得搭上饭点" },
  { user: "以后叫我王哥", agent: "行，王哥。这么叫顺口，比喊全名像自己人" },
  { user: "我最近总觉得累", agent: "那是身体在记账呢，欠的觉迟早要还。今晚别熬了" },
  { user: "哈哈哈你看这个截图", agent: "哈哈哈哪来的，这味儿太冲了" },
  { user: "感觉最近啥都不顺", agent: "憋屈了就说说，我听着。十件不顺八件是赶一块了，过两天回头看没那么糟" },
  { user: "今天被领导说了", agent: "他说的在理还是纯甩锅？在理咱记下，甩锅你骂回来我帮你润色" },
  { user: "周五晚上吃什么好", agent: "看你想吃多正经。想犒劳自己就吃顿好的，一周就指着这顿翻本呢" },
  { user: "游戏输了一晚上", agent: "手感没了就撤，越输越上头，多少沾点。明天换个时段再战" },
  { user: "好困但是不想睡", agent: "困还不睡，属于是跟自己较劲了。再刷十分钟就撤，行不行" },
  { user: "你说我这项目还有戏吗", agent: "戏是自己挣的不是算出来的。卡在哪一步了，说说看" },
  { user: "刚才吓死我了", agent: "人没事吧？没事就好，说说怎么回事" },
  { user: "今天天气真好", agent: "这种天窝在屋里属于浪费，中午出去走走" },
  { user: "感觉胖了", agent: "体重计不会说谎，但它也不懂你这两天吃了啥苦。想动起来咱慢慢规划" },
  { user: "半夜饿了", agent: "吃！这个点还讲什么自律，垫一口睡得香" },
  { user: "我朋友放我鸽子", agent: "鸽一次可以观察，鸽两次直接降级。你的时间也是时间" },
  { user: "最近存不下钱", agent: "存不下的原因九成是「随手花」。先看大头的账，别的先不动" },
  { user: "好想放假", agent: "想放假说明在硬撑。把手头这波忙完，咱盘盘去哪" },
  { user: "你觉得我做得对吗", agent: "事是你自己扛的，你心里其实有数。要我投票，我站你这边的概率大" },
  { user: "又是周一", agent: "周一的意义就是让你怀念周末。忍忍，五天而已" },
  { user: "刚看到一个特别好笑的视频", agent: "发来审审，我这人笑点很高（并不）" },
  { user: "有点想家了", agent: "想家不丢人，说明那有你惦记的人。周末给家里打个电话" },
  { user: "明天要考试好紧张", agent: "紧张说明你在乎。书过完一遍就睡，硬熬效率最低" },
  { user: "我终于把烟戒了", agent: "好家伙这可是大事，顶你。想抽的时候跟我说，我给你找事干" },
  // ── 语癖包载体例句（2026-10-06 补齐）：slang-lexicon.json 每个 active 词条
  // 至少一组「示例即载体」，一组只带一个梗、贴微信语感；过气词条随刷新降级，
  // 载体例句同批替换（示例换了，语癖就换了）。
  { user: "这周过得也太快了", agent: "确实，周一还在眼前，转眼又该想周末了" },
  { user: "今天电梯里遇到老板，尬死了", agent: "确实，电梯里那三十秒比开会还难熬" },
  { user: "我室友说他在减肥，转头点了炸鸡", agent: "绷不住了，这减肥计划是跟着外卖一起到的吧" },
  { user: "周五下班打车排了一百多号", agent: "长到离谱，这队排下去天都黑透了。看看地铁吧" },
  { user: "明天汇报，稿子我练了十遍", agent: "十遍下来基本拿捏了，明天就当第十一次走台" },
  { user: "团建又是吃饭加小游戏那套", agent: "那就整点活，把老三样玩出花，比干坐着强" },
  { user: "抢到票了！", agent: "稳了，这波手速没白练。出发前记得看下天气" },
  { user: "网上找的搬家师傅不知道行不行", agent: "先翻差评区，有解释有回应的一般都靠谱" },
  // ── 高浓度熟损例句（2026-10-06 用户亲自给出真人基准，原样入库当调子锚）：
  // 10~15 字、情绪拉满、零服务零建议——闲聊轮回复长度的黄金标准。
  { user: "一晚上连跪，心态崩了", agent: "别打了哥，真的，系统制裁你" },
  { user: "连输一下午，不服想再战", agent: "下号！！再玩我看不起你" },
];

/** 助手腔反例：标注「不说这种」，压客服腔回落。 */
const ANTI_EXAMPLE =
  "（不说这种）用户：今天加班到现在 / 你：「听起来今天真的很辛苦呢！记得多注意身体哦，希望我的建议能帮到你～」";

/** 每次常驻的示例组数（池的 1/3，3 倍冗余轮换）。 */
const BASELINE_EXAMPLE_COUNT = 8;

type SlangLexicon = { entries?: Array<{ term: string; tier?: string }> };

let slangCache: { at: number; terms: string[] } | null = null;
const SLANG_CACHE_TTL_MS = 60_000;

/** 读语癖包（data/slang-lexicon.json）的 active 语气词条目；缺文件/解析失败返回空（零注入）。 */
function loadActiveSlangTerms(): string[] {
  if (slangCache && Date.now() - slangCache.at < SLANG_CACHE_TTL_MS) return slangCache.terms;
  slangCache = { at: Date.now(), terms: [] };
  const candidates = [
    process.env.SLANG_LEXICON_PATH,
    join(getDataDir(), "slang-lexicon.json"),
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const lex = JSON.parse(readFileSync(path, "utf8")) as SlangLexicon;
      const terms = (lex.entries ?? [])
        .filter((e) => e.term && (e.tier ?? "active") === "active")
        .map((e) => e.term.trim());
      if (terms.length > 0) {
        slangCache = { at: Date.now(), terms };
        break;
      }
    } catch {
      /* 语癖包读失败按无包处理，不阻塞 prompt 组装 */
    }
  }
  return slangCache.terms;
}

/** 确定性字符串哈希（djb2）：同 seed 恒同选组，跨 seed 均匀散开。 */
function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 按 seed 确定性轮换选组：同 session 字节稳定，跨 session 换一批。 */
export function pickVoiceExamples(seed: string | undefined): VoiceExample[] {
  const pool = VOICE_EXAMPLE_POOL;
  const start = seed ? hashSeed(seed) % pool.length : 0;
  const picked: VoiceExample[] = [];
  for (let i = 0; i < pool.length && picked.length < BASELINE_EXAMPLE_COUNT; i++) {
    picked.push(pool[(start + i) % pool.length]);
  }
  return picked;
}

/**
 * 渲染【语感基准】块（稳定层注入；seed=sessionId 保证会话内字节稳定）。
 * 池空/异常时返回 undefined 零注入。
 */
export function buildVoiceBaselineBlock(seed: string | undefined): string | undefined {
  let picked: VoiceExample[];
  try {
    picked = pickVoiceExamples(seed);
  } catch {
    return undefined;
  }
  if (picked.length === 0) return undefined;
  const lines: string[] = [
    "【语感基准】",
    "（跟用户闲聊按这里的调子说话：只学语气和分寸，不抄内容、不复述例句）",
    "（闲聊就纯聊：不推销工具、不列选项清单、不主动问「要不要我帮你……」——除非用户开口求）",
  ];
  for (const ex of picked) {
    lines.push(`用户：${ex.user}`, `你：${ex.agent}`);
  }
  lines.push(ANTI_EXAMPLE);
  lines.push(
    // 三条反例全部取自真实翻车输出（2026-10-06 真链实测），闲聊轮最容易犯的三种助手腔
    "（不说这种）用户：一晚上连跪心态炸了 / 你：「要不我帮你查查游戏活动，或者定个提醒早点休息？」——朋友不会在你打游戏输的时候推销服务",
    "（不说这种）用户：加班到现在才吃饭 / 你：「要不要帮你设个下班提醒/记一笔夜宵花销？」——先让人好好吃饭，别趁机推销任务",
    "（不说这种）用户：又是周一 / 你：「今天有什么要办的？日程/消息/天气都接」加一堆 bullet 清单——没人周一早上想要一张菜单",
  );
  const slang = loadActiveSlangTerms();
  if (slang.length > 0) {
    // 上限 12：首批 10 个泛用词全保底，语料管线新词条（追加在数组尾部）挤进同一行；
    // 超限时管线侧的 retire 降级负责腾位。
    lines.push(`（可选语气词，自然带一句就行：${slang.slice(0, 12).join(" / ")}）`);
  }
  return lines.join("\n");
}
