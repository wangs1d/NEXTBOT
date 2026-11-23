import "package:flutter/material.dart";

import "../core/models/chat_models.dart";
import "mobile_theme.dart";

/// 主动消息的「为什么是现在」长按面板（需求 §3.10 可解释，2026-11-23）。
///
/// 一句人话 + 一个能动手的出口：解释文本来自服务端 explainTiming（随载荷
/// `why` 下发，客户端绝不自己拼引擎 token）；「以后少一点」不在面板里做
/// 第二套设置——它把用户带去既有设置页的「主动性」分区（三档频率唯一真源）。
///
/// 复用旁聊菜单同款的 showModalBottomSheet + MobileTheme surface 形态
/// （mobile_ui 现有底部卡样式），不引入新弹层框架。

/// 面板里展示的那句话：取消息携带的 `why`。
/// 普通聊天 / 服务端未解释的主动消息返回 null（长按保持无害）。
String? proactiveWhyLine(ChatMessage m) {
  final String w = (m.why ?? "").trim();
  return w.isEmpty ? null : w;
}

/// 面板标题与动作行文案（常量出口，单测锁措辞）。
const String kProactiveWhyTitle = "为什么是现在";

/// 主行动文案：语义是「降频」，落点是既有频率档设置。
const String kProactiveWhyLessOften = "以后少一点";

const String kProactiveWhyLessOftenHint = "去「设置 · 主动性」换个更安静的档";

/// 弹出「为什么是现在」底部面板。
///
/// [onOpenFrequencySettings] 由调用方注入（跳设置页是宿主的路由职责，
/// 面板本身只管说清这一句话），点动作行时先收面板再执行。
Future<void> showProactiveWhySheet(
  BuildContext context, {
  required String why,
  VoidCallback? onOpenFrequencySettings,
}) {
  final MobilePalette p = MobileTheme.of(context);
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: p.surface,
    showDragHandle: true,
    builder: (BuildContext sheetContext) {
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 2, 20, 14),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                kProactiveWhyTitle,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: p.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                why,
                style: TextStyle(
                  fontSize: 14,
                  height: 1.5,
                  color: p.textSecondary,
                ),
              ),
              const SizedBox(height: 6),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.tune, size: 22, color: p.textPrimary),
                title: Text(
                  kProactiveWhyLessOften,
                  style: TextStyle(fontSize: 14, color: p.textPrimary),
                ),
                subtitle: Text(
                  kProactiveWhyLessOftenHint,
                  style: TextStyle(fontSize: 12, color: p.textMuted),
                ),
                trailing: Icon(Icons.chevron_right, size: 20, color: p.textMuted),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  onOpenFrequencySettings?.call();
                },
              ),
            ],
          ),
        ),
      );
    },
  );
}
