package com.example.private_ai_app

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 消息捕捉 Flutter 通道（pai/phone_msg_events）。
 *
 * native → Dart：onMessagesCaptured(batch) 推送捕获的通知消息批量。
 * Dart → native：
 *   - drainQueue        取走落盘队列里积压的捕获消息（启动/重连时补报）
 *   - queueSize         落盘队列当前条数（设置页展示）
 *   - isListenerEnabled 通知使用权是否已授予
 *   - openListenerSettings 跳转系统「通知使用权」设置页
 *   - startBridgeService 拉起常驻前台服务（保活 WS 桥接与上报）
 *   - setCaptureConfig  下发动态捕捉配置：自定义包名规则 + 未识别包全量捕捉开关
 *   - getCaptureConfig  读取当前动态捕捉配置（设置页回显）
 */
class MessageCapturePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    companion object {
        private const val TAG = "MsgCapturePlugin"
        private const val CHANNEL_NAME = "pai/phone_msg_events"
        private val mainHandler = Handler(Looper.getMainLooper())

        @Volatile
        private var channel: MethodChannel? = null

        /** 把一批捕获消息推给 Dart；通道不存在返回 false（上层转落盘队列）。
         *  Dart 侧处理失败的场景由启动时 drainQueue 补报兜底。 */
        fun dispatchToDart(batch: List<Map<String, Any?>>): Boolean {
            val ch = channel ?: return false
            mainHandler.post {
                try {
                    ch.invokeMethod("onMessagesCaptured", batch)
                } catch (e: Exception) {
                    Log.w(TAG, "dispatchToDart failed", e)
                }
            }
            return true
        }

        fun detachEngine() {
            channel = null
            MessageCaptureListenerService.dartChannelReady = false
        }
    }

    private var appContext: android.content.Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL_NAME)
        channel!!.setMethodCallHandler(this)
        MessageCaptureListenerService.dartChannelReady = true
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        MessageCaptureListenerService.dartChannelReady = false
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "drainQueue" -> result.success(CaptureQueueStore.drain())
            "queueSize" -> result.success(CaptureQueueStore.size())
            "isListenerEnabled" -> result.success(isListenerEnabledSafe())
            "openListenerSettings" -> {
                try {
                    val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    appContext?.startActivity(intent)
                    result.success(true)
                } catch (e: Exception) {
                    result.success(false)
                }
            }
            "startBridgeService" -> {
                try {
                    val intent = Intent(appContext, MessageBridgeForegroundService::class.java)
                    androidx.core.content.ContextCompat.startForegroundService(appContext!!, intent)
                    result.success(true)
                } catch (e: Exception) {
                    Log.w(TAG, "startForegroundService failed", e)
                    result.success(false)
                }
            }
            "setCaptureConfig" -> {
                val ctx = appContext
                if (ctx == null) {
                    result.success(false)
                    return
                }
                try {
                    val args = call.arguments as? Map<*, *>
                    val rules = (args?.get("extraRules") as? List<*>)?.mapNotNull { raw ->
                        (raw as? Map<*, *>)?.let { m ->
                            val pkg = (m["pkg"] as? String)?.trim().orEmpty()
                            val platform = (m["platform"] as? String)?.trim().orEmpty().ifEmpty { "generic" }
                            if (pkg.isEmpty()) null else pkg to platform
                        }
                    }.orEmpty()
                    val captureAll = args?.get("captureAll") == true
                    MessageCaptureListenerService.applyConfig(ctx, rules, captureAll)
                    result.success(true)
                } catch (e: Exception) {
                    Log.w(TAG, "setCaptureConfig failed", e)
                    result.success(false)
                }
            }
            "getCaptureConfig" -> {
                val ctx = appContext ?: return result.success(null)
                result.success(MessageCaptureListenerService.readConfig(ctx))
            }
            else -> result.notImplemented()
        }
    }

    private fun isListenerEnabledSafe(): Boolean = try {
        androidx.core.app.NotificationManagerCompat
            .getEnabledListenerPackages(appContext!!)
            .contains(appContext!!.packageName)
    } catch (_: Exception) {
        false
    }
}
