/**
 * 邮箱 IMAP 轮询服务（MailWatchService）单元测试。
 *
 * 全部用假 clientFactory（不发真网络请求）覆盖：
 *   - 新邮件差量检测 + UID 幂等（重复轮询不重复回调）
 *   - processed-uids 落盘读写（跨实例/重启仍然幂等）
 *   - 重要性分级：VIP → critical / 关键词 → high / 普通 → normal
 *   - 未配置或未启用时 start() no-op 且 status() 如实说明
 *   - 连接失败：诚实记账（lastError / consecutiveFailures），不抛错不 crash
 *   - 原始邮件正文摘要提取（plain / base64 / quoted-printable+gbk / multipart / html）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import iconv from "iconv-lite";

import {
  classifyMailImportance,
  decodeHtmlEntities,
  extractMailTextSnippet,
  sanitizeMailText,
  stripInvisibleMailChars,
  MailWatchService,
  type IncomingMail,
  type MailWatchClassification,
  type MailWatchDeps,
  type MailWatchFetchedMail,
  type MailWatchClient,
} from "../src/services/mail-watch-service.js";

// ---------------------------------------------------------------------- //
// 假 IMAP 客户端：内存邮箱，可模拟连接失败与标记已读
// ---------------------------------------------------------------------- //

class FakeMailbox {
  mails: MailWatchFetchedMail[] = [];
  seenUids: number[] = [];
  connectFailures = 0;
  client: MailWatchClient;

  constructor() {
    this.client = {
      connect: async () => {
        if (this.connectFailures > 0) {
          this.connectFailures -= 1;
          throw new Error("connect ECONNREFUSED 127.0.0.1:993");
        }
      },
      logout: async () => {},
      mailboxOpen: async () => ({ uidValidity: 42n, exists: this.mails.length }),
      fetchRecentMessages: async (limit: number) => this.mails.slice(-limit),
      markSeen: async (uid: number) => {
        this.seenUids.push(uid);
      },
    };
  }

  add(uid: number, from: string, subject: string, textSnippet?: string, source?: Buffer): void {
    this.mails.push({ uid, from, to: "me@example.com", subject, textSnippet, source });
  }
}

interface Received {
  mail: IncomingMail;
  classification: MailWatchClassification;
}

function makeService(opts: {
  mailbox: FakeMailbox;
  persistPath: string;
  env?: Record<string, string | undefined>;
  onNewMessage?: MailWatchDeps["onNewMessage"];
  factoryCalls?: { count: number };
}): MailWatchService {
  return new MailWatchService({
    clientFactory: () => {
      if (opts.factoryCalls) opts.factoryCalls.count += 1;
      return opts.mailbox.client;
    },
    onNewMessage: opts.onNewMessage,
    env: {
      MAIL_WATCH_ENABLED: "1",
      MAIL_WATCH_HOST: "imap.example.com",
      MAIL_WATCH_USER: "me@example.com",
      MAIL_WATCH_PASS: "secret",
      ...opts.env,
    },
    persistPath: opts.persistPath,
  });
}

function tmpStatePath(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mail-watch-")).then((dir) => join(dir, "mail-watch", "processed-uids.json"));
}

// ---------------------------------------------------------------------- //
// 差量检测 / UID 幂等 / 落盘
// ---------------------------------------------------------------------- //

test("首启基线：第一轮只记录已处理 UID，不把历史邮件当新消息轰炸", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(101, "a@example.com", "上月对账单");
  mailbox.add(102, "b@example.com", "周末聚餐呀");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });

  const result = await service.pollOnce();
  assert.ok(result.ok);
  assert.equal(result.handled, 0, "首启应建立基线而不通知");
  assert.equal(received.length, 0);

  const status = service.status();
  assert.equal(status.processedUidCount, 2);
  assert.equal(status.uidValidity, "42");
});

test("差量检测：窗口内新增 UID 才触发 onNewMessage，且分级信息齐全", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(101, "a@example.com", "旧邮件");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  await service.pollOnce(); // 基线

  mailbox.add(102, "老板 <boss@example.com>", "明天开会提前半小时");
  const result = await service.pollOnce();
  assert.ok(result.ok);
  assert.equal(result.handled, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.mail.uid, 102);
  assert.equal(received[0]!.mail.actorId, "default_user");
  assert.equal(received[0]!.mail.from, "老板 <boss@example.com>");
  assert.ok(received[0]!.classification.reasons.length >= 0, "reasons 数组存在");
});

test("UID 幂等：重复轮询同一批邮件不重复回调", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(101, "a@example.com", "第一封");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  await service.pollOnce();

  mailbox.add(102, "b@example.com", "第二封");
  const r2 = await service.pollOnce();
  assert.ok(r2.ok && r2.handled === 1);
  const r3 = await service.pollOnce();
  const r4 = await service.pollOnce();
  assert.ok(r3.ok && r3.handled === 0, "第三轮无新邮件");
  assert.ok(r4.ok && r4.handled === 0, "第四轮无新邮件");
  assert.equal(received.length, 1, "uid=102 只回调一次");
});

test("processed-uids 落盘：文件可读、结构完整，跨实例（重启）仍然幂等", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(201, "a@example.com", "落盘前");
  const persistPath = await tmpStatePath();
  const received: Received[] = [];
  const service = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  await service.pollOnce();
  mailbox.add(202, "b@example.com", "落盘前2");
  await service.pollOnce();

  // 文件确实落盘且内容可解析
  const raw = JSON.parse(await readFile(persistPath, "utf8")) as { version: number; initialized: boolean; uidValidity: string; uids: number[] };
  assert.equal(raw.version, 1);
  assert.equal(raw.initialized, true);
  assert.equal(raw.uidValidity, "42");
  assert.deepEqual(raw.uids, [201, 202]);

  // 模拟重启：新实例 + 同一落盘文件 + 邮箱里还是那两封 → 不重复回调
  const service2 = makeService({ mailbox, persistPath, onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); } });
  const result = await service2.pollOnce();
  assert.ok(result.ok && result.handled === 0, "重启后同一批邮件不得重复通知");
  assert.equal(received.length, 1);
});

// ---------------------------------------------------------------------- //
// 重要性分级
// ---------------------------------------------------------------------- //

test("VIP 白名单命中 → critical（精确地址大小写不敏感 + @domain 整域）", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received = new Map<number, MailWatchClassification>();
  const service = makeService({
    mailbox,
    persistPath,
    env: { MAIL_WATCH_VIP_SENDERS: "Boss@Family.com, @corp.example.com" },
    onNewMessage: async (mail, c) => { received.set(mail.uid!, c); },
  });
  await service.pollOnce(); // 基线

  mailbox.add(301, '老板 <BOSS@family.com>', "晚饭吃什么");
  mailbox.add(302, "同事 <someone@corp.example.com>", "周报请查收");
  mailbox.add(303, "陌生 <stranger@other.com>", "普通通知");
  const result = await service.pollOnce();
  assert.ok(result.ok && result.handled === 3);

  assert.equal(received.get(301)!.importance, "critical", "精确地址（大小写不敏感）命中 VIP");
  assert.equal(received.get(301)!.reasons[0], "vip_sender:boss@family.com");
  assert.equal(received.get(302)!.importance, "critical", "@domain 整域命中 VIP");
  assert.equal(received.get(303)!.importance, "normal", "非 VIP 无规则命中即为 normal");
});

test("确定性关键词 → high：主题命中验证码、正文命中取件码、英文航班", () => {
  const subjectHit = classifyMailImportance({
    from: "noreply@service.com",
    subject: "【某平台】您的验证码是 823105，5 分钟内有效",
    textSnippet: "",
  });
  assert.equal(subjectHit.importance, "high");
  assert.match(subjectHit.reasons[0]!, /验证码/);

  const textHit = classifyMailImportance({
    from: "notice@cainiao.com",
    subject: "您有新的包裹通知",
    textSnippet: "您的包裹已到丰巢驿站，取件码 8-2-3010，请及时领取。",
  });
  assert.equal(textHit.importance, "high");

  const englishHit = classifyMailImportance({
    from: "no-reply@airline.com",
    subject: "Your flight boarding pass is ready",
    textSnippet: "",
  });
  assert.equal(englishHit.importance, "high");
});

test("无关邮件 → normal（无规则命中、reasons 为空）", () => {
  const normal = classifyMailImportance({
    from: "friend@example.com",
    subject: "周末聚餐呀",
    textSnippet: "周六晚上老地方见？",
  });
  assert.equal(normal.importance, "normal");
  assert.deepEqual(normal.reasons, []);
});

test("VIP 优先级高于关键词：VIP 发来的普通邮件也是 critical", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received: Received[] = [];
  const service = makeService({
    mailbox,
    persistPath,
    env: { MAIL_WATCH_VIP_SENDERS: "boss@family.com" },
    onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); },
  });
  await service.pollOnce();
  mailbox.add(401, "boss@family.com", "周末聚餐呀"); // 无关键词，但 VIP
  await service.pollOnce();
  assert.equal(received[0]!.classification.importance, "critical");
});

// ---------------------------------------------------------------------- //
// 乱码修复：HTML 实体解码 + 隐形字符清除
// ---------------------------------------------------------------------- //

test("extractMailTextSnippet：HTML 实体解码（数字十进制/十六进制/命名）", () => {
  const raw = [
    "From: a@example.com",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>价格 &#165;99 与 &amp; 合作 &#x798F; 字 &quot;引号&quot; &eacute;l&egrave;ve</p>",
  ].join("\r\n");
  const text = extractMailTextSnippet(Buffer.from(raw, "utf8"));
  assert.match(text, /价格 ¥99 与 & 合作 福 字 "引号" élève/);
});

test("extractMailTextSnippet：&#847; &shy; 等营销干扰字符解码后被清除，不再出现实体乱码", () => {
  const raw = [
    "From: uber@uber.com",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>&#847;&shy;&#847;&shy;&#847;&shy;即刻领取：您的前 2 笔订单可享受高达 60% 的优惠</p>",
  ].join("\r\n");
  const text = extractMailTextSnippet(Buffer.from(raw, "utf8"));
  assert.equal(text, "即刻领取：您的前 2 笔订单可享受高达 60% 的优惠");
  assert.equal(text, stripInvisibleMailChars(decodeHtmlEntities(text)), "解码后不含残留隐形字符");
});

test("sanitizeMailText：主题里的实体与零宽字符被净化", () => {
  assert.equal(sanitizeMailText("Save &#36;10&nbsp;now\u200B"), "Save $10 now");
  assert.equal(sanitizeMailText("Uber\u00ADEats"), "UberEats");
});

// ---------------------------------------------------------------------- //
// 营销/广告邮件过滤
// ---------------------------------------------------------------------- //

test("营销识别：List-Unsubscribe 头 / 营销主题词 / 退订尾巴组合 均判 promotional", () => {
  // a) 合规营销邮件最强信号：List-Unsubscribe 头（正文不带营销词也判）
  const headerHit = classifyMailImportance({
    from: "news@shop.com",
    subject: "您 10 月的会员权益已更新",
    textSnippet: "会员中心内容有更新，点击查看。",
    source: Buffer.from(
      "From: news@shop.com\r\nList-Unsubscribe: <mailto:un@shop.com>\r\n\r\nbody",
      "latin1",
    ),
  });
  assert.equal(headerHit.importance, "promotional");
  assert.match(headerHit.reasons[0]!, /list_unsubscribe_header/);

  // b) 主题命中营销关键词（Uber Eats 广告场景）
  const subjectHit = classifyMailImportance({
    from: "uber@uber.com",
    subject: "即刻领取：您的前 2 笔订单可享受高达 60% 的优惠",
    textSnippet: "浏览当地餐厅，使用 Uber Eats 优惠好处多多。",
  });
  assert.equal(subjectHit.importance, "promotional");
  assert.match(subjectHit.reasons[0]!, /subject_keyword/);

  // d) 正文退订尾巴 + 营销关键词组合
  const footerHit = classifyMailImportance({
    from: "notice@mall.com",
    subject: "来自商城的消息",
    textSnippet: "秋冬新品上架，全场折扣进行中。如不想继续接收，可随时退订。",
  });
  assert.equal(footerHit.importance, "promotional");

  // 事务性邮件不受影响：正文有"优惠"但无退订尾巴、主题无营销词 → 不判营销
  const transactional = classifyMailImportance({
    from: "notice@cainiao.com",
    subject: "您有新的包裹通知",
    textSnippet: "您的包裹已到丰巢驿站，取件码 8-2-3010，请及时领取。",
  });
  assert.equal(transactional.importance, "high");
});

test("营销识别开关：VIP 白名单优先于营销判定；MAIL_WATCH_FILTER_PROMO=0 可关闭", () => {
  // VIP 发的营销邮件仍是 critical（白名单是用户显式意志）
  const vipPromo = classifyMailImportance(
    { from: "boss@family.com", subject: "会员日专享：全场 8 折优惠", textSnippet: "" },
    ["boss@family.com"],
  );
  assert.equal(vipPromo.importance, "critical");

  // 关闭过滤开关后营销检测跳过（回退旧行为：normal 或按关键词规则）
  const disabled = classifyMailImportance(
    { from: "uber@uber.com", subject: "即刻领取：前 2 笔订单享 60% 优惠", textSnippet: "" },
    [],
    { filterPromotional: false },
  );
  assert.equal(disabled.importance, "normal");
});

test("服务级过滤：promotional 邮件不回调 onNewMessage、不进 message-hub，UID 照常记录", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received: Received[] = [];
  const ingested: string[] = [];
  const service = new MailWatchService({
    clientFactory: () => mailbox.client,
    onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); },
    messageHub: {
      ingestInbound: async (input) => { ingested.push(input.externalMessageId ?? ""); },
    },
    env: {
      MAIL_WATCH_ENABLED: "1",
      MAIL_WATCH_HOST: "imap.example.com",
      MAIL_WATCH_USER: "me@example.com",
      MAIL_WATCH_PASS: "secret",
    },
    persistPath,
  });
  await service.pollOnce(); // 基线

  mailbox.add(601, "uber@uber.com", "即刻领取：您的前 2 笔订单可享受高达 60% 的优惠", "浏览当地餐厅，使用 Uber Eats。");
  mailbox.add(602, "friend@example.com", "周末聚餐呀", "周六晚上老地方见？");
  const result = await service.pollOnce();
  assert.ok(result.ok && result.handled === 2, "营销邮件也计入 handled（UID 消费掉不重判）");

  assert.equal(received.length, 1, "只有普通邮件触发 onNewMessage");
  assert.equal(received[0]!.mail.uid, 602);
  assert.equal(ingested.length, 1, "营销邮件不进消息中心");
  assert.equal(service.status().promotionalFiltered, 1);

  // 下一轮不再重判（UID 已记入已处理集合）
  const again = await service.pollOnce();
  assert.ok(again.ok && again.handled === 0);
  assert.equal(service.status().promotionalFiltered, 1);
});

test("MAIL_WATCH_FILTER_PROMO=0 关闭过滤：营销邮件恢复落库与回调", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received: Received[] = [];
  const ingested: string[] = [];
  const service = new MailWatchService({
    clientFactory: () => mailbox.client,
    onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); },
    messageHub: {
      ingestInbound: async (input) => { ingested.push(input.externalMessageId ?? ""); },
    },
    env: {
      MAIL_WATCH_ENABLED: "1",
      MAIL_WATCH_HOST: "imap.example.com",
      MAIL_WATCH_USER: "me@example.com",
      MAIL_WATCH_PASS: "secret",
      MAIL_WATCH_FILTER_PROMO: "0",
    },
    persistPath,
  });
  await service.pollOnce(); // 基线
  mailbox.add(701, "uber@uber.com", "即刻领取：您的前 2 笔订单可享受高达 60% 的优惠", "");
  const result = await service.pollOnce();
  assert.ok(result.ok && result.handled === 1);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.classification.importance, "normal", "关闭过滤后回退为 normal（无关键词命中）");
  assert.equal(ingested.length, 1);
  assert.equal(service.status().promotionalFiltered, 0);
});

// ---------------------------------------------------------------------- //
// 系统通知过滤（noise）：机器发件人默认不进消息中心，"关于用户的"照常放行
// ---------------------------------------------------------------------- //

test("系统通知识别：GitHub/Autodesk 等机器发件人未命中重要规则 → noise", () => {
  // GitHub 通知（用户截图里的噪音来源）
  const github = classifyMailImportance({
    from: "GitHub <notifications@github.com>",
    subject: "[GitHub] Your pull request #42 was approved",
    textSnippet: "CI passed. View it on GitHub or unsubscribe.",
  });
  assert.equal(github.importance, "noise");
  assert.match(github.reasons[0]!, /machine_sender/);

  // Autodesk 授权通知
  const autodesk = classifyMailImportance({
    from: "no-reply@autodesk.com",
    subject: "Your license will expire in 30 days",
    textSnippet: "",
  });
  assert.equal(autodesk.importance, "noise");

  // alerts@/updates@ 等角色地址同样拦
  assert.equal(classifyMailImportance({ from: "alerts@monitor.io", subject: "Uptime report", textSnippet: "" }).importance, "noise");

  // 真人账号（词边界保护）：noreply123@ / wang.ge@ 不是机器角色，不拦
  assert.equal(classifyMailImportance({ from: "noreply123@example.com", subject: "嗨", textSnippet: "" }).importance, "normal");
  assert.equal(classifyMailImportance({ from: "wang.ge@example.com", subject: "嗨", textSnippet: "" }).importance, "normal");
});

test("误杀保护：机器发件人的出票/账单/验证码邮件先被重要规则救回 → high 而非 noise", () => {
  // 携程出票（no-reply 发件人 + 主题命中机票规则）
  const ctrip = classifyMailImportance({
    from: "携程旅行 <no-reply@ctrip.com>",
    subject: "出票成功：您的机票已出票",
    textSnippet: "航班信息与票面详情见附件。",
  });
  assert.equal(ctrip.importance, "high");
  assert.match(ctrip.reasons[0]!, /机票/);

  // 酒店预订确认（预订/出票规则，2026-11-02 新增）
  const hotel = classifyMailImportance({
    from: "booking <noreply@hotel.cn>",
    subject: "预订成功：亚朵酒店 11 月 5 日大床房",
    textSnippet: "",
  });
  assert.equal(hotel.importance, "high");

  // 电影票/演出票
  const cinema = classifyMailImportance({
    from: "maoyan <no-reply@maoyan.com>",
    subject: "订单确认：电影票 2 张，今晚 20:30 场次",
    textSnippet: "",
  });
  assert.equal(cinema.importance, "high");
});

test("服务级过滤：noise 邮件不回调 onNewMessage、不进 message-hub，UID 照常记录", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received: Received[] = [];
  const ingested: string[] = [];
  const service = new MailWatchService({
    clientFactory: () => mailbox.client,
    onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); },
    messageHub: {
      ingestInbound: async (input) => { ingested.push(input.externalMessageId ?? ""); },
    },
    env: {
      MAIL_WATCH_ENABLED: "1",
      MAIL_WATCH_HOST: "imap.example.com",
      MAIL_WATCH_USER: "me@example.com",
      MAIL_WATCH_PASS: "secret",
    },
    persistPath,
  });
  await service.pollOnce(); // 基线

  mailbox.add(801, "GitHub <notifications@github.com>", "[GitHub] Build completed");
  mailbox.add(802, "Autodesk <no-reply@autodesk.com>", "Your subscription receipt");
  mailbox.add(803, "friend@example.com", "周末聚餐呀", "周六晚上老地方见？");
  const result = await service.pollOnce();
  assert.ok(result.ok && result.handled === 3, "系统通知也计入 handled（UID 消费掉不重判）");

  assert.equal(received.length, 1, "只有真人来信触发 onNewMessage");
  assert.equal(received[0]!.mail.uid, 803);
  assert.equal(ingested.length, 1, "系统通知不进消息中心（不制造未读）");
  assert.equal(service.status().noiseFiltered, 2);

  // 下一轮不再重判（UID 已记入已处理集合）
  const again = await service.pollOnce();
  assert.ok(again.ok && again.handled === 0);
  assert.equal(service.status().noiseFiltered, 2);
});

test("MAIL_WATCH_FILTER_NOISE=0 关闭过滤：系统通知回退为 normal，恢复落库与回调", async () => {
  const persistPath = await tmpStatePath();
  const mailbox = new FakeMailbox();
  const received: Received[] = [];
  const ingested: string[] = [];
  const service = new MailWatchService({
    clientFactory: () => mailbox.client,
    onNewMessage: async (mail, c) => { received.push({ mail, classification: c }); },
    messageHub: {
      ingestInbound: async (input) => { ingested.push(input.externalMessageId ?? ""); },
    },
    env: {
      MAIL_WATCH_ENABLED: "1",
      MAIL_WATCH_HOST: "imap.example.com",
      MAIL_WATCH_USER: "me@example.com",
      MAIL_WATCH_PASS: "secret",
      MAIL_WATCH_FILTER_NOISE: "0",
    },
    persistPath,
  });
  await service.pollOnce(); // 基线
  mailbox.add(901, "GitHub <notifications@github.com>", "[GitHub] Build completed");
  const result = await service.pollOnce();
  assert.ok(result.ok && result.handled === 1);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.classification.importance, "normal", "关闭过滤后回退为 normal（无关键词命中）");
  assert.equal(ingested.length, 1);
  assert.equal(service.status().noiseFiltered, 0);
});

// ---------------------------------------------------------------------- //
// 标记已读 / 生命周期 / 诚实失败
// ---------------------------------------------------------------------- //

test("MAIL_WATCH_MARK_SEEN 默认不标已读；=1 时仅对新邮件标记", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(501, "a@example.com", "历史邮件");
  const persistPath = await tmpStatePath();
  const service = makeService({ mailbox, persistPath, env: { MAIL_WATCH_MARK_SEEN: "1" } });
  await service.pollOnce();
  assert.deepEqual(mailbox.seenUids, [], "首启基线不标已读");

  mailbox.add(502, "b@example.com", "新邮件");
  await service.pollOnce();
  assert.deepEqual(mailbox.seenUids, [502], "只标新邮件");

  // 默认（未设 env）不标
  const mailbox2 = new FakeMailbox();
  mailbox2.add(501, "a@example.com", "历史邮件");
  const service2 = makeService({ mailbox: mailbox2, persistPath: await tmpStatePath() });
  await service2.pollOnce();
  mailbox2.add(502, "b@example.com", "新邮件");
  await service2.pollOnce();
  assert.deepEqual(mailbox2.seenUids, [], "默认不污染用户邮箱已读状态");
});

test("未启用 start() no-op；启用但缺凭证也 no-op 并如实说明原因", () => {
  const mailbox = new FakeMailbox();
  const factoryCalls = { count: 0 };

  // 默认 MAIL_WATCH_ENABLED=0：不启动、不碰 IMAP
  const disabled = new MailWatchService({
    clientFactory: () => {
      factoryCalls.count += 1;
      return mailbox.client;
    },
    env: { MAIL_WATCH_HOST: "imap.example.com", MAIL_WATCH_USER: "u", MAIL_WATCH_PASS: "p" },
    persistPath: join(tmpdir(), "mail-watch-disabled-test", "uids.json"),
  });
  disabled.start();
  let status = disabled.status();
  assert.equal(status.running, false);
  assert.equal(status.enabled, false);
  assert.match(status.reason ?? "", /未启用/);

  // 启用了但缺 MAIL_WATCH_PASS：no-op + 如实说明
  const unconfigured = new MailWatchService({
    clientFactory: () => {
      factoryCalls.count += 1;
      return mailbox.client;
    },
    env: { MAIL_WATCH_ENABLED: "1", MAIL_WATCH_HOST: "imap.example.com", MAIL_WATCH_USER: "u" },
    persistPath: join(tmpdir(), "mail-watch-disabled-test", "uids.json"),
  });
  unconfigured.start();
  status = unconfigured.status();
  assert.equal(status.running, false);
  assert.equal(status.configured, false);
  // 2026-10-01 邮箱自动接入后文案区分两种缺配置：host+user 在而 pass 缺 = 等授权码；全缺 = 未配置
  assert.match(status.reason ?? "", /授权码|未配置/);
  assert.equal(factoryCalls.count, 0, "no-op 路径不得创建 IMAP 客户端");
});

test("start/stop：启动后真实轮询，stop 后如实标注并停止调度", async () => {
  const mailbox = new FakeMailbox();
  mailbox.add(601, "a@example.com", "启动时的存量");
  const persistPath = await tmpStatePath();
  const service = makeService({ mailbox, persistPath });

  service.start();
  assert.equal(service.status().running, true);
  // 等 setTimeout(0) 的第一轮 tick 跑完
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(service.status().lastPollAt, "启动后应完成第一轮拉取");

  service.stop();
  const status = service.status();
  assert.equal(status.running, false);
  assert.match(status.reason ?? "", /停止/);
});

test("连接失败：pollOnce 返回 ok:false，status 如实记账（连续失败计数可见），恢复后清零", async () => {
  const mailbox = new FakeMailbox();
  mailbox.connectFailures = 2; // 前两轮连接失败
  const persistPath = await tmpStatePath();
  const service = makeService({ mailbox, persistPath });

  const r1 = await service.pollOnce();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /ECONNREFUSED/);
  const s1 = service.status();
  assert.equal(s1.consecutiveFailures, 1);
  assert.match(s1.lastError ?? "", /ECONNREFUSED/, "失败原因如实进 status，不假装在盯");

  await service.pollOnce();
  assert.equal(service.status().consecutiveFailures, 2);

  const r3 = await service.pollOnce();
  assert.equal(r3.ok, true);
  const s3 = service.status();
  assert.equal(s3.consecutiveFailures, 0, "恢复后失败计数清零");
  assert.equal(s3.lastError, null);
});

test("actorId 约定：MAIL_WATCH_ACTOR_ID > MESSAGE_BRIDGE_DEFAULT_ACTOR_ID > default_user", () => {
  const mk = (env: Record<string, string | undefined>) =>
    new MailWatchService({ env, persistPath: join(tmpdir(), "mail-watch-actor-test", "uids.json") });

  assert.equal(mk({}).status().actorId, "default_user");
  assert.equal(
    mk({ MESSAGE_BRIDGE_DEFAULT_ACTOR_ID: "session-mvp-001" }).status().actorId,
    "session-mvp-001",
    "未显式配置时沿用消息桥的默认用户约定",
  );
  assert.equal(
    mk({ MESSAGE_BRIDGE_DEFAULT_ACTOR_ID: "session-mvp-001", MAIL_WATCH_ACTOR_ID: "alice" }).status().actorId,
    "alice",
    "显式 MAIL_WATCH_ACTOR_ID 优先",
  );
});

// ---------------------------------------------------------------------- //
// 原始邮件正文摘要提取（生产 imapflow 适配器依赖的解析逻辑）
// ---------------------------------------------------------------------- //

test("extractMailTextSnippet：plain 文本直接提取", () => {
  const raw = Buffer.from(
    "From: a@b.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n你好，请查收明天的会议纪要。",
    "utf8",
  );
  assert.equal(extractMailTextSnippet(raw), "你好，请查收明天的会议纪要。");
});

test("extractMailTextSnippet：base64 + utf-8 正文解码", () => {
  const text = "您的快递已到菜鸟驿站，取件码 8823。";
  const raw = Buffer.from(
    `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text, "utf8").toString("base64")}`,
    "latin1",
  );
  assert.match(extractMailTextSnippet(raw), /取件码 8823/);
});

test("extractMailTextSnippet：quoted-printable + gbk 中文解码", () => {
  const gbkBytes = iconv.encode("您的验证码是 823105，请勿泄露。", "gbk");
  // 手工 QP 编码：=XX 形式还原字节
  let qp = "";
  for (const b of gbkBytes) {
    if (b === 0x3d || b < 0x20 || b > 0x7e) qp += `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    else qp += String.fromCharCode(b);
  }
  const raw = Buffer.from(
    `Content-Type: text/plain; charset="gbk"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp}`,
    "latin1",
  );
  assert.match(extractMailTextSnippet(raw), /验证码是 823105/);
});

test("extractMailTextSnippet：multipart/alternative 优先取 text/plain", () => {
  const boundary = "----part-boundary-42";
  const raw = Buffer.from(
    [
      "Content-Type: multipart/alternative;",
      ` boundary="${boundary}"`,
      "",
      "preamble 应被跳过",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "会议改期到明天上午十点。",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><b>会议改期到明天上午十点。</b></body></html>",
      `--${boundary}--`,
      "epilogue 应被跳过",
    ].join("\r\n"),
    "utf8",
  );
  assert.equal(extractMailTextSnippet(raw), "会议改期到明天上午十点。");
});

test("extractMailTextSnippet：仅 HTML 时去标签兜底；空输入返回空串", () => {
  const raw = Buffer.from(
    "Content-Type: text/html; charset=utf-8\r\n\r\n<html><body style='x'><b>面试邀请</b>：请查收</body></html>",
    "utf8",
  );
  assert.match(extractMailTextSnippet(raw), /面试邀请\s*：?\s*请查收/);
  assert.equal(extractMailTextSnippet(null), "");
  assert.equal(extractMailTextSnippet(Buffer.alloc(0)), "");
});
