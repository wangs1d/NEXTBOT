import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 深度财务分析能力域 —— ChatCompletionTool schema。
 *
 * 共 16 个工具：
 *   - finance.import_transactions  批量导入交易记录（CSV/JSON）
 *   - finance.analyze_spending    消费分析（按类别 / 时间段聚合）
 *   - finance.set_budget          设置预算（按月 / 按类别）
 *   - finance.get_budget_status   查询预算执行进度
 *   - finance.reconcile           自动对账：找出账单 vs 已记录差异
 *   - finance.categorize          自动分类一笔交易
 *   - finance.export_report       导出财务报告（markdown / csv / json）
 *   - finance.list_subscriptions  订阅盘点：列出自动续费订阅 + 疑似候选
 *   - finance.confirm_subscription 确认候选 / 手动登记订阅
 *   - finance.update_subscription 更新订阅状态 / 使用记录
 *   - finance.cancel_subscription 自动取消订阅（识别 + 退订 + 省钱统计）
 *   - finance.savings_summary     订阅省钱统计（已退订累计省下多少）
 *   - finance.add_bill            登记定期账单（追踪）
 *   - finance.list_bills          账单追踪：到期日 / 状态 / 月均固定支出
 *   - finance.update_bill         更新账单信息
 *   - finance.pay_bill            账单缴费登记（入账 + 预算联动）
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY：
 *   1. 用户不是每轮都会查账本 / 预算
 *   2. 关键词触发（"账单" / "预算" / "对账" / "月度报告" / "订阅" / "退订" / "缴费"）时由 tool_discover 拉出
 *
 * 与 wallet.* / budget.calculate 区分：
 *   - wallet.* 是单条即时操作（转账 / 充值 / 单笔购买）
 *   - budget.calculate 是一次性粗略估算（输入 income/rent/food/transport 出 remain）
 *   - finance.* 维护完整账本 + 预算执行 + 对账 + 报告 + 订阅盘点/取消 + 账单管理
 */
