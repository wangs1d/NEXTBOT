import "dart:async";

import "package:flutter/foundation.dart";
import "package:speech_to_text/speech_to_text.dart" as stt;
import "package:permission_handler/permission_handler.dart";

/// 语音识别服务
class SpeechService {
  static final SpeechService _instance = SpeechService._internal();
  factory SpeechService() => _instance;
  SpeechService._internal();

  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _isListening = false;
  bool _isAvailable = false;
  void Function(String text)? _onResult;
  VoidCallback? _onDone;
  void Function(String message)? _onError;

  bool get isListening => _isListening;

  bool get isAvailable => _isAvailable;

  Future<bool> initialize() async {
    try {
      final status = await Permission.microphone.request();
      if (status != PermissionStatus.granted) {
        debugPrint("麦克风权限被拒绝");
        return false;
      }

      _isAvailable = await _speech.initialize(
        onStatus: (String status) {
          debugPrint("语音识别状态: $status");
          if (status == "done" || status == "notListening") {
            _notifyDone();
          }
        },
        onError: (Object error) {
          debugPrint("语音识别错误: $error");
          _notifyError(error.toString());
        },
      );

      debugPrint("语音识别初始化: $_isAvailable");
      return _isAvailable;
    } catch (e) {
      debugPrint("初始化语音识别失败: $e");
      return false;
    }
  }

  Future<bool> startListening({
    required void Function(String text) onResult,
    VoidCallback? onDone,
    void Function(String message)? onError,
  }) async {
    if (_isListening) await cancel();
    if (!_isAvailable && !await initialize()) {
      debugPrint("语音识别不可用");
      return false;
    }

    _onResult = onResult;
    _onDone = onDone;
    _onError = onError;
    _isListening = true;
    try {
      await _speech.listen(
        onResult: (result) {
          final String text = result.recognizedWords;
          if (result.finalResult && text.isNotEmpty) {
            _completeWithResult(text);
          }
        },
        listenOptions: stt.SpeechListenOptions(
          partialResults: false,
          cancelOnError: true,
          listenMode: stt.ListenMode.dictation,
          listenFor: const Duration(seconds: 30),
          pauseFor: const Duration(seconds: 3),
          localeId: "zh_CN",
        ),
        onSoundLevelChange: (level) {},
      );
      return true;
    } catch (e) {
      _isListening = false;
      _clearCallbacks();
      debugPrint("启动语音识别失败: $e");
      return false;
    }
  }

  Future<void> stopListening() async {
    _clearCallbacks();
    if (_isListening || _speech.isListening) {
      await _speech.stop();
      _isListening = false;
    }
  }

  Future<void> cancel() async {
    _clearCallbacks();
    if (_isListening || _speech.isListening) {
      await _speech.cancel();
      _isListening = false;
    }
  }

  void dispose() {
    _clearCallbacks();
    _isListening = false;
    unawaited(_speech.cancel());
  }

  void _completeWithResult(String text) {
    final void Function(String text)? onResult = _onResult;
    final VoidCallback? onDone = _onDone;
    _clearCallbacks();
    _isListening = false;
    onResult?.call(text);
    onDone?.call();
  }

  void _notifyDone() {
    final VoidCallback? onDone = _onDone;
    _clearCallbacks();
    _isListening = false;
    onDone?.call();
  }

  void _notifyError(String message) {
    final void Function(String message)? onError = _onError;
    _clearCallbacks();
    _isListening = false;
    if (onError != null) {
      onError(message);
    } else {
      debugPrint(message);
    }
  }

  void _clearCallbacks() {
    _onResult = null;
    _onDone = null;
    _onError = null;
  }
}
