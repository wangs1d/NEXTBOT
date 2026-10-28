import "package:flutter/material.dart";

import "../config/api_config.dart";
import "../theme/app_theme.dart";

/// 编译期烤入是否完整；出错时返回给用户看的文案，正常返回 null。
///
/// 根 State 的字段初始化里直接读 [ApiConfig.httpBase]/[ApiConfig.wsUrl]，漏烤时
/// 异常在 element 挂载阶段抛出，整棵树挂不上——Release 的 ErrorWidget 是无文字
/// 灰块，用户只看到白屏。故在 runApp 前主动探测一次，换成一屏可读提示。
String? detectBootConfigError() {
  try {
    final String base = ApiConfig.httpBase;
    final String ws = ApiConfig.wsUrl;
    if (base.isEmpty || ws.isEmpty) {
      return "客户端烤入的后端地址为空（HTTP_BASE / WS_URL）。";
    }
    return null;
  } on StateError catch (e) {
    return e.message;
  }
}

/// 配置错误的整屏提示：把打包命令原样交给用户，避免白屏无线索。
class ConfigErrorApp extends StatelessWidget {
  const ConfigErrorApp({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "NEXTBOT",
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: AppPalette.mainPanel,
        colorScheme: ColorScheme.fromSeed(
          seedColor: AppPalette.mainPanel,
          brightness: Brightness.dark,
        ),
      ),
      home: Scaffold(
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 620),
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    "客户端打包配置错误",
                    style: TextStyle(
                      color: AppPalette.appBarForeground,
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 16),
                  SelectableText(
                    message,
                    style: const TextStyle(
                      color: AppPalette.locationDialogBody,
                      fontSize: 14,
                      height: 1.7,
                    ),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    "这是打包时漏烤地址，不是网络问题：本机服务是否在跑都与之无关，"
                    "按上面的命令重新出包即可恢复。",
                    style: TextStyle(
                      color: AppPalette.locationDialogMuted,
                      fontSize: 13,
                      height: 1.6,
                    ),
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
