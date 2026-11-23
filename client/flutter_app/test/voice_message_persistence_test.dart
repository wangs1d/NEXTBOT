/// 语音条跨重启持久化回归（2026-11-23）。
///
/// 事故形态：agent.voice.message 落地时 attachments（含 mediaUrl/duration/
/// transcript）、durationMs、waveform 只在内存里；两端共用的
/// IsarLocalHistoryStore 写盘/读取链路漏存这三个字段。重启后聊天记录里
/// contentType 仍是 "audio"，但 attachments 为空 →
/// 气泡渲染条件（contentType==audio && 有 audio 附件）不成立，语音条凭空消失。
///
/// 本测试锁四件事：
///  1. 语音条存盘后，换新 store 实例（模拟重启）读回，attachments 全字段还在；
///  2. message 级 durationMs / waveform 也随消息读回；
///  3. transcript 在落盘 JSON 里不是明文（与正文同款 PIN 加密）；
///  4. 气泡渲染前置条件（audio contentType + audio 附件）在重启后仍成立。
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:path_provider/path_provider.dart";
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";

import "package:nextbot/core/db/isar_local_history_store.dart";
import "package:nextbot/core/models/chat_models.dart";

import "helpers/temp_path_provider.dart";

const String _pin = "voice-test-pin";

void main() {
  setUp(() {
    // 同一个 platform 实例 → 两个 store 指向同一份 nextbot_store.json，
    // 才能真实模拟「杀进程后重开 App、从磁盘重新装载」。
    PathProviderPlatform.instance = TempPathProviderPlatform();
  });

  Future<File> storeFile() async =>
      File("${(await getApplicationDocumentsDirectory()).path}/nextbot_store.json");

  ChatMessage voiceMessage() => ChatMessage(
        messageId: "voice-msg-001",
        sessionId: "main",
        role: "assistant",
        text: "", // 有 mediaUrl 时正文留空，和真实落地一致
        timestamp: DateTime(2026, 11, 23, 11, 0),
        contentType: "audio",
        durationMs: 5200,
        waveform: const <double>[0.3, 0.6, 0.9, 0.5],
        attachments: <MessageAttachment>[
          MessageAttachment(
            type: MessageAttachmentType.audio,
            url: "/agent/voice/messages/actor-1/abc-123.mp3",
            durationMs: 5200,
            transcript: "大哥，明天记得带伞",
            mimeType: "audio/mpeg",
          ),
        ],
      );

  test("语音条跨重启读回：attachments/duration/waveform 全在，气泡条件成立", () async {
    final writer = IsarLocalHistoryStore(userPin: _pin);
    await writer.init();
    await writer.saveMessage(voiceMessage());

    // 新实例 = 重启后重新装载（读的是同一份磁盘文件）
    final restarted = IsarLocalHistoryStore(userPin: _pin);
    await restarted.init();
    final List<ChatMessage> history = await restarted.listMessages("main");

    expect(history, hasLength(1));
    final ChatMessage m = history.single;
    expect(m.contentType, "audio");
    expect(m.durationMs, 5200);
    expect(m.waveform, <double>[0.3, 0.6, 0.9, 0.5]);
    expect(m.attachments, hasLength(1));

    final MessageAttachment a = m.attachments.single;
    expect(a.type, MessageAttachmentType.audio);
    expect(a.url, "/agent/voice/messages/actor-1/abc-123.mp3");
    expect(a.durationMs, 5200);
    expect(a.transcript, "大哥，明天记得带伞");
    expect(a.mimeType, "audio/mpeg");

    // 气泡渲染前置条件（mobile_chat_page / chat_page 同款）
    final bool canRenderVoiceBubble = m.contentType == "audio" &&
        m.attachments.any((MessageAttachment x) =>
            x.type == MessageAttachmentType.audio);
    expect(canRenderVoiceBubble, isTrue,
        reason: "重启后语音条必须仍满足气泡渲染条件，否则用户看到语音条消失");
  });

  test("transcript 落盘加密：磁盘 JSON 里搜不到转写明文", () async {
    final store = IsarLocalHistoryStore(userPin: _pin);
    await store.init();
    await store.saveMessage(voiceMessage());

    final String raw = await (await storeFile()).readAsString();
    expect(raw, isNot(contains("大哥，明天记得带伞")),
        reason: "transcript 属隐私文本，不能像旧正文一样裸写在磁盘");
    // 密文标记确实存在（附件被写盘了，而不是被静默丢弃）
    expect(raw, contains('"attachments"'));
  });
}
