# 手机离线必达推送 · 华为 Push Kit 直连

> 2026-10-13 定稿：移除极光（JPush），高可控直连华为。目标：手机端 WS 断开 /
> App 被杀后，日程提醒与重要主动消息经华为系统推送直达横幅弹窗。
> 不配服务端 env 时一切照旧（WS 在线直推），全链路 0 元。

## 链路总览

```
到点/主动消息 → ProactivePipeline（手机不在场 → 定向手机提案 targetDeviceClass=mobile）
  → HuaweiPushProvider（服务端直连）
     ① POST oauth-login.cloud.huawei.com/oauth2/v3/token（client_credentials 换 access token）
     ② POST push-api.cloud.huawei.com/v1/{appId}/messages:send（按 HMS token 定向）
        → 手机系统通知（横幅弹窗，channel_id="proactive" HIGH 渠道）
```

token 注册：客户端 `MobilePushRegistrar`（启动 + 每次 WS 连上，按 actorId 去重）
经 `MobilePushPlugin.kt`（HmsInstanceId.getToken）拿到 HMS token →
`POST /api/proactivity/push/register`（provider=huawei）→ `data/proactivity/push-tokens.json`。

## 已完成清单（无需再做）

- [x] 客户端依赖切到 `com.huawei.hms:push:6.12.0.300`，极光/小米插件已移除
- [x] `MobilePushPlugin.kt` 直取 HMS token（provider=huawei）
- [x] 服务端 `HuaweiPushProvider`（OAuth token 缓存 + messages:send）
- [x] AGC 应用 `com.nextbot.app` + SHA-256 指纹登记（桌面 nextbot-signing keystore）
- [x] `agconnect-services.json`：`android/app/`（agconnect 插件自动启用）+
      `android/app/src/main/assets/`（运行时读取 app_id）

## 你需要做的最后两步

1. **服务端 env**（重启生效）：
   ```
   HUAWEI_PUSH_APP_ID=6917618972894682511
   HUAWEI_PUSH_CLIENT_SECRET=<AGC 截图里的 Client Secret 全量>
   ```
2. **打 APK**：无需任何构建环境变量，直接 `.\client\flutter_app\build_apk.ps1`
   （注意：APK 需用登记指纹对应的签名。当前 release 仍是 debug 签名——把桌面
   `nextbot-signing` 的 keystore 接入 gradle 或在 AGC 登记 debug 签名指纹，
   二选一后再打，否则 HMS token 注册会静默失败。）

## 验证

1. 手机（华为/荣耀）登录后看日志：`[mobile-push] token registered (provider=huawei)`
2. 服务端 `GET /api/proactivity/push/status` → 该 actor 名下有 huawei token
3. **杀掉 App** → `POST /api/proactivity/push/test`（body: `{"actorId":"<登录邮箱>"}`）
   → 手机弹系统通知
4. 真实场景：设一条 1 分钟后的提醒 → 杀 App → 到点横幅弹窗
   （`GET /api/proactivity/diagnostics` 可看提案走了 mobile_push/huawei 通道）

## 能力边界与后续

- **仅华为/荣耀设备**：HMS Core 只在华为/荣耀 ROM 上存在。小米/红米设备杀 App 后
  收不到推送（App 在线时走 WS 不受影响）。要覆盖小米需另接 MiPush 直连
  （客户端 SDK + 服务端 API，模式与华为直连同构），按需再做。
- **JPushProvider 类保留休眠**：服务端代码留着但已从激活列表移除（不再吃 env），
  未来想恢复聚合模式把 `JPushProvider.fromEnv` 加回 envProviders 即可。
- **webhook/bark 兜底**：`MOBILE_PUSH_WEBHOOK_URL` / `BARK_URL` 通道仍可用，与
  huawei 通道并存（多设备多 provider 任一成功即止）。
- iOS 未实现（client 无 ios/ 目录），iOS 设备用 `BARK_URL` 零改造接入。
