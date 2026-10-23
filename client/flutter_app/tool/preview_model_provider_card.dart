// 模型接入卡片预览（免 build 取证）：flutter run -d windows -t tool/preview_model_provider_card.dart
//
// 左栏：首启向导深色语言（与 onboarding 步骤 4 同款配色/排版，深色 Theme 子树）；
// 右栏：设置页浅色语言（与设置「模型服务」卡同款，浅色 Theme 子树）。
// 引导默认展开（initiallyGuideOpen）便于截图核对内容。
import "package:flutter/material.dart";
import "package:window_manager/window_manager.dart";

import "package:nextbot/features/model_config/model_provider_card.dart";
import "package:nextbot/features/model_config/model_provider_catalog.dart";

Future<void> _noopSave(ModelConfigDraft draft) async {}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  windowManager.waitUntilReadyToShow(
    const WindowOptions(
      size: Size(1400, 960),
      minimumSize: Size(900, 600),
      title: "模型接入卡片预览",
    ),
    () async {
      windowManager.show();
      windowManager.focus();
    },
  );
  runApp(const _PreviewApp());
}

class _PreviewApp extends StatelessWidget {
  const _PreviewApp();

  static const ModelProviderCardColors darkColors = ModelProviderCardColors(
    fieldBg: Color(0xFF141414),
    fieldBorder: Color(0xFF232323),
    focusedBorder: Color(0x80FFFFFF),
    textPrimary: Color(0xFFF2F2F2),
    textSecondary: Color(0xFF9B9B9B),
    textMuted: Color(0xFF6B6B6B),
    error: Color(0xFFF2604E),
  );

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "模型接入卡片预览",
      debugShowCheckedModeBanner: false,
      theme: ThemeData(brightness: Brightness.light, useMaterial3: true),
      home: Scaffold(
        backgroundColor: const Color(0xFF0B0B0B),
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // ① 首启向导（深色 Theme 子树）
            Expanded(
              child: Theme(
                data: ThemeData(
                  brightness: Brightness.dark,
                  useMaterial3: true,
                  scaffoldBackgroundColor: Colors.black,
                  colorScheme: ColorScheme.fromSeed(seedColor: Colors.white, brightness: Brightness.dark),
                ),
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(24),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 560),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          const _Label("① 首启向导 · 步骤 4（深色）", Color(0xFF9B9B9B)),
                          const SizedBox(height: 8),
                          const Text("接入你的模型",
                              style: TextStyle(color: Color(0xFFF2F2F2), fontSize: 26, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 8),
                          const Text("选一个模型服务商，按引导拿到 API Key 填进来，我才有大脑。数据只存在这台电脑上。",
                              style: TextStyle(color: Color(0xFF9B9B9B), fontSize: 13.5, height: 1.6)),
                          const SizedBox(height: 24),
                          const ModelProviderCard(
                            saveLabel: "保存并完成",
                            initiallyGuideOpen: true,
                            onSave: _noopSave,
                            colors: darkColors,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const VerticalDivider(width: 1, thickness: 1, color: Color(0xFF2A2A2A)),
            // ② 设置页（浅色 Theme 子树）
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 760),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        const _Label("② 设置页 · 模型服务（浅色，已配置 DeepSeek 回显）", Color(0xFF888888)),
                        const SizedBox(height: 8),
                        Card(
                          margin: EdgeInsets.zero,
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: <Widget>[
                                Row(
                                  children: <Widget>[
                                    const Icon(Icons.memory_outlined, size: 18),
                                    const SizedBox(width: 8),
                                    Text("模型服务", style: Theme.of(context).textTheme.titleMedium),
                                  ],
                                ),
                                const SizedBox(height: 6),
                                Text("选模型服务商，按引导获取 API Key 后填入。仅保存在本机，保存后自动重启本地引擎生效。",
                                    style: Theme.of(context).textTheme.bodySmall),
                                const SizedBox(height: 14),
                                const ModelProviderCard(
                                  initialBaseUrl: "https://api.deepseek.com",
                                  initialApiKey: "sk-demo-1234567890abcdef",
                                  initiallyGuideOpen: true,
                                  onSave: _noopSave,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text, this.color);

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text(text, textAlign: TextAlign.center, style: TextStyle(color: color, fontSize: 13));
  }
}
