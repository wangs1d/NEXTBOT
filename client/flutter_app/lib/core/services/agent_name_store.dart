import "package:flutter/foundation.dart";

/// 手机端 agent 名称的单一活水源（账号级，两端共享）。
///
/// - 登录/恢复会话后由服务端 `agentProfile.displayName` 灌初值；
/// - 对话中用户给 agent 取名 → 服务端统一改名管道广播 `identity_renamed`，
///   控制器收到后即时写入这里，顶栏胶囊当场浮现，无需重进应用。
class AgentNameStore {
  AgentNameStore._();

  static final AgentNameStore instance = AgentNameStore._();

  /// 未取名 = null（顶栏只显示状态点，不显示空胶囊）。
  final ValueNotifier<String?> name = ValueNotifier<String?>(null);

  void set(String? raw) {
    final String trimmed = (raw ?? "").trim();
    final String? next = trimmed.isEmpty ? null : trimmed;
    if (name.value == next) return;
    name.value = next;
  }

  void clear() => set(null);
}
