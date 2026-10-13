import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";

import "app/ambient_feeds_controller.dart";
import "core/config/api_config.dart";
import "core/services/account_session_store.dart";
import "core/services/access_auth_api.dart";
import "core/services/local_notification_service.dart";
import "mobile_ui/mobile_home.dart";
import "mobile_ui/mobile_login_page.dart";
import "mobile_ui/mobile_theme.dart";

/// 手机端应用入口(Android / iOS)。
///
/// ⚠️ 铁律（用户 2026-10-13 明令）：这是**唯一**的桌面调试手机 UI 通道。
/// 调试手机端一律用本入口（-t lib/main_mobile.dart），绝不允许改桌面主入口
/// main.dart 的路由（_buildApp 的 _isMobile 分流 / home 指向）让桌面 exe
/// 落到手机壳——桌面 exe 必须路由到真的桌面代码。
///
/// 运行：
/// - Linux/macOS/Windows 桌面调试手机 UI：
///   `flutter run -d windows -t lib/main_mobile.dart`
/// - Android 模拟器连接本机后端：
///   `flutter run -t lib/main_mobile.dart --dart-define=HTTP_BASE=http://10.0.2.2:3000`
/// - 真机(手机与后端在同一局域网)：
///   改用手机连的局域网 IP,如 `--dart-define=HTTP_BASE=http://192.168.1.100:3000`
///
/// 登录门禁：仅提供邮箱登录（与桌面端 /accounts/web 两步式同协议）。
/// 登录邮箱写入 [ApiConfig.runtimeUserId]——WS `session.init`/HTTP/本地存储
/// 全链按该 userId 落库，与桌面端登录同一账号即共享全部数据。已登录会话
/// 读盘恢复（account_session.json），退出登录回到登录页。
///
/// 底部导航：「对话」 / 「日程」 / 「我的」(邮箱、消息中心、服务接入、
/// 模型目录、帮助反馈、主题、退出登录)。功能与桌面端同源同数据,详见 mobile_home.dart。
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MobileApp());
}

/// 手机端根组件：登录门禁 + 白黑极简主题 + 全功能主壳。
class MobileApp extends StatefulWidget {
  const MobileApp({super.key});

  @override
  State<MobileApp> createState() => _MobileAppState();
}

class _MobileAppState extends State<MobileApp> {
  /// 主题模式(亮 / 暗 / 跟随系统)。
  final ValueNotifier<ThemeMode> _themeMode = ValueNotifier(ThemeMode.system);

  /// 登录态恢复中（读盘未出前沿用空白页，防闪登录页）。
  bool _booting = true;

  /// 已登录（本机有会话或本次登录成功）。
  bool _loggedIn = false;

  @override
  void initState() {
    super.initState();
    // 系统通知服务初始化（Android 13+ 运行时权限申请 + 渠道注册）：
    // 不 init 则 show() 静默返回，手机后台到点提醒永远无系统通知（2026-10-12 修复）。
    unawaited(LocalNotificationService.init());
    LocalNotificationService.onOutcome =
        AmbientFeedsController.instance.sendProactiveOutcome;
    _restoreSession();
  }

  /// 启动恢复本机登录态：有会话先把邮箱写进运行时身份覆盖，
  /// 再进主壳——保证主壳里所有请求第一时间就带本账号身份。
  Future<void> _restoreSession() async {
    await AccountSessionStore.instance.load();
    // 设备凭据顺手加载（服务端开访问鉴权时 HTTP/WS 自动附带 Bearer token）
    await AccessCredentialStore.instance.load();
    final String? email = AccountSessionStore.instance.email;
    if (!mounted) return;
    setState(() {
      if (email != null && email.isNotEmpty) {
        ApiConfig.runtimeUserId = email;
        _loggedIn = true;
      }
      _booting = false;
    });
  }

  /// 登录页回调：落盘会话 → 写运行时身份覆盖 → 切入主壳。
  /// 身份覆盖必须先于主壳构建，首个 `session.init`/HTTP 才带登录邮箱。
  Future<void> _onLoggedIn(String email) async {
    await AccountSessionStore.instance.save(email);
    ApiConfig.runtimeUserId = AccountSessionStore.instance.email;
    if (!mounted) return;
    setState(() => _loggedIn = true);
  }

  /// 退出登录：清本机会话与运行时身份覆盖，回登录页。
  /// 主壳被换下时其聊天控制器随 dispose 断开 WS。
  Future<void> _onLogout() async {
    await AccountSessionStore.instance.clear();
    ApiConfig.runtimeUserId = null;
    if (!mounted) return;
    setState(() => _loggedIn = false);
  }

  /// 调试跳过登录（仅 debug 构建注入登录页）：临时身份直进主壳看 UI，
  /// 不落盘会话——重启仍回登录页，正式登录不受影响。
  void _onDebugSkipLogin() {
    ApiConfig.runtimeUserId = "debug@preview.local";
    if (!mounted) return;
    setState(() => _loggedIn = true);
  }

  @override
  void dispose() {
    _themeMode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: _themeMode,
      builder: (BuildContext context, ThemeMode mode, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: "NEXTBOT",
          theme: MobileTheme.light,
          darkTheme: MobileTheme.dark,
          themeMode: mode,
          home: _buildHome(mode),
        );
      },
    );
  }

  Widget _buildHome(ThemeMode mode) {
    if (_booting) {
      // 读盘未出前给一帧纯背景，避免登录页闪现
      final MobilePalette p = MobileTheme.of(context);
      return Scaffold(backgroundColor: p.background, body: const SizedBox.shrink());
    }
    if (!_loggedIn) {
      return MobileLoginPage(
        onLoggedIn: (String email) => unawaited(_onLoggedIn(email)),
        // 调试构建给「跳过登录」入口；release 不注入，按钮自动隐藏
        onDebugSkip: kDebugMode ? _onDebugSkipLogin : null,
      );
    }
    return MobileHomePage(
      themeMode: mode,
      onThemeModeChanged: (ThemeMode m) => _themeMode.value = m,
      onLogout: _onLogout,
    );
  }
}
