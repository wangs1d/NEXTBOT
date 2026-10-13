import "../models/chat_models.dart";

abstract class LocalHistoryStore {
  Future<void> init();
  Future<void> saveSession(ChatSession session);
  Future<void> saveMessage(ChatMessage message);
  Future<List<ChatSession>> listSessions();
  Future<List<ChatMessage>> listMessages(String sessionId);
  Future<int> migrateAssistantTimestampFrames();

  // 历史消息删除
  Future<void> deleteMessage(String messageId);
  Future<void> deleteMessagesForSession(String sessionId);
  Future<void> clearAllMessages();

  // Preference 存储
  Future<dynamic> getPreference(String key);
  Future<void> savePreference(String key, dynamic value);

  // 离线待发用户消息队列（断网时入队并持久化，联网后按序补发）
  /// 全部待发载荷（FIFO，按入队顺序）。
  Future<List<Map<String, dynamic>>> listPendingUserMessages();
  /// 入队一条 `chat.user_message` WS 载荷（按 messageId 去重，超上限丢最旧）。
  Future<void> enqueuePendingUserMessage(Map<String, dynamic> payload);
  /// 补发成功后按 messageId 出队。
  Future<void> dequeuePendingUserMessage(String messageId);

  
  // 生物特征注册状态
  Future<bool> getBiometricRegistrationStatus();
  Future<void> saveBiometricRegistrationStatus(bool isRegistered);
}
