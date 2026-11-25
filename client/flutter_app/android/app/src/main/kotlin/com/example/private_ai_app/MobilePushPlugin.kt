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
import java.util.concurrent.atomic.AtomicReference

/**
 * 移动端推送通道（pai/mobile_push）—— 华为 HMS Push 直连。
 *
 * Dart 侧 MobilePushRegistrar 启动/WS 重连时调 getPushToken，把 HMS push token 上报
 * 服务端（POST /api/proactivity/push/register，provider=huawei），用于手机端离线
 * （WS 断开/App 被杀）后的离线必达：服务端 HuaweiPushProvider 经华为 OAuth +
 * Push Kit API 直推系统通知，不经任何第三方聚合。
 *
 * 前置条件（缺一则 getPushToken 返回 configured=false，Dart 静默降级）：
 *   1) assets/agconnect-services.json —— **单一源** android/app/agconnect-services.json，
 *      构建期由 Gradle 任务 syncAgcAssets 复制到 build/generated/agc-assets 再并入
 *      assets（见 app/build.gradle.kts）。仓库里不再保留 src/main/assets 的第二份副本：
 *      2026-11-22 换 AGC 应用时只改了 app/ 那一份，assets 里的旧 app_id 仍覆盖生效，
 *      APK 内 app_id 依旧是上一个应用，HMS 必然拿不到 token。
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

    /**
     * 取 token 的并发闸（2026-11-22）。
     *
     * HMS 的 getToken 在「应用信息不一致 / 网络异常」时可能**永不返回**。旧实现
     * 既无超时也无闸门：一次挂死 → Dart 侧 await 永不完成 → 既拿不到 token、
     * 也不上报任何失败（实测新包启动后 8 分钟零上报零日志）；而 Dart 的 60s
     * 自愈定时器仍会不断发起新调用，任务越堆越多。
     */
    @Volatile
    private var tokenInFlight = false

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
            // 透传写穿（2026-11-25）：取走 App 被杀/后台期间 HMS 投递到
            // PushTokenService 的消息队列，由 Dart 写进本地对话。
            "takePushed" -> {
                val context = appContext
                if (context == null) {
                    result.success(emptyList<Map<String, Any?>>())
                    return
                }
                result.success(PushTokenService.takeAll(context))
            }
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
                // 成功后写缓存，供后续快路径命中；失败把 HMS 报错带出（远程诊断用）。
                //
                // 2026-11-22 加固：HMS 可能永不返回（见 tokenInFlight 注释）。这里
                // 用「单线程闸 + 15s 超时」把挂死转成一条可见错误，Dart 侧照常退避
                // 重试；超时后底层线程若仍卡着，闸门保证不会再堆新任务。
                if (tokenInFlight) {
                    result.success(
                        mapOf(
                            "provider" to PROVIDER,
                            "configured" to true,
                            "token" to "",
                            "err" to "getToken in flight (previous attempt still running)",
                        )
                    )
                    return
                }
                tokenInFlight = true
                executor.execute {
                    val tokenRef = AtomicReference("")
                    val errRef = AtomicReference("")
                    try {
                        // 单线程 executor 内不能再 submit 后等待（会自锁），用独立线程 join
                        val worker = Thread {
                            try {
                                tokenRef.set(
                                    HmsInstanceId.getInstance(context).getToken(id, "HCM") ?: ""
                                )
                            } catch (t: Throwable) {
                                errRef.set("${t.javaClass.simpleName}: ${t.message ?: "unknown"}")
                            }
                        }
                        worker.isDaemon = true
                        worker.name = "hms-get-token"
                        worker.start()
                        worker.join(TOKEN_TIMEOUT_MS)
                        if (worker.isAlive) {
                            errRef.set("getToken timeout ${TOKEN_TIMEOUT_MS}ms")
                            worker.interrupt()
                        }
                    } catch (t: Throwable) {
                        errRef.set("${t.javaClass.simpleName}: ${t.message ?: "unknown"}")
                    }
                    val token = tokenRef.get()
                    var err = errRef.get()
                    if (err.isEmpty() && token.isEmpty()) err = "getToken returned empty"
                    if (token.isNotEmpty()) {
                        try {
                            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                .edit().putString(KEY_TOKEN, token).apply()
                        } catch (_: Exception) {
                        }
                    }
                    tokenInFlight = false
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

        /** 单次 getToken 的等待上限：超时按错误返回，不让 Dart 侧无限 await。 */
        private const val TOKEN_TIMEOUT_MS = 15_000L
    }
}
