// 媒体播放服务状态机单测：agent.media.* 事件 → MediaPlaybackService 状态流转。
// 平台调用（audioplayers）收敛在 MediaPlaybackAdapter，此处注入 fake，
// 只验证状态机与诚实错误上报，不触碰真实音频栈。
import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/services/media_playback_service.dart";

/// fake 适配器：记录调用序列，play 可配置失败，手动触发播完事件。
class FakeMediaPlaybackAdapter extends MediaPlaybackAdapter {
  final List<String> calls = <String>[];
  Object? playError;

  @override
  Future<void> play(String url) async {
    calls.add("play:$url");
    if (playError != null) {
      throw playError!;
    }
  }

  @override
  Future<void> pause() async => calls.add("pause");

  @override
  Future<void> resume() async => calls.add("resume");

  @override
  Future<void> stop() async => calls.add("stop");

  void emitCompleted() {
    onCompletedController.add(null);
  }
}

MediaPlaybackService buildService(FakeMediaPlaybackAdapter adapter) {
  final MediaPlaybackService service = MediaPlaybackService.withAdapter(adapter);
  service.addListener(() {});
  return service;
}

void main() {
  test("kMediaPlaybackCapability 常量为 true（session.init 声明用）", () {
    expect(kMediaPlaybackCapability, isTrue);
  });

  test("agent.media.play 带 url：进入 playing 状态并调用底层播放", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "9905",
      "title": "晴天",
      "artist": "周杰伦",
      "url": "http://m7.music.net.cn/play.mp3",
      "durationMs": 269000,
    });

    expect(adapter.calls, <String>["play:http://m7.music.net.cn/play.mp3"]);
    final MediaNowPlaying? st = service.nowPlaying;
    expect(st, isNotNull);
    expect(st!.trackId, "9905");
    expect(st.title, "晴天");
    expect(st.artist, "周杰伦");
    expect(st.playing, isTrue);
    expect(st.paused, isFalse);
    expect(st.error, isNull);
  });

  test("agent.media.play 只有 urlError：暴露错误状态，绝不假装在放", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "9906",
      "title": "VIP 专属",
      "url": null,
      "urlError": "该曲目无可播放 URL（无版权/仅 VIP/地区限制）",
    });

    expect(adapter.calls, isEmpty, reason: "无 url 不得触发底层播放");
    final MediaNowPlaying? st = service.nowPlaying;
    expect(st, isNotNull);
    expect(st!.playing, isFalse);
    expect(st.error, contains("无可播放 URL"));
    expect(st.title, "VIP 专属");
  });

  test("pause/resume 状态机", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "1",
      "url": "http://m7.music.net.cn/a.mp3",
    });
    expect(service.nowPlaying!.playing, isTrue);

    await service.handleMediaEvent("agent.media.pause", <String, dynamic>{});
    expect(adapter.calls.last, "pause");
    expect(service.nowPlaying!.paused, isTrue);
    expect(service.nowPlaying!.playing, isFalse);

    await service.handleMediaEvent("agent.media.resume", <String, dynamic>{});
    expect(adapter.calls.last, "resume");
    expect(service.nowPlaying!.paused, isFalse);
    expect(service.nowPlaying!.playing, isTrue);
  });

  test("stop 清空播放状态", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "2",
      "url": "http://m7.music.net.cn/b.mp3",
    });
    await service.handleMediaEvent("agent.media.stop", <String, dynamic>{});

    expect(adapter.calls.last, "stop");
    expect(service.nowPlaying, isNull);
  });

  test("底层播放抛错：进入错误状态且 playing=false", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    adapter.playError = StateError("音频下载失败（Windows 临时文件路径不可用）");
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "3",
      "url": "http://m7.music.net.cn/c.mp3",
    });

    final MediaNowPlaying? st = service.nowPlaying;
    expect(st!.playing, isFalse);
    expect(st.error, contains("播放失败"));
    expect(st.error, contains("下载失败"));
  });

  test("自然播完回调：playing 归位，曲目信息保留", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "4",
      "title": "稻香",
      "url": "http://m7.music.net.cn/d.mp3",
    });
    adapter.emitCompleted();
    await Future<void>.delayed(Duration.zero);

    final MediaNowPlaying? st = service.nowPlaying;
    expect(st!.playing, isFalse);
    expect(st.paused, isFalse);
    expect(st.title, "稻香");
  });

  test("新 play 顶掉旧播放（单播放语义）", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "10",
      "title": "第一首",
      "url": "http://m7.music.net.cn/e1.mp3",
    });
    await service.handleMediaEvent("agent.media.play", <String, dynamic>{
      "trackId": "11",
      "title": "第二首",
      "url": "http://m7.music.net.cn/e2.mp3",
    });

    expect(service.nowPlaying!.trackId, "11");
    expect(service.nowPlaying!.title, "第二首");
    expect(service.nowPlaying!.playing, isTrue);
  });

  test("未知事件类型静默忽略", () async {
    final FakeMediaPlaybackAdapter adapter = FakeMediaPlaybackAdapter();
    final MediaPlaybackService service = buildService(adapter);

    await service.handleMediaEvent("agent.voice.speak", <String, dynamic>{});
    expect(adapter.calls, isEmpty);
    expect(service.nowPlaying, isNull);
  });
}
