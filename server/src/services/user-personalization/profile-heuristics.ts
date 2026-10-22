export type ProfilePatch = {
  displayName?: string;
  /** true = 用户明确指定如何称呼（"叫我X/称呼我X"），称呼须原样使用、不得改为「姓+先生」 */
  displayNameExplicit?: boolean;
  interest?: string;
  identity?: string;
  toneNote?: string;
  replyPreference?: string;
  freeformNote?: string;
};

const CONCISE_REPLY_PREF_RE =
  /不要.*(?:标题|摘要|长篇大论|废话|口水话|总结)|(?:简洁|精简|直接点|短一点|一句话|一两句|别展开|长话短说|太长不看|少点废话|口语化短句|像聊天一样|像真人朋友聊天)/i;

const ADAPTIVE_REPLY_PREF_RE =
  /(?:跟着|顺着).*(?:风格|习惯|方式)|越聊越熟|熟一点|自然一点|像朋友一点|别太官方|别像客服|别像机器人/i;

const LIVELY_TONE_PREF_RE =
  /(?:活人感|像真人|真实一点|有点人味|别太端着|别太正经|自然一点|会聊天一点|口语化一点|顺着聊|陪我聊|追问|多问一句|搞笑|幽默|逗一点|皮一点|俏皮|可爱一点|卖萌|调侃|吐槽|内涵|阴阳|损我两句)/i;

/** 名字捕获只收「叫」类显式指定/自我介绍——「我是」会误捕身份（「我是做后端的」→称呼：做后端的，
 *  2026-10-22 移除；身份归 IDENTITY_RE） */
const NAME_RE =
  /(?:我叫|叫我|称呼我|你可以叫我|名字叫)\s*([^\s，。！？,.]{1,16})/;
/** 明确指定称呼的说法（"叫我X/称呼我X/你可以叫我X"）——区别于自我介绍"我叫X" */
const REQUESTED_APPELLATION_RE =
  /(?:叫我|称呼我|喊我|你可以叫我)\s*([^\s，。！？,.]{1,16})/;
const INTEREST_RE =
  /(?:我喜欢|我爱|我最爱|经常|平时喜欢)\s*([^\s，。！？,.]{2,40})/;
const IDENTITY_RE =
  /我是\s*([^\s，。！？,.]{2,24}(?:人|的|者|员|生|师|狗|党)?)/;

export function extractProfilePatches(userText: string): ProfilePatch[] {
  const t = userText.trim();
  if (!t) return [];

  const patches: ProfilePatch[] = [];

  const name = NAME_RE.exec(t);
  if (name?.[1]) {
    // 明确指定（"叫我王哥"）→ 打用户指定标记；自我介绍（"我叫王铭川"）→ 只作事实记录
    const requested = REQUESTED_APPELLATION_RE.exec(t);
    patches.push({
      displayName: name[1].trim(),
      displayNameExplicit: Boolean(requested?.[1]),
    });
  }

  const interest = INTEREST_RE.exec(t);
  if (interest?.[1]) patches.push({ interest: interest[1].trim() });

  const identity = IDENTITY_RE.exec(t);
  if (identity?.[1]) patches.push({ identity: identity[1].trim() });

  if (/(幽默|搞笑|轻松|正式|严谨|温柔|温暖|亲切|俏皮|可爱|活人感)/i.test(t)) {
    patches.push({ toneNote: t.slice(0, 120) });
  }

  if (CONCISE_REPLY_PREF_RE.test(t)) {
    patches.push({
      replyPreference:
        "默认短句、口语化、少解释，像熟人回话；不要客服腔、标题党、表格感和长篇总结。",
    });
  }

  if (ADAPTIVE_REPLY_PREF_RE.test(t)) {
    patches.push({
      freeformNote:
        "回复要继续顺着用户自己的说话方式微调，不套固定模板，整体保持自然、克制、灵活。",
    });
  }

  if (LIVELY_TONE_PREF_RE.test(t)) {
    patches.push({
      freeformNote:
        "用户接受更有活人感的表达：可以视关系和上下文加入幽默、俏皮、轻微调侃、情绪色彩或短追问，但不要固定扮演某种人格。",
    });
  }

  if (/记住|别忘了|以后都要|之后都要/.test(t) && t.length <= 200) {
    patches.push({ freeformNote: t.slice(0, 120) });
  }

  return patches;
}

function upsertBullet(sectionBody: string, bullet: string): string {
  const line = `- ${bullet}`;
  if (sectionBody.includes(bullet)) return sectionBody;
  const trimmed = sectionBody.trimEnd();
  return trimmed ? `${trimmed}\n${line}` : line;
}

function replaceBulletPrefix(sectionBody: string, prefix: string, bullet: string): string {
  const lines = sectionBody.split("\n");
  const filtered = lines.filter((line) => !line.trim().startsWith(`- ${prefix}`));
  filtered.push(`- ${bullet}`);
  return filtered.join("\n").trim();
}

