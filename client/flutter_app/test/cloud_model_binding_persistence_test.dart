/// 用户自有模型 key 的跨卸载保活回归（2026-11-12）。
///
/// 事故形态：key 明文只写 App 私有目录（卸载必删），服务端加密绑定按随机
/// `inst_时间戳` 索引（重装必换），两头都断，用户重装后必须重新填 key。
///
/// 锁四件事：
///  1. 私有文件缺失（模拟卸载重装）→ 自动从公共加密备份读回并回写自愈；
///  2. 保存/清空双写，清空用 revoked 覆盖记录，不会在重装后幽灵复活；
///  3. 备份通道不可用（桌面/权限受限）→ 回落原有私有文件语义，不阻断保存；
///  4. 安装标识由稳定设备 id 派生，卸载重装后仍是同一个 actor，
///     服务端 model-keys 目录下按 actor 的加密绑定 因此能继续命中。
library;

import "dart:convert";
import "dart:io";

import "package:flutter/services.dart" show MethodCall, MethodChannel;
import "package:flutter_test/flutter_test.dart";
import "package:path_provider/path_provider.dart";

import "package:nextbot/core/services/cloud_model_binding_store.dart";
import "package:nextbot/core/services/device_key_backup.dart";
import "package:nextbot/core/services/install_identity.dart";
import "package:nextbot/core/services/ws_session_init.dart";

const String _privateFile = "cloud_model_binding.json";
const String _identityFile = "install_identity.json";
const String _stableId = "inst_stable_deadbeef00112233";
const MethodChannel _testChannel = MethodChannel(DeviceKeyBackup.channelName);

