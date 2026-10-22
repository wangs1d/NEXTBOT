import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// 桌面输入活动探针 —— 回答"人还在电脑前吗、连续坐了多久"。
///
/// 为什么需要它（2026-10-22 修）：健康提醒最初用的是「应用启动到现在过了多久」，
/// 那是**本地计时器**，不是感知——人离开了电脑它照样数到 52 分钟，
/// 桌面桥在线也不等于人在动。久坐判断必须落在**系统级输入事件**上。
///
/// 实现口径（Windows）：`GetLastInputInfo`（user32）+ `GetTickCount`（kernel32）。
/// - 零依赖、零权限：不需要全局键盘钩子，不需要管理员，不监听按键内容，
///   只读"上一次输入距今多少毫秒"这一个数字（隐私上等价于屏保计时器）；
/// - 开销≈0：一次 syscall，30 秒采一次；
/// - 只回答"有没有动"，不记录动了什么——这是刻意保留的边界。
///
/// 非 Windows 平台返回 -1（不可用），调用方降级到原来的兜底逻辑，不抛错。
class InputActivityProbe {
  InputActivityProbe._();

  static bool _resolved = false;
  static _GetLastInputInfoDart? _getLastInputInfo;
  static _GetTickCountDart? _getTickCount;

  /// 结构体只分配一次、反复复用（30 秒一次采样，无需每次 malloc/free）
  static Pointer<_LastInputInfo>? _buf;

  /// 上一次采样得到的空闲毫秒数（-1 = 探针不可用）
  static int _lastIdleMs = -1;
  static int get lastIdleMs => _lastIdleMs;

  /// 探针是否可用（仅 Windows 且符号解析成功）
  static bool get available => _resolve();

  static bool _resolve() {
    if (_resolved) return _getLastInputInfo != null;
    _resolved = true;
    if (!Platform.isWindows) return false;
    try {
      final DynamicLibrary user32 = DynamicLibrary.open('user32.dll');
      final DynamicLibrary kernel32 = DynamicLibrary.open('kernel32.dll');
      _getLastInputInfo =
          user32.lookupFunction<_GetLastInputInfoNative, _GetLastInputInfoDart>(
        'GetLastInputInfo',
      );
      _getTickCount =
          kernel32.lookupFunction<_GetTickCountNative, _GetTickCountDart>(
        'GetTickCount',
      );
      return true;
    } catch (_) {
      // 解析失败（受限环境）：降级，不影响主流程
      _getLastInputInfo = null;
      _getTickCount = null;
      return false;
    }
  }

  /// 采样一次：返回距上次键盘/鼠标输入的毫秒数；不可用返回 -1。
  ///
  /// 用 32 位 GetTickCount 而非 64 位版本，是为了与 LASTINPUTINFO.dwTime 的
  /// 位宽严格一致——两者同源，直接相减再按 32 位掩码处理回绕（49.7 天），
  /// 不会出现 64/32 混算导致的巨大负值。
  static int sample() {
    if (!_resolve()) {
      _lastIdleMs = -1;
      return -1;
    }
    try {
      final Pointer<_LastInputInfo> li =
          _buf ??= calloc<_LastInputInfo>();
      li.ref.cbSize = sizeOf<_LastInputInfo>();
      final int ok = _getLastInputInfo!(li);
      if (ok == 0) {
        _lastIdleMs = -1;
        return -1;
      }
      final int now = _getTickCount!();
      // 32 位无符号相减，天然处理 tick 回绕
      final int idle = (now - li.ref.dwTime) & 0xFFFFFFFF;
      _lastIdleMs = idle;
      return idle;
    } catch (_) {
      _lastIdleMs = -1;
      return -1;
    }
  }
}

final class _LastInputInfo extends Struct {
  @Uint32()
  external int cbSize;

  @Uint32()
  external int dwTime;
}

typedef _GetLastInputInfoNative = Int32 Function(Pointer<_LastInputInfo>);
typedef _GetLastInputInfoDart = int Function(Pointer<_LastInputInfo>);
typedef _GetTickCountNative = Uint32 Function();
typedef _GetTickCountDart = int Function();
