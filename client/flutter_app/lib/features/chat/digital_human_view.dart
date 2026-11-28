// 数字人视图 —— 按平台自动选择实现。
//
// - 原生平台(io):`digital_human_view_io.dart` —— Windows 走 webview_windows
//   (WebView2)，Android/iOS 转交 webview_flutter 的 mobile 实现。
// - Web(html):`digital_human_view_stub.dart` 占位。
//
// 为何要分化：webview_flutter 在 Windows 没有平台实现，WebViewController()
// 会落到 fallback 图标（截图里那个转圈）而非真实数字人流。
export "digital_human_view_io.dart" //
    if (dart.library.html) "digital_human_view_stub.dart";
