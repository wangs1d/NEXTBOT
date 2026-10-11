import "dart:async";
import "dart:convert";
import "dart:io";

import "package:url_launcher/url_launcher.dart";

import "../../core/config/api_config.dart";
import "../../core/theme/app_theme.dart";
import "../../core/utils/agent_result_parser.dart";
import "travel_plan_models.dart";
import "travel_web_panel_controller.dart" show TravelWebPanelPayload;

/// 行程卡 → 本机 server 页面 + 浏览器打开（**手机端路径**）。
///
/// 桌面端自 2026-10-11 起不再走这里：行程统一在独立系统窗口里以「行迹」桌面页
/// 1:1 呈现（见 main.dart `_openTravelPlanWindow`）。手机端没有可用的应用内行程
/// 界面（webview_windows 不支持移动端），浏览器仍是唯一可行路径，故保留。
///
/// 取数（真实数据优先）：
/// - 卡片带服务端 `planId`（Agent 生成时已落盘）→ 页面直接读仓库
///   `GET /travel/plans/:planId`（`?planId=` 打开），零拷贝、即真实数据；
/// - 仅文本兜底行程（无 planId）→ 本地转载荷 `POST /travel-plans` 存进内存
///   （24h TTL），页面 `?id=` 同源取回。
///
/// 进入方式按平台分流（页面本体也由服务端按 UA 分流）：
/// - Android / iOS：应用内浏览器（`LaunchMode.inAppBrowserView`），不离开 App；
///   服务端把手机 UA 分流到竖屏版 `/travel-map`。应用内浏览器不可用时退系统浏览器。
/// - Windows / 桌面：系统浏览器（`externalApplication`），服务端给桌面双栏版。
///
/// server 不可达 / 超时 / 打开失败一律返回 false，调用方降级到
/// [TravelPlanWindowLauncher]（独立子进程窗口）→ 应用内全屏页。
class TravelPlanBrowserLauncher {
  TravelPlanBrowserLauncher._();

  static const Duration _timeout = Duration(seconds: 4);

  /// 尝试经本机 server 用浏览器打开行程；失败返回 false。
  static Future<bool> open(AgentResultData data) async {
    HttpClient? client;
    try {
      final TravelPlanData plan = TravelPlanData.from(data);

      // 取数策略：手机端且卡片已带服务端 planId（Agent 生成时已落盘到数据仓库）→ 直接
      // 让页面读真实仓库 GET /travel/plans/:planId，零拷贝、天然就是真实数据。
      // 其余情况（纯文本兜底行程没有 planId）回落到
      // 「本机 POST 内存载荷」这条老路。
      final bool mobile = Platform.isAndroid || Platform.isIOS;
      final Uri base = Uri.parse(ApiConfig.httpBase);
      final bool useStore = mobile && plan.hasPlanId;
      String? storeId;
      if (useStore) {
        storeId = plan.planId;
      } else {
        final Map<String, dynamic> payload = TravelWebPanelPayload.build(
          plan,
          // 浏览器自带全屏/关闭，页面内按钮语义不同：
          // fullscreen:false 保留页内全屏按钮；closable:false 隐藏页内关闭按钮
          fullscreen: false,
          closable: false,
        );
        // 页面主题令牌组：App 暗色变体 → 深色霓虹；暖色变体 → 浅色
        payload["theme"] =
            AppThemeController.instance.value == AppThemeVariant.dark ? "dark" : "light";

        final Uri storeUri = base.replace(
          path: "${base.path}/travel-plans".replaceAll("//", "/"),
        );

        client = HttpClient()..connectionTimeout = _timeout;
        final HttpClientRequest request = await client
            .postUrl(storeUri)
            .timeout(_timeout);
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(payload));
        final HttpClientResponse response =
            await request.close().timeout(_timeout);
        if (response.statusCode != 200) return false;
        final String body =
            await response.transform(utf8.decoder).join().timeout(_timeout);
        final Object? decoded = jsonDecode(body);
        final Object? rawId = decoded is Map ? decoded["id"] : null;
        final String id = rawId?.toString() ?? "";
        if (id.isEmpty) return false;
        storeId = id;
      }

      final Uri pageUri = base.replace(
        // 引导页而非直接开行程页：已有行程页打开时经 BroadcastChannel 认领并
        // 热换载数据（地图不重新 Boot），引导页自动关闭——标签页复用零冷启动；
        // 无已开页面时引导页 450ms 后自行跳转到正常行程页
        path: "${base.path}/travel-map/switch".replaceAll("//", "/"),
        // 真实仓库用 planId=，内存载荷用 id=；服务端引导页按参数选择转发方式
        queryParameters: useStore
            ? <String, String>{"planId": storeId}
            : <String, String>{"id": storeId},
      );
      // 手机端优先应用内浏览器（不离开 App）；in-app 不可用（无 Custom Tabs /
      // 平台不支持）时退系统浏览器，保证"点了总能看到界面"。
      if (Platform.isAndroid || Platform.isIOS) {
        try {
          if (await launchUrl(pageUri, mode: LaunchMode.inAppBrowserView)) {
            return true;
          }
        } catch (_) {
          // 落到系统浏览器
        }
      }
      return launchUrl(pageUri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // server 未启动 / 超时 / 浏览器打开失败：交给调用方降级
      return false;
    } finally {
      client?.close();
    }
  }
}
