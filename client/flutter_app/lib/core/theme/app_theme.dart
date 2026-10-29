import "package:flutter/material.dart";

import "app_typography.dart";

/// 主题配色变体。
///
/// - [dark]：深色（默认，沿用项目原有配色）
/// - [warm]：浅色 / 米白（截图中的奶油雾面风格）
enum AppThemeVariant { dark, warm }

/// 全局主题切换控制器（单例 + [ValueNotifier]）。
///
/// 侧边栏底部按钮调用 [toggle] 在两种主题之间切换；
/// `MaterialApp.theme` 通过 `ValueListenableBuilder` 重建实现热切换。
class AppThemeController extends ValueNotifier<AppThemeVariant> {
  AppThemeController() : super(AppThemeVariant.dark);

  static final AppThemeController instance = AppThemeController();

  void toggle() {
    value = value == AppThemeVariant.dark
        ? AppThemeVariant.warm
        : AppThemeVariant.dark;
  }

  void setVariant(AppThemeVariant v) {
    if (value == v) return;
    value = v;
  }
}

/// 颜色调色板。
///
/// 深色主题保持原 [mainPanel] / [sidebar] / [sidebarSeparator] 等命名不变；
/// 暖色主题在前面加 [warm] 前缀，避开命名冲突。
/// 历史使用 [AppPalette] 静态色的代码（如定位弹窗）继续工作；
/// 需要跟随主题切换的地方改用 [AppPalette.of] 读取运行时色值。
abstract final class AppPalette {
  // ═══════════════════════════════════════════════════════════
  // 深色主题（默认，沿用项目原有配色）
  // 侧栏/顶栏统一走更深一档的深灰(#131313),与聊天主背景纯黑(#0F0F0F)
  // 保留 4 级灰阶差,既能区分又能融为一体。
  // ═══════════════════════════════════════════════════════════
  static const Color mainPanel = Color(0xFF0F0F0F);

  /// 侧栏/顶栏:深一档的灰(#131313),比主背景略亮、与纯黑可识别
  static const Color sidebar = Color(0xFF131313);
  static const Color sidebarSeparator = Color(0xFF2A2A2A);
  static const Color appBarForeground = Color(0xFFE8E8E8);
  static const Color sidebarDivider = Color(0xFF27272A);
  static const Color sidebarIconDefault = Color(0xFF71717A);
  static const Color sidebarIconHover = Color(0xFFD4D4D8);
  static const Color sidebarIconSelected = Color(0xFFA3A3A3);

  /// 定位权限弹窗：灰色系，与主面板/侧栏协调
  static const Color locationDialogBg = Color(0xFF171717);
  static const Color locationDialogCard = Color(0xFF1F1F1F);
  static const Color locationDialogBorder = Color(0xFF353535);
  static const Color locationDialogTitle = Color(0xFFE8E8E8);
  static const Color locationDialogBody = Color(0xFFBBBBBB);
  static const Color locationDialogMuted = Color(0xFF989898);
  static const Color locationDialogButtonBg = Color(0xFF2C2C2C);
  static const Color locationDialogButtonFg = Color(0xFFE8E8E8);

  /// 阅读态文档(摘要详情)的链接/项目符号强调色。
  /// 中性灰主题下主色与正文同灰度，来源链接会看不出可点，阅读面单独用蓝色。
  static const Color readerLink = Color(0xFF378DFF);

  // ═══════════════════════════════════════════════════════════
  // 暖色 / 米色主题（新增）
  // 整体走「燕麦米白」：极浅暖灰底 + 略深的米色侧栏 + 近乎白的工作台卡片
  // 强调色收敛为低饱和的暖橙
  // ═══════════════════════════════════════════════════════════
  static const Color warmMainPanel = Color(0xFFF8FAFD);
  static const Color warmSidebar = Color(0xFFF6F8FB);
  static const Color warmSidebarSeparator = Color(0xFFE5EAF1);
  static const Color warmAppBarForeground = Color(0xFF21242B);
  static const Color warmSidebarDivider = Color(0xFFE8EDF4);

