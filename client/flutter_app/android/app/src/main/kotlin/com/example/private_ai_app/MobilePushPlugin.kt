package com.example.private_ai_app

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.huawei.hms.aaid.HmsInstanceId
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * 移动端推送通道（pai/mobile_push）—— 华为 HMS Push 直连。
 *
 * Dart 侧 MobilePushRegistrar 启动/WS 重连时调 getPushToken，把 HMS push token 上报
 * 服务端（POST /api/proactivity/push/register，provider=huawei），用于手机端离线
 * （WS 断开/App 被杀）后的离线必达：服务端 HuaweiPushProvider 经华为 OAuth +
 * Push Kit API 直推系统通知，不经任何第三方聚合。
 *
 * 前置条件（缺一则 getPushToken 返回 configured=false，Dart 静默降级）：
 *   1) assets/agconnect-services.json（源 = android/app/src/main/assets/ 同名文件，
 *      直接打进 APK assets；android/app/ 根的另一份无插件消费，仅为存档，
 *      两处必须手工同步，勿只改其一——2026-10-14 旧 app_id 残留即此坑）
 *   2) AGC 后台登记的签名指纹与实际签名一致（HMS 注册强校验）
 *
 * 契约（getPushToken 返回值）：
 *   {"provider":"huawei","configured":false}                       —— 无 AGC 配置（Dart 放弃）
 *   {"provider":"huawei","configured":true,"token":""}             —— token 未就绪（Dart 退避重试）
 *   {"provider":"huawei","configured":true,"token":"<rid>"}        —— 就绪（Dart 上报服务端）
 */
class MobilePushPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var appContext: Context? = null
    private var appId: String? = null
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME).also {
            it.setMethodCallHandler(this)
        }
        appId = readAgConnectAppId(binding.applicationContext)
    }

    /** 从 assets 读取 AGC 配置的应用 ID（getToken 需要）；缺文件 = 未配置推送 */
    private fun readAgConnectAppId(context: Context): String? = try {
        val raw = context.assets.open("agconnect-services.json").bufferedReader().use { it.readText() }
        JSONObject(raw).getJSONObject("client").optString("app_id").takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
        null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getPushToken" -> {
                val context = appContext
                val id = appId
                if (context == null || id == null) {
                    result.success(mapOf("provider" to PROVIDER, "configured" to false))
                    return
                }
                // 快路径：PushTokenService.onNewToken 已缓存 token（系统事件回调，
                // 后台也会送达）→ 立即返回，无需等 getToken 网络握手
                val cached = try {
                    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getString(KEY_TOKEN, null)
                } catch (_: Exception) {
                    null
                }
                if (!cached.isNullOrEmpty()) {
                    result.success(mapOf("provider" to PROVIDER, "configured" to true, "token" to cached))
                    return
                }
                // 慢路径：getToken 是阻塞调用（SDK 内部走网络），必须离开主线程；
                // 成功后写缓存，供后续快路径命中；失败把 HMS 报错带出（远程诊断用）
                executor.execute {
                    var token = ""
                    var err = ""
                    try {
                        token = HmsInstanceId.getInstance(context).getToken(id, "HCM") ?: ""
                        if (token.isEmpty()) err = "getToken returned empty"
                    } catch (t: Throwable) {
                        err = "${t.javaClass.simpleName}: ${t.message ?: "unknown"}"
                    }
                    if (token.isNotEmpty()) {
                        try {
                            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                .edit().putString(KEY_TOKEN, token).apply()
                        } catch (_: Exception) {
                        }
                    }
                    mainHandler.post {
                        result.success(
                            mapOf(
                                "provider" to PROVIDER,
                                "configured" to true,
                                "token" to token,
                                "err" to err,
                            )
                        )
                    }
                }
            }
            else -> result.notImplemented()
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
    }

    companion object {
        private const val CHANNEL_NAME = "pai/mobile_push"
        private const val PROVIDER = "huawei"
        const val PREFS = "pai_push"
        const val KEY_TOKEN = "hms_token"
    }
}
