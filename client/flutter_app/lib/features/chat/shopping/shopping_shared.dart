import "package:flutter/material.dart";

import "../../../core/ui/card_metrics.dart";

/// 购物卡公共视觉与解析工具。
///
/// 视觉口径对齐 `docs/design/mobile-shopping/index.html`（v1 已拍板）：
/// 圆角 12、outline 0.22 细边、卡片底色沿用 surfaceContainerHigh（与
/// product_pick / price_compare 同族，保证聊天流里商品卡看起来是一家人）；
/// 语义色只给三态——有货绿、待确认琥珀、无法购买灰。
///
/// 本期只做手机端：尺寸按窄屏取，卡片最大宽 390（与既有卡一致），
/// 横滑轮播按视口比例取卡宽，不写死 128，窄屏自动露出 2.5 张。
abstract final class ShopTokens {
  /// 卡圆角。
  static const double radius = 12;

  /// 有货 / 主推徽章 / 已签收。
  static const Color ok = Color(0xFF2E9E63);
  static const Color okSoft = Color(0xFFD8F0E2);
  static const Color okInk = Color(0xFF0E5B36);

  /// 待确认 / 缺货提示。
  static const Color warn = Color(0xFFB8862F);
  static const Color warnSoft = Color(0xFFFDFBF3);
  static const Color warnLine = Color(0xFFF0EADB);

  /// 卡片最大宽度（2026-11-13 P0-7 改：硬编码 390 → 响应式）。
  ///
  /// 手机端顶满可用宽度（430/480pt 机型上不再空 40–90px），中屏留边距，
  /// 桌面与消息流同宽。口径集中在 [CardMetrics]，全仓只有这一处定义。
  static double maxWidth(BuildContext context) => CardMetrics.maxWidth(context);
}

/// 金额展示：整数不带小数、非整数保留一位。
String shopMoney(num? value) {
  if (value == null) return "—";
  if (value == value.roundToDouble()) return value.toInt().toString();
  return value.toStringAsFixed(1);
}

/// 安全取字段。
String shopStr(Object? value) => value == null ? "" : value.toString();

num? shopNum(Object? value) {
  if (value is num) return value;
  if (value is String) return num.tryParse(value.replaceAll(",", ""));
  return null;
}

bool shopBool(Object? value) => value == true || value == "true";

/// 毫秒时间戳 → `HH:mm`（卡内展示抓取时刻）。
///
/// 报价的可信度一半来自「什么时候抓的」——服务端已在 shopItems[] 下发
/// [fetchedAt]，这里只做展示格式化；拿不到就返回空串（不显示占位符）。
String shopClock(Object? ms) {
  final num? n = shopNum(ms);
  if (n == null || n <= 0) return "";
  final DateTime d = DateTime.fromMillisecondsSinceEpoch(n.round());
  final String hh = d.hour.toString().padLeft(2, "0");
  final String mm = d.minute.toString().padLeft(2, "0");
  return "$hh:$mm";
}

/// 平台品牌色（2026-11-13）。
///
/// 用途：**来源标注**。用户投诉「比价卡片没有标注对应的来源，是哪个平台的」
/// ——报价必须一眼可溯源，平台名 + 品牌色小圆点是最低成本且不喧宾夺主的做法。
///
/// 说明：京东 / 拼多多同为红系，靠圆点区分度低，因此圆点之外还**始终渲染
/// 平台中文名**——颜色只是辅助识别，名字才是准确信息。
Color shopPlatformBrand(String platform) {
  switch (platform.toLowerCase()) {
    case "jd":
    case "jingdong":
      return const Color(0xFFE1251B); // 京东红
    case "taobao":
    case "tb":
      return const Color(0xFFFF5000); // 淘宝橙
    case "tmall":
      return const Color(0xFFC4122F); // 天猫红
    case "pdd":
    case "pinduoduo":
      return const Color(0xFFE22E1F); // 拼多多红
    case "suning":
      return const Color(0xFFF57421); // 苏宁橙
    case "smzdm":
      return const Color(0xFFFF6A00); // 什么值得买橙
    case "douyin":
    case "bytedance":
      return const Color(0xFF17181C); // 抖音黑
    case "amazon":
      return const Color(0xFFFF9900); // 亚马逊橙
    case "xiaohongshu":
      return const Color(0xFFFF2442); // 小红书红
    default:
      return const Color(0xFF8A8F99); // 未知平台：中性灰
  }
}

