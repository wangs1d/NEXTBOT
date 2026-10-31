import 'dart:async';
import 'dart:convert';
import 'dart:ffi' as ffi;
import 'dart:ui';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'enums.dart';
import 'cursor.dart';

typedef _GetAsyncKeyStateNative = ffi.Int16 Function(ffi.Int32);
typedef _GetAsyncKeyStateDart = int Function(int);

_GetAsyncKeyStateDart? _getAsyncKeyState;
bool _getAsyncKeyStateFailed = false;

/// VK_CONTROL (0x11); GetAsyncKeyState 高位 = 物理按下瞬间状态，
/// 不依赖 Flutter 收没收到 keydown（WebView 抢焦点/前台切换会吞事件）。
int? _queryVkControl() {
  if (_getAsyncKeyStateFailed) return null;
  try {
    _getAsyncKeyState ??= ffi.DynamicLibrary.open('user32.dll')
        .lookup<ffi.NativeFunction<_GetAsyncKeyStateNative>>(
            'GetAsyncKeyState')
        .asFunction();
    return _getAsyncKeyState!(0x11) & 0x8000;
  } catch (_) {
    _getAsyncKeyStateFailed = true;
    return null;
  }
}

/// Ctrl 判定：优先 OS 物理键状态，FFI 不可用时退回 HardwareKeyboard。
bool _isCtrlHeld() {
  final int? vk = _queryVkControl();
  if (vk == null) return HardwareKeyboard.instance.isControlPressed;
  return vk != 0 || HardwareKeyboard.instance.isControlPressed;
}

class HistoryChanged {
  final bool canGoBack;
  final bool canGoForward;
  const HistoryChanged(this.canGoBack, this.canGoForward);
}

typedef PermissionRequestedDelegate
    = FutureOr<WebviewPermissionDecision> Function(
        String url, WebviewPermissionKind permissionKind, bool isUserInitiated);

typedef ScriptID = String;

/// Ctrl+滚轮缩放回调：按下一档传 +1，上一档传 -1。设置后 Ctrl+滚轮不再透传
/// 页面滚动（WebView2 原生收不到键盘修饰键，缩放只能在宿主层驱动）。
typedef ZoomStepDelegate = void Function(int step);

/// Attempts to translate a button constant such as [kPrimaryMouseButton]
/// to a [PointerButton]
PointerButton getButton(int value) {
  switch (value) {
    case kPrimaryMouseButton:
      return PointerButton.primary;
    case kSecondaryMouseButton:
      return PointerButton.secondary;
    case kTertiaryButton:
      return PointerButton.tertiary;
    default:
      return PointerButton.none;
  }
}

const String _pluginChannelPrefix = 'io.jns.webview.win';
const MethodChannel _pluginChannel = MethodChannel(_pluginChannelPrefix);

class WebviewValue {
  const WebviewValue({
    required this.isInitialized,
  });

  final bool isInitialized;

  WebviewValue copyWith({
    bool? isInitialized,
  }) {
    return WebviewValue(
      isInitialized: isInitialized ?? this.isInitialized,
    );
  }

  WebviewValue.uninitialized()
      : this(
          isInitialized: false,
        );
}

/// Controls a WebView and provides streams for various change events.
class WebviewController extends ValueNotifier<WebviewValue> {
  /// Explicitly initializes the underlying WebView environment
  /// using  an optional [browserExePath], an optional [userDataPath]
  /// and optional Chromium command line arguments [additionalArguments].
  ///
  /// The environment is shared between all WebviewController instances and
  /// can be initialized only once. Initialization must take place before any
  /// WebviewController is created/initialized.
  ///
  /// Throws [PlatformException] if the environment was initialized before.
  static Future<void> initializeEnvironment(
      {String? userDataPath,
      String? browserExePath,
      String? additionalArguments}) async {
    return _pluginChannel
        .invokeMethod('initializeEnvironment', <String, dynamic>{
      'userDataPath': userDataPath,
      'browserExePath': browserExePath,
      'additionalArguments': additionalArguments
    });
  }

