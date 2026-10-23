// 检查更新真机链路 E2E：真实 Windows 进程 + 真实侧栏按钮 + 真实 HTTP 请求。
//
// 运行（需 Windows 桌面，先起本地 manifest 假服务）：
//   node integration_test/manifest_e2e_server.mjs
//   flutter test integration_test/update_check_e2e_test.dart -d windows ^
//     --dart-define=UPDATE_MANIFEST_URL=http://127.0.0.1:18500
//
// 假服务按状态文件（%TEMP%\manifest_e2e_state.json）的 mode 字段返回结果，
// 本测试直接改写状态文件切态：
//   A = latest 与本地相同 → upToDate → 右上角玻璃通知卡「已是最新版本」
//   B = latest 9.9.9      → optionalUpdate → 更新按钮正上方浮卡（立即升级/暂不更新）
//   C = HTTP 500          → 检查失败 → 重试浮卡；点「重试」切 B 后应换成新版本卡
//   E = latest 9.9.9 且 url 指向本地真下载端点 → 验证应用内下载流程
//       （点「立即升级」卡内进度 → 「重启完成更新」→ 真实落盘 → 取消还原；
//        不点「重启完成更新」——exit+静默安装腿需真实安装包，发版时人工闭环）
//   F = minVersion 99.0.0 → 强锁 → 不可关闭的升级弹窗（主题渲染取证）
// 每阶段用 RepaintBoundary 出真实渲染 PNG 到 %TEMP%，供人工目检。
// 主题由 --dart-define=E2E_THEME=warm|dark 选择（默认 warm）：浮卡/弹窗
// 配色已主题化，两套主题都应出真实渲染证据；截图文件名带主题前缀。
import "dart:io" show File, Platform;
import "dart:typed_data" show ByteData;
import "dart:ui" as ui show FrameTiming, Image, ImageByteFormat;

import "package:flutter/material.dart";
import "package:flutter/rendering.dart" show RenderRepaintBoundary;
import "package:flutter/scheduler.dart" show SchedulerBinding, TimingsCallback;
import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";
import "package:package_info_plus/package_info_plus.dart";
import "package:nextbot/core/presentation/glass_notify.dart";
import "package:nextbot/core/presentation/update_result_card.dart";
import "package:nextbot/core/theme/app_theme.dart";
import "package:nextbot/features/chat/sidebar_user_menu.dart"
    show ThemeChoice;
import "package:nextbot/widgets/app_sidebar.dart";

const String _statePath =
    r"C:\Users\Administrator\AppData\Local\Temp\manifest_e2e_state.json";
const String _shotDir = r"C:\Users\Administrator\AppData\Local\Temp";
const String _themeMode = String.fromEnvironment(
  "E2E_THEME",
  defaultValue: "warm",
);
final AppThemeVariant _themeVariant = _themeMode == "dark"
    ? AppThemeVariant.dark
    : AppThemeVariant.warm;
final GlobalKey _shotKey = GlobalKey(debugLabel: "updateE2eShot");

void _setMode(String mode) {
  File(_statePath).writeAsStringSync('{"mode":"$mode"}');
}

/// 真实网络返回需要事件轮转，pumpAndSettle 在无帧调度时会提前放行，
/// 这里轮询到条件成立再继续。注意 integration binding 走真实时钟，
/// 入场/退场动画（300ms）必须以真实时间等待播完，pump(duration) 不会快进。
Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() done, {
  int maxMs = 8000,
}) async {
  final Stopwatch sw = Stopwatch()..start();
  while (!done() && sw.elapsedMilliseconds < maxMs) {
    await tester.pump();
    await Future<void>.delayed(const Duration(milliseconds: 30));
  }
  // 等入场动画在真实时间播完并出最终一帧
  await Future<void>.delayed(const Duration(milliseconds: 450));
  await tester.pump();
}

Future<void> _shot(String name) async {
  final BuildContext? ctx = _shotKey.currentContext;
  final RenderRepaintBoundary? boundary =
      ctx?.findRenderObject() as RenderRepaintBoundary?;
  if (boundary == null || boundary.debugNeedsLayout) return;
  final ui.Image image = await boundary.toImage(pixelRatio: 1.0);
  final ByteData? bytes =
      await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  if (bytes == null) return;
  final String path =
      "$_shotDir\\update_e2e_${_themeMode}_$name.png";
  await File(path).writeAsBytes(bytes.buffer.asUint8List());
  debugPrint("[update-e2e] shot: $path");
}

