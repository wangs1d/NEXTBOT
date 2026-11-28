import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";

import "sphere_overlay_launcher.dart";

typedef AgentSpherePatchListener = void Function(AgentSpherePatch patch);
typedef AgentSphereFocusListener = void Function();
typedef AgentSphereMessageListener = void Function(Map<String, dynamic> message);

/// Agent 3D 形象状态 — 与 overlay 桌宠 / agent.embodiment.patch 对齐
class AgentSpherePatch {
  const AgentSpherePatch({
    this.mood,
    this.energy,
    this.caption,
    this.clearCaption = false,
    this.phase,
    this.subAgentType,
    this.subAgentDisplayName,
    this.source,
  });

  final String? mood;
  final double? energy;
  final String? caption;
  final bool clearCaption;
  final String? phase;
  final String? subAgentType;
  final String? subAgentDisplayName;
  final String? source;

  Map<String, dynamic> toJson() => <String, dynamic>{
        "type": "agent-sphere:patch",
        if (mood != null) "mood": mood,
        if (energy != null) "energy": energy,
        if (clearCaption) "caption": null else if (caption != null) "caption": caption,
        if (phase != null) "phase": phase,
        if (subAgentType != null) "subAgentType": subAgentType,
        if (subAgentDisplayName != null) "subAgentDisplayName": subAgentDisplayName,
        if (source != null) "source": source,
      };
}

/// 统一驱动聊天页 WebView 与桌面悬浮 Agent 的表情状态
class AgentSphereMoodBridge {
  AgentSphereMoodBridge._();

  static final AgentSphereMoodBridge instance = AgentSphereMoodBridge._();

  final List<AgentSpherePatchListener> _listeners = <AgentSpherePatchListener>[];
  final List<AgentSphereFocusListener> _focusListeners = <AgentSphereFocusListener>[];
  final List<AgentSphereMessageListener> _messageListeners = <AgentSphereMessageListener>[];
  double _speakingEnergy = 0.45;

  void addListener(AgentSpherePatchListener listener) {
    if (!_listeners.contains(listener)) _listeners.add(listener);
  }

  void removeListener(AgentSpherePatchListener listener) {
    _listeners.remove(listener);
  }

  void addFocusListener(AgentSphereFocusListener listener) {
    if (!_focusListeners.contains(listener)) _focusListeners.add(listener);
  }

  void removeFocusListener(AgentSphereFocusListener listener) {
    _focusListeners.remove(listener);
  }

  void addMessageListener(AgentSphereMessageListener listener) {
    if (!_messageListeners.contains(listener)) _messageListeners.add(listener);
  }

  void removeMessageListener(AgentSphereMessageListener listener) {
    _messageListeners.remove(listener);
  }

  void forwardMessage(Map<String, dynamic> message) {
    for (final AgentSphereMessageListener listener
        in List<AgentSphereMessageListener>.from(_messageListeners)) {
      listener(message);
    }
  }

  void requestChatFocus() {
    for (final AgentSphereFocusListener listener in List<AgentSphereFocusListener>.from(_focusListeners)) {
      listener();
    }
  }

  void patch(AgentSpherePatch patch) {
    for (final AgentSpherePatchListener listener in List<AgentSpherePatchListener>.from(_listeners)) {
      listener(patch);
    }
    if (!kIsWeb && Platform.isWindows) {
      unawaited(SphereOverlayLauncher.patchMood(patch));
    }
  }

  void applyEmbodimentPatch(AgentSpherePatch patch) {
    if (patch.mood == "speaking" && patch.energy != null) {
      _speakingEnergy = patch.energy!;
    }
    if (patch.mood == "happy") {
      happy();
      return;
    }
    this.patch(patch);
  }

  void listening({String caption = "正在聆听…"}) {
    _speakingEnergy = 0.45;
    patch(AgentSpherePatch(mood: "listening", energy: 0.65, caption: caption, source: "user_message"));
  }

  void thinking({
    String? caption,
    String? phase,
    String? subAgentType,
    String? subAgentDisplayName,
  }) {
    final bool isDelegate = phase?.startsWith("delegate") ?? false;
    patch(AgentSpherePatch(
      mood: "thinking",
      energy: isDelegate ? 0.78 : 0.72,
      caption: caption,
      phase: phase,
      subAgentType: subAgentType,
      subAgentDisplayName: subAgentDisplayName,
      source: "agent_status",
    ));
  }

  void speaking({String? caption}) {
    _speakingEnergy = (_speakingEnergy + 0.025).clamp(0.45, 1.0);
    patch(AgentSpherePatch(
      mood: "speaking",
      energy: _speakingEnergy,
      caption: caption,
      source: "assistant_chunk",
    ));
  }

  void idle() {
    _speakingEnergy = 0.45;
    patch(const AgentSpherePatch(mood: "idle", energy: 0.5, clearCaption: true, source: "idle"));
  }

  void happy() {
    patch(const AgentSpherePatch(mood: "happy", energy: 0.55, clearCaption: true, source: "assistant_done"));
    Future<void>.delayed(const Duration(milliseconds: 1800), idle);
  }

  void alert({required String caption, String? source}) {
    patch(AgentSpherePatch(mood: "alert", energy: 0.85, caption: caption, source: source ?? "alert"));
  }
}
