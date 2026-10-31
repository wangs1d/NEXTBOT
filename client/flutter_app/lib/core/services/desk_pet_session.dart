import "dart:async" show unawaited;
import "dart:io";

import "package:flutter/foundation.dart";

import "desk_pet_preference.dart";
import "sphere_entity_controller.dart";
import "sphere_overlay_launcher.dart";

/// 桌宠会话：默认隐藏，用户点击“召唤桌宠”后才显示。
class DeskPetSession extends ChangeNotifier {
  DeskPetSession._() {
    // 桌宠进程自己退出（崩溃/被杀）时，页脚按钮要跟着回到「召唤桌宠」。
    SphereOverlayLauncher.overlayActive.addListener(_onOverlayActiveChanged);
  }

  static final DeskPetSession instance = DeskPetSession._();

  bool _summoned = false;
  bool _bootstrapping = false;
  String? _error;

  bool get isSummoned => _summoned;
  bool get isBootstrapping => _bootstrapping;
  String? get error => _error;

  static bool get isSupported => kIsWeb || (!kIsWeb && Platform.isWindows);

  Future<bool> summon() async {
    if (!isSupported) {
      _error = "当前平台不支持桌宠。";
      notifyListeners();
      return false;
    }

    _bootstrapping = true;
    _error = null;
    notifyListeners();

    if (kIsWeb) {
      _summoned = true;
      _bootstrapping = false;
      notifyListeners();
      return true;
    }

    final String? setupIssue = SphereOverlayLauncher.overlayUnavailableReason;
    if (setupIssue != null) {
      _bootstrapping = false;
      _error = setupIssue;
      notifyListeners();
      return false;
    }

    final bool ok = await launchOverlayDeskPet();
    if (!_bootstrapping) return false; // 等待首帧期间用户已收起，不再改状态或报错
    _bootstrapping = false;
    if (!ok) {
      _error ??= SphereOverlayLauncher.overlayUnavailableReason ?? "桌宠启动失败";
      notifyListeners();
      return false;
    }

    unawaited(DeskPetPreference.saveSummoned(true));
    return true;
  }

  /// 上次会话桌宠开着 → 启动后自动恢复；从没召唤过则什么都不做。
  Future<void> restoreIfSummonedLastSession() async {
    if (!DeskPetPreference.isSupported) return;
    if (_summoned || _bootstrapping) return;
    if (!await DeskPetPreference.loadSummoned()) return;
    await summon();
  }

  void _onOverlayActiveChanged() {
    if (SphereOverlayLauncher.overlayActive.value || !_summoned) return;
    _summoned = false;
    _bootstrapping = false;
    unawaited(DeskPetPreference.saveSummoned(false));
    notifyListeners();
  }

  Future<void> dismiss() async {
    if (!_summoned && !_bootstrapping) return;

    _summoned = false;
    _bootstrapping = false;
    _error = null;
    unawaited(DeskPetPreference.saveSummoned(false));
    // 先让页脚回到「召唤桌宠」：桌宠进程自己收尾要几百毫秒
    notifyListeners();

    if (!kIsWeb && Platform.isWindows) {
      // 常驻桌宠只收窗口，进程留给下一次召唤；空闲超时由桌宠自己退出
      await SphereOverlayLauncher.hideOverlay();
      SphereEntityController.instance.reset();
    }
  }

  /// Windows 独立桌宠：默认直接使用 PySide6 (sphere-overlay-py) 透明桌宠窗口。
  Future<bool> launchOverlayDeskPet() async {
    if (kIsWeb || !Platform.isWindows) return false;

    final bool ok = await SphereOverlayLauncher.launchOverlay();
    if (ok) {
      _summoned = true;
      SphereEntityController.instance.markElectronReady();
      notifyListeners();
      return true;
    }

    _error = SphereOverlayLauncher.lastLaunchError ??
        SphereOverlayLauncher.overlayUnavailableReason ??
        "桌宠启动失败\n请确认 sphere-overlay-py 依赖已安装（python -m pip install -r requirements.txt），且 agent-sphere-avatar 已执行 npm run build。";
    notifyListeners();
    return false;
  }
}