function patchSection(md: string, heading: string, mutator: (body: string) => string): string {
  const re = new RegExp(`(## ${heading}\\s*\\n)([\\s\\S]*?)(?=\\n## |$)`);
  const match = re.exec(md);
  if (!match) return md;
  const nextBody = mutator(match[2].trim());
  return md.slice(0, match.index) + match[1] + nextBody + "\n\n" + md.slice(match.index + match[0].length);
}

export function applyProfilePatches(md: string, patches: ProfilePatch[]): string {
  if (patches.length === 0) return md;
  let out = md;

  const stamp = new Date().toISOString();
  out = out.replace(
    /> 本文件由 Agent[\s\S]*?最后更新：[^\n]*/,
    `> 本文件由 Agent 在与你的对话中持续更新。最后更新：${stamp}`,
  );

  for (const patch of patches) {
    if (patch.displayName) {
      // 用户明确指定的称呼附「（用户指定）」标记：问候/播报解析时原样使用，
      // 即使它长得像大名（appellation.ts 的显式优先规则）
      const marker = patch.displayNameExplicit ? "（用户指定）" : "";
      out = patchSection(out, "基本信息", (body) =>
        replaceBulletPrefix(body, "称呼：", `称呼：${patch.displayName}${marker}`),
      );
    }
    if (patch.identity) {
      out = patchSection(out, "基本信息", (body) =>
        upsertBullet(body, `身份/背景：${patch.identity}`),
      );
    }
    if (patch.interest) {
      out = patchSection(out, "兴趣与习惯", (body) =>
        upsertBullet(body, `兴趣：${patch.interest}`),
      );
    }
    if (patch.toneNote) {
      out = patchSection(out, "沟通偏好", (body) =>
        upsertBullet(body, `用户曾表达：${patch.toneNote}`),
      );
    }
    if (patch.replyPreference) {
      out = patchSection(out, "沟通偏好", (body) =>
        replaceBulletPrefix(body, "回复偏好：", `回复偏好：${patch.replyPreference}`),
      );
    }
    if (patch.freeformNote) {
      out = patchSection(out, "备注", (body) => upsertBullet(body, patch.freeformNote!));
    }
  }

  return out;
}

export function syncPreferredToneInProfile(md: string, toneLabel: string): string {
  return patchSection(md, "沟通偏好", (body) =>
    replaceBulletPrefix(body, "语气风格：", `语气风格：${toneLabel}（系统会根据对话自动调整）`),
  );
}

/**
 * 结构感知截断：画像超长时按 section 重要性整块裁剪，而不是尾部 slice
 * （尾部 slice 会先丢掉文件头部的「基本信息」——姓名/所在地恰恰在最前）。
 * 保留优先级：文件头 + 基本信息 > 沟通偏好 > 兴趣与习惯 > 备注。
 * 即超长时先丢「备注」，再丢「兴趣与习惯」，再丢「沟通偏好」；
 * 「基本信息」与文件头（标题+引用块）永不裁剪。
 */
const TRUNCATE_DROP_ORDER = ["## 备注", "## 兴趣与习惯", "## 沟通偏好"] as const;

export function truncateProfileForPrompt(md: string, maxChars: number): string {
  if (md.length <= maxChars) return md;

  // 拆成 header（第一个 ## 之前）+ 各 section 块（含标题行到下一个 ## 之前）
  const firstHeading = md.search(/^## /m);
  if (firstHeading < 0) return `…（画像过长已截断）\n${md.slice(0, maxChars)}`;
  const header = md.slice(0, firstHeading);
  const marks: number[] = [];
  const re = /^## .*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) marks.push(m.index);
  const blocks: Array<{ heading: string; text: string }> = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1] : md.length;
    const text = md.slice(marks[i], end);
    blocks.push({ heading: text.split("\n")[0].trim(), text });
  }

  const render = (kept: Array<{ heading: string; text: string }>) =>
    header + kept.map((b) => b.text).join("");

  // 按丢弃顺序逐块移除，一旦装得下即停；基本信息始终保留
  let kept = blocks;
  for (const drop of TRUNCATE_DROP_ORDER) {
    if (render(kept).length <= maxChars) return render(kept);
    kept = kept.filter((b) => b.heading !== drop);
  }
  const result = render(kept);
  if (result.length <= maxChars) return result;
  // 仅剩 header + 基本信息仍超长（极端情况）：丢文件头（只是时间戳引用块），保基本信息
  const basicIdx = result.search(/^## /m);
  const body = basicIdx >= 0 ? result.slice(basicIdx) : result;
  return `…（画像过长已截断）\n${body.slice(0, maxChars)}`;
}