String _binding(String key) => jsonEncode(<String, String>{
      "baseUrl": "https://api.deepseek.com",
      "apiKey": key,
      "model": "deepseek-chat",
    });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory temp;
  final List<MethodCall> calls = <MethodCall>[];
  String? backupPayload;
  String? stableId;

  void installMockHandler() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_testChannel, (MethodCall call) async {
      calls.add(call);
      switch (call.method) {
        case "stableInstallId":
          return stableId;
        case "readBackup":
          return backupPayload;
        case "writeBackup":
          backupPayload = (call.arguments as Map)["json"] as String?;
          return true;
        case "deleteBackup":
          backupPayload = null;
          return true;
      }
      return null;
    });
  }

  Future<File> privateFile() async => File("${temp.path}/$_privateFile");
  Future<File> identityFile() async => File("${temp.path}/$_identityFile");

  setUp(() async {
    temp = await Directory.systemTemp.createTemp("byok-survive-");
    CloudModelBindingStore.directoryResolver = () async => temp;
    InstallIdentity.directoryResolver = () async => temp;
    CloudModelBindingStore.instance.resetForTest();
    InstallIdentity.instance.resetForTest();
    DeviceKeyBackup.debugForceAvailable = true;
    calls.clear();
    backupPayload = null;
    stableId = _stableId;
    installMockHandler();
  });

  tearDown(() async {
    DeviceKeyBackup.debugForceAvailable = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_testChannel, null);
    CloudModelBindingStore.directoryResolver = getApplicationSupportDirectory;
    InstallIdentity.directoryResolver = getApplicationSupportDirectory;
    if (await temp.exists()) await temp.delete(recursive: true);
  });

  test("私有文件在时优先用私有值，不读跨卸载备份", () async {
    await (await privateFile()).writeAsString(_binding("sk-private"));
    backupPayload = _binding("sk-from-backup");
    await CloudModelBindingStore.instance.load();
    expect(CloudModelBindingStore.instance.apiKey, "sk-private");
    expect(calls.where((c) => c.method == "readBackup"), isEmpty);
  });

  test("私有文件缺失（卸载重装）→ 从备份恢复并回写私有文件", () async {
    backupPayload = _binding("sk-survived");
    await CloudModelBindingStore.instance.load();
    final store = CloudModelBindingStore.instance;
    expect(store.isConfigured, isTrue);
    expect(store.apiKey, "sk-survived");
    expect(store.baseUrl, "https://api.deepseek.com");
    expect(await (await privateFile()).exists(), isTrue,
        reason: "恢复后必须回写私有文件自愈，下次启动不必再走原生通道");
  });

  test("保存双写：私有文件 + 公共加密备份", () async {
    await CloudModelBindingStore.instance.load();
    await CloudModelBindingStore.instance.save(
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-new",
      model: "deepseek-chat",
    );
    expect(await (await privateFile()).readAsString(), contains("sk-new"));
    expect(backupPayload, contains("sk-new"));
    expect(calls.where((c) => c.method == "writeBackup").length, 1);
  });

  test("清空：删私有文件 + 写 revoked 覆盖记录", () async {
    await CloudModelBindingStore.instance.save(
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-new",
      model: "deepseek-chat",
    );
    await CloudModelBindingStore.instance.clear();
    expect(CloudModelBindingStore.instance.isConfigured, isFalse);
    expect(await (await privateFile()).exists(), isFalse);
    expect(backupPayload, '{"revoked":true}');
  });

  test("revoked 备份不会把已停用的配置复活", () async {
    backupPayload = '{"revoked":true}';
    await CloudModelBindingStore.instance.load();
    expect(CloudModelBindingStore.instance.isConfigured, isFalse);
  });

  test("备份通道不可用（桌面）→ 回落私有文件语义，保存仍成功", () async {
    DeviceKeyBackup.debugForceAvailable = false;
    await CloudModelBindingStore.instance.save(
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-desktop",
      model: "deepseek-chat",
    );
    expect(CloudModelBindingStore.instance.isConfigured, isTrue);
    expect(await (await privateFile()).readAsString(), contains("sk-desktop"));
    expect(calls.where((c) => c.method == "writeBackup"), isEmpty);
  });

  test("稳定安装 id：删掉身份文件重装后仍是同一个 actor", () async {
    await InstallIdentity.instance.applyBootChannel();
    expect(InstallIdentity.instance.cachedInstallId, _stableId);
    expect(await (await identityFile()).exists(), isTrue);

    await (await identityFile()).delete();
    InstallIdentity.instance.resetForTest();
    await InstallIdentity.instance.applyBootChannel();
    expect(InstallIdentity.instance.cachedInstallId, _stableId,
        reason: "重装后必须命中服务端同一份 model-keys 目录下按 actor 的加密绑定");
  });

  test("老随机 id 平滑迁移到稳定 id，保留 legacy 与 channel", () async {
    await (await identityFile()).writeAsString(jsonEncode(<String, String>{
      "installId": "inst_old_random",
      "channel": "byok",
    }));
    await InstallIdentity.instance.applyBootChannel();
    expect(InstallIdentity.instance.cachedInstallId, _stableId);
    final Map<String, dynamic> saved =
        jsonDecode(await (await identityFile()).readAsString()) as Map<String, dynamic>;
    expect(saved["legacyInstallId"], "inst_old_random");
    expect(saved["channel"], "byok");
  });

  test("取不到设备标识（桌面）时回落随机 id 且跨启动稳定", () async {
    stableId = null;
    await InstallIdentity.instance.applyBootChannel();
    final String? first = InstallIdentity.instance.cachedInstallId;
    expect(first, isNotNull);
    expect(first, startsWith("inst_"));
    InstallIdentity.instance.resetForTest();
    await InstallIdentity.instance.applyBootChannel();
    expect(InstallIdentity.instance.cachedInstallId, first);
  });

  test("session.init 撤绑语义：缺字段=保留，空对象=撤绑，三元组=绑定", () async {
    await InstallIdentity.instance.applyBootChannel();
    // 未配置绑定 + 普通补发 → 不带 modelProvider（服务端语义=保留已有绑定，
    // 与旧客户端/桥接通道兼容）。
    Map<String, dynamic> init = buildWsSessionInit();
    expect(init.containsKey("modelProvider"), isFalse,
        reason: "普通握手绝不能误撤云端绑定");
    // 停用自有模型（clearModelBinding: true）→ 必须显式空对象，服务端才撤绑；
    // 不然云端绑定残留，重装后幽灵复活。
    init = buildWsSessionInit(announceModelUnbind: true);
    expect(init["modelProvider"], <String, dynamic>{});
    // 已配置绑定 → 带完整三元组。
    await CloudModelBindingStore.instance.save(
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-init",
      model: "deepseek-chat",
    );
    init = buildWsSessionInit();
    final Map<dynamic, dynamic> mp = init["modelProvider"] as Map<dynamic, dynamic>;
    expect(mp["apiKey"], "sk-init");
    expect(mp["baseUrl"], "https://api.deepseek.com");
    expect(mp["model"], "deepseek-chat");
  }, timeout: const Timeout(Duration(seconds: 60)));
}
