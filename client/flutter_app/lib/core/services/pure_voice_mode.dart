import "dart:async";

import "package:flutter/foundation.dart";
import "package:window_manager/window_manager.dart";

import "../presentation/dynamic_island.dart";
import "../presentation/glass_notify.dart";
import "agent_sphere_voice_controller.dart";
import "briefing_tts_api.dart";
import "tts_player.dart";
import "voice_duplex_service.dart";
import "../config/api_config.dart";

/// 纯语音模式阶段（岛条目跟随该阶段而非自由映射状态文案）。
enum PureVoicePhase { ambient, thinking, speaking }

/// 纯语音模式控制器 —— 原 voice-orb-py 玻璃胶囊悬浮球的接班人。
///
/// 视觉全部由灵动岛承载，主窗口保持隐藏；语音唤醒回归：
///   1. 进入/退出：hide 主窗 + WS `mode.changed` 上报（服务端把主动消息
///      投递节奏切到语音档，per-actor 内存态，见 server voice-mode-state.ts）；
///   2. 唤醒待命：进入即武装唤醒词监听（小助手/嘿 agent…），岛保持原态
///      （无条目无文案）；只有明确喊了 agent 才开始对话——
///      唤醒命中 → 声纹验证聆听（只有注册声纹才回复）→ 思考中 → 播报中；
///      不出现「已唤醒」提示，唤醒命中直接进入聆听；
///   3. 播报收尾：原生玻璃卡简洁弹窗 + TTS 播报，播完开 10 秒追问窗口
///      （窗口内开口免唤醒，同样过声纹），超时回唤醒待命；
///   4. 语音指令「打开界面」退出回完整界面；对话记录照常落聊天流。
///
/// 对话通路（2026-09-28 起）：
///   - 默认优先 MiniMax 实时语音通道（VoiceDuplexService，/ws/voice-duplex）：
///     识别文本经 `text.turn` 喂服务端端到端 realtime，回复语音整轮回流直接播，
///     会话期内上下文延续；回复**不落聊天流**，文字经播报弹窗呈现。
///     麦克风仍归本地唤醒/声纹/识别所有，无抢麦冲突。
///   - 通道不可用（服务端无 MINIMAX_API_KEY / 连接失败 / 中途断开）时
///     静默回落既有聊天链路（识别文本转交原回调 → 回复落流 → notifyReply 播报）。
///
/// 能力栈全部复用既有服务：唤醒 VoiceWakeService、声纹 ASR
/// MultimodalRecognitionService（经 AgentSphereVoiceController 编排，
/// 验证通过才回调识别文本）、播报 TtsPlayer。
/// 3D 球体/桌宠悬浮球/球上字幕不受影响。
class PureVoiceModeController {
  PureVoiceModeController._();

  static final PureVoiceModeController instance = PureVoiceModeController._();

  /// 是否处于纯语音模式（主窗口隐藏、岛为唯一视觉）。
  final ValueNotifier<bool> isActive = ValueNotifier<bool>(false);

  /// WS 发送器由 main 注入（避免直接依赖 WS 客户端单例）。
  void Function(String type, Map<String, dynamic> payload)? sendEvent;

  PureVoicePhase _phase = PureVoicePhase.ambient;
  void Function(String)? _originalOnRecognized;
  Timer? _followUpTimer;
  Timer? _submitSafetyTimer;
  Timer? _transientEntryTimer;
  bool _duplexActive = false;
  static const List<String> _exitPhrases = <String>[
    "打开界面",
    "打开主界面",
    "退出语音",
  ];

  AgentSphereVoiceController get _voice => AgentSphereVoiceController.instance;

