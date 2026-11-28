import "dart:async";

import "package:flutter/foundation.dart" show ValueNotifier;

import "agent_sphere_mood_bridge.dart";
import "speech_service.dart";
import "voice_command_processor.dart";
import "voice_wake_service.dart";

/// 3D Agent 语音交互状态（唤醒 + ASR）
class AgentSphereVoiceState {
  const AgentSphereVoiceState({
    this.wakeEnabled = true,
    this.isWaitingWake = false,
    this.isSpeaking = false,
    this.statusText = "正在启动…",
    this.statusDetail = "",
    this.wakeHint = "",
  });

  final bool wakeEnabled;
  final bool isWaitingWake;
  final bool isSpeaking;
  final String statusText;
  final String statusDetail;
  final String wakeHint;

  AgentSphereVoiceState copyWith({
    bool? wakeEnabled,
    bool? isWaitingWake,
    bool? isSpeaking,
    String? statusText,
    String? statusDetail,
    String? wakeHint,
  }) {
    return AgentSphereVoiceState(
      wakeEnabled: wakeEnabled ?? this.wakeEnabled,
      isWaitingWake: isWaitingWake ?? this.isWaitingWake,
      isSpeaking: isSpeaking ?? this.isSpeaking,
      statusText: statusText ?? this.statusText,
      statusDetail: statusDetail ?? this.statusDetail,
      wakeHint: wakeHint ?? this.wakeHint,
    );
  }
}

/// 全屏 3D Agent 语音能力 — 替代原「语音模式」页
class AgentSphereVoiceController {
  AgentSphereVoiceController._();

  static final AgentSphereVoiceController instance =
      AgentSphereVoiceController._();

  final ValueNotifier<AgentSphereVoiceState> state =
      ValueNotifier<AgentSphereVoiceState>(const AgentSphereVoiceState());

  final VoiceCommandProcessor _commandProcessor = VoiceCommandProcessor();
  final VoiceWakeService _wakeService = VoiceWakeService.instance;
  final SpeechService _speechService = SpeechService();

  bool _bootstrapped = false;

  /// 识别到文本后回调（由 main 注入：填入输入框并发送）
  void Function(String text)? onRecognizedText;

  AgentSphereVoiceState get _s => state.value;

  void _emit(AgentSphereVoiceState next) => state.value = next;

  Future<void> bootstrap() async {
    if (_bootstrapped) return;
    _bootstrapped = true;
    _commandProcessor.initializeDefaultCommands();
    AgentSphereMoodBridge.instance.idle();

    if (_s.wakeEnabled) {
      await startWakeListening();
    } else {
      _emit(_s.copyWith(statusText: "点击 Agent 开始说话"));
    }
  }

  Future<void> dispose() async {
    await _wakeService.stop();
    await _speechService.cancel();
    _bootstrapped = false;
  }

  /// 离开聊天页时暂停监听
  Future<void> pauseForBackground() async {
    await _stopWakeListening();
    await _stopListening(resumeWake: false);
  }

  /// 回到聊天页时恢复唤醒
  Future<void> resumeForForeground() async {
    if (!_bootstrapped) {
      await bootstrap();
      return;
    }
    if (_s.wakeEnabled && !_s.isSpeaking) {
      await startWakeListening();
    }
  }

  Future<void> toggleWakeEnabled() async {
    if (_s.wakeEnabled) {
      await _wakeService.stop();
      _emit(_s.copyWith(
        wakeEnabled: false,
        isWaitingWake: false,
        wakeHint: "",
        statusText: _s.isSpeaking ? _s.statusText : "点击 Agent 开始说话",
        statusDetail: _s.isSpeaking ? _s.statusDetail : "语音唤醒已关闭",
      ));
    } else {
      _emit(_s.copyWith(wakeEnabled: true, statusDetail: ""));
      if (!_s.isSpeaking) await startWakeListening();
    }
  }

  Future<void> startWakeListening() async {
    if (_s.isSpeaking || !_s.wakeEnabled) return;

    final bool ok = await _wakeService.start(
      onWake: _onWakeDetected,
      onPartial: (String partial) {
        if (!_s.isWaitingWake) return;
        _emit(_s.copyWith(wakeHint: partial));
      },
    );

    _emit(_s.copyWith(
      isWaitingWake: ok,
      statusText: ok ? "等待唤醒" : "语音唤醒不可用",
      statusDetail: ok
          ? "说「${VoiceWakeService.displayWakePhrase}」开始对话"
          : "请检查麦克风权限，或点击 Agent 说话",
      wakeHint: "",
    ));
    if (ok) AgentSphereMoodBridge.instance.idle();
  }

  Future<void> _stopWakeListening() async {
    await _wakeService.stop();
    _emit(_s.copyWith(isWaitingWake: false, wakeHint: ""));
  }

  void _onWakeDetected() {
    _emit(_s.copyWith(
      isWaitingWake: false,
      wakeHint: "",
      statusText: "已唤醒",
      statusDetail: "",
    ));
    AgentSphereMoodBridge.instance.listening(caption: "唤醒成功");
    unawaited(startVoiceSession(fromWake: true));
  }

  void toggleVoiceSession() {
    if (_s.isSpeaking) {
      unawaited(_stopListening());
    } else {
      unawaited(_stopWakeListening());
      unawaited(startVoiceSession());
    }
  }

  Future<void> startVoiceSession({bool fromWake = false}) async {
    if (_s.isSpeaking) return;
    await _stopWakeListening();
    if (!_s.isSpeaking) {
      unawaited(_beginListening(fromWake: fromWake));
    }
  }

  Future<void> _beginListening({required bool fromWake}) async {
    _emit(_s.copyWith(
      isSpeaking: true,
      statusText: "正在聆听…",
      statusDetail: fromWake ? "请讲" : "",
      wakeHint: "",
    ));
    AgentSphereMoodBridge.instance.listening();

    final bool started = await _speechService.startListening(
      onResult: (String text) {
        if (!_s.isSpeaking) return;
        onRecognizedText?.call(text);
        _commandProcessor.processCommand(text);
      },
      onDone: () {
        if (_s.isSpeaking) unawaited(_stopListening());
      },
      onError: (String message) {
        _emit(_s.copyWith(statusText: "识别失败", statusDetail: message));
        AgentSphereMoodBridge.instance.alert(caption: "识别失败");
        unawaited(_stopListening());
      },
    );

    if (!started && _s.isSpeaking) {
      _emit(_s.copyWith(
        statusText: "语音识别不可用",
        statusDetail: "请检查麦克风权限和系统语音识别服务",
      ));
      AgentSphereMoodBridge.instance.alert(caption: "语音识别不可用");
      await _stopListening();
    }
  }

  Future<void> _stopListening({bool resumeWake = true}) async {
    await _speechService.cancel();
    _emit(_s.copyWith(
      isSpeaking: false,
      statusText: _s.wakeEnabled && resumeWake ? "等待唤醒" : "点击 Agent 开始说话",
      statusDetail: _s.wakeEnabled && resumeWake
          ? "说「${VoiceWakeService.displayWakePhrase}」开始对话"
          : (_s.wakeEnabled ? "" : "语音唤醒已关闭"),
    ));
    AgentSphereMoodBridge.instance.idle();

    if (_s.wakeEnabled && resumeWake) {
      await startWakeListening();
    }
  }
}
