import "dart:async";
import "dart:convert";
import "dart:math" as math;
import "dart:typed_data";

import "package:flutter/foundation.dart";
import "package:record/record.dart";
import "package:web_socket_channel/web_socket_channel.dart";

import "../config/api_config.dart";
import "pcm_stream_player.dart";
import "tts_player.dart";

/// 全双工语音 WS 客户端（/ws/voice-duplex）。
///
/// 两种上行：
///   - `text.turn`：纯语音模式用——本地识别文本进，整轮语音回流；
///   - `audio.chunk`：电话通话用——麦克风 16kHz PCM16 流式上行，
///     服务端能量 VAD 断句后端到端应答。
/// 下行统一是 `tts.chunk`：realtime 引擎为 `format="pcm"` 裸流（边收边播，
/// 见 [PcmStreamPlayer]），pipeline 引擎为整块 wav/mp3（经 [TtsPlayer]）。
///
/// 半双工门控（回声防护）：任何 TTS 播报期间（含通话接通问候语）麦克风
/// 上行自动暂停，播完自动恢复；服务端在 thinking/speaking 态还会二次丢弃
/// 上行音频，双层防扬声器回流污染对话上下文。
///
/// 引擎是否可用由服务端 `session.ready` 的 `engineKind="realtime"` 判定——
/// 本客户端只认「是不是端到端实时引擎」，不认具体厂商（MiniMax / 本地 /
/// 其它云端都一样）。服务端回 pipeline 引擎时 start 返回 false，调用方回落。
class VoiceDuplexService {
  VoiceDuplexService._();

  static final VoiceDuplexService instance = VoiceDuplexService._();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Completer<bool>? _readyCompleter;
  Completer<void>? _playbackCompleter;
  bool _turnInFlight = false;

  /// 流式 PCM 段：active=正在收/播；gen=代次（打断/新段递增，旧回调作废）；
  /// pending=原生 start 就绪前先到的块（start 是异步的，首块常在就绪前到达）。
  bool _pcmActive = false;
  int _pcmGen = 0;
  final List<Uint8List> _pcmPending = <Uint8List>[];

  /// 起播就绪前就收到了 tts.end（本轮音频很短时的竞态），就绪后立即收尾
  bool _pcmEndPending = false;

  /// 原生播放器不可用时的降级态（C++ 侧未编译进当前 exe / 非 Windows）：
  /// 攒齐本轮 PCM，tts.end 时整段包 WAV 交给 TtsPlayer 播。
  /// 绝不能静默丢块——服务端已流式化，丢了就是「有对话、没声音」。
  bool _pcmFallback = false;
  int _pcmFallbackSr = 24000;
  final List<Uint8List> _pcmFallbackBuf = <Uint8List>[];

  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _micSub;
  bool _micGated = false;
  VoidCallback? _gatingCompletionListener;

  /// 门控起始时刻（毫秒）；与 [_micGateStuckMs] 配合做失准自愈
  int? _gatedSinceMs;

  /// 门控卡死阈值：播报超过这么久仍未恢复即判定为状态失准，强制放行上行。
  static const int _micGateStuckMs = 15000;

  /// 播放中的门控上限：确实有音频在播时放宽（流式长回复可能远超 15s），
  /// 超过这个上限仍未播完才判定为异常并强放行。
  static const int _micGateMaxMs = 60000;

  String? engine;
  String? lastState;

  /// 服务端本次会话是否走端到端实时引擎（engineKind=="realtime"）。
  /// 本地/云端任一实时引擎实现都置真——不依赖具体厂商名。
  bool _realtimeEngine = false;

  /// 服务端 VAD 能量阈值下限（与 endpoint-detector 的 DEFAULT_SPEECH_THRESHOLD
  /// 同口径，都是 16bit RMS 原值）。服务端实际生效值是
  /// max(本值, 背景噪声×3)，所以这是"最好情况"的门槛：低于它说话肯定不会被
  /// 识别，永远断不了句，表现就是「通话接通了但说了没反应」。
  static const double vadThreshold = 200;

  /// 麦克风实时电平（0-1，对数映射），通话 UI 画电平条/做诊断提示用。
  final ValueNotifier<double> micLevel = ValueNotifier<double>(0);

  /// 上一个完整诊断窗口（2s）的峰值 RMS（16bit 原值口径）；0 表示窗口内没数据
  double lastMicPeakRms = 0;