  /// 进入纯语音模式（侧边栏用户菜单「纯语音模式」）。
  ///
  /// 声纹未注册时先现身主窗走注册页（不进语音模式，注册完再进）；
  /// 已注册则隐藏主窗并武装唤醒监听——岛保持原态，喊了才对话。
  Future<void> enter() async {
    if (isActive.value) return;
    await _voice.bootstrap(); // 幂等：聊天页可能已初始化过
    if (!_voice.state.value.isVoiceprintRegistered) {
      // 声纹未注册：主窗现身走既有注册页流程（隐藏窗口里弹页看不见），
      // 注册完成 markVoiceprintRegistered 会自动武装唤醒监听，再进本模式。
      unawaited(windowManager.show());
      unawaited(windowManager.focus());
      _voice.startVoiceSession(); // 未注册分支 → onRequestVoiceprintRegistration
      return;
    }

    isActive.value = true;
    _phase = PureVoicePhase.ambient;

    // 语音模式独占：非语音条目停泊（不抢屏打断「岛=唯一视觉」），
    // 退出时按原顺序放行回常规仲裁。
    DynamicIslandController.instance.setVoiceExclusive(true);

    _originalOnRecognized = _voice.onRecognizedText;
    _voice.onRecognizedText = _onVoiceText;
    _voice.state.addListener(_onVoiceStateChanged);

    sendEvent?.call("mode.changed", <String, dynamic>{
      "active": true,
      "source": "client_island",
    });
    DynamicIslandLauncher.instance.setVoiceTalkMode(true);
    await windowManager.hide();

    // 岛上对话依赖唤醒词触发；被用户关过则重新打开。
    if (!_voice.state.value.wakeEnabled) {
      await _voice.toggleWakeEnabled();
    }
    await _voice.startWakeListening();

    // MiniMax 实时语音通道：连上后对话改走 text.turn → 语音整轮回流。
    // 麦克风仍归本地唤醒/声纹/识别；连不上静默回落聊天链路。
    final bool duplexOk = await VoiceDuplexService.instance.start(
      actorId: ApiConfig.effectiveActorId,
    );
    if (duplexOk) {
      _duplexActive = true;
      _wireDuplexCallbacks();
      IslandRealFeeds.setVoiceEntry(title: "实时语音", trailing: "已连接，直接说话");
      _transientEntryTimer?.cancel();
      _transientEntryTimer = Timer(const Duration(seconds: 3), () {
        if (isActive.value && _phase == PureVoicePhase.ambient) {
          IslandRealFeeds.dismissVoice(); // 回唤醒待命原态
        }
      });
    }
  }

  /// 退出纯语音模式，回完整界面（岛条目撤下、识别回调还原）。
  Future<void> exit() async {
    if (!isActive.value) return;
    isActive.value = false;
    _followUpTimer?.cancel();
    _submitSafetyTimer?.cancel();
    _transientEntryTimer?.cancel();
    _duplexActive = false;
    VoiceDuplexService.instance.onTurnCompleted = null;
    VoiceDuplexService.instance.onError = null;
    VoiceDuplexService.instance.onConnectionLost = null;
    unawaited(VoiceDuplexService.instance.stop());
    _voice.state.removeListener(_onVoiceStateChanged);
    _voice.onRecognizedText = _originalOnRecognized;
    _originalOnRecognized = null;
    DynamicIslandLauncher.instance.setVoiceTalkMode(false);
    if (_voice.state.value.isSpeaking) {
      _voice.toggleVoiceSession(); // 停聆听（内部自动恢复唤醒监听）
    }
    // 先关独占（停泊条目放行回队列），再撤语音条目——
    // dismiss('voice') 的 FIFO 会让停泊的第一条自然顶上来。
    DynamicIslandController.instance.setVoiceExclusive(false);
    IslandRealFeeds.dismissVoice();
    sendEvent?.call("mode.changed", <String, dynamic>{
      "active": false,
      "source": "client_island",
    });
    await windowManager.show();
    unawaited(windowManager.focus());
  }

  /// 回复收尾钩子（main.dart chat.assistant_done 落聊天流后调用）。
  /// 简洁弹窗 + TTS 播报，播完开 10 秒追问窗口。
  Future<void> notifyReply(String replyText) async {
    if (!isActive.value) return;
    _submitSafetyTimer?.cancel();
    final String snippet =
        replyText.trim().isEmpty ? "（本轮无文字回复）" : replyText.trim();
    _phase = PureVoicePhase.speaking;
    IslandRealFeeds.setVoiceEntry(title: "播报中", trailing: "回复已落聊天流");
    unawaited(_showReplyPopup(snippet));
    await _speak(_speakableText(snippet));
    _startFollowUpWindow();
  }

  // ── 实时语音通路 ──

