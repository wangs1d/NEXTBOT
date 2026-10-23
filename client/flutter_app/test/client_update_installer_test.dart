// 一键更新链路单测：应用内下载控制器的状态机与落盘行为（真实临时目录 +
// mock http），以及静默安装 cmd 脚本的关键内容。UI 层不在此测。
import "dart:async";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart" as http;

import "package:nextbot/core/services/client_update_installer.dart";

void main() {
  late Directory storageDir;

  setUp(() async {
    storageDir = await Directory.systemTemp.createTemp("upd_flow_test");
  });

  tearDown(() async {
    if (storageDir.existsSync()) {
      await storageDir.delete(recursive: true);
    }
  });

  ClientUpdateFlowController buildController({
    required http.Client client,
    required String url,
  }) {
    return ClientUpdateFlowController(
      downloadUrl: url,
      version: "0.2.2",
      httpClient: client,
      storageDir: storageDir,
    );
  }

  http.MockClient mockServer({
    List<List<int>> chunks = const <List<int>>[],
    int? contentLength,
    int getStatus = 200,
    void Function()? onGet,
  }) {
    return http.MockClient.streaming(
      (http.BaseRequest request, http.ByteStream _) async {
        if (request.method == "HEAD") {
          return http.StreamedResponse(
            const Stream<List<int>>.empty(),
            200,
            headers: contentLength == null
                ? const <String, String>{}
                : <String, String>{"content-length": "$contentLength"},
          );
        }
        onGet?.call();
        if (getStatus != 200) {
          return http.StreamedResponse(
            const Stream<List<int>>.empty(),
            getStatus,
          );
        }
        return http.StreamedResponse(
          Stream<List<int>>.fromIterable(chunks),
          200,
          contentLength: contentLength ?? chunks.fold<int>(0, (int a, List<int> b) => a + b.length),
        );
      },
    );
  }

  const String fakeUrl = "http://ecs.example.com/downloads/Nextbot-Setup-0.2.2.exe";

  test("下载完成：落盘、进度到 100%、状态 downloaded", () async {
    final ClientUpdateFlowController c = buildController(
      client: mockServer(chunks: <List<int>>[
        List<int>.filled(3, 1),
        List<int>.filled(5, 2),
      ]),
      url: fakeUrl,
    );
    addTearDown(c.dispose);

    await c.begin();

    expect(c.phase, ClientUpdatePhase.downloaded);
    expect(c.progress, 1.0);
    expect(c.received, 8);
    final File f = File("${storageDir.path}${Platform.pathSeparator}Nextbot-Setup-0.2.2.exe");
    expect(f.existsSync(), isTrue);
    expect(f.lengthSync(), 8);
  });

  test("已有同尺寸成品：复用不再发起 GET", () async {
    final File existing = File(
      "${storageDir.path}${Platform.pathSeparator}Nextbot-Setup-0.2.2.exe",
    );
    existing.writeAsBytesSync(List<int>.filled(8, 9));
    int getCalls = 0;
    final ClientUpdateFlowController c = buildController(
      client: mockServer(contentLength: 8, onGet: () => getCalls++),
      url: fakeUrl,
    );
    addTearDown(c.dispose);

    await c.begin();

    expect(c.phase, ClientUpdatePhase.downloaded);
    expect(getCalls, 0);
    expect(existing.readAsBytesSync()[0], 9);
  });

  test("服务端 500：进入 failed 且带错误文案", () async {
    final ClientUpdateFlowController c = buildController(
      client: mockServer(getStatus: 500),
      url: fakeUrl,
    );
    addTearDown(c.dispose);

    await c.begin();

    expect(c.phase, ClientUpdatePhase.failed);
    expect(c.error, isNotNull);
  });

  test("下载中取消：回到 idle 且 .part 清理，begin 正常收尾", () async {
    final StreamController<List<int>> stalled = StreamController<List<int>>();
    final ClientUpdateFlowController c = buildController(
      client: http.MockClient.streaming(
        (http.BaseRequest request, http.ByteStream _) async {
          if (request.method == "HEAD") {
            return http.StreamedResponse(
              const Stream<List<int>>.empty(),
              200,
              headers: const <String, String>{"content-length": "1000"},
            );
          }
          return http.StreamedResponse(stalled.stream, 200, contentLength: 1000);
        },
      ),
      url: fakeUrl,
    );
    addTearDown(c.dispose);
    addTearDown(stalled.close);

    final Future<void> begun = c.begin();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(c.phase, ClientUpdatePhase.downloading);
    expect(Directory(storageDir.path).listSync().any(
          (FileSystemEntity e) => e.path.endsWith(".part"),
        ), isTrue);

    await c.cancel();
    await begun;

    expect(c.phase, ClientUpdatePhase.idle);
    expect(
      Directory(storageDir.path).listSync().any(
            (FileSystemEntity e) => e.path.endsWith(".part"),
          ),
      isFalse,
    );
  });

  test("非 exe 直链时文件名回落为 Nextbot-Setup-<版本>.exe", () async {
    final ClientUpdateFlowController c = buildController(
      client: mockServer(chunks: <List<int>>[<int>[1]]),
      url: "http://ecs.example.com/downloads/blob/abc123",
    );
    addTearDown(c.dispose);

    await c.begin();

    expect(
      File("${storageDir.path}${Platform.pathSeparator}Nextbot-Setup-0.2.2.exe")
          .existsSync(),
      isTrue,
    );
  });

  test("静默安装脚本：等退轮询 + 静默参数 + 拉起新版三要素齐备", () {
    final String s = ClientUpdateFlowController.kApplyUpdateScript;
    expect(s, contains('tasklist /FI "PID eq %1"'));
    expect(s, contains(":waitloop"));
    expect(s, contains("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS"));
    expect(s, contains('start "" "%3"'));
    // detached 无控制台：必须用 ping 做延时，timeout 会立即失败导致空转
    expect(s, contains("ping -n 2 127.0.0.1"));
    expect(s, isNot(contains("timeout ")));
  });
}
