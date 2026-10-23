import "dart:convert";
import "dart:typed_data";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";

import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/presentation/user_avatar.dart";
import "package:nextbot/core/services/user_avatar_api.dart";

/// 用户头像能力测试（客户端侧）：
/// - [UserAvatarApi.resolveUrl] 相对路径 → 本端绝对 URL 的拼装规则
/// - [UserAvatarApi.fetchAvatarPath] 各响应分支（有 / 无 / 失败）
/// - [UserAvatarApi.uploadAvatar] multipart 上传出口（请求形态 + 返回值）
/// - [UserAvatar] 组件：无图回退 fallback，有图渲染 Image
void main() {
  const String relativePath = "/agent/avatars/me@test.com/abc.webp";

  group("UserAvatarApi.resolveUrl", () {
    test("相对路径拼本端 httpBase 成绝对地址", () {
      expect(
        UserAvatarApi.resolveUrl(relativePath),
        "${ApiConfig.httpBase}$relativePath",
      );
    });

    test("已是 http/https 绝对地址则原样返回", () {
      const String abs = "https://cdn.example.com/a.webp";
      expect(UserAvatarApi.resolveUrl(abs), abs);
      const String absHttp = "http://127.0.0.1:3000/x.webp";
      expect(UserAvatarApi.resolveUrl(absHttp), absHttp);
    });

    test("null / 空串 / 纯空白 → null（调用方据此渲染 fallback）", () {
      expect(UserAvatarApi.resolveUrl(null), isNull);
      expect(UserAvatarApi.resolveUrl(""), isNull);
      expect(UserAvatarApi.resolveUrl("   "), isNull);
    });
  });

  group("UserAvatarApi.fetchAvatarPath", () {
    test("有头像 → 返回相对路径", () async {
      final UserAvatarApi api = UserAvatarApi(
        baseUrl: "http://127.0.0.1:3000",
        client: MockClient((http.Request request) async {
          expect(request.method, "GET");
          expect(request.url.path, "/api/user/avatar");
          expect(request.url.queryParameters["userId"],
              ApiConfig.effectiveActorId);
          return http.Response(
            jsonEncode(<String, Object?>{
              "ok": true,
              "avatarPath": relativePath,
            }),
            200,
            headers: <String, String>{
              "content-type": "application/json; charset=utf-8",
            },
          );
        }),
      );
      expect(await api.fetchAvatarPath(), relativePath);
    });

    test("无头像（avatarPath=null）→ null", () async {
      final UserAvatarApi api = UserAvatarApi(
        client: MockClient((http.Request _) async => http.Response(
              jsonEncode(<String, Object?>{"ok": true, "avatarPath": null}),
              200,
            )),
      );
      expect(await api.fetchAvatarPath(), isNull);
    });

    test("ok=false / 非 200 / 网络异常 → null（静默降级）", () async {
      final UserAvatarApi notOk = UserAvatarApi(
        client: MockClient((http.Request _) async =>
            http.Response(jsonEncode(<String, Object?>{"ok": false}), 200)),
      );
      expect(await notOk.fetchAvatarPath(), isNull);

      final UserAvatarApi serverError = UserAvatarApi(
        client:
            MockClient((http.Request _) async => http.Response("boom", 500)),
      );
      expect(await serverError.fetchAvatarPath(), isNull);

      final UserAvatarApi thrown = UserAvatarApi(
        client: MockClient((http.Request _) async => throw Exception("offline")),
      );
      expect(await thrown.fetchAvatarPath(), isNull);
    });
  });

  group("UserAvatarApi.uploadAvatar", () {
    final Uint8List pngBytes = Uint8List.fromList(<int>[
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02
    ]);

    test("multipart 上传成功 → 返回新 avatarPath，请求形态正确", () async {
      late http.Request captured;
      final UserAvatarApi api = UserAvatarApi(
        baseUrl: "http://127.0.0.1:3000",
        client: MockClient((http.Request request) async {
          captured = request;
          return http.Response(
            jsonEncode(<String, Object?>{
              "ok": true,
              "avatarPath": relativePath,
            }),
            200,
          );
        }),
      );
      final String? path = await api.uploadAvatar(pngBytes, "me.png");
      expect(path, relativePath);
      expect(captured.method, "POST");
      expect(captured.url.path, "/api/user/avatar");
      expect(captured.url.queryParameters["userId"],
          ApiConfig.effectiveActorId);
      expect(captured.headers["content-type"], startsWith("multipart/form-data"));
      // 文件字段名 file + 原始文件名都要进 body（服务端按 multipart 取流）
      final String body = latin1.decode(captured.bodyBytes);
      expect(body, contains('name="file"'));
      expect(body, contains('filename="me.png"'));
    });

    test("服务端拒绝 / 非 200 → null（调用方弹失败提示）", () async {
      final UserAvatarApi rejected = UserAvatarApi(
        client: MockClient((http.Request _) async => http.Response(
              jsonEncode(<String, Object?>{
                "ok": false,
                "error": "无法解析的图片文件",
              }),
              400,
            )),
      );
      expect(await rejected.uploadAvatar(pngBytes, "x.png"), isNull);

      final UserAvatarApi thrown = UserAvatarApi(
        client: MockClient((http.Request _) async => throw Exception("offline")),
      );
      expect(await thrown.uploadAvatar(pngBytes, "x.png"), isNull);
    });
  });

  group("UserAvatar 组件", () {
    Widget fallback() => const SizedBox(key: Key("fallback"), width: 32);

    testWidgets("url 为空 → 直接渲染 fallback，不发起网络加载", (WidgetTester tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: UserAvatar(url: null, size: 32, fallback: fallback()),
        ),
      ));
      expect(find.byKey(const Key("fallback")), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    });

    testWidgets("url 非空 → 渲染网络图片（加载失败才回退 fallback）", (WidgetTester tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: UserAvatar(
            url: "${ApiConfig.httpBase}$relativePath",
            size: 32,
            fallback: fallback(),
          ),
        ),
      ));
      expect(find.byType(Image), findsOneWidget);
      // 圆形裁剪容器按 size 落位
      final SizedBox box = tester.widget<SizedBox>(
        find.descendant(
          of: find.byType(ClipOval),
          matching: find.byType(SizedBox),
        ),
      );
      expect(box.width, 32);
      expect(box.height, 32);
    });
  });
}
