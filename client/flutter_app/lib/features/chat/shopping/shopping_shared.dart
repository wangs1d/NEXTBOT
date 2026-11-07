import "package:flutter/material.dart";

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

  /// 卡片最大宽度（与 product_pick 卡口径一致）。
  static const double maxWidth = 390;
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
    this.maxWidth = ShopTokens.maxWidth,
  });

  final ColorScheme cs;
  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(maxWidth: maxWidth),
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
