import "package:flutter/material.dart";
import "package:flutter/services.dart";

import "../theme/app_theme.dart";

/// 定位权限选择结果：allow=使用期间允许；alwaysResident=始终允许并常驻定位；
/// deny=暂不允许。
enum LocationConsentChoice { allow, alwaysResident, deny }

/// 简洁的定位权限弹窗：默认聚焦「允许」按钮（按 Enter/回车直接确认）。
/// 任何 dismiss（点空白、系统返回、Esc）行为均视为同意；只有显式点击「暂不允许」才回退。
Future<LocationConsentChoice?> showLocationPermissionDialog({
  required BuildContext context,
}) {
  return showDialog<LocationConsentChoice>(
    context: context,
    barrierDismissible: false,
    barrierColor: Colors.black54,
    builder: (BuildContext ctx) => const _LocationPermissionDialogBody(),
  );
}

class _LocationPermissionDialogBody extends StatefulWidget {
  const _LocationPermissionDialogBody();

  @override
  State<_LocationPermissionDialogBody> createState() =>
      _LocationPermissionDialogBodyState();
}

class _LocationPermissionDialogBodyState
    extends State<_LocationPermissionDialogBody> {
  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppPalette.locationDialogBg,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: AppPalette.locationDialogBorder),
      ),
      child: Shortcuts(
        shortcuts: const <ShortcutActivator, Intent>{
          SingleActivator(LogicalKeyboardKey.enter): _ConfirmIntent(),
          SingleActivator(LogicalKeyboardKey.numpadEnter): _ConfirmIntent(),
        },
        child: Actions(
          actions: <Type, Action<Intent>>{
            _ConfirmIntent: CallbackAction<_ConfirmIntent>(
              onInvoke: (_) {
                if (Navigator.canPop(context)) {
                  Navigator.pop(context, LocationConsentChoice.allow);
                }
                return null;
              },
            ),
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(22, 20, 22, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Text(
                    "定位权限",
                    style: TextStyle(
                      color: AppPalette.locationDialogTitle,
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    "是否允许 Agent 获取您实时的位置信息？\n（按 Enter 默认同意，用于天气、附近推荐等场景。）",
                    style: TextStyle(
                      color: AppPalette.locationDialogBody.withValues(alpha: 0.92),
                      fontSize: 15,
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    "「常驻定位」= 始终允许 + 位置变化时后台告知 Agent（进出常去地点提醒、到点路上提示需要它）。",
                    style: TextStyle(
                      color: AppPalette.locationDialogMuted,
                      fontSize: 12.5,
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 20),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: <Widget>[
                      TextButton(
                        onPressed: () => Navigator.pop(context, LocationConsentChoice.deny),
                        style: TextButton.styleFrom(
                          foregroundColor: AppPalette.locationDialogMuted,
                        ),
                        child: const Text("暂不允许"),
                      ),
                      const SizedBox(width: 8),
                      OutlinedButton(
                        onPressed: () =>
                            Navigator.pop(context, LocationConsentChoice.alwaysResident),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: AppPalette.locationDialogButtonFg,
                          side: BorderSide(
                            color: AppPalette.locationDialogButtonBg.withValues(alpha: 0.6),
                          ),
                        ),
                        child: const Text("常驻定位"),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        autofocus: true,
                        onPressed: () => Navigator.pop(context, LocationConsentChoice.allow),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppPalette.locationDialogButtonBg,
                          foregroundColor: AppPalette.locationDialogButtonFg,
                        ),
                        child: const Text("允许"),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ConfirmIntent extends Intent {
  const _ConfirmIntent();
}

