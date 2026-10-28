import "package:flutter/material.dart";

/// 输入框里的技能胶囊：用户先挑一个技能挂到输入框上，补齐参数后再发送。
class ComposerSkill {
  const ComposerSkill({
    required this.id,
    required this.label,
    required this.icon,
    required this.hint,
    required this.prompt,
    this.detailRequired = true,
  });

  final String id;

  /// 胶囊与引导 chip 上的短名。
  final String label;

  final IconData icon;

  /// 胶囊挂上后输入框的占位提示：告诉用户该补什么参数。
  final String hint;

  /// 发送时拼在用户输入前面的技能指令；用户没补充内容时单独发送这句。
  final String prompt;

  /// 必须先补参数才允许发送（比价、查单号这类空跑没有意义）。
  final bool detailRequired;

  String compose(String detail) {
    final String d = detail.trim();
    if (d.isEmpty) return prompt;
    return prompt.endsWith("：") ? "$prompt$d" : "$prompt：$d";
  }
}

/// 引导 chip 与胶囊共用的技能表（顺序即展示顺序）。
const List<ComposerSkill> kComposerSkills = <ComposerSkill>[
  ComposerSkill(
    id: "hotel_compare",
    label: "酒店比价",
    icon: Icons.hotel_rounded,
    hint: "目的地 + 入住/退房日期，例如「三亚 11-02 到 11-05」",
    prompt: "比较目的地酒店价格：",
  ),
  ComposerSkill(
    id: "food_nearby",
    label: "附近美食",
    icon: Icons.restaurant_rounded,
    hint: "想吃什么可以补一句，也可以直接发送",
    prompt: "推荐附近的美食",
    detailRequired: false,
  ),
  ComposerSkill(
    id: "news_today",
    label: "今日要闻",
    icon: Icons.newspaper_rounded,
    hint: "直接发送即可",
    prompt: "查一下今天的重要新闻",
    detailRequired: false,
  ),
  ComposerSkill(
    id: "inbox_ads",
    label: "整理广告邮件",
    icon: Icons.mark_email_read_rounded,
    hint: "直接发送即可",
    prompt: "整理邮箱中的广告邮件",
    detailRequired: false,
  ),
  ComposerSkill(
    id: "price_compare",
    label: "商品比价",
    icon: Icons.price_check_rounded,
    hint: "贴商品名或链接，按同规格跨平台比价",
    prompt: "帮我比价这个商品：",
  ),
  ComposerSkill(
    id: "express_track",
    label: "查快递",
    icon: Icons.local_shipping_rounded,
    hint: "运单号，或说明是哪家快递寄的",
    prompt: "看看这个快递到哪了：",
  ),
];
