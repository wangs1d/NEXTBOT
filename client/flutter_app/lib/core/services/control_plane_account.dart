import "dart:convert";

import "package:http/http.dart" as http;

import "../config/api_config.dart";
import "account_session_store.dart";
import "install_identity.dart";
import "./nb_http.dart";

/// 控制面账号自注册。
///
/// 捆绑形态下账号/世界数据都在本地 runtime，控制面（管理后台所在服务器）
/// 的收件人列表里没有这个用户——后台「全体用户」群发站内信时会直接跳过，
/// 用户永远收不到。这里在启动时向控制面补注册一行账号，幂等：已存在时
/// 视为成功。
///
/// 身份：已登录时用登录邮箱（与 /accounts/web 网页注册同一行账号，后台
/// 用户列表只见一行；换邮箱登录=另一行，互不串台）；未登录且无部署配置
/// USER_ID 时不注册——避免再插一行 inst_ 安装身份造成「一人两行」，
/// 登录完成后由调用方（main._completeWebAuth）补注册。安装身份兜底仅
/// 保留给显式配了 USER_ID 的部署形态。
class ControlPlaneAccount {
  ControlPlaneAccount._();

  static const Duration _timeout = Duration(seconds: 10);

  /// 确保当前登录身份在控制面有账号行。返回是否就绪（新注册或已存在）。
  static Future<bool> ensureRegistered({http.Client? client}) async {
    final http.Client c = client ?? NbClient();
    try {
      // 自带 load（幂等）：不依赖调用方先初始化账号会话，避免启动竞态
      await AccountSessionStore.instance.load();
      final String? email = AccountSessionStore.instance.email;
      final String actorId;
      final String displayName;
      final Map<String, String> body = <String, String>{};
      if (email != null && email.isNotEmpty) {
        actorId = email;
        displayName = email.split("@").first;
        body["email"] = email;
      } else {
        final String deployUserId = await InstallIdentity.instance.actorId();
        if (deployUserId.startsWith("inst_") || deployUserId == "local-device") {
          // 未登录且无部署配置：不注册，等登录后由 _completeWebAuth 补注册
          return false;
        }
        actorId = deployUserId;
        displayName = deployUserId;
      }
      body["userId"] = actorId;
      body["displayName"] = displayName;
      final http.Response res = await c
          .post(
            Uri.parse("${ApiConfig.controlPlaneBase}/accounts/register"),
            headers: const <String, String>{
              "Content-Type": "application/json",
            },
            body: jsonEncode(body),
          )
          .timeout(_timeout);
      final Map<String, dynamic> data =
          jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data["ok"] == true) return true;
      // 已注册过：服务端报「该用户已存在 Agent 账号」，同样视为就绪
      final String message = data["message"]?.toString() ?? "";
      if (message.contains("已存在")) return true;
      return false;
    } catch (_) {
      // 控制面不可达不打断启动；下次启动重试
      return false;
    } finally {
      if (client == null) c.close();
    }
  }
}
