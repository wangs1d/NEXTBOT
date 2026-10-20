import "dart:io" show Directory, File, Platform, exit;
import "dart:typed_data" show ByteData;

import "package:flutter/foundation.dart" show debugPrint;
import "package:flutter/services.dart"
    show MethodCall, MethodChannel, rootBundle;
import "package:tray_manager/tray_manager.dart";
import "package:window_manager/window_manager.dart";

/// 系统托盘 + 「点 X 后台驻留」：
/// - setPreventClose(true) 拦截 WM_CLOSE（自绘标题栏 X / Alt+F4 都走这里），
///   onWindowClose 里改为隐藏窗口，进程与后台服务连接继续运行；
/// - 隐藏同时置 skipTaskbar(true)：**任务栏不留图标**，入口只在托盘
///   （SW_HIDE 在部分窗口状态下不清任务栏按钮，显式 DeleteTab 才是确定行为）；
/// - 托盘左键单击恢复主窗口，右键菜单提供「显示主窗口 / 退出」；
/// - 退出先置 [_exiting] 让 onWindowClose 放行，再 destroy 真正结束进程。
///
/// 失败兜底（关键）：托盘图标装不上时**不拦截关闭**。否则点 X 后窗口既不在
/// 任务栏、也没有托盘入口，用户再也找不回进程，只能去任务管理器杀。
class AppTrayService with WindowListener, TrayListener {
  AppTrayService._();

  static final AppTrayService instance = AppTrayService._();

  static const String _menuKeyShow = "show_main_window";
  static const String _menuKeyExit = "exit_app";

  /// 单实例激活通道：桌面再次启动本应用时，原生侧（新进程）发现已有主实例
  /// 后不建新窗口，而是向本实例发「请前置」请求（见 runner/single_instance.h）。
  static const MethodChannel _instanceChannel =
      MethodChannel("pai/single_instance");

  /// 托盘图标资源（pubspec 已声明 assets/tray_icon.ico）。
  static const String _iconAssetKey = "assets/tray_icon.ico";
  static const String _iconFileName = "tray_icon.ico";

  bool _initialized = false;

  /// 托盘图标 + 菜单是否真的装上了。false 时不做 preventClose。
  bool _trayReady = false;

  /// 托盘菜单「退出」置 true：onWindowClose 不再隐藏，放行 destroy。
  bool _exiting = false;

  bool get isTrayReady => _trayReady;

  Future<void> init() async {
    if (_initialized) return;
    _initialized = true;
    windowManager.addListener(this);
    trayManager.addListener(this);

    // 单实例激活监听：必须在托盘就绪判定之前注册——托盘装不上时应用点 X
    // 会正常退出、没有驻留实例，但只要有实例在跑，再次点桌面图标就该前置它。
    _instanceChannel.setMethodCallHandler(_handleInstanceCall);

    _trayReady = await _installTray();
    if (!_trayReady) {
      // 没有托盘入口就别拦关闭，保持「点 X 正常退出」。
      debugPrint(
        "[AppTray] tray unavailable -> close keeps default (exit) behavior",
      );
      return;
    }
    // 点 X 不再销毁进程，只隐藏窗口后台驻留（任务栏同时摘图标）。
    await windowManager.setPreventClose(true);
  }

  List<MenuItem> _buildMenuItems() => <MenuItem>[
        MenuItem(key: _menuKeyShow, label: "显示主窗口"),
        MenuItem.separator(),
        MenuItem(key: _menuKeyExit, label: "退出"),
      ];

  Future<bool> _installTray() async {
    final String? iconPath = await _materializeIcon();
    if (iconPath == null) {
      debugPrint("[AppTray] tray icon not found anywhere");
      return false;
    }
    try {
      await trayManager.setIcon(iconPath);
      await trayManager.setToolTip("NEXTBOT");
      await trayManager.setContextMenu(Menu(items: _buildMenuItems()));
      return true;
    } catch (e) {
      debugPrint("[AppTray] setIcon/menu failed: $e");
      return false;
    }
  }

  /// 取托盘图标文件路径。
  ///
  /// 首选从 Flutter 资源包直接解出到临时文件：与打包目录布局无关，
  /// Release / Debug / `flutter run` 三种形态一定拿得到。旧实现按
  /// `exe/data/flutter_assets/assets/` 猜路径，Debug 包资源目录陈旧时
  /// 直接抛异常又被 catch 吞掉——症状就是「点了关闭只隐藏、托盘里却没有图标」。
  Future<String?> _materializeIcon() async {
    try {
      final ByteData data = await rootBundle.load(_iconAssetKey);
      final String sep = Platform.pathSeparator;
      final File tmp =
          File("${Directory.systemTemp.path}${sep}nextbot_$_iconFileName");
      final int expected = data.lengthInBytes;
      if (!tmp.existsSync() || tmp.lengthSync() != expected) {
        await tmp.writeAsBytes(data.buffer.asUint8List(), flush: true);
      }
      if (tmp.existsSync() && tmp.lengthSync() == expected) {
        return tmp.path;
      }
    } catch (e) {
      debugPrint("[AppTray] load asset icon failed: $e");
    }
    for (final String path in _iconCandidates()) {
      if (File(path).existsSync()) return path;
    }
    return null;
  }