  /// 仅左侧边栏区域使用的浅灰色底（不共享给顶栏/标题栏）
  static const Color warmSidebarPanel = Color(0xFFF0F1F3);
  static const Color warmSidebarIconDefault = Color(0xFF747C88);
  static const Color warmSidebarIconHover = Color(0xFF2C3440);
  static const Color warmSidebarIconSelected = Color(0xFF4B5563);

  // 暖色 surface 渐层（与 ColorScheme.fromSeed 输出的 surfaceContainer* 对齐）
  static const Color warmSurfaceContainerLowest = Color(0xFFFFFFFF);
  static const Color warmSurfaceContainerLow = Color(0xFFFDFEFF);
  static const Color warmSurfaceContainer = Color(0xFFF6F8FC);
  static const Color warmSurfaceContainerHigh = Color(0xFFF0F4F9);
  static const Color warmSurfaceContainerHighest = Color(0xFFE8EDF4);

  // 暖色文字 / 描边
  static const Color warmOnSurface = Color(0xFF232833);
  static const Color warmOnSurfaceVariant = Color(0xFF98A2B3);
  static const Color warmOutline = Color(0xFFDCE3EC);

  // 暖色强调（primary / secondary / tertiary）—— 收敛饱和度，更接近截图
  static const Color warmPrimary = Color(0xFF2C3440);
  static const Color warmOnPrimary = Color(0xFFFFFFFF);
  static const Color warmPrimaryContainer = Color(0xFFF1F4F8);
  static const Color warmOnPrimaryContainer = Color(0xFF2C3440);
  static const Color warmSecondary = Color(0xFF6B5CA5);
  static const Color warmOnSecondary = Color(0xFFFFFFFF);
  static const Color warmSecondaryContainer = Color(0xFFF3F0FB);
  static const Color warmOnSecondaryContainer = Color(0xFF51437D);
  static const Color warmTertiary = Color(0xFF8E5B7B);
  static const Color warmOnTertiary = Color(0xFFFFFFFF);
  static const Color warmTertiaryContainer = Color(0xFFF7EEF4);
  static const Color warmOnTertiaryContainer = Color(0xFF704661);

  // 暖色：定位弹窗
  static const Color warmLocationDialogBg = Color(0xFFF8FAFD);
  static const Color warmLocationDialogCard = Color(0xFFFFFFFF);
  static const Color warmLocationDialogBorder = Color(0xFFDCE3EC);
  static const Color warmLocationDialogTitle = Color(0xFF232833);
  static const Color warmLocationDialogBody = Color(0xFF667085);
  static const Color warmLocationDialogMuted = Color(0xFF98A2B3);
  static const Color warmLocationDialogButtonBg = Color(0xFFEAF3FF);
  static const Color warmLocationDialogButtonFg = Color(0xFF0055B8);

  // ═══════════════════════════════════════════════════════════
  // 运行时调色板入口（按当前 [AppThemeVariant] 返回对应色）
  // ═══════════════════════════════════════════════════════════