Widget _harness() {
  // 侧栏配色读 AppThemeController、浮卡/弹窗读 Theme——两处同步到
  // dart-define 选的主题，整屏渲染才是该主题的真实样子
  AppThemeController.instance.setVariant(_themeVariant);
  return RepaintBoundary(
    key: _shotKey,
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.of(_themeVariant),
      builder: (BuildContext context, Widget? child) =>
          GlassNotifyHost(child: UpdateResultCardHost(child: child)),
      home: Builder(
        builder: (BuildContext navCtx) => Scaffold(
          body: Row(
            children: <Widget>[
              AppSidebar(
                tabIndex: 0,
                onTabSelected: (_) {},
                currentTheme: ThemeChoice.system,
                onSetLightTheme: () {},
                onSetDarkTheme: () {},
                onSetSystemTheme: () {},
                inboxUnread: 0,
                onInboxUnreadChanged: (_) {},
                onOpenSettings: () {},
                onCheckUpdate: () async {
                  // 强锁路径要 showDialog，必须给 navigator 子树内的
                  // context；_shotKey 在 MaterialApp 之上，够不着 Navigator
                  await UpdateResultCard.runManualUpdateCheck(navCtx);
                },
                onOpenUserMenuFeedback: () {},
                onOpenDevices: () {},
                onLogout: () {},
              ),
              const Expanded(child: SizedBox.shrink()),
            ],
          ),
        ),
      ),
    ),
  );
}

Future<void> _settle(WidgetTester tester) async {
  // 退场动画(300ms)以真实时间播完；摘卡触发的重建还需要再出一帧
  await Future<void>.delayed(const Duration(milliseconds: 450));
  await tester.pump();
  await Future<void>.delayed(const Duration(milliseconds: 80));
  await tester.pump();
}

