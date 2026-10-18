import "dart:io" show File, Platform, exit;

import "package:flutter/foundation.dart" show debugPrint;
import "package:tray_manager/tray_manager.dart";
import "package:window_manager/window_manager.dart";

/// 系统托盘 + 「点 X 后台驻留」：
/// - setPreventClose(true) 拦截 WM_CLOSE（自绘标题栏 X / Alt+F4 都走这里），
///   onWindowClose 里改为隐藏窗口，进程与后台服务连接继续运行；
/// - 托盘左键单击恢复主窗口，右键菜单提供「显示主窗口 / 退出」；
/// - 退出先置 [_exiting] 让 onWindowClose 放行，再 destroy 真正结束进程。
class AppTrayService with WindowListener, TrayListener {
  AppTrayService._();

  static final AppTrayService instance = AppTrayService._();

  static const String _menuKeyShow = "show_main_window";
  static const String _menuKeyExit = "exit_app";

  bool _initialized = false;

  /// 托盘菜单「退出」置 true：onWindowClose 不再隐藏，放行 destroy。
  bool _exiting = false;

  Future<void> init() async {
    if (_initialized) return;
    _initialized = true;
    windowManager.addListener(this);
    trayManager.addListener(this);
    // 点 X 不再销毁进程，只隐藏窗口后台驻留。
    await windowManager.setPreventClose(true);
    try {
      await trayManager.setIcon(await _resolveIconPath());
      await trayManager.setToolTip("NEXTBOT");
      await trayManager.setContextMenu(Menu(items: _buildMenuItems()));
    } catch (e) {
      debugPrint("[AppTray] init failed: $e");
    }
  }

  List<MenuItem> _buildMenuItems() => <MenuItem>[
        MenuItem(key: _menuKeyShow, label: "显示主窗口"),
        MenuItem.separator(),
        MenuItem(key: _menuKeyExit, label: "退出"),
      ];

  /// 托盘图标文件路径：release 打包后 assets 解包在 exe 同级
  /// data/flutter_assets/ 下；debug 运行 cwd 为项目根，相对路径可直读。
  Future<String> _resolveIconPath() async {
    final String sep = Platform.pathSeparator;
    final String releasePath = "${File(Platform.resolvedExecutable).parent.path}"
        "${sep}data${sep}flutter_assets${sep}assets${sep}tray_icon.ico";
    if (File(releasePath).existsSync()) return releasePath;
    return "assets${sep}tray_icon.ico";
  }

  /// 显示并聚焦主窗口（托盘单击/菜单共用）；最小化状态先还原。
  Future<void> showMainWindow() async {
    try {
      if (await windowManager.isMinimized()) {
        await windowManager.restore();
      }
      await windowManager.show();
      await windowManager.focus();
    } catch (e) {
      debugPrint("[AppTray] showMainWindow failed: $e");
    }
  }

  /// 托盘菜单「退出」：真正结束进程。
  Future<void> exitApp() async {
    _exiting = true;
    try {
      await windowManager.destroy();
    } catch (e) {
      debugPrint("[AppTray] destroy failed: $e");
    }
    // 兜底：窗口销毁后消息循环应自然退出，极端情况下强制结束。
    Future<void>.delayed(const Duration(seconds: 2), () => exit(0));
  }

  // ---- WindowListener ----

  @override
  void onWindowClose() {
    if (_exiting) return;
    windowManager.hide();
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