  /// 上一个诊断窗口内是否出现过足以触发 VAD 的声音
  bool get micHasSignal => lastMicPeakRms >= vadThreshold;

  /// 麦克风诊断/电平刷新回调（通话 UI 据此重绘）
  VoidCallback? onMicProbe;

  double _uplinkPeakRms = 0;
  int _uplinkChunks = 0;
  Timer? _micProbeTimer;

  bool get isReady =>
      _channel != null &&
      (_readyCompleter?.isCompleted ?? false) &&
      _realtimeEngine;

  bool get micActive => _micSub != null;

  /// 会话状态机（listening/thinking/speaking）变化
  void Function(String state)? onStateChanged;

  /// 一轮对话完成（assistantText 为语音转录；audio 上行时 userText 可能为空）
  void Function(String userText, String assistantText)? onTurnCompleted;

  /// 服务端错误。recoverable=false 或连接断开时调用方应回落。
  void Function(String message, bool recoverable)? onError;

  /// 连接断开（服务端重启/网络断）。
  void Function()? onConnectionLost;

  /// 建立会话并等待握手。
  ///
  /// [sessionId] 传通话 callId 时，服务端把该通电话的场景上下文并进
  /// realtime 人设（来电汇报内容/来电留言）。返回本次会话是否走端到端实时
  /// 引擎（engineKind=="realtime"，与具体厂商无关）。
  Future<bool> start({
    String? sessionId,
    String? actorId,
    Duration timeout = const Duration(seconds: 6),
  }) async {
    await stop();
    try {
      final Uri uri = Uri.parse("${ApiConfig.wsUrl}/voice-duplex");
      final WebSocketChannel channel = WebSocketChannel.connect(uri);
      _channel = channel;
      _readyCompleter = Completer<bool>();
      _sub = channel.stream.listen(
        _onMessage,
        onDone: _onDisconnected,
        onError: (Object _) => _onDisconnected(),
      );
      channel.sink.add(jsonEncode(<String, dynamic>{
        "type": "session.start",
        if (sessionId != null && sessionId.isNotEmpty) "sessionId": sessionId,
        // 声纹闸：声明身份；该身份已注册声纹时服务端要求 speaker.verify 后才受理对话
        if (actorId != null && actorId.isNotEmpty) "actorId": actorId,
      }));
      final bool ok = await _readyCompleter!.future.timeout(
        timeout,
        onTimeout: () => false,
      );
      if (!ok) {
        await stop();
      }
      return ok;
    } catch (e) {
      debugPrint("[VoiceDuplex] start failed: $e");
      await stop();
      return false;
    }
  }

  /// 声纹验证通过后上报一次性说话人令牌（服务端放行本连接的对话帧）。
  void sendSpeakerVerify(String token) {
    final WebSocketChannel? channel = _channel;
    if (channel == null) return;
    channel.sink.add(jsonEncode(<String, dynamic>{
      "type": "speaker.verify",
      "token": token,
    }));
  }

  /// 发送一轮文本对话（纯语音模式：本地识别文本 → 语音回流）。
  /// 返回 false = 连接不可用/上一轮未完成，调用方应回落。
  Future<bool> sendTextTurn(String text) async {
    final WebSocketChannel? channel = _channel;
    if (channel == null || !isReady || _turnInFlight) return false;
    _turnInFlight = true;
    _playbackCompleter = null;
    channel.sink.add(jsonEncode(<String, dynamic>{
      "type": "text.turn",
      "text": text,
    }));
    return true;
  }