export const FINANCE_DEEP_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "finance.import_transactions",
      description:
        "批量导入交易记录到用户账本，落盘到 data/finance/{actorId}/transactions.json。\n" +
        "支持三种输入（系统按内容自动识别，账单导出走确定性解析、不依赖模型抽取）：\n" +
        "  - 支付宝/微信账单导出：用户直接粘贴「支付宝交易记录明细查询 / 支付宝交易明细清单」\n" +
        "    或「微信支付账单明细」导出的 CSV 原文（含说明头与表头，format 传 csv 即可）。\n" +
        "    系统自动识别并逐列解析：只入账成功状态交易；退款（已退款/已全额退款/退款成功）、\n" +
        "    等待付款、不计收支（零钱充值/提现等资金自有账户间转移）行自动跳过并在结果中说明；\n" +
        "    平台交易单号作为幂等键，重复导入同一份账单不会重复入账。\n" +
        "  - json：JSON 数组字符串，每个元素 { date, amount, type, category?, merchant?, description?, source? }\n" +
        "  - csv：CSV 文本，首行表头 date,amount,type,category,merchant,description（后三个可空）\n" +
        "未分类（category 为空或非法）会自动按 description 关键词分类。\n" +
        "适用场景：用户粘贴支付宝/微信账单导出内容、一段账单 / 银行流水等。注意：用户上传的\n" +
        "账单导出文件原文请完整放入 data，不要自行改写金额、日期或状态，以免解析失真。",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["json", "csv"],
            description:
              "数据格式：json 或 csv。用户粘贴支付宝/微信账单导出内容时传 csv，\n" +
              "系统会自动识别账单格式并走确定性解析。",
          },
          data: {
            type: "string",
            description:
              "数据内容字符串。用户粘贴账单导出原文时请原样完整传入（含「支付宝交易记录明细查询」\n" +
              "或「微信支付账单明细」等说明头与列名行）；json 时为 JSON 数组文本；csv 时为带表头的 CSV 文本。",
          },
          source: {
            type: "string",
            description:
              "数据来源标记（可选）。如 alipay / wechat / bank / manual。会写入每条记录的 source 字段。",
          },
        },
        required: ["format", "data"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.analyze_spending",
      description:
        "消费分析：按类别 / 时间段聚合，返回 top 类别 / 趋势 / 异常。\n" +
        "返回字段：totalExpense / totalIncome / net / count / byCategory / byMonth / topCategories / anomalies / trend。\n" +
        "适用场景：用户问「这个月花了多少」「最近30天消费分析」「哪个类别花得最多」「消费趋势怎么样」。",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "起始时间 ISO 8601（含）。未传则默认近 30 天。如 \"2025-07-01T00:00:00+08:00\"。",
          },
          to: {
            type: "string",
            description: "结束时间 ISO 8601（含）。未传则到当前时间。",
          },
          groupBy: {
            type: "string",
            enum: ["category", "month"],
            description:
              "聚合维度。category=按类别（默认）/ month=按月。两者都返回 byCategory，month 额外返回 byMonth。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.set_budget",
      description:
        "设置预算（按月 / 按类别，如餐饮 2000/月）。\n" +
        "同类别同周期的预算会覆盖旧预算（不叠加）。\n" +
        "适用场景：用户说「设餐饮预算2000」「每月交通不超过500」「今年购物预算2万」。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["餐饮", "交通", "购物", "娱乐", "医疗", "教育", "居住", "工资", "其他"],
            description: "预算类别。如 餐饮 / 交通 / 购物 / 娱乐 / 医疗 / 教育 / 居住。",
          },
          amount: {
            type: "number",
            description: "预算金额（正数）。如 2000 表示 2000 元。",
          },
          period: {
            type: "string",
            enum: ["monthly", "yearly"],
            description: "周期：monthly 月度 / yearly 年度。",
          },
          startDate: {
            type: "string",
            description: "起始日期 ISO 8601（可选）。未传则用当前日期。如 \"2025-07-01\"。",
          },
          endDate: {
            type: "string",
            description: "结束日期 ISO 8601（可选）。不传则永久有效。",
          },
        },
        required: ["category", "amount", "period"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.get_budget_status",
      description:
        "查询预算执行进度：已花 / 剩余 / 警告级别。\n" +
        "警告级别：ok（<80%）/ warning（80%~100%）/ exceeded（≥100%）。\n" +
        "适用场景：用户问「预算还剩多少」「这个月餐饮花了多少」「预算超支了吗」。",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description:
              "查询月份 YYYY-MM（可选）。未传则用当前月。如 \"2025-07\"。年度预算会按当年聚合。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.reconcile",
      description:
        "自动对账：用户给的账单（expectedItems）vs 已记录交易，找出差异。\n" +
        "返回：onlyInRecords（已记录但账单没有）/ onlyInExpected（账单有但未记录）/ amountMismatch（金额不一致）/ matched。\n" +
        "匹配规则：同日期同商户（日期容差 ±2 天）。\n" +
        "适用场景：用户说「帮我对账」「银行流水和我的账本对不上」「这月账单核对一下」。",
      parameters: {
        type: "object",
        properties: {
          expectedItems: {
            type: "array",
            description: "用户提供的账单（期望交易列表）。",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "ISO 8601 日期。" },
                amount: { type: "number", description: "金额（正数）。" },
                type: {
                  type: "string",
                  enum: ["income", "expense"],
                  description: "类型：income 收入 / expense 支出。",
                },
                merchant: { type: "string", description: "商户（可选）。" },
                description: { type: "string", description: "描述（可选）。" },
              },
              required: ["date", "amount", "type"],
              additionalProperties: false,
            },
          },
        },
        required: ["expectedItems"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.categorize",
      description:
        "自动分类一笔交易（基于描述关键词规则）。\n" +
        "支持分类：餐饮 / 交通 / 购物 / 娱乐 / 医疗 / 教育 / 居住 / 工资 / 其他。\n" +
        "适用场景：用户问「这笔麦当劳算什么类」「星巴克算餐饮吗」「工资算哪类」。",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "交易描述。如 \"美团外卖\" / \"星巴克国贸店\" / \"7月工资\"。",
          },
          amount: {
            type: "number",
            description:
              "金额（可选）。工资类需要金额校验（>1000 才会归为工资，避免小额误判）。",
          },
        },
        required: ["description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.export_report",
      description:
        "导出财务报告（月度 / 年度 / 自定义范围），落盘返回 fileUrl。\n" +
        "支持格式：markdown / csv / json。\n" +
        "报告含：总览 / 按类别汇总 / Top 3 类别 / 预算执行 / 异常交易 / 明细（最新 50 条）。\n" +
        "适用场景：用户说「导出月度报告」「生成2025年7月财务报表」「我要一份 CSV 账单」。",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "起始时间 ISO 8601（含）。如 \"2025-07-01T00:00:00+08:00\"。",
          },
          to: {
            type: "string",
            description: "结束时间 ISO 8601（含）。如 \"2025-07-31T23:59:59+08:00\"。",
          },
          format: {
            type: "string",
            enum: ["markdown", "csv", "json"],
            description: "导出格式：markdown / csv / json。默认 markdown。",
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.list_subscriptions",
      description:
        "订阅服务盘点：列出自动续费订阅（已确认 + 已退订/忽略）以及账本中检测到的疑似订阅候选。\n" +
        "每条含：merchant / amount（每期金额）/ periodDays（周期天数）/ status / nextRenewalDate（下次续费日）/\n" +
        "lastUsedAt（最近使用）/ monthlyCost（折算月成本）/ evidence（检测证据）。\n" +
        "调用时会先自动扫描账本刷新疑似候选，无需先跑检测。\n" +
        "适用场景：「我有哪些订阅」「盘点一下自动续费」「订阅一个月多少钱」「有什么疑似订阅待确认」。",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["all", "candidate", "confirmed", "cancelled", "ignored"],
            description:
              "状态过滤（可选，默认 all）。candidate=疑似待确认 / confirmed=已确认 / cancelled=已退订 / ignored=已忽略。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.confirm_subscription",
      description:
        "确认/登记一个订阅服务：把疑似订阅候选（finance.list_subscriptions 返回的 candidate）确认为正式订阅，\n" +
        "或直接手动登记新订阅。确认后参与月度订阅盘点与续费前提醒（下次续费日前 3 天主动提醒）。\n" +
        "适用场景：「这个订阅是真的，每月25」「登记一下我的B站大会员」「Netflix确认还在订」。\n" +
        "注意：不传 subscriptionId 时会按商户名自动关联同名候选或新建。",
      parameters: {
        type: "object",
        properties: {
          merchant: {
            type: "string",
            description: "商户/服务名。如 \"Netflix\" / \"B站大会员\" / \"iCloud\"。",
          },
          amount: {
            type: "number",
            description: "每期金额（正数）。如 25 表示每期 25 元。",
          },
          periodDays: {
            type: "number",
            description: "周期天数。常见：7（周付）/ 30（月付）/ 90（季付）/ 365（年付）。",
          },
          subscriptionId: {
            type: "string",
            description: "候选订阅 ID（可选）。确认 list_subscriptions 返回的某个 candidate 时传入。",
          },
          nextRenewalDate: {
            type: "string",
            description:
              "下次续费日 YYYY-MM-DD（可选）。未传则不设，后续可用 update_subscription 补。",
          },
          category: {
            type: "string",
            enum: ["餐饮", "交通", "购物", "娱乐", "医疗", "教育", "居住", "工资", "其他"],
            description: "分类（可选）。订阅多归娱乐/购物。",
          },
        },
        required: ["merchant", "amount", "periodDays"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.update_subscription",
      description:
        "更新订阅状态/使用记录。使用率评估的数据入口：用户说「还在用/没怎么用」时记 used，\n" +
        "「已退订」记 cancel，「这个不算订阅」记 ignore。也支持改下次续费日 / 恢复 / 备注。\n" +
        "适用场景：「B站我还在用」→ used；「Netflix我已经退了」→ cancel；\n" +
        "「那个不是订阅，是一次性买断」→ ignore；「爱奇艺下月5号续费」→ set_renewal。",
      parameters: {
        type: "object",
        properties: {
          subscriptionId: {
            type: "string",
            description: "订阅记录 ID（finance.list_subscriptions 返回的 id）。",
          },
          action: {
            type: "string",
            enum: ["used", "cancel", "ignore", "reactivate", "set_renewal", "note"],
            description:
              "操作：used=标记最近使用 / cancel=已退订 / ignore=忽略（非订阅）/ reactivate=恢复确认 / set_renewal=改下次续费日 / note=写备注。",
          },
          lastUsedAt: {
            type: "string",
            description: "最近使用日期 YYYY-MM-DD（可选，action=used 时默认今天）。",
          },
          nextRenewalDate: {
            type: "string",
            description: "下次续费日 YYYY-MM-DD（action=set_renewal 时必传）。",
          },
          note: {
            type: "string",
            description: "备注（action=note 时必传）。如 \"shared with family\"。",
          },
        },
        required: ["subscriptionId", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.cancel_subscription",
      description:
        "自动取消订阅（省钱型）：识别并退订用户「想退但嫌麻烦」的自动续费订阅，并统计省下的钱。\n" +
        "不传目标时返回建议取消名单（60 天未用 / 从未使用，按月成本从高到低），由用户确认后退订；\n" +
        "指定 merchant 或 subscriptionId 时执行退订：记录省钱金额（每期/月/年），\n" +
        "有自动执行通道时直接代办，否则返回该商户的最短取消路径（App/官网 + 微信/支付宝扣款入口）。\n" +
        "距下次续费 ≤3 天时会给出「赶在扣款前取消」的紧急提示。\n" +
        "适用场景：「帮我退掉没用的订阅」「Netflix 别自动续费了」「把一直没用想退嫌麻烦的都退了」「退订能省多少」。",
      parameters: {
        type: "object",
        properties: {
          subscriptionId: {
            type: "string",
            description: "订阅记录 ID（finance.list_subscriptions 返回的 id，可选）。",
          },
          merchant: {
            type: "string",
            description:
              "商户/服务名（与 subscriptionId 二选一）。支持模糊匹配，如 \"netflix\" / \"B站\"。",
          },
          reason: {
            type: "string",
            description: "退订原因（可选，记录用）。如 \"太久没用了\" / \"太贵\"。",
          },
          execute: {
            type: "boolean",
            description:
              "是否尝试自动执行（默认 true）。无自动执行通道或执行失败时，回退为返回取消路径指引。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.savings_summary",
      description:
        "订阅省钱统计：列出已退订订阅及累计省下的金额（每期 / 每月 / 每年），退订动作的成果账。\n" +
        "适用场景：「退订省了多少钱」「帮我看看一共省下多少」「订阅退订记录」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.add_bill",
      description:
        "登记定期账单（账单管理·追踪）：房租 / 水电 / 燃气 / 话费 / 宽带 / 物业 / 信用卡还款 / 保险等。\n" +
        "登记后自动追踪下次到期日，到期前 3 天主动提醒，缴费后一键入账联动预算。\n" +
        "周付/月付按 dueDay（周几/几号）自动推算到期日；季付/年付/一次性需给下次到期日 dueDate。\n" +
        "适用场景：「记一下房租每月1号3500」「水电费每次200左右月底交」「帮我盯住信用卡还款日」。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "账单名。如 \"房租\" / \"水电费\" / \"信用卡还款\" / \"宽带\"。",
          },
          amount: {
            type: "number",
            description: "每期金额（正数）。如 3500。",
          },
          cadence: {
            type: "string",
            enum: ["weekly", "monthly", "quarterly", "yearly", "one_off"],
            description: "缴费周期：weekly 周付 / monthly 月付 / quarterly 季付 / yearly 年付 / one_off 一次性。",
          },
          dueDay: {
            type: "number",
            description:
              "扣费日：monthly/quarterly/yearly 填 1~31（几号）；weekly 填 1~7（1=周一 … 7=周日）。",
          },
          dueDate: {
            type: "string",
            description:
              "下次到期日 YYYY-MM-DD：quarterly / yearly / one_off 必填（缴费后自动顺延一个周期）。",
          },
          category: {
            type: "string",
            enum: ["餐饮", "交通", "购物", "娱乐", "医疗", "教育", "居住", "工资", "其他"],
            description: "预算分类（可选，默认 居住）。缴费自动入账到该分类，联动预算执行。",
          },
          autopay: {
            type: "boolean",
            description: "是否自动扣款（可选，默认 false）。影响提醒话术：确认余额充足 vs 记得手动缴。",
          },
          merchant: {
            type: "string",
            description: "收款方/商户（可选）。如 \"国家电网\" / \"招商银行\"。",
          },
          note: {
            type: "string",
            description: "备注（可选）。",
          },
        },
        required: ["name", "amount", "cadence"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.list_bills",
      description:
        "账单追踪：列出登记的定期账单 + 下次到期日 + 状态（即将到期 due_soon / 已逾期 overdue / 正常 ok / 一次性已缴 paid），\n" +
        "并汇总月均固定支出（周期账单折算月成本合计，做预算时的固定盘子）。\n" +
        "按紧迫度排序：逾期 > 即将到期 > 正常。\n" +
        "适用场景：「最近有什么账单要交」「房租什么时候交」「每月固定支出多少」「有逾期账单吗」。",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["all", "due_soon", "overdue", "ok", "paid"],
            description: "状态过滤（可选，默认 all）。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.update_bill",
      description:
        "更新账单信息：改金额 / 扣费日 / 到期日 / 自动扣款标记 / 分类 / 备注（账单涨价、搬家换租常用）。\n" +
        "适用场景：「房租涨到3800」「水电费改成每月25号扣」「这张账单是自动扣款的」。",
      parameters: {
        type: "object",
        properties: {
          billId: {
            type: "string",
            description: "账单 ID（finance.list_bills 返回的 id）。",
          },
          name: { type: "string", description: "新账单名（可选）。" },
          amount: { type: "number", description: "新每期金额（可选）。" },
          dueDay: { type: "number", description: "新扣费日（可选，含义同 add_bill）。" },
          dueDate: { type: "string", description: "新下次到期日 YYYY-MM-DD（可选）。" },
          category: {
            type: "string",
            enum: ["餐饮", "交通", "购物", "娱乐", "医疗", "教育", "居住", "工资", "其他"],
            description: "新预算分类（可选）。",
          },
          autopay: { type: "boolean", description: "是否自动扣款（可选）。" },
          note: { type: "string", description: "备注（可选，传空串清除）。" },
        },
        required: ["billId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.pay_bill",
      description:
        "账单缴费登记（账单管理·预算联动）：标记某笔账单已缴，自动把这笔支出写入账本（source=bill_payment），\n" +
        "季付/年付账单自动顺延一个周期，并返回该分类预算的最新执行进度（已花/剩余/警告级别）。\n" +
        "适用场景：「房租交了」「水电费我昨天付了」「信用卡还完了」。",
      parameters: {
        type: "object",
        properties: {
          billId: {
            type: "string",
            description: "账单 ID（finance.list_bills 返回的 id）。",
          },
          date: {
            type: "string",
            description: "缴费日期 YYYY-MM-DD（可选，默认今天）。",
          },
          amount: {
            type: "number",
            description: "实缴金额（可选，默认账单金额。水电费这类金额浮动的用它）。",
          },
        },
        required: ["billId"],
        additionalProperties: false,
      },
    },
  },
  // finance.bills.sync_now — 立即后台拉取支付宝账单（handler 在 create-app-services 注册，
  // 闭包持有 FinanceBillAutoFetchService）
  {
    type: "function",
    function: {
      name: "finance.bills.sync_now",
      description:
        "立即用用户的支付宝登录态后台拉取最近几天的交易明细并自动入账（确定性幂等去重，\n" +
        "重复调用不会重复记账）。适用场景：用户问「同步一下我的账单」「把支付宝流水拉下来」\n" +
        "「这个月花了多少（先更新数据）」。前置条件：用户已在浏览器会话导入支付宝 Cookie\n" +
        "（siteId=alipay）并授权 agentAllowed；未导入时工具会如实失败并给出指引——此时可让\n" +
        "用户直接粘贴账单导出内容走 finance.import_transactions。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  // finance.bills.auto_fetch — 账单后台自动拉取的账号级开关（handler 同上，
  // 闭包持有 FinanceBillAutoFetchService；调度只轮已开启的账号）
  {
    type: "function",
    function: {
      name: "finance.bills.auto_fetch",
      description:
        "为当前用户开启/关闭「后台每天自动拉支付宝账单并入账」，或查看当前状态。\n" +
        "适用场景：用户说「以后自动帮我把账单同步进来」「别再自动拉了」「账单自动同步是开着的吗」。\n" +
        "这是账号级开关：只影响用户自己，别人的节奏互不影响；关掉后调度立刻不再拉他。\n" +
        "前置条件同 sync_now（需已导入支付宝 Cookie 并授权），未导入时开启不会报错，\n" +
        "到点会如实把「Cookie 不可用」记进状态，用户补登录后自动接上。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["on", "off", "status"],
            description: "on=开启 / off=关闭 / status=查看当前开关与最近一次同步结果。",
          },
          intervalMin: {
            type: "number",
            description: "可选：准实时轮询间隔（分钟，10-1440）。给了它=按间隔模式；不给=每日定点模式。",
          },
          hour: {
            type: "number",
            description: "可选：每日执行时刻（0-23），仅未给 intervalMin 时生效。默认 21 点。",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];
