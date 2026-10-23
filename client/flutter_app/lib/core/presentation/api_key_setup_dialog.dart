import "package:flutter/material.dart";

import "../services/local_runtime_config.dart";
import "../theme/app_theme.dart";

/// 首启「配置模型服务」对话框（byok 形态）：检测到 config.env 无
/// OPENAI_API_KEY 时引导用户填自己的模型 key，写入 %APPDATA%\Nextbot。
/// 不可关闭（无 key 的 runtime 无法聊天），保存后由调用方重启 runtime。
Future<bool?> showApiKeySetupDialog({required BuildContext context}) {
  return showDialog<bool>(
    context: context,
    barrierDismissible: false,
    barrierColor: Colors.black54,
    builder: (BuildContext ctx) => const _ApiKeySetupDialogBody(),
  );
}

class _ApiKeySetupDialogBody extends StatefulWidget {
  const _ApiKeySetupDialogBody();

  @override
  State<_ApiKeySetupDialogBody> createState() => _ApiKeySetupDialogBodyState();
}

class _ApiKeySetupDialogBodyState extends State<_ApiKeySetupDialogBody> {
  final TextEditingController _keyController = TextEditingController();
  final TextEditingController _baseUrlController = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _keyController.dispose();
    _baseUrlController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final String key = _keyController.text.trim();
    if (key.isEmpty) {
      setState(() => _error = "请填写 API Key");
      return;
    }
    final Map<String, String> existing = LocalRuntimeConfig.readSync();
    final Map<String, String> values = <String, String>{
      ...existing,
      "OPENAI_API_KEY": key,
      if (_baseUrlController.text.trim().isNotEmpty)
        "OPENAI_BASE_URL": _baseUrlController.text.trim(),
    };
    await LocalRuntimeConfig.write(values);
    if (!mounted) return;
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: Dialog(
        backgroundColor: AppPalette.locationDialogBg,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: const BorderSide(color: AppPalette.locationDialogBorder),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 20, 22, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const Text(
                  "配置模型服务",
                  style: TextStyle(
                    color: AppPalette.locationDialogTitle,
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  "填写你自己的大模型 API Key（OpenAI 兼容接口），"
                  "仅保存在本机，对话直连模型服务商。",
                  style: TextStyle(
                    color: AppPalette.locationDialogBody,
                    fontSize: 13,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _keyController,
                  obscureText: true,
                  autofocus: true,
                  style: const TextStyle(
                      color: AppPalette.locationDialogTitle, fontSize: 14),
                  decoration: InputDecoration(
                    labelText: "API Key（必填）",
                    labelStyle: const TextStyle(
                        color: AppPalette.locationDialogMuted, fontSize: 13),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(
                          color: AppPalette.locationDialogBorder),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(
                          color: AppPalette.locationDialogButtonBg),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _baseUrlController,
                  style: const TextStyle(
                      color: AppPalette.locationDialogTitle, fontSize: 14),
                  decoration: InputDecoration(
                    labelText: "API Base URL（选填，如 https://api.deepseek.com/v1）",
                    labelStyle: const TextStyle(
                        color: AppPalette.locationDialogMuted, fontSize: 13),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(
                          color: AppPalette.locationDialogBorder),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(
                          color: AppPalette.locationDialogButtonBg),
                    ),
                  ),
                ),
                if (_error != null) ...<Widget>[
                  const SizedBox(height: 8),
                  Text(
                    _error!,
                    style: const TextStyle(color: Color(0xFFE57373), fontSize: 12),
                  ),
                ],
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: <Widget>[
                    FilledButton(
                      onPressed: _save,
                      style: FilledButton.styleFrom(
                        backgroundColor: AppPalette.locationDialogButtonBg,
                        foregroundColor: AppPalette.locationDialogButtonFg,
                      ),
                      child: const Text("保存并启动"),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