void main() {
  final IntegrationTestWidgetsFlutterBinding binding =
      IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.defaultTestTimeout = const Timeout(Duration(minutes: 5));

  testWidgets("检查更新三态真机链路", (WidgetTester tester) async {
    await binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => binding.setSurfaceSize(null));

    // ── A：已是最新 → 右上角玻璃通知卡 ─────────────────────────────
    // 本地版本动态读取（迭代会改 pubspec 版本号，不能写死）
    final PackageInfo pkg = await PackageInfo.fromPlatform();
    final String v = pkg.version;
    _setMode("A");
    await tester.pumpWidget(_harness());
    await tester.pump();
    // 采集入场窗口的帧耗时（debug 数字偏大，看量级与最差帧）
    final List<ui.FrameTiming> frames = <ui.FrameTiming>[];
    final TimingsCallback onFrames =
        (List<ui.FrameTiming> t) => frames.addAll(t);
    SchedulerBinding.instance.addTimingsCallback(onFrames);
    await tester.tap(find.byTooltip("检查更新"));
    await _pumpUntil(
      tester,
      () => GlassNotify.entries.isNotEmpty &&
          find.text("当前版本 v$v").evaluate().isNotEmpty,
    );
    await Future<void>.delayed(const Duration(milliseconds: 700));
    await tester.pump();
    SchedulerBinding.instance.removeTimingsCallback(onFrames);
    if (frames.isNotEmpty) {
      final List<ui.FrameTiming> sorted = List<ui.FrameTiming>.of(frames)
        ..sort((ui.FrameTiming a, ui.FrameTiming b) => b.totalSpan
            .inMicroseconds
            .compareTo(a.totalSpan.inMicroseconds));
      final ui.FrameTiming worst = sorted.first;
      debugPrint("[update-e2e] frames=${frames.length} "
          "worstBuild=${worst.buildDuration.inMilliseconds}ms "
          "worstRaster=${worst.rasterDuration.inMilliseconds}ms "
          "worstTotal=${worst.totalSpan.inMilliseconds}ms");
    }
    expect(GlassNotify.entries.first.title, "已是最新版本",
        reason: "upToDate 应出右上角玻璃通知卡");
    expect(find.text("当前版本 v$v"), findsOneWidget);
    expect(find.textContaining("发现新版本"), findsNothing);
    await _shot("A_uptodate_toast");
    // 注：玻璃卡悬停会暂停倒计时（既有交互设计），真机指针若停在卡上则
    // 不自动收起，故这里不对自动消失做硬断言，直接进入下一阶段。

    // ── B：发现新版本 → 更新按钮正上方浮卡 ─────────────────────────
    _setMode("B");
    await tester.tap(find.byTooltip("检查更新"));
    await _pumpUntil(
      tester,
      () => find.text("发现新版本 v9.9.9").evaluate().isNotEmpty,
    );
    expect(find.text("当前 v$v → 最新 v9.9.9"), findsOneWidget);
    expect(find.text("立即升级"), findsOneWidget);
    expect(find.text("暂不更新"), findsOneWidget);
    await _shot("B_available_card");
    final Rect cardRect = tester.getRect(find.text("当前 v$v → 最新 v9.9.9"));
    final Rect btnRect = tester.getRect(find.byTooltip("检查更新"));
    debugPrint("[update-e2e] card=$cardRect button=$btnRect");
    // 由卡内文本反推卡面左缘：文本左 - (14 padding + 36 图标 + 10 间距)
    final double cardLeft = cardRect.left - 60;
    expect((cardLeft - btnRect.left).abs(), lessThan(4.0),
        reason: "浮卡左缘应与按钮左缘对齐（锚定按钮正上方）");
    // 卡片底缘贴按钮顶缘上方：卡内最底部的文本也应整体在按钮顶之上
    expect(cardRect.bottom, lessThan(btnRect.top),
        reason: "浮卡应整体悬在按钮上方，而非盖住按钮或伸向屏幕中部/底部");

    // ── C：检查失败 → 重试浮卡；重试走真 HTTP 换成新版本卡 ──────────
    // 注：用精确标题匹配而非 textContaining——假服务 notes 文案里含
    // 「发现新版本」子串，模糊匹配会撞上 notes 文本
    _setMode("C");
    await tester.tap(find.text("暂不更新"));
    await _settle(tester);
    expect(find.text("发现新版本 v9.9.9"), findsNothing);
    await tester.tap(find.byTooltip("检查更新"));
    await _pumpUntil(
      tester,
      () => find.text("检查更新失败").evaluate().isNotEmpty,
    );
    expect(find.text("重试"), findsOneWidget);
    await _shot("C_failure_card");

    _setMode("B");
    await tester.tap(find.text("重试"));
    await _pumpUntil(
      tester,
      () => find.text("发现新版本 v9.9.9").evaluate().isNotEmpty,
    );
    expect(find.text("检查更新失败"), findsNothing,
        reason: "点重试应真实重发检查并换成新版本浮卡");
    await _shot("D_retry_switched_to_available");

    // 「暂不更新」关闭浮卡
    await tester.tap(find.text("暂不更新"));
    await _settle(tester);
    expect(find.text("发现新版本 v9.9.9"), findsNothing,
        reason: "暂不更新应关闭浮卡");
  });

  testWidgets("应用内下载流程真机链路：升级→重启就绪→落盘→取消还原",
      (WidgetTester tester) async {
    await binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => binding.setSurfaceSize(null));

    _setMode("E");
    await tester.pumpWidget(_harness());
    await tester.pump();
    await tester.tap(find.byTooltip("检查更新"));
    await _pumpUntil(
      tester,
      () => find.text("发现新版本 v9.9.9").evaluate().isNotEmpty,
    );

    // 点「立即升级」→ 卡内就地进入下载流程（不跳浏览器）
    await tester.tap(find.text("立即升级"));
    await _pumpUntil(tester, () => find.text("取消").evaluate().isNotEmpty);
    await _shot("E_in_card_downloading");

    // 回环下载毫秒级：等「重启完成更新」就绪态出现
    await _pumpUntil(
      tester,
      () => find.text("重启完成更新").evaluate().isNotEmpty,
      maxMs: 20000,
    );
    expect(find.text("取消"), findsOneWidget,
        reason: "就绪态仍应可取消还原");
    await _shot("F_restart_ready");

    // 成品真实落盘（真实 %LOCALAPPDATA%\Nextbot\update，尺寸与端点一致）
    final String localAppData = Platform.environment["LOCALAPPDATA"]!;
    final File downloaded = File(
      "$localAppData${Platform.pathSeparator}Nextbot"
      "${Platform.pathSeparator}update"
      "${Platform.pathSeparator}fake-setup.exe",
    );
    expect(downloaded.existsSync(), isTrue, reason: "安装包应真实下载落盘");
    expect(downloaded.lengthSync(), 12 * 1024 * 1024);

    // downloaded 态点「取消」→ 回 idle（立即升级重新可见），进程不退
    await tester.tap(find.text("取消"));
    await _pumpUntil(
      tester,
      () => find.text("立即升级").evaluate().isNotEmpty,
    );
    expect(find.text("重启完成更新"), findsNothing);

    // 暂不更新（flow idle）→ 还原静态卡；再暂不更新 → 关卡
    await tester.tap(find.text("暂不更新"));
    await _pumpUntil(
      tester,
      () => find.text("立即升级").evaluate().isNotEmpty,
    );
    await tester.tap(find.text("暂不更新"));
    await _settle(tester);
    expect(find.text("发现新版本 v9.9.9"), findsNothing,
        reason: "还原静态卡后暂不更新应关闭浮卡");
  });

  testWidgets("强锁升级弹窗真机渲染", (WidgetTester tester) async {
    await binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => binding.setSurfaceSize(null));

    _setMode("F");
    await tester.pumpWidget(_harness());
    await tester.pump();
    await tester.tap(find.byTooltip("检查更新"));
    await _pumpUntil(
      tester,
      () => find.text("版本过旧，需要升级").evaluate().isNotEmpty,
    );
    // 先出证再断言：弹窗没起来时截图能直接看出屏幕上是什么
    await _shot("G_forced_dialog");
    expect(find.text("立即升级"), findsOneWidget,
        reason: "强锁弹窗唯一出口是升级，不应有「暂不更新」");
    expect(find.text("暂不更新"), findsNothing);
  });
}