  /// 挂接实时语音回调（enter 成功连上后调用；exit 时清空）。
  void _wireDuplexCallbacks() {
    VoiceDuplexService.instance
      ..onTurnCompleted = _onDuplexTurnCompleted
      ..onError = (String message, bool recoverable) {
        if (!isActive.value || !_duplexActive) return;
        IslandRealFeeds.setVoiceEntry(title: "语音链路异常", trailing: recoverable ? "请再说一遍" : "即将回落常规链路");
        _transientEntryTimer?.cancel();
        _transientEntryTimer = Timer(const Duration(seconds: 4), () {
          if (isActive.value && _phase == PureVoicePhase.ambient) {
            IslandRealFeeds.dismissVoice();
          }
        });
        if (!recoverable) {
          _fallbackFromDuplex();
        }
      }
      ..onConnectionLost = () {
        if (!isActive.value) return;
        _fallbackFromDuplex();
      };
  }

  /// realtime 回合完成：弹窗呈现回复文字（语音已由 tts.chunk 回流直接播），
  /// 播完再开追问窗口——否则扬声器声音会被本地识别当成人声。
  void _onDuplexTurnCompleted(String userText, String assistantText) {
    if (!isActive.value || !_duplexActive) return;
    _submitSafetyTimer?.cancel();
    _phase = PureVoicePhase.speaking;
    IslandRealFeeds.setVoiceEntry(title: "播报中", trailing: "实时语音");
    unawaited(_showReplyPopup(
      assistantText.trim().isEmpty ? "（本轮无文字回复）" : assistantText.trim(),
    ));
    unawaited(() async {
      await VoiceDuplexService.instance.waitPlayback();
      _startFollowUpWindow();
    }());
  }

  /// 实时语音通道失效：断开并静默回落聊天链路（后续识别文本照常落聊天流）。
  void _fallbackFromDuplex() {
    if (!_duplexActive) return;
    _duplexActive = false;
    unawaited(VoiceDuplexService.instance.stop());
    _submitSafetyTimer?.cancel();
    if (_phase == PureVoicePhase.thinking) {
      _phase = PureVoicePhase.ambient;
    }
    IslandRealFeeds.setVoiceEntry(title: "实时语音已断开", trailing: "回落常规链路");
    _transientEntryTimer?.cancel();
    _transientEntryTimer = Timer(const Duration(seconds: 4), () {
      if (isActive.value && _phase == PureVoicePhase.ambient) {
        IslandRealFeeds.dismissVoice();
      }
    });
  }

  // ── 内部 ──

  /// 识别文本接管（声纹验证通过才会回调）：退出指令截胡；其余置「思考中」
  /// 并转交原回调（填输入框 + 发送，对话记录照常落聊天流）。
  void _onVoiceText(String text) {
    final String t = text.trim();
    final String normalized = t.replaceAll("。", "").replaceAll("，", "");
    for (final String phrase in _exitPhrases) {
      if (normalized == phrase) {
        unawaited(exit());
        return;
      }
    }
    if (t.isEmpty) return;
    _followUpTimer?.cancel();

    // 实时语音通路：识别文本直接喂 MiniMax realtime，回复语音整轮回流。
    if (_duplexActive) {
      _phase = PureVoicePhase.thinking;
      IslandRealFeeds.setVoiceEntry(title: "思考中", spinning: true);
      // 识别会话收尾（内部自动恢复唤醒监听）；realtime 服务端回合超时 45s。
      if (_voice.state.value.isSpeaking) {
        _voice.toggleVoiceSession();
      }
      unawaited(() async {
        final bool queued = await VoiceDuplexService.instance.sendTextTurn(t);
        if (!queued) {
          // 连接已失效：回落常规聊天链路（本轮文本继续走原路）
          _fallbackFromDuplex();
          _originalOnRecognized?.call(text);
          return;
        }
        _submitSafetyTimer?.cancel();
        _submitSafetyTimer = Timer(const Duration(seconds: 60), () {
          if (!isActive.value) return;
          if (_phase == PureVoicePhase.thinking) {
            _phase = PureVoicePhase.ambient;
            IslandRealFeeds.dismissVoice(); // 回唤醒待命原态
          }
        });
      }());
      return;
    }

    _phase = PureVoicePhase.thinking;
    IslandRealFeeds.setVoiceEntry(title: "思考中", spinning: true);
    // 识别会话收尾（内部自动恢复唤醒监听）；回复超时兜底 120s 回唤醒待命。
    if (_voice.state.value.isSpeaking) {
      _voice.toggleVoiceSession();
    }
    _submitSafetyTimer?.cancel();
    _submitSafetyTimer = Timer(const Duration(seconds: 120), () {
      if (!isActive.value) return;
      if (_phase == PureVoicePhase.thinking) {
        _phase = PureVoicePhase.ambient;
        IslandRealFeeds.dismissVoice(); // 回唤醒待命原态
      }
    });
    _originalOnRecognized?.call(text);
  }