/// 从任意结构里取 map 列表（服务端载荷容错）。
List<Map<String, dynamic>> shopMaps(Object? value) {
  if (value is! List) return const <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
  for (final Object? raw in value) {
    if (raw is Map) {
      out.add(<String, dynamic>{
        for (final MapEntry<Object?, Object?> e in raw.entries)
          e.key.toString(): e.value,
      });
    }
  }
  return out;
}

/// 购物卡外壳：白/浅底 + 12 圆角 + 细边，内容裁切以免轮播溢出圆角。
class ShopCardShell extends StatelessWidget {
  const ShopCardShell({
    super.key,
    required this.cs,
    required this.child,
    this.maxWidth,
  });

  final ColorScheme cs;
  final Widget child;
  /// 卡片最大宽度；缺省走响应式令牌（[CardMetrics]）。
  final double? maxWidth;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(maxWidth: maxWidth ?? CardMetrics.maxWidth(context)),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(ShopTokens.radius),
        border: Border.all(color: cs.outline.withValues(alpha: 0.22)),
      ),
      clipBehavior: Clip.antiAlias,
      child: child,
    );
  }
}

/// 购物卡统一卡头：图标 + 标题 + 右侧附属信息（页码点 / 平台 / 时间）。
class ShopCardHeader extends StatelessWidget {
  const ShopCardHeader({
    super.key,
    required this.cs,
    required this.title,
    this.icon,
    this.iconColor,
    this.trailing,
    this.subtitle,
  });

  final ColorScheme cs;
  final String title;
  final IconData? icon;
  final Color? iconColor;
  final Widget? trailing;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(13, 11, 13, 9),
      child: Row(
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 15, color: iconColor ?? cs.onSurfaceVariant),
            const SizedBox(width: 7),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
                if (subtitle != null && subtitle!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (trailing != null) ...<Widget>[
            const SizedBox(width: 8),
            trailing!,
          ],
        ],
      ),
    );
  }
}

/// 细分割线（卡内分区）。
class ShopDivider extends StatelessWidget {
  const ShopDivider({super.key, required this.cs});

  final ColorScheme cs;

  @override
  Widget build(BuildContext context) => Container(
        height: 1,
        color: cs.outline.withValues(alpha: 0.14),
      );
}

/// 徽章：有货绿 / 琥珀 / 中性。
enum ShopBadgeTone { ok, warn, neutral }

class ShopBadge extends StatelessWidget {
  const ShopBadge({
    super.key,
    required this.cs,
    required this.label,
    this.tone = ShopBadgeTone.ok,
  });

  final ColorScheme cs;
  final String label;
  final ShopBadgeTone tone;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg) = switch (tone) {
      ShopBadgeTone.ok => (ShopTokens.okSoft, ShopTokens.okInk),
      ShopBadgeTone.warn => (const Color(0xFFFAEBCD), const Color(0xFF7A5312)),
      ShopBadgeTone.neutral => (
          cs.surfaceContainerHighest,
          cs.onSurfaceVariant,
        ),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 8.5,
          fontWeight: FontWeight.w700,
          color: fg,
          height: 1.25,
        ),
      ),
    );
  }
}

/// 卡内按钮：primary 实心（反色）/ ghost 描边。
class ShopButton extends StatelessWidget {
  const ShopButton({
    super.key,
    required this.cs,
    required this.label,
    required this.onTap,
    this.primary = true,
    this.expand = true,
    this.height = 42,
  });

  final ColorScheme cs;
  final String label;
  final VoidCallback? onTap;
  final bool primary;
  final bool expand;
  final double height;

  @override
  Widget build(BuildContext context) {
    final bool enabled = onTap != null;
    final Widget body = Container(
      height: height,
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: primary
            ? (enabled ? cs.onSurface : cs.onSurface.withValues(alpha: 0.35))
            : Colors.transparent,
        borderRadius: BorderRadius.circular(11),
        border: primary
            ? null
            : Border.all(color: cs.outline.withValues(alpha: 0.35)),
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: primary
              ? cs.surface
              : (enabled ? cs.onSurface : cs.onSurfaceVariant),
        ),
      ),
    );
    return ShopTap(
      onTap: onTap,
      child: SizedBox(
        width: expand ? double.infinity : null,
        child: body,
      ),
    );
  }
}