  /// Get the browser version info including channel name if it is not the
  /// WebView2 Runtime.
  /// Returns [null] if the webview2 runtime is not installed.
  static Future<String?> getWebViewVersion() async {
    return _pluginChannel.invokeMethod<String>('getWebViewVersion');
  }

  late Completer<void> _creatingCompleter;
  int _textureId = 0;

  /// 渲染纹理 id（初始化后有效；宿主层直接走 method channel 时需要）。
  int get textureId => _textureId;
  bool _isDisposed = false;

  Future<void> get ready => _creatingCompleter.future;

  PermissionRequestedDelegate? _permissionRequested;

  late MethodChannel _methodChannel;
  late EventChannel _eventChannel;
  StreamSubscription? _eventStreamSubscription;

  final StreamController<String> _urlStreamController =
      StreamController<String>();

  /// A stream reflecting the current URL.
  Stream<String> get url => _urlStreamController.stream;

  final StreamController<LoadingState> _loadingStateStreamController =
      StreamController<LoadingState>.broadcast();
  final StreamController<WebErrorStatus> _onLoadErrorStreamController =
      StreamController<WebErrorStatus>();

  /// A stream reflecting the current loading state.
  Stream<LoadingState> get loadingState => _loadingStateStreamController.stream;

  /// A stream reflecting the navigation error when navigation completed with an error.
  Stream<WebErrorStatus> get onLoadError => _onLoadErrorStreamController.stream;

  final StreamController<HistoryChanged> _historyChangedStreamController =
      StreamController<HistoryChanged>();

  /// A stream reflecting the current history state.
  Stream<HistoryChanged> get historyChanged =>
      _historyChangedStreamController.stream;

  final StreamController<String> _securityStateChangedStreamController =
      StreamController<String>();

  /// A stream reflecting the current security state.
  Stream<String> get securityStateChanged =>
      _securityStateChangedStreamController.stream;

  final StreamController<String> _titleStreamController =
      StreamController<String>();

  /// A stream reflecting the current document title.
  Stream<String> get title => _titleStreamController.stream;

  final StreamController<SystemMouseCursor> _cursorStreamController =
      StreamController<SystemMouseCursor>.broadcast();

  /// A stream reflecting the current cursor style.
  Stream<SystemMouseCursor> get _cursor => _cursorStreamController.stream;

  final StreamController<dynamic> _webMessageStreamController =
      StreamController<dynamic>();

  Stream<dynamic> get webMessage => _webMessageStreamController.stream;

  final StreamController<bool>
      _containsFullScreenElementChangedStreamController =
      StreamController<bool>.broadcast();

  /// A stream reflecting whether the document currently contains full-screen elements.
  Stream<bool> get containsFullScreenElementChanged =>
      _containsFullScreenElementChangedStreamController.stream;

  WebviewController() : super(WebviewValue.uninitialized());

  /// Initializes the underlying platform view.
  Future<void> initialize() async {
    if (_isDisposed) {
      return Future<void>.value();
    }
    _creatingCompleter = Completer<void>();
    try {
      final reply =
          await _pluginChannel.invokeMapMethod<String, dynamic>('initialize');

      _textureId = reply!['textureId'];
      _methodChannel = MethodChannel('$_pluginChannelPrefix/$_textureId');
      _eventChannel = EventChannel('$_pluginChannelPrefix/$_textureId/events');
      _eventStreamSubscription =
          _eventChannel.receiveBroadcastStream().listen((event) {
        final map = event as Map<dynamic, dynamic>;
        switch (map['type']) {
          case 'urlChanged':
            _urlStreamController.add(map['value']);
            break;
          case 'onLoadError':
            final value = WebErrorStatus.values[map['value']];
            _onLoadErrorStreamController.add(value);
            break;
          case 'loadingStateChanged':
            final value = LoadingState.values[map['value']];
            _loadingStateStreamController.add(value);
            break;
          case 'historyChanged':
            final value = HistoryChanged(
                map['value']['canGoBack'], map['value']['canGoForward']);
            _historyChangedStreamController.add(value);
            break;
          case 'securityStateChanged':
            _securityStateChangedStreamController.add(map['value']);
            break;
          case 'titleChanged':
            _titleStreamController.add(map['value']);
            break;
          case 'cursorChanged':
            _cursorStreamController.add(getCursorByName(map['value']));
            break;
          case 'webMessageReceived':
            try {
              final message = json.decode(map['value']);
              _webMessageStreamController.add(message);
            } catch (ex) {
              _webMessageStreamController.addError(ex);
            }
            break;
          case 'containsFullScreenElementChanged':
            _containsFullScreenElementChangedStreamController.add(map['value']);
            break;
        }
      });

      _methodChannel.setMethodCallHandler((call) {
        if (call.method == 'permissionRequested') {
          return _onPermissionRequested(
              call.arguments as Map<dynamic, dynamic>);
        }

        throw MissingPluginException('Unknown method ${call.method}');
      });

      value = value.copyWith(isInitialized: true);
      _creatingCompleter.complete();
    } on PlatformException catch (e) {
      _creatingCompleter.completeError(e);
    }

    return _creatingCompleter.future;
  }

