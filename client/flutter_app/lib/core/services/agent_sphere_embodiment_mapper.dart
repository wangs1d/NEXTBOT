import "agent_sphere_mood_bridge.dart";
import "../utils/assistant_text_sanitizer.dart";

/// 将服务端 WS 事件映射为 Agent 球形形象 patch（与 agent-sphere-avatar/ws-agent-mapper 对齐）
class AgentSphereEmbodimentMapper {
  AgentSphereEmbodimentMapper._();

  static double _speakingEnergy = 0.45;
  static int _speakingChunkCount = 0;
  static final AssistantTextSanitizer _chunkSanitizer =
      AssistantTextSanitizer();

  static void resetSpeakingState() {
    _speakingEnergy = 0.45;
    _speakingChunkCount = 0;
    _chunkSanitizer.reset();
  }

  static AgentSpherePatch? mapWsEvent(String type, Map<String, dynamic> payload) {
    if (type == "agent.embodiment.patch") {
      return _fromEmbodiment(payload);
    }

    if (type == "agent.embodiment.command") {
      return null;
    }

    switch (type) {
      case "chat.agent_status":
        final String line = payload["line"]?.toString().trim() ?? "";
        if (line.isEmpty) return null;
        final String phase = payload["phase"]?.toString() ?? "";
        final bool isDelegate = phase.startsWith("delegate");
        return AgentSpherePatch(
          mood: "thinking",
          energy: isDelegate ? 0.78 : 0.72,
          caption: line,
          phase: phase.isEmpty ? null : phase,
          subAgentType: payload["agentType"]?.toString(),
          subAgentDisplayName: payload["subAgentDisplayName"]?.toString(),
          source: "agent_status",
        );
      case "tool.call":
        final String line = _firstNonEmpty(<String?>[
          payload["userStatusLine"]?.toString().trim(),
          payload["assistantPreamble"]?.toString().trim(),
          payload["toolName"]?.toString().trim(),
        ]);
        return AgentSpherePatch(
          mood: "thinking",
          energy: 0.68,
          caption: line.isEmpty ? "工具执行中" : line,
          source: "tool",
        );
      // 语音数据帧与旧的显示帧共用「说话中」形象：打字机退役后，
      // 模型仍在流式生成，球体呼吸/字幕不该跟着一起停。
      case "chat.assistant_chunk":
      case "chat.assistant_speech":
        final String chunk =
            _chunkSanitizer.ingest(payload["chunk"]?.toString() ?? "");
        if (chunk.isEmpty) return null;
        _speakingChunkCount += 1;
        _speakingEnergy = (0.45 + _speakingChunkCount * 0.015).clamp(0.45, 1.0);
        return AgentSpherePatch(
          mood: "speaking",
          energy: _speakingEnergy,
          caption: chunk.length > 24 ? chunk.substring(chunk.length - 24) : chunk,
          source: "assistant_chunk",
        );
      case "chat.assistant_done":
        resetSpeakingState();
        return const AgentSpherePatch(mood: "happy", energy: 0.55, clearCaption: true, source: "assistant_done");
      case "error.event":
        resetSpeakingState();
        return AgentSpherePatch(
          mood: "alert",
          energy: 0.85,
          caption: payload["message"]?.toString() ?? "错误",
          source: "error",
        );
      case "schedule.reminder_fired":
        final String msg = payload["message"]?.toString().trim() ??
            payload["title"]?.toString().trim() ??
            "提醒";
        return AgentSpherePatch(mood: "alert", energy: 0.9, caption: msg, source: "reminder");
      case "schedule.agent_task_fired":
        final String title = payload["title"]?.toString().trim() ?? "自动化任务";
        return AgentSpherePatch(
          mood: "thinking",
          energy: 0.75,
          caption: title,
          phase: "agent_task",
          source: "agent_task",
        );
      case "agent.voice.incoming":
        return const AgentSpherePatch(mood: "alert", energy: 0.9, caption: "Agent 来电", source: "phone");
      case "agent.peer_message":
        final String preview = (payload["preview"] ?? payload["text"] ?? "新消息").toString();
        return AgentSpherePatch(
          mood: "alert",
          energy: 0.82,
          caption: preview.length > 40 ? preview.substring(0, 40) : preview,
          source: "peer",
        );
      default:
        return null;
    }
  }

  static AgentSpherePatch _fromEmbodiment(Map<String, dynamic> p) {
    final dynamic caption = p["caption"];
    return AgentSpherePatch(
      mood: p["mood"]?.toString(),
      energy: p["energy"] is num ? (p["energy"] as num).toDouble() : null,
      caption: caption?.toString(),
      clearCaption: caption == null,
      phase: p["phase"]?.toString(),
      subAgentType: p["subAgentType"]?.toString(),
      subAgentDisplayName: p["subAgentDisplayName"]?.toString(),
      source: p["source"]?.toString(),
    );
  }

  static String _firstNonEmpty(List<String?> values) {
    for (final String? v in values) {
      if (v != null && v.isNotEmpty) return v;
    }
    return "";
  }
}
