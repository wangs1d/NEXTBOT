import "package:flutter/material.dart";

import "media_disk_cache.dart";

/// 一个「游玩地点」种草项。
///
/// 版式对齐设计稿：一段简短介绍 + 该地点的三张实拍图 + 右上角圆形勾选。
/// 图片按顺序取前三张，缺图时回落暗色渐变（不塞占位假图）。
class TravelSeedPlace {
  const TravelSeedPlace({
    required this.id,
    required this.intro,
    required this.images,
    this.name = "",
  });

  final String id;

  /// 地点名（可选；版式里默认不单独占一行，介绍开头自带地名即可）。
  final String name;

  /// 简短介绍：2~6 行，允许换行。
  final String intro;

  /// 该地点的实拍图，最多渲染三张。
  final List<String> images;
}

/// 种草卡配色（默认深色，与行程规划页一致；浅色主题可整体替换）。
class TravelSeedCardTheme {
  const TravelSeedCardTheme({
    required this.background,
    required this.text,
    required this.accent,
    required this.onAccent,
    required this.border,
    required this.photoFallback,
    required this.photoFallbackIcon,
  });

  final Color background;
  final Color text;
  final Color accent;
  final Color onAccent;
  final Color border;
  final Color photoFallback;
  final Color photoFallbackIcon;

  static const TravelSeedCardTheme dark = TravelSeedCardTheme(
    background: Color(0xFF232327),
    text: Color(0xFFF2F2F3),
    accent: Color(0xFFF5A552),
    onAccent: Color(0xFF1A1A1C),
    border: Color(0x14FFFFFF),
    photoFallback: Color(0xFF2E2E34),
    photoFallbackIcon: Color(0xFF56565E),
  );
}

/// 「选择游玩地点」种草卡（手机端聊天内联 / 桌面端规划页共用）。
///
/// 交互：点整卡或右上角圆框都能切换选中；选中态 = 琥珀描边 + 圆框打勾。
class TravelSeedPlaceCard extends StatelessWidget {
  const TravelSeedPlaceCard({
    super.key,
    required this.place,
    required this.selected,
    required this.onChanged,
    this.theme = TravelSeedCardTheme.dark,
    this.photoBuilder,
  });

  final TravelSeedPlace place;
  final bool selected;
  final ValueChanged<bool> onChanged;
  final TravelSeedCardTheme theme;

  /// 自定义图片渲染：设计稿/测试注入本地图；线上默认走带鉴权头的磁盘缓存。
  final Widget Function(BuildContext context, String url)? photoBuilder;

  static const double _cardRadius = 22;
  static const double _photoRadius = 18;
  static const double _photoGap = 8;

  void _toggle() => onChanged(!selected);

  @override
  Widget build(BuildContext context) {
    final List<String> photos =
        place.images.where((String u) => u.trim().isNotEmpty).take(3).toList();
    return Semantics(
      button: true,
      selected: selected,
      label: "选择${place.name.isEmpty ? "这个地点" : place.name}",
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _toggle,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOutCubic,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: theme.background,
            borderRadius: BorderRadius.circular(_cardRadius),
            border: Border.all(
              color: selected ? theme.accent : theme.border,
              width: selected ? 1.4 : 1,
            ),
          ),
          child: Stack(
            children: <Widget>[
              Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  // 右上角让位给圆形勾选框，避免文字压在框下。
                  Padding(
                    padding: const EdgeInsets.only(right: 34),
                    child: Text(
                      place.intro,
                      style: TextStyle(
                        fontSize: 14.5,
                        height: 1.75,
                        letterSpacing: 0.1,
                        color: theme.text,
                      ),
                    ),
                  ),
                  if (photos.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 14),
                    Row(
                      children: <Widget>[
                        for (int i = 0; i < photos.length; i++) ...<Widget>[
                          if (i > 0) const SizedBox(width: _photoGap),
                          Expanded(
                            child: AspectRatio(
                              aspectRatio: 1,
                              child: ClipRRect(
                                borderRadius:
                                    BorderRadius.circular(_photoRadius),
                                child: _SeedPhoto(
                                  url: photos[i],
                                  theme: theme,
                                  builder: photoBuilder,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ],
              ),
              Positioned(
                top: 0,
                right: 0,
                child: Semantics(
                  button: true,
                  selected: selected,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: _toggle,
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 160),
                      width: 26,
                      height: 26,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: selected
                            ? theme.accent
                            : Colors.black.withValues(alpha: 0.22),
                        border: Border.all(
                          color: selected
                              ? theme.accent
                              : Colors.white.withValues(alpha: 0.28),
                          width: 1.5,
                        ),
                      ),
                      child: selected
                          ? Icon(
                              Icons.check_rounded,
                              size: 18,
                              color: theme.onAccent,
                            )
                          : null,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 单张地点实拍图：圆角裁切 + 磁盘缓存（带鉴权头）+ 失败回落到暗色渐变。
class _SeedPhoto extends StatelessWidget {
  const _SeedPhoto({
    required this.url,
    required this.theme,
    this.builder,
  });

  final String url;
  final TravelSeedCardTheme theme;
  final Widget Function(BuildContext context, String url)? builder;

  @override
  Widget build(BuildContext context) {
    final Widget? custom = builder?.call(context, url);
    if (custom != null) return custom;
    return CachedMediaImage(
      url: url,
      fit: BoxFit.cover,
      loadingBuilder: (BuildContext context) {
        return DecoratedBox(
          decoration: BoxDecoration(color: theme.photoFallback),
        );
      },
      errorBuilder: (BuildContext context, Object error, StackTrace? stack) {
        return DecoratedBox(
          decoration: BoxDecoration(color: theme.photoFallback),
          child: Center(
            child: Icon(
              Icons.landscape_outlined,
              size: 22,
              color: theme.photoFallbackIcon,
            ),
          ),
        );
      },
    );
  }
}