  Future<bool?> _onPermissionRequested(Map<dynamic, dynamic> args) async {
    if (_permissionRequested == null) {
      return null;
    }

    final url = args['url'] as String?;
    final permissionKindIndex = args['permissionKind'] as int?;
    final isUserInitiated = args['isUserInitiated'] as bool?;

    if (url != null && permissionKindIndex != null && isUserInitiated != null) {
      final permissionKind = WebviewPermissionKind.values[permissionKindIndex];
      final decision =
          await _permissionRequested!(url, permissionKind, isUserInitiated);

      switch (decision) {
        case WebviewPermissionDecision.allow:
          return true;
        case WebviewPermissionDecision.deny:
          return false;
        default:
          return null;
      }
    }

    return null;
  }

  @override
  Future<void> dispose() async {
    await _creatingCompleter.future;
    if (!_isDisposed) {
      _isDisposed = true;
      await _eventStreamSubscription?.cancel();
      await _pluginChannel.invokeMethod('dispose', _textureId);
    }
    super.dispose();
  }

  /// Loads the given [url].
  Future<void> loadUrl(String url) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('loadUrl', url);
  }

  /// Loads a document from the given string.
  Future<void> loadStringContent(String content) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('loadStringContent', content);
  }

  /// Reloads the current document.
  Future<void> reload() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('reload');
  }

  /// Stops all navigations and pending resource fetches.
  Future<void> stop() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('stop');
  }

  /// Navigates the WebView to the previous page in the navigation history.
  Future<void> goBack() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('goBack');
  }

  /// Navigates the WebView to the next page in the navigation history.
  Future<void> goForward() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('goForward');
  }

  /// Adds the provided JavaScript [script] to a list of scripts that should be run after the global
  /// object has been created, but before the HTML document has been parsed and before any
  /// other script included by the HTML document is run.
  ///
  /// Returns a [ScriptID] on success which can be used for [removeScriptToExecuteOnDocumentCreated].
  ///
  /// see https://docs.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2?view=webview2-1.0.1264.42#addscripttoexecuteondocumentcreated
  Future<ScriptID?> addScriptToExecuteOnDocumentCreated(String script) async {
    if (_isDisposed) {
      return null;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod<String?>(
        'addScriptToExecuteOnDocumentCreated', script);
  }

  /// Removes the script identified by [scriptId] from the list of registered scripts.
  ///
  /// see https://docs.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2?view=webview2-1.0.1264.42#removescripttoexecuteondocumentcreated
  Future<void> removeScriptToExecuteOnDocumentCreated(ScriptID scriptId) async {
    if (_isDisposed) {
      return null;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod(
        'removeScriptToExecuteOnDocumentCreated', scriptId);
  }

  /// Runs the JavaScript [script] in the current top-level document rendered in
  /// the WebView and returns its result.
  ///
  /// see https://docs.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2?view=webview2-1.0.1264.42#executescript
  Future<dynamic> executeScript(String script) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);

    final data = await _methodChannel.invokeMethod('executeScript', script);
    if (data == null) return null;
    return jsonDecode(data as String);
  }

  /// 把滚轮投递到页面坐标 (dx, dy) 处的元素。
  ///
  /// 为什么不走 SendMouseInput(WHEEL)：实测本机 WebView2 Runtime（156.x）
  /// 只投递 point=(0,0) 的滚轮事件，任何非零坐标一律静默丢弃（按住鼠标
  /// 键也不行；点击不受影响）——滚轮在宿主层转发等于完全失效。改为在页面
  /// 里向 elementFromPoint 命中的元素派发 WheelEvent：MapLibre 等监听
  /// wheel 的组件照常工作；事件未被 preventDefault 时手动滚动最近的可
  /// 滚动祖先，兜底页面默认滚动。
  ///
  /// [pos]/[delta] 是 Flutter 逻辑坐标；页面缩放（put_ZoomFactor）会改
  /// 变 CSS 像素与逻辑像素的比值，由页面自己的 devicePixelRatio 换算。
  Future<void> dispatchScrollAt(Offset pos, Offset delta, double devicePixelRatio) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    final String js = """
(function(){
  var z = window.devicePixelRatio / __DPR__;
  var x = __FX__ / z, y = __FY__ / z;
  var sx = __DX__ / z, sy = __DY__ / z;
  var el = document.elementFromPoint(x, y);
  if (!el) { (document.scrollingElement || document.documentElement).scrollBy(sx, sy); return true; }
  var ev = new WheelEvent('wheel', {deltaX: sx, deltaY: sy, clientX: x, clientY: y, bubbles: true, cancelable: true});
  el.dispatchEvent(ev);
  if (ev.defaultPrevented) return true;
  var n = el;
  while (n) {
    if (n.nodeType === 1) {
      var cs = getComputedStyle(n);
      var canY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight - n.clientHeight > 1;
      var canX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth - n.clientWidth > 1;
      if ((canY && sy !== 0) || (canX && sx !== 0)) { n.scrollBy(sx, sy); return true; }
    }
    if (n === document.documentElement || n === document.body) break;
    n = n.parentElement;
  }
  (document.scrollingElement || document.documentElement).scrollBy(sx, sy);
  return true;
})()"""
        .replaceAll('__DPR__', '$devicePixelRatio')
        .replaceAll('__FX__', '${pos.dx}')
        .replaceAll('__FY__', '${pos.dy}')
        .replaceAll('__DX__', '${delta.dx}')
        .replaceAll('__DY__', '${delta.dy}');
    try {
      await executeScript(js);
    } catch (_) {
      // 页面跳转中执行失败：丢弃本次滚轮
    }
  }

  /// Posts the given JSON-formatted message to the current document.
  Future<void> postWebMessage(String message) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('postWebMessage', message);
  }

  /// Sets the user agent value.
  Future<void> setUserAgent(String userAgent) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('setUserAgent', userAgent);
  }

  /// Clears browser cookies.
  Future<void> clearCookies() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('clearCookies');
  }

  /// Clears browser cache.
  Future<void> clearCache() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('clearCache');
  }

  /// Toggles ignoring cache for each request. If true, cache will not be used.
  Future<void> setCacheDisabled(bool disabled) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('setCacheDisabled', disabled);
  }

  /// Opens the Browser DevTools in a separate window
  Future<void> openDevTools() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('openDevTools');
  }

  /// Sets the background color to the provided [color].
  ///
  /// Due to a limitation of the underlying WebView implementation,
  /// semi-transparent values are not supported.
  /// Any non-zero alpha value will be considered as opaque (0xff).
  Future<void> setBackgroundColor(Color color) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod(
        'setBackgroundColor', color.value.toSigned(32));
  }

  /// Sets the zoom factor.
  Future<void> setZoomFactor(double zoomFactor) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('setZoomFactor', zoomFactor);
  }

  /// Sets the [WebviewPopupWindowPolicy].
  Future<void> setPopupWindowPolicy(
      WebviewPopupWindowPolicy popupPolicy) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod(
        'setPopupWindowPolicy', popupPolicy.index);
  }

  /// Suspends the web view.
  Future<void> suspend() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('suspend');
  }

  /// Resumes the web view.
  Future<void> resume() async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('resume');
  }

  /// Adds a Virtual Host Name Mapping.
  ///
  /// Please refer to
  /// [Microsofts](https://docs.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_3#setvirtualhostnametofoldermapping)
  /// documentation for more details.
  Future<void> addVirtualHostNameMapping(String hostName, String folderPath,
      WebviewHostResourceAccessKind accessKind) async {
    if (_isDisposed) {
      return;
    }

    return _methodChannel.invokeMethod(
        'setVirtualHostNameMapping', [hostName, folderPath, accessKind.index]);
  }

  /// Removes a Virtual Host Name Mapping.
  ///
  /// Please refer to
  /// [Microsofts](https://docs.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_3#clearvirtualhostnametofoldermapping)
  /// documentation for more details.
  Future<void> removeVirtualHostNameMapping(String hostName) async {
    if (_isDisposed) {
      return;
    }
    return _methodChannel.invokeMethod('clearVirtualHostNameMapping', hostName);
  }

  /// Limits the number of frames per second to the given value.
  Future<void> setFpsLimit([int? maxFps = 0]) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('setFpsLimit', maxFps);
  }

  /// Sends a Pointer (Touch) update
  Future<void> _setPointerUpdate(WebviewPointerEventKind kind, int pointer,
      Offset position, double size, double pressure) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('setPointerUpdate',
        [pointer, kind.index, position.dx, position.dy, size, pressure]);
  }

  /// Moves the virtual cursor to [position].
  Future<void> _setCursorPos(Offset position) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel
        .invokeMethod('setCursorPos', [position.dx, position.dy]);
  }

  /// Indicates whether the specified [button] is currently down.
  Future<void> _setPointerButtonState(PointerButton button, bool isDown) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('setPointerButton',
        <String, dynamic>{'button': button.index, 'isDown': isDown});
  }

  /// Sets the horizontal and vertical scroll delta.
  Future<void> _setScrollDelta(double dx, double dy) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel.invokeMethod('setScrollDelta', [dx, dy]);
  }

  /// Sets the surface size to the provided [size].
  Future<void> _setSize(Size size, double scaleFactor) async {
    if (_isDisposed) {
      return;
    }
    assert(value.isInitialized);
    return _methodChannel
        .invokeMethod('setSize', [size.width, size.height, scaleFactor]);
  }
}