  static Color resolveMainPanel(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmMainPanel : mainPanel;

  static Color resolveSidebar(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmSidebar : sidebar;

  /// 仅左侧边栏面板：浅色主题下用米色，与顶栏/标题栏区分
  static Color resolveSidebarPanel(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmSidebarPanel : sidebar;

  static Color resolveSidebarSeparator(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmSidebarSeparator : sidebarSeparator;

  static Color resolveAppBarForeground(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmAppBarForeground : appBarForeground;

  static Color resolveSidebarDivider(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmSidebarDivider : sidebarDivider;

  static Color resolveSidebarIconDefault(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmSidebarIconDefault : sidebarIconDefault;

  static Color resolveSidebarIconHover(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmSidebarIconHover : sidebarIconHover;

  static Color resolveSidebarIconSelected(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? warmSidebarIconSelected : sidebarIconSelected;

  // ═══════════════════════════════════════════════════════════
  // 卡片 / 工作台面板背景：
  // 暖色主题下让卡片比主背景略浅（接近纯白），还原截图的层次感
  // ═══════════════════════════════════════════════════════════

  /// 深色主题下卡片与主面板同色，仅靠描边分层
  static const Color cardBackgroundDark = Color(0xFF0F0F0F);

  /// 暖色主题下卡片比主背景略浅，几乎为奶白
  static const Color cardBackgroundWarm = Color(0xFFFFFFFF);

  static Color resolveCardBackground(AppThemeVariant v) =>
      v == AppThemeVariant.warm ? cardBackgroundWarm : cardBackgroundDark;
}

/// 全应用 `MaterialApp.theme`。
///
/// 新增根级 Tab 时：在 `main.dart` 的 Tab 标题列表、`IndexedStack`、侧栏 `destinations`
/// 三处对齐索引；页面根布局用 [MainPanel] 包裹（或至少使用 `Theme.of(context).colorScheme`，勿写死浅色底）。
abstract final class AppTheme {
  /// 兼容旧调用：等价于 [of](AppThemeVariant.dark)。
  static ThemeData get material => of(AppThemeVariant.dark);

  /// 按指定变体返回对应的 [ThemeData]。
  /// 侧边栏底部的「主题切换」按钮会重新构建整个 [MaterialApp]，
  /// 因此这里返回的是不可变实例，每次切换都是新对象。
  static ThemeData of(AppThemeVariant variant) {
    return variant == AppThemeVariant.warm ? _buildWarm() : _buildDark();
  }

  /// MiSans 字体族（已内嵌，见 pubspec.yaml fonts 段）。
  ///
  /// 主字体用小米 MiSans，观感更现代、中英文数字更和谐；
  /// 回退顺序保留苹方/雅黑/思源，用于覆盖 MiSans 缺失的零星字符（如部分符号）。
  static const String appFontFamily = 'MiSans';

  /// 跨平台回退顺序。
  ///   - Windows:  Microsoft YaHei（微软雅黑）→ SimHei（黑体）
  ///   - Linux:    Noto Sans CJK SC（思源黑体）
  ///   - 兜底:     系统默认 sans-serif
  static const List<String> appFontFamilyFallback = <String>[
    'PingFang SC',
    'Microsoft YaHei',
    '微软雅黑',
    'Heiti SC',
    'Noto Sans CJK SC',
    'Source Han Sans SC',
    'sans-serif',
  ];

  /// 深色主题（原 [AppTheme.material] 内容，未改动）。
  static ThemeData _buildDark() {
    final ColorScheme base = ColorScheme.fromSeed(
      seedColor: const Color(0xFF757575),
      brightness: Brightness.dark,
    );
    // fromSeed 仍可能带出色相；强调色统一为中性灰，与侧栏/弹窗一致。
    final ColorScheme cs = base.copyWith(
      primary: const Color(0xFF8A8A8A),
      onPrimary: AppPalette.appBarForeground,
      primaryContainer: const Color(0xFF2A2A2A),
      onPrimaryContainer: const Color(0xFFBEBEBE),
      secondary: const Color(0xFF757575),
      onSecondary: AppPalette.appBarForeground,
      secondaryContainer: const Color(0xFF1F1F1F),
      onSecondaryContainer: AppPalette.locationDialogBody,
      tertiary: AppPalette.locationDialogMuted,
      onTertiary: AppPalette.appBarForeground,
      outline: AppPalette.locationDialogBorder,
      onSurface: AppPalette.appBarForeground,
      surface: AppPalette.mainPanel,
      surfaceContainerLowest: AppPalette.mainPanel,
      surfaceContainerLow: const Color(0xFF161616),
      surfaceContainer: const Color(0xFF1C1C1C),
      surfaceContainerHigh: const Color(0xFF232323),
      surfaceContainerHighest: const Color(0xFF2A2A2A),
    );
    final ThemeData theme = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: cs,
      // 全局字体族：内嵌 MiSans，并按平台回退到苹方/雅黑/思源/系统无衬线
      fontFamily: appFontFamily,
      fontFamilyFallback: appFontFamilyFallback,
      dialogTheme: DialogThemeData(
        backgroundColor: AppPalette.locationDialogBg,
        surfaceTintColor: Colors.transparent,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppPalette.locationDialogButtonBg,
          foregroundColor: AppPalette.locationDialogButtonFg,
        ),
      ),
      scaffoldBackgroundColor: AppPalette.mainPanel,
      // AppBar 默认走与侧栏一致的深灰色;不显式设置 backgroundColor
      // 的 AppBar 也会自动跟随此色,避免出现"顶栏纯黑、侧栏深灰"的错位。
      appBarTheme: const AppBarTheme(
        backgroundColor: AppPalette.sidebar,
        foregroundColor: AppPalette.appBarForeground,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: Colors.white,
        unselectedLabelColor: Colors.white70,
        indicatorColor: cs.onSurface,
        dividerColor: cs.outline.withValues(alpha: 0.25),
        overlayColor: WidgetStateProperty.all(Colors.transparent),
        labelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        unselectedLabelStyle:
            const TextStyle(fontWeight: FontWeight.w400, fontSize: 14),
        indicator: UnderlineTabIndicator(
          borderSide: BorderSide(width: 2, color: cs.onSurface),
          insets: const EdgeInsets.symmetric(horizontal: 12),
        ),
      ),
      cardTheme: CardThemeData(
        color: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.transparent,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.outline.withValues(alpha: 0.35)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.onSurface.withValues(alpha: 0.5)),
        ),
      ),
      dividerTheme: DividerThemeData(
        color: cs.outline.withValues(alpha: 0.35),
        thickness: 1,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: cs.surfaceContainerHigh,
        contentTextStyle: TextStyle(color: cs.onSurface, fontSize: 14),
        actionTextColor: cs.primary,
      ),
    );
    // 统一排版:把全局行高 token 写入 TextTheme(正文 1.6 / 标题 1.3 等)
    return theme.copyWith(
      textTheme: AppTypography.applyLineHeights(theme.textTheme),
    );
  }

  /// 暖色 / 米色主题。
  ///
  /// 走 Light 亮度，种子色取自暖橙 `#B98B43`，
  /// 再把所有"灰阶 surface" 覆盖为奶茶色梯度，把强调色统一为暖棕。
  static ThemeData _buildWarm() {
    final ColorScheme base = ColorScheme.fromSeed(
      seedColor: const Color(0xFFB98B43),
      brightness: Brightness.light,
    );
    final ColorScheme cs = base.copyWith(
      primary: AppPalette.warmPrimary,
      onPrimary: AppPalette.warmOnPrimary,
      primaryContainer: AppPalette.warmPrimaryContainer,
      onPrimaryContainer: AppPalette.warmOnPrimaryContainer,
      secondary: AppPalette.warmSecondary,
      onSecondary: AppPalette.warmOnSecondary,
      secondaryContainer: AppPalette.warmSecondaryContainer,
      onSecondaryContainer: AppPalette.warmOnSecondaryContainer,
      tertiary: AppPalette.warmTertiary,
      onTertiary: AppPalette.warmOnTertiary,
      tertiaryContainer: AppPalette.warmTertiaryContainer,
      onTertiaryContainer: AppPalette.warmOnTertiaryContainer,
      outline: AppPalette.warmOutline,
      onSurface: AppPalette.warmOnSurface,
      onSurfaceVariant: AppPalette.warmOnSurfaceVariant,
      surface: AppPalette.warmMainPanel,
      surfaceContainerLowest: AppPalette.warmSurfaceContainerLowest,
      surfaceContainerLow: AppPalette.warmSurfaceContainerLow,
      surfaceContainer: AppPalette.warmSurfaceContainer,
      surfaceContainerHigh: AppPalette.warmSurfaceContainerHigh,
      surfaceContainerHighest: AppPalette.warmSurfaceContainerHighest,
    );
    final ThemeData theme = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: cs,
      fontFamily: appFontFamily,
      fontFamilyFallback: appFontFamilyFallback,
      dialogTheme: DialogThemeData(
        backgroundColor: AppPalette.warmLocationDialogBg,
        surfaceTintColor: Colors.transparent,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppPalette.warmLocationDialogButtonBg,
          foregroundColor: AppPalette.warmLocationDialogButtonFg,
        ),
      ),
      scaffoldBackgroundColor: AppPalette.warmMainPanel,
      appBarTheme: const AppBarTheme(
        backgroundColor: AppPalette.warmMainPanel,
        foregroundColor: AppPalette.warmAppBarForeground,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: AppPalette.warmOnSurface,
        unselectedLabelColor: AppPalette.warmOnSurfaceVariant,
        indicatorColor: AppPalette.warmOnSurface,
        dividerColor: AppPalette.warmOutline.withValues(alpha: 0.55),
        overlayColor: WidgetStateProperty.all(Colors.transparent),
        labelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        unselectedLabelStyle:
            const TextStyle(fontWeight: FontWeight.w400, fontSize: 14),
        indicator: UnderlineTabIndicator(
          borderSide: BorderSide(width: 2, color: AppPalette.warmOnSurface),
          insets: const EdgeInsets.symmetric(horizontal: 12),
        ),
      ),
      cardTheme: CardThemeData(
        color: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: cs.outline.withValues(alpha: 0.55)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.transparent,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.outline.withValues(alpha: 0.55)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.outline.withValues(alpha: 0.55)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(24),
          borderSide: BorderSide(color: cs.onSurface.withValues(alpha: 0.65)),
        ),
      ),
      dividerTheme: DividerThemeData(
        color: cs.outline.withValues(alpha: 0.55),
        thickness: 1,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: cs.surfaceContainerHigh,
        contentTextStyle: TextStyle(color: cs.onSurface, fontSize: 14),
        actionTextColor: cs.primary,
      ),
    );
    return theme.copyWith(
      textTheme: AppTypography.applyLineHeights(theme.textTheme),
    );
  }

  /// 与主面板同色、仅用描边区分的容器（卡片、区块等）。
  ///
  /// - [fill]：自定义填充色；不传则保持透明（深色主题默认）。
  ///           暖色主题下可传 [AppPalette.cardBackgroundWarm] 让卡片略亮。
  static BoxDecoration borderedPanel(
    ColorScheme cs, {
    double radius = 12,
    double borderAlpha = 0.35,
    Color? borderColor,
    Color? fill,
  }) {
    return BoxDecoration(
      color: fill ?? Colors.transparent,
      borderRadius: BorderRadius.circular(radius),
      border: Border.all(
        color: borderColor ?? cs.outline.withValues(alpha: borderAlpha),
      ),
    );
  }

  /// 子 Tab 胶囊：背景透明，选中时描边略强。
  static BoxDecoration subNavChip(ColorScheme cs, {required bool selected}) {
    return BoxDecoration(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(
        color: selected
            ? cs.onSurface.withValues(alpha: 0.55)
            : cs.outline.withValues(alpha: 0.35),
        width: selected ? 1.25 : 1,
      ),
    );
  }
}

/// 主内容区画布，与 [AppPalette.mainPanel] / `colorScheme.surface` 一致。
///
/// 新 Tab 的根 `build` 推荐：`return MainPanel(child: YourPageBody(...));`
class MainPanel extends StatelessWidget {
  const MainPanel({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: child,
    );
  }
}