/// 可点击包装（卡内按钮统一走这里，保持水波纹一致）。
class ShopTap extends StatelessWidget {
  const ShopTap({
    super.key,
    required this.onTap,
    required this.child,
    this.radius = 11,
  });

  final VoidCallback? onTap;
  final Widget child;
  final double radius;

  @override
  Widget build(BuildContext context) {
    if (onTap == null) return child;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(radius),
        child: child,
      ),
    );
  }
}

/// 卡内小字按钮（2026-11-13 P1）：「跳过这家 / 重新出码」这类行内次级动作。
///
/// 与 [ShopButton] 的分工：ShopButton 是**主流程**按钮（实心/描边、占位大、
/// 一眼可见）；本组件是行内次级动作——小、轻、不抢主按钮的视线，但仍然要
/// 点得中（命中区 ≥ 28pt）。
enum ShopMiniTone { neutral, danger }

class ShopMiniButton extends StatelessWidget {
  const ShopMiniButton({
    super.key,
    required this.cs,
    required this.label,
    required this.onTap,
    this.tone = ShopMiniTone.neutral,
  });

  final ColorScheme cs;
  final String label;
  final VoidCallback? onTap;
  final ShopMiniTone tone;

  @override
  Widget build(BuildContext context) {
    final bool enabled = onTap != null;
    final Color fg = switch (tone) {
      ShopMiniTone.neutral => cs.onSurfaceVariant,
      ShopMiniTone.danger => ShopTokens.warn,
    };
    return ShopTap(
      onTap: onTap,
      radius: 999,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: enabled
                ? cs.outline.withValues(alpha: 0.35)
                : cs.outline.withValues(alpha: 0.15),
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w600,
            color: enabled ? fg : cs.onSurfaceVariant.withValues(alpha: 0.5),
            height: 1.2,
          ),
        ),
      ),
    );
  }
}

/// 平台来源浮标（2026-11-13）：贴在商品图左上角。
///
/// 为什么浮在图上而不是压在正文里：轮播卡一屏露出 2.5 张、逐卡滑动，用户
/// 靠**位置**认平台。旧实现把平台名塞进正文底行，结果被店铺名挤掉
/// （`shop.isEmpty ? platform : shop`）——这就是用户说的「没标注是哪个
/// 平台的」。浮在图上它永远不会被挤掉，也永远在第一视觉层。
class ShopPlatformTag extends StatelessWidget {
  const ShopPlatformTag({
    super.key,
    required this.cs,
    required this.platform,
    required this.label,
  });

  final ColorScheme cs;
  final String platform;
  final String label;

  @override
  Widget build(BuildContext context) {
    if (label.isEmpty) return const SizedBox.shrink();
    final Color brand = shopPlatformBrand(platform);
    return Container(
      padding: const EdgeInsets.fromLTRB(5, 3, 7, 3),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.white.withValues(alpha: 0.24)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: brand, shape: BoxShape.circle),
          ),
          const SizedBox(width: 4),
          Text(
            label,
            style: const TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w700,
              color: Colors.white,
              height: 1.2,
            ),
          ),
        ],
      ),
    );
  }
}

/// 平台来源行（2026-11-13）：正文里的「平台 · 店铺」一行。
///
/// 平台名始终在（品牌色 + 半粗），店铺名跟随其后——平台是**来源**，
/// 店铺是补充，顺序不能反。
class ShopSourceLine extends StatelessWidget {
  const ShopSourceLine({
    super.key,
    required this.cs,
    required this.platform,
    required this.label,
    this.shop,
    this.trailing,
  });

  final ColorScheme cs;
  final String platform;
  final String label;
  final String? shop;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final String name = label.isNotEmpty ? label : platform;
    final Color brand = shopPlatformBrand(platform);
    return Row(
      children: <Widget>[
        Container(
          width: 5,
          height: 5,
          decoration: BoxDecoration(color: brand, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w700,
              color: cs.onSurface,
            ),
          ),
        ),
        if (shop != null && shop!.isNotEmpty) ...<Widget>[
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              "· ${shop!}",
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 9, color: cs.onSurfaceVariant),
            ),
          ),
        ],
        if (trailing != null && trailing!.isNotEmpty) ...<Widget>[
          const SizedBox(width: 6),
          Text(
            trailing!,
            style: TextStyle(fontSize: 9, color: cs.onSurfaceVariant),
          ),
        ],
      ],
    );
  }
}