class Webview extends StatefulWidget {
  final WebviewController controller;
  final PermissionRequestedDelegate? permissionRequested;
  final double? width;
  final double? height;

  /// An optional scale factor. Defaults to [FlutterView.devicePixelRatio] for
  /// rendering in native resolution.
  /// Setting this to 1.0 will disable high-DPI support.
  /// This should only be needed to mimic old behavior before high-DPI support
  /// was available.
  final double? scaleFactor;

  /// The [FilterQuality] used for scaling the texture's contents.
  /// Defaults to [FilterQuality.none] as this renders in native resolution
  /// unless specifying a [scaleFactor].
  final FilterQuality filterQuality;

  /// Ctrl+滚轮缩放回调（见 [ZoomStepDelegate]）。null 时 Ctrl+滚轮照旧透传滚动。
  final ZoomStepDelegate? onCtrlWheelZoom;

  const Webview(this.controller,
      {this.width,
      this.height,
      this.permissionRequested,
      this.scaleFactor,
      this.filterQuality = FilterQuality.none,
      this.onCtrlWheelZoom});

  @override
  _WebviewState createState() => _WebviewState();
}

class _WebviewState extends State<Webview> {
  final GlobalKey _key = GlobalKey();
  final _downButtons = <int, PointerButton>{};