  /// 语音控制器状态 → 岛条目（thinking/speaking 阶段由各自流程接管，不映射）。
  ///
  /// 语音唤醒语义：唤醒命中不出现「已唤醒」提示，直接以「正在聆听」呈现；
  /// 等待唤醒（会话收束）回原态——唤醒监听由共享控制器自动恢复；
  /// 声纹拒绝上岛明示「不回复」并退回唤醒待命。
  void _onVoiceStateChanged() {
    if (!isActive.value || _phase != PureVoicePhase.ambient) return;
    final AgentSphereVoiceState s = _voice.state.value;
    if (s.statusText.contains("聆听")) {
      IslandRealFeeds.setVoiceEntry(
        title: "正在聆听",
        spinning: true,
        trailing: "请讲",
      );
    } else if (s.statusText.contains("等待唤醒")) {
      IslandRealFeeds.dismissVoice(); // 回唤醒待命原态
    } else if (s.statusText.contains("失败") ||
        s.statusText.contains("错误") ||
        s.statusText.contains("拒绝")) {
      // 声纹未通过/识别错误：明示不回复，停会话退回唤醒待命
      // （toggleVoiceSession 内部自动恢复唤醒监听）。
      IslandRealFeeds.setVoiceEntry(
        title: s.statusText,
        trailing: "仅注册声纹可对话",
      );
      if (s.isSpeaking) {
        _voice.toggleVoiceSession();
      }
      _transientEntryTimer?.cancel();
      _transientEntryTimer = Timer(const Duration(seconds: 4), () {
        if (isActive.value && _phase == PureVoicePhase.ambient) {
          IslandRealFeeds.dismissVoice();
        }
      });
    }
    // 「已唤醒」「验证通过」不加提示：唤醒命中直接进入聆听状态条目。
  }

  /// 追问窗口：播完立即重开声纹聆听（窗口内开口免唤醒词，同样过声纹），
  /// 10 秒无人接话自动收起回唤醒待命。
  void _startFollowUpWindow() {
    _followUpTimer?.cancel();
    if (!isActive.value) return;
    _phase = PureVoicePhase.ambient;
    _voice.startVoiceSession();
    _followUpTimer = Timer(const Duration(seconds: 10), () {
      if (!isActive.value) return;
      final AgentSphereVoiceState s = _voice.state.value;
      if (s.isSpeaking && s.statusText.contains("聆听")) {
        _voice.toggleVoiceSession(); // 无人接话 → 内部恢复唤醒监听 → 回原态
      }
    });
  }

  /// TTS 播报（复用简报 TTS 端点，经 BriefingTtsApi 取音频后直接播）。
  Future<void> _speak(String text) async {
    final String? base64Audio = await BriefingTtsApi.fetchSpeech(
      text,
      timeout: const Duration(seconds: 20),
    );
    if (base64Audio == null) return;
    await TtsPlayer.instance.playFromBase64(base64Audio);
  }

  /// 简洁回复弹窗（应用内玻璃卡）：长文截断预览，12 秒自动关闭；
  /// 完整内容已落聊天流，主窗口打开后可见。
  Future<void> _showReplyPopup(String text) async {
    final String compact =
        text.length > 260 ? "${text.substring(0, 260)}…" : text;
    GlassNotify.show(
      title: "Agent 回复",
      message: compact,
      variant: GlassNotifyVariant.info,
      duration: const Duration(milliseconds: 12000),
    );
  }

  /// TTS 喂给朗读端的口语化清洗：剥代码块/表格/常见 markdown 标记。
  String _speakableText(String text) {
    String t = text;
    t = t.replaceAll(RegExp(r"```[\s\S]*?```"), " 代码略。 ");
    t = t.replaceAll(RegExp(r"\|"), "，");
    t = t.replaceAll(RegExp(r"[*#>`_~\[\]]"), "");
    t = t.replaceAll(RegExp(r"\n{2,}"), "。");
    return t;
  }
}
