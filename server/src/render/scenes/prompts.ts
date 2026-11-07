/**
 * 场景契约文本（只写 schema / 字段 / 边界，不写版式修辞）。
 *
 * 2026-11-05 二次收敛：盘点清单契约已整体删除——它要求模型输出 JSON 槽位，
 * 而「让模型输出机器可读结构」正是配合率不稳定的根源。现在盘点结构由
 * render/scenes/digest-roundup.scene.ts 从工具回执直供，prompt 里不再有
 * 任何与盘点相关的格式要求。
 */

import { DISPLAY_EFFECT_TYPES } from "@nextbot/agent-protocol";

/**
 * 天气卡轮边界（2026-10-08 定稿）：天气数值已由 tool-card-registry 从工具回执
 * 确定性建卡，同屏正文再复述就是双份。
 */
export const WEATHER_CARD_BOUNDARY =
  `天气轮：天气/气温/湿度/风速/降水概率这些数值已由系统专用天气卡片展示给用户，正文里不要再出现。` +
  `严禁用 markdown 标题、表格或引用块罗列天气数据，严禁把工具回执的数值抄写成清单。` +
  `严禁向用户展示经纬度坐标数字（如 35.68, 139.77）——坐标仅供工具入参，位置只说城市/区域名，解析不出就不提位置。` +
  `直接用两三句口语给结论和建议（穿什么/要不要带伞），像朋友聊天一样自然收束。` +
  `建议只能基于回执里的事实（气温/降水/天气现象）与用户本轮明说的上下文；` +
  `用户没提过的具体行为场景（骑车/开车/跑步/洗晒等）不要替用户虚构，拿不准就不写。`;

/**
 * 明日预览边界（2026-11-05）：行程/天气/待办已由系统按固定版式渲染成
 * 预览正文，模型不再自己排一遍。
 */
export const TOMORROW_PREVIEW_BOUNDARY =
  `明日预览：行程、天气、待办已由系统按固定版式渲染，正文不要重排这些内容，` +
  `只补一句口语化提醒（如要不要带伞、几点出门）即可。`;

/**
 * 提醒确认卡轮边界（2026-11-07）：时间、事项、状态已由系统按固定版式展示，
 * 正文再抄一遍就是双份。只写内容边界，不写任何版式描述。
 */
export const REMINDER_CONFIRM_BOUNDARY =
  `提醒轮：具体时刻、日期和提醒事项已由系统提醒确认卡展示，正文里不要再出现，` +
  `也不要把工具回执的数值改写成清单或表格。` +
  `只用一两句口语把事情确认下来，像朋友聊天一样自然收束；` +
  `没定成功时如实说明原因并给下一步，不要预告「正在设置」。`;

/**
 * 盘点清单边界（2026-11-07）：清单条目与版式已由系统从工具回执确定性渲染，
 * 模型再写一遍标题/列表/表格就是双份。生成前注入，避免出口整体换稿。
 */
export const DIGEST_ROUNDUP_BOUNDARY =
  `盘点轮：清单条目与版式已由系统按工具回执生成，正文不要罗列条目、不要写标题层级或表格，` +
  `只留一两句口语语气即可。`;

/** 结构卡可用 cardType（唯一来源：display-effects 枚举 + 权限引导卡） */
export const RESULT_CARD_TYPES: readonly string[] = [
  ...DISPLAY_EFFECT_TYPES.filter((t) => t !== ""),
  "permission_request",
];

/** 结构卡载荷 schema（字段级，无版式描述） */
export const RESULT_CARD_CONTRACT =
  `[AGENT_RESULT_CARD_START]{"cardType":"${RESULT_CARD_TYPES.join("|")}",` +
  `"title":"≤20字","items":[{"type":"num|warn","text":"条目文本","url":"可选"}],"footer":"可选"}` +
  `[AGENT_RESULT_CARD_END]`;