  /// 开启麦克风上行（16kHz PCM16 单声道流式 → audio.chunk）。
  /// 仅电话通话用；纯语音模式的麦克风归本地唤醒/声纹/识别，勿开。
  Future<bool> startMic() async {
    final WebSocketChannel? channel = _channel;
    if (channel == null || !isReady) return false;
    if (_micSub != null) {
      // 已在采集：兜底补齐诊断探针（二者本应成对，异常错位时自愈）
      if (_micProbeTimer == null) _startMicProbe();
      return true;
    }
    try {
      try {
        if (!await _recorder.hasPermission()) {
          debugPrint("[VoiceDuplex] mic permission denied：系统未授予麦克风权限，"
              "通话将无法上行（Windows 需检查「设置 → 隐私 → 麦克风」）");
          return false;
        }
      } catch (e) {
        debugPrint("[VoiceDuplex] mic permission probe failed: $e");
        return false;
      }
      final Stream<Uint8List> stream = await _recorder.startStream(
        const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: 16000,
          numChannels: 1,
        ),
      );
      _micSub = stream.listen((Uint8List data) {
        // 电平统计刻意放在门控之前：被半双工门控丢弃的那部分也要能被看见，
        // 否则用户会误判成「麦克风坏了」，实际只是 Agent 正在播报。
        _updateMicLevel(data);
        // 门控：播报期间 / 上一轮未收尾时不送（回声防护第一层）。
        // 叠了超时自愈：一旦 PS 播放器状态失准（历史 bug：播完没归位导致
        // isPlaying 恒 true），门控会永久关死上行，表现为「说了完全没反应」。
        // 正常播报都远短于 15s，超时即判定为失准并强行放行。
        if (_isMicGatedEffective()) return;
        final WebSocketChannel? ch = _channel;
        if (ch == null || !isReady) return;
        ch.sink.add(jsonEncode(<String, dynamic>{
          "type": "audio.chunk",
          "pcm": base64Encode(data),
        }));
      });
      _startMicProbe();
      // 若此刻恰有 TTS 在播（通话接通问候语等），门控到播完
      if (TtsPlayer.instance.isPlaying) {
        _setMicGated(true);
      }
      // 订阅播放器开播/播完：把所有播报路径（含不经 duplex 的
      // agent.phone.voice_reply 问候语）统一纳入半双工门控，防回采自激
      TtsPlayer.instance
        ..addOnPlaybackStarted(_onPlaybackStarted)
        ..addOnCompleted(_onPlaybackCompleted);
      return true;
    } catch (e) {
      debugPrint("[VoiceDuplex] startMic failed: $e");
      return false;
    }
  }

  void _onPlaybackStarted() {
    if (micActive) _setMicGated(true);
  }

  void _onPlaybackCompleted() {
    if (micActive) _setMicGated(false);
  }

  /// 停麦克风上行。
  Future<void> stopMic() async {
    _stopMicProbe();
    await _micSub?.cancel();
    _micSub = null;
    _setMicGated(false);
    TtsPlayer.instance
      ..removeOnPlaybackStarted(_onPlaybackStarted)
      ..removeOnCompleted(_onPlaybackCompleted);
    try {
      if (await _recorder.isRecording()) await _recorder.stop();
    } catch (_) {}
  }

  /// 等本轮回复音频播放完（tts.chunk 已播完；无音频轮立即返回）。
  Future<void> waitPlayback(
      {Duration timeout = const Duration(seconds: 90)}) async {
    final Completer<void>? c = _playbackCompleter;
    if (c == null) return;
    await c.future.timeout(timeout, onTimeout: () {});
  }

  /// 收会话（服务端销毁 realtime 连接）并关闭 WS。
  Future<void> stop() async {
    final WebSocketChannel? channel = _channel;
    _channel = null;
    _abortPcmStream();
    await stopMic();
    await _sub?.cancel();
    _sub = null;
    _readyCompleter = null;
    _playbackCompleter = null;
    _turnInFlight = false;
    _realtimeEngine = false;
    if (channel != null) {
      try {
        channel.sink.add(jsonEncode(<String, dynamic>{"type": "session.stop"}));
      } catch (_) {}
      try {
        await channel.sink.close(1000);
      } catch (_) {}
    }
  }

  // ── 内部 ──

  /// 流式 PCM 块入口：首块触发原生起播（异步就绪），就绪前到达的块先暂存。
  void _handlePcmChunk(String base64Audio, int sampleRate) {
    final Uint8List bytes;
    try {
      bytes = base64Decode(base64Audio);
    } catch (_) {
      return;
    }
    if (_pcmActive) {
      PcmStreamPlayer.instance.write(bytes);
      return;
    }
    if (_pcmFallback) {
      _pcmFallbackBuf.add(bytes);
      return;
    }
    _pcmPending.add(bytes);
    if (_pcmPending.length == 1) {
      unawaited(_startPcmStream(sampleRate));
    }
  }

  Future<void> _startPcmStream(int sampleRate) async {
    final int gen = ++_pcmGen;
    final bool ok =
        await PcmStreamPlayer.instance.start(sampleRate: sampleRate);
    if (gen != _pcmGen) {
      _pcmPending.clear(); // 期间被打断或已开新段，本次起播作废
      return;
    }
    if (!ok) {
      // 降级：原生播放器不可用（通道未注册 = 原生侧还没编译进去 / 非 Windows）。
      // 转入整段播放路径，保住「能听到」这条底线，只牺牲流式首字延迟。
      debugPrint(
        "[VoiceDuplex] 原生 PCM 播放器不可用，降级为整段 WAV 播放"
        "（非 Windows，或 pai/pcm_player 通道未注册）",
      );
      _pcmFallback = true;
      _pcmFallbackSr = sampleRate;
      _pcmFallbackBuf.addAll(_pcmPending);
      _pcmPending.clear();
      _setMicGated(true);
      _playbackCompleter = Completer<void>();
      if (_pcmEndPending) {
        _pcmEndPending = false;
        unawaited(_playPcmFallback());
      }
      return;
    }
    _pcmActive = true;
    _setMicGated(true);
    _playbackCompleter = Completer<void>();
    for (final Uint8List b in _pcmPending) {
      PcmStreamPlayer.instance.write(b);
    }
    _pcmPending.clear();
    if (_pcmEndPending) {
      // 起播就绪前 tts.end 已到：立即收尾，别让播放器悬着不结束
      _pcmEndPending = false;
      unawaited(_finishPcmStream());
    }
  }

  /// 输入结束：等原生播完已入队音频 → 解除门控并结算本轮播放。
  Future<void> _finishPcmStream() async {
    if (_pcmFallback) {
      await _playPcmFallback();
      return;
    }
    if (!_pcmActive) {
      // 起播还在途（首块仍在暂存）：记下结束请求，待就绪后立即收尾
      if (_pcmPending.isNotEmpty) _pcmEndPending = true;
      return;
    }
    final int gen = _pcmGen;
    _pcmActive = false;
    await PcmStreamPlayer.instance.finish();
    if (gen != _pcmGen) return; // 已被打断/新段取代
    _setMicGated(false);
    if (!(_playbackCompleter?.isCompleted ?? true)) {
      _playbackCompleter?.complete();
    }
  }

  /// 降级播放：把攒下的裸 PCM 整段包成 WAV 交给 TtsPlayer（非流式）。
  Future<void> _playPcmFallback() async {
    final int gen = _pcmGen;
    final Uint8List pcm = _concatBytes(_pcmFallbackBuf);
    _pcmFallbackBuf.clear();
    _pcmFallback = false;
    if (pcm.isEmpty) {
      _setMicGated(false);
      if (!(_playbackCompleter?.isCompleted ?? true)) {
        _playbackCompleter?.complete();
      }
      return;
    }
    void onDone() {
      if (gen != _pcmGen) return; // 已被打断/新段取代
      TtsPlayer.instance.removeOnCompleted(onDone);
      _setMicGated(false);
      if (!(_playbackCompleter?.isCompleted ?? true)) {
        _playbackCompleter?.complete();
      }
    }

    TtsPlayer.instance.addOnCompleted(onDone);
    final bool played = await TtsPlayer.instance
        .playFromBytes(_pcmToWav(pcm, _pcmFallbackSr), format: "wav");
    if (!played) {
      // 播放失败也要解除门控，否则麦克风被永久关死
      onDone();
    }
  }

  /// 立即中断当前流式播放（打断/挂断）。
  void _abortPcmStream() {
    if (!_pcmActive && _pcmPending.isEmpty && _pcmFallbackBuf.isEmpty) return;
    _pcmGen++; // 让在途 start/finish 回调作废
    _pcmActive = false;
    _pcmEndPending = false;
    _pcmFallback = false;
    _pcmPending.clear();
    _pcmFallbackBuf.clear();
    unawaited(PcmStreamPlayer.instance.stop());
    _setMicGated(false);
    if (!(_playbackCompleter?.isCompleted ?? true)) {
      _playbackCompleter?.complete();
    }
  }

  /// 拼接字节块。
  Uint8List _concatBytes(List<Uint8List> chunks) {
    if (chunks.isEmpty) return Uint8List(0);
    if (chunks.length == 1) return chunks.first;
    int total = 0;
    for (final Uint8List c in chunks) {
      total += c.length;
    }
    final Uint8List out = Uint8List(total);
    int offset = 0;
    for (final Uint8List c in chunks) {
      out.setRange(offset, offset + c.length, c);
      offset += c.length;
    }
    return out;
  }

  /// 裸 PCM16 单声道包最小 WAV 容器（与服务端 pcmToWav 同构）。
  Uint8List _pcmToWav(Uint8List pcm, int sampleRate, {int channels = 1}) {
    const int bitsPerSample = 16;
    final int byteRate = sampleRate * channels * (bitsPerSample >> 3);
    final int blockAlign = channels * (bitsPerSample >> 3);
    final ByteData h = ByteData(44);
    void str(int offset, String s) {
      for (int i = 0; i < s.length; i++) {
        h.setUint8(offset + i, s.codeUnitAt(i));
      }
    }

    str(0, "RIFF");
    h.setUint32(4, 36 + pcm.length, Endian.little);
    str(8, "WAVE");
    str(12, "fmt ");
    h.setUint32(16, 16, Endian.little);
    h.setUint16(20, 1, Endian.little); // PCM
    h.setUint16(22, channels, Endian.little);
    h.setUint32(24, sampleRate, Endian.little);
    h.setUint32(28, byteRate, Endian.little);
    h.setUint16(32, blockAlign, Endian.little);
    h.setUint16(34, bitsPerSample, Endian.little);
    str(36, "data");
    h.setUint32(40, pcm.length, Endian.little);
    final Uint8List out = Uint8List(44 + pcm.length);
    out.setRange(0, 44, h.buffer.asUint8List());
    out.setRange(44, out.length, pcm);
    return out;
  }

  /// 累计一块上行音频的 RMS（每 8 个样本抽 1 个，够诊断用）。
  void _updateMicLevel(Uint8List chunk) {
    if (chunk.length < 2) return;
    final ByteData view = ByteData.sublistView(chunk);
    final int sampleCount = chunk.length ~/ 2;
    double sum = 0;
    int n = 0;
    for (int i = 0; i < sampleCount; i += 8) {
      final double v = view.getInt16(i * 2, Endian.little).toDouble();
      sum += v * v;
      n++;
    }
    if (n == 0) return;
    final double rms = math.sqrt(sum / n);
    if (rms > _uplinkPeakRms) _uplinkPeakRms = rms;
    _uplinkChunks++;
    micLevel.value = (rms / 32768 * 8).clamp(0.0, 1.0).toDouble();
  }

  /// 启动麦克风诊断采样：每 2s 汇总一次峰值电平并打日志。
  ///
  /// 这是「通话接通了但说了没反应」最主要的排查依据——日志里能直接看出麦克风
  /// 到底有没有吐数据、电平够不够触发服务端 VAD（阈值见 [vadThreshold]），
  /// 不必再靠猜。
  void _startMicProbe() {
    _stopMicProbe();
    _uplinkPeakRms = 0;
    _uplinkChunks = 0;
    lastMicPeakRms = 0;
    _micProbeTimer = Timer.periodic(const Duration(seconds: 2), (Timer _) {
      final double peak = _uplinkPeakRms;
      final int chunks = _uplinkChunks;
      _uplinkPeakRms = 0;
      _uplinkChunks = 0;
      lastMicPeakRms = peak;
      final String verdict;
      if (chunks == 0) {
        verdict = "麦克风未吐出任何数据（被其他录音占用/权限未生效/设备异常）";
      } else if (peak < vadThreshold) {
        verdict = "电平低于 VAD 阈值 $vadThreshold，说话不会被识别";
      } else {
        verdict = "电平可触发 VAD";
      }
      debugPrint(
        "[VoiceDuplex] mic probe blocks=$chunks peakRMS=${peak.toStringAsFixed(0)} "
        "gated=$_micGated playing=${TtsPlayer.instance.isPlaying} engine=$engine → $verdict",
      );
      onMicProbe?.call();
    });
  }

  void _stopMicProbe() {
    _micProbeTimer?.cancel();
    _micProbeTimer = null;
    _uplinkPeakRms = 0;
    _uplinkChunks = 0;
    lastMicPeakRms = 0;
    micLevel.value = 0;
    _gatedSinceMs = null;
  }

  /// 门控是否真的生效（含失准超时判定）。
  bool _isMicGatedEffective() {
    final bool playing =
        TtsPlayer.instance.isPlaying || PcmStreamPlayer.instance.isPlaying;
    final bool busy = _micGated || playing;
    if (!busy) {
      _gatedSinceMs = null;
      return false;
    }
    final int now = DateTime.now().millisecondsSinceEpoch;
    _gatedSinceMs ??= now;
    // 有音频在播：按更宽的上限判定（流式长回复可达数十秒，不算卡死）
    final int limit = playing ? _micGateMaxMs : _micGateStuckMs;
    if (now - _gatedSinceMs! <= limit) return true;
    debugPrint(
      "[VoiceDuplex] mic gate stuck >${limit}ms (gated=$_micGated "
      "playing=$playing) → force release，防止上行被永久关闭",
    );
    _micGated = false;
    _gatedSinceMs = null;
    return false;
  }

  void _setMicGated(bool gated) {
    if (_micGated == gated) return;
    _micGated = gated;
    _gatedSinceMs = gated ? DateTime.now().millisecondsSinceEpoch : null;
    if (gated) {
      // 播完自动解除门控（一次性）
      void onDone() {
        _setMicGated(false);
        TtsPlayer.instance.removeOnCompleted(onDone);
        _gatingCompletionListener = null;
      }

      _gatingCompletionListener = onDone;
      TtsPlayer.instance.addOnCompleted(onDone);
    } else {
      final VoidCallback? l = _gatingCompletionListener;
      if (l != null) {
        TtsPlayer.instance.removeOnCompleted(l);
        _gatingCompletionListener = null;
      }
    }
  }

  void _onMessage(dynamic data) {
    final Map<String, dynamic> evt;
    try {
      evt = jsonDecode(data.toString()) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (evt["type"]?.toString()) {
      case "session.ready":
        engine = evt["engine"]?.toString();
        // 能力判定：只认「端到端实时引擎」这一类，不匹配具体厂商名。
        // 旧服务端不带 engineKind 时按 engine 名兜底，保证前后端可分别升级。
        final String kind = evt["engineKind"]?.toString() ??
            (engine == "minimax-realtime" ? "realtime" : "");
        _realtimeEngine = kind == "realtime";
        if (_readyCompleter?.isCompleted != true) {
          _readyCompleter?.complete(_realtimeEngine);
        }
      case "state":
        lastState = evt["state"]?.toString();
        onStateChanged?.call(lastState ?? "");
      case "tts.chunk":
        final String audio = evt["audio"]?.toString() ?? "";
        if (audio.isEmpty) break;
        final String format = evt["format"]?.toString() ?? "wav";
        if (format == "pcm") {
          // 流式分块下发：边收边喂原生 PCM 播放器，首块即起播（不等整轮）
          final Object? sr = evt["sampleRate"];
          _handlePcmChunk(audio, sr is int && sr > 0 ? sr : 24000);
          break;
        }
        // 整段块（pipeline 引擎）：沿用 TtsPlayer
        // 半双工：播报即门控麦克风，播完恢复
        _setMicGated(true);
        final Completer<void> completer = Completer<void>();
        _playbackCompleter = completer;
        void onPlaybackDone() {
          if (!completer.isCompleted) completer.complete();
          TtsPlayer.instance.removeOnCompleted(onPlaybackDone);
          _setMicGated(false);
        }

        TtsPlayer.instance.addOnCompleted(onPlaybackDone);
        unawaited(
          TtsPlayer.instance.playFromBase64(audio, format: format).then((
            bool played,
          ) {
            if (!played) {
              // 播放失败也要解除门控，否则麦克风被永久关死
              onPlaybackDone();
            }
          }),
        );
      case "tts.end":
        // 流式段输入结束：等原生把已入队音频播完后解除半双工门控
        unawaited(_finishPcmStream());
      case "turn.completed":
        _turnInFlight = false;
        final String user = evt["userText"]?.toString() ?? "";
        final String assistant = evt["assistantText"]?.toString() ?? "";
        onTurnCompleted?.call(user, assistant);
      case "error":
        _turnInFlight = false;
        onError?.call(
          evt["message"]?.toString() ?? "语音链路未知错误",
          evt["recoverable"] == true,
        );
      case "session.ended":
        _onDisconnected();
      default:
        break;
    }
  }

  void _onDisconnected() {
    if (_channel == null) return; // 已主动 stop，忽略
    _channel = null;
    _abortPcmStream();
    _readyCompleter?.complete(false);
    _readyCompleter = null;
    if (!(_playbackCompleter?.isCompleted ?? true)) {
      _playbackCompleter?.complete();
    }
    _playbackCompleter = null;
    _turnInFlight = false;
    _realtimeEngine = false;
    onConnectionLost?.call();
  }
}