  PointerDeviceKind _pointerKind = PointerDeviceKind.unknown;

  MouseCursor _cursor = SystemMouseCursors.basic;

  WebviewController get _controller => widget.controller;

  StreamSubscription? _cursorSubscription;

  @override
  void initState() {
    super.initState();

    // TODO: Refactor callback and event handling and
    // remove this line
    _controller._permissionRequested = widget.permissionRequested;

    // Report initial surface size
    WidgetsBinding.instance.addPostFrameCallback((_) => _reportSurfaceSize());

    _cursorSubscription = _controller._cursor.listen((cursor) {
      setState(() {
        _cursor = cursor;
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    return (widget.height != null && widget.width != null)
        ? SizedBox(
            key: _key,
            width: widget.width,
            height: widget.height,
            child: _buildInner())
        : SizedBox.expand(key: _key, child: _buildInner());
  }

  Widget _buildInner() {
    return NotificationListener<SizeChangedLayoutNotification>(
        onNotification: (notification) {
          _reportSurfaceSize();
          return true;
        },
        child: SizeChangedLayoutNotifier(
            child: _controller.value.isInitialized
                ? Listener(
                    onPointerHover: (ev) {
                      // ev.kind is for whatever reason not set to touch
                      // even on touch input
                      if (_pointerKind == PointerDeviceKind.touch) {
                        // Ignoring hover events on touch for now
                        return;
                      }
                      _controller._setCursorPos(ev.localPosition);
                    },
                    onPointerDown: (ev) {
                      _pointerKind = ev.kind;
                      if (ev.kind == PointerDeviceKind.touch) {
                        _controller._setPointerUpdate(
                            WebviewPointerEventKind.down,
                            ev.pointer,
                            ev.localPosition,
                            ev.size,
                            ev.pressure);
                        return;
                      }
                      final button = getButton(ev.buttons);
                      _downButtons[ev.pointer] = button;
                      _controller._setPointerButtonState(button, true);
                    },
                    onPointerUp: (ev) {
                      _pointerKind = ev.kind;
                      if (ev.kind == PointerDeviceKind.touch) {
                        _controller._setPointerUpdate(
                            WebviewPointerEventKind.up,
                            ev.pointer,
                            ev.localPosition,
                            ev.size,
                            ev.pressure);
                        return;
                      }
                      final button = _downButtons.remove(ev.pointer);
                      if (button != null) {
                        _controller._setPointerButtonState(button, false);
                      }
                    },
                    onPointerCancel: (ev) {
                      _pointerKind = ev.kind;
                      final button = _downButtons.remove(ev.pointer);
                      if (button != null) {
                        _controller._setPointerButtonState(button, false);
                      }
                    },
                    onPointerMove: (ev) {
                      _pointerKind = ev.kind;
                      if (ev.kind == PointerDeviceKind.touch) {
                        _controller._setPointerUpdate(
                            WebviewPointerEventKind.update,
                            ev.pointer,
                            ev.localPosition,
                            ev.size,
                            ev.pressure);
                      } else {
                        _controller._setCursorPos(ev.localPosition);
                      }
                    },
                    onPointerSignal: (signal) {
                      if (signal is PointerScrollEvent &&
                          widget.onCtrlWheelZoom != null &&
                          _isCtrlHeld()) {
                        widget.onCtrlWheelZoom!(
                            signal.scrollDelta.dy < 0 ? 1 : -1);
                        return;
                      }
                      if (signal is PointerScrollEvent) {
                        _controller.dispatchScrollAt(
                          signal.localPosition,
                          signal.scrollDelta,
                          widget.scaleFactor ??
                              WidgetsBinding
                                  .instance.platformDispatcher.views.first
                                  .devicePixelRatio,
                        );
                      }
                    },
                    onPointerPanZoomUpdate: (signal) {
                      _controller._setScrollDelta(
                          signal.panDelta.dx, signal.panDelta.dy);
                    },
                    child: MouseRegion(
                        cursor: _cursor,
                        child: Texture(
                          textureId: _controller._textureId,
                          filterQuality: widget.filterQuality,
                        )),
                  )
                : const SizedBox()));
  }

  void _reportSurfaceSize() async {
    final box = _key.currentContext?.findRenderObject() as RenderBox?;
    if (box != null) {
      await _controller.ready;
      unawaited(_controller._setSize(
          box.size, widget.scaleFactor ?? window.devicePixelRatio));
    }
  }

  @override
  void dispose() {
    super.dispose();
    _cursorSubscription?.cancel();
  }
}