  /// 兜底路径链：exe 同级 → 工程根 → 构建产物（debug 直跑常见布局）。
  Iterable<String> _iconCandidates() sync* {
    final String sep = Platform.pathSeparator;
    final String exeDir = File(Platform.resolvedExecutable).parent.path;
    final String cwd = Directory.current.path;
    yield "$exeDir$sep" "data$sep" "flutter_assets$sep" "assets$sep$_iconFileName";
    yield "$exeDir$sep" "assets$sep$_iconFileName";
    yield "$cwd$sep" "data$sep" "flutter_assets$sep" "assets$sep$_iconFileName";
    yield "$cwd$sep" "assets$sep$_iconFileName";
    for (final String cfg in <String>["Release", "Debug", "Profile"]) {
      yield "$cwd$sep" "build$sep" "windows$sep" "x64$sep" "runner$sep$cfg$sep"
          "data$sep" "flutter_assets$sep" "assets$sep$_iconFileName";
    }
  }

  /// 显示并聚焦主窗口（托盘单击/菜单共用）：先恢复任务栏图标再显示，
  /// 最小化状态先还原。
  Future<void> showMainWindow() async {
    try {
      await windowManager.setSkipTaskbar(false);
      if (await windowManager.isMinimized()) {
        await windowManager.restore();
      }
      await windowManager.show();
      await windowManager.focus();
    } catch (e) {
      debugPrint("[AppTray] showMainWindow failed: $e");
    }
  }

  /// 原生「请前置」请求处理：桌面再次启动本应用时，新进程静默退出，转而
  /// 经此请求本实例把托盘中的主窗口恢复并前置（复用托盘单击同一路径）。
  Future<dynamic> _handleInstanceCall(MethodCall call) async {
    if (call.method == "onActivateRequested") {
      await showMainWindow();
    }
    return null;
  }

  /// 隐藏到托盘：任务栏图标一并摘掉。
  Future<void> _hideToTray() async {
    try {
      // 显式 DeleteTab：SW_HIDE 在最大化/被 owner 持有的窗口上可能留下任务栏按钮。
      await windowManager.setSkipTaskbar(true);
    } catch (e) {
      debugPrint("[AppTray] setSkipTaskbar(true) failed: $e");
    }
    try {
      await windowManager.hide();
    } catch (e) {
      debugPrint("[AppTray] hide failed: $e");
      // 隐藏失败又已经拦掉关闭 -> 会留下找不到的进程，直接收场。
      exit(0);
    }
  }

  /// 托盘菜单「退出」：真正结束进程。
  ///
  /// 走标准关闭链路 [windowManager.close]（WM_CLOSE → DestroyWindow →
  /// WM_DESTROY 里释放引擎 → PostQuitMessage），而**不是** destroy()。
  ///
  /// 坑（2026-10-20 实测）：window_manager 的 destroy() 原生实现只有
  /// `PostQuitMessage(0)`，窗口压根没销毁。于是消息循环退出后引擎只能在
  /// main() 返回、栈对象析构时才释放，而那时原生侧 `CoUninitialize()` 已经
  /// 跑过——引擎与 WebView2 在 COM 已卸载的线程上析构，flutter_windows.dll
  /// 必然访问违例（事件日志：0xc0000005 偏移 0x1d7b0，随后回调二次异常
  /// 0xc000041d）。WER 随即挂起全部线程、收集 dump（内存 220MB→690MB），
  /// 进程要 13~19 秒才消失——用户侧就是「点托盘退出卡十几秒」。
  Future<void> exitApp() async {
    if (_exiting) return;
    _exiting = true;
    // 先放手关闭拦截：close() 发的是 WM_CLOSE，preventClose 还挂着的话
    // 只会走 onWindowClose 隐藏窗口，进程根本不会退出。
    try {
      await windowManager.setPreventClose(false);
    } catch (e) {
      debugPrint("[AppTray] release preventClose failed: $e");
    }
    // 托盘图标先摘：进程结束后 Windows 不会立即抹掉残影（要等鼠标划过）。
    // 失败无妨，绝不影响下面真正决定退出的一步。
    try {
      await trayManager.destroy();
    } catch (e) {
      debugPrint("[AppTray] tray destroy failed: $e");
    }
    try {
      await windowManager.close();
    } catch (e) {
      debugPrint("[AppTray] close failed: $e");
    }
    // 兜底：关闭链路任一环卡住（窗口不可见/插件未生效）时，短延时后
    // 直接 PostQuitMessage + 强制结束，绝不让用户对着没反应的托盘干等。
    await Future<void>.delayed(const Duration(milliseconds: 800));
    try {
      await windowManager.destroy();
    } catch (e) {
      debugPrint("[AppTray] destroy fallback failed: $e");
    }
    await Future<void>.delayed(const Duration(milliseconds: 400));
    exit(0);
  }

  // ---- WindowListener ----

  @override
  void onWindowClose() {
    if (_exiting) return;
    _hideToTray();
  }

  // ---- TrayListener ----

  @override
  void onTrayIconMouseDown() {
    showMainWindow();
  }

  @override
  void onTrayIconRightMouseDown() {
    trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case _menuKeyShow:
        showMainWindow();
      case _menuKeyExit:
        exitApp();
    }
  }
}
