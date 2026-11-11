import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 桌面入口契约（源码级）测试。
 *
 * ⚠️ 铁律（用户 2026-10-13 明令）：桌面应用 exe 必须路由到真的桌面代码——
 * main.dart `_buildApp()` 在桌面平台必须走桌面链路（注册门禁 → 首启向导 →
 * AppSidebar 桌面主壳），`_isMobile` 只按平台判定（Android/iOS），任何调试/
 * 排查都不许伪造它或把桌面 exe 路由进手机壳（MobileLoginPage / MobileHomePage）。
 *
 * 调手机 UI 的通道（2026-11-10 更新）：不再有独立调试入口（main_mobile.dart
 * 已删除，入口分家曾导致「调试正常、真机没变」），手机 UI 一律走本生产入口
 * ——模拟器/真机 `flutter run` 跑 main.dart，App 级装配单源在
 * lib/app/mobile_bootstrap.dart。
 *
 * 为什么锁源码而不是锁运行时：本机 `flutter test` 不可用（管道耗尽），
 * 服务端测试直接读客户端源码做静态断言——这是项目里既有的契约锁法，
 * 改坏入口必挂 `cd server && node --import tsx --test`。
 */

const CLIENT_LIB = join(import.meta.dirname, "../../client/flutter_app/lib");
const mainDart = readFileSync(join(CLIENT_LIB, "main.dart"), "utf8");

test("_isMobile 只按平台判定：Android/iOS，桌面平台必须为 false", () => {
  // 精确匹配 getter 实现——任何人想放宽到 Windows（伪造桌面手机模式）都过不了
  assert.ok(
    mainDart.includes(
      "bool get _isMobile => !kIsWeb && (Platform.isAndroid || Platform.isIOS);",
    ),
    "_isMobile 必须保持「只按 Android/iOS 平台判定」的实现，禁止把桌面平台纳入手机分流",
  );
  // 防御性断言：getter 里不许出现桌面平台条件
  const getter = mainDart.match(/bool get _isMobile => [^;]+;/)?.[0] ?? "";
  assert.ok(
    !/isWindows|isMacOS|isLinux/.test(getter),
    "_isMobile 不允许包含桌面平台条件（isWindows/isMacOS/isLinux）",
  );
});

test("手机壳（MobileLoginPage/MobileHomePage）只允许在手机 gate 内出现一次", () => {
  // 桌面 exe 一旦被路由进手机壳，必然新增 MobileLoginPage/MobileHomePage 的实例化点
  // （2026-11-10 起 home 外层统一包 MobileSystemBars，手机壳以 child: 出现在 gate 内）
  assert.equal(
    (mainDart.match(/child: MobileLoginPage\(/g) ?? []).length,
    1,
    "MobileLoginPage 只能在 _buildMobileLoginGate 里作为 home 内容出现一次",
  );
  assert.equal(
    (mainDart.match(/child: MobileHomePage\(/g) ?? []).length,
    1,
    "MobileHomePage 只能在 _buildMobileMainGate 里作为 home 内容出现一次",
  );
  // 两个手机 gate 只能在 _buildApp 的 _isMobile 分支里各被 return 一次
  assert.equal(
    (mainDart.match(/return _buildMobileLoginGate\(\);/g) ?? []).length,
    1,
    "手机登录门禁只能在 _buildApp 的 _isMobile 分支返回",
  );
  assert.equal(
    (mainDart.match(/return _buildMobileMainGate\(\);/g) ?? []).length,
    1,
    "手机主壳只能在 _buildApp 的 _isMobile 分支返回",
  );
});

test("桌面链路完整：注册门禁 → 首启向导 → AppSidebar 桌面主壳仍在", () => {
  assert.ok(mainDart.includes("home: RegisterPage("), "桌面注册门禁必须存在");
  assert.ok(mainDart.includes("home: OnboardingFlow("), "桌面首启向导必须存在");
  assert.ok(mainDart.includes("AppSidebar("), "桌面主壳（AppSidebar）必须存在");
});

test("禁止伪造手机模式的调试开关（env/flag/写死）", () => {
  // 伪造通道排查：环境变量、编译期常量、全局调试开关都不许存在
  assert.ok(
    !/forceMobile|fakeMobile|debugMobile|kMobileDebug|MOBILE_MODE/i.test(mainDart),
    "main.dart 不允许出现伪造手机模式的调试开关",
  );
  // 手机 gate 前不许有环境变量旁路（kRegisterPreviewEnv 等既有 env 与手机壳无关，
  // 这里只锁「_buildMobile 前置条件只有 _accountEmail 判空」这一形状）
  const mobileBranch = mainDart.match(/if \(_isMobile\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(mobileBranch.includes("if (_isMobile)"), "手机分支必须由 _isMobile 守卫");
  assert.ok(
    !mobileBranch.includes("Platform.environment"),
    "手机分支内不许读环境变量做旁路",
  );
});

test("main_mobile.dart 独立调试入口已废除（2026-11-10），禁止重建分家入口", () => {
  // 曾经 main_mobile.dart 与 main.dart 各养一份系统栏装配，导致
  // 「模拟器调试正常、真机 APK 一点没变」的分家 bug。手机壳现在
  // 只允许从 main.dart 生产路径进入（_isMobile 分流），App 级装配
  // 单源在 lib/app/mobile_bootstrap.dart。
  assert.ok(
    !existsSync(join(CLIENT_LIB, "main_mobile.dart")),
    "禁止重建 main_mobile.dart 独立调试入口（手机 UI 一律走 main.dart 生产路径）",
  );
});
