package com.example.private_ai_app

import android.content.Context
import android.content.Intent
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 后台保活插件（KeepAlivePlugin）—— 拉起 [MessageBridgeForegroundService]
 * 低优先级常驻前台服务，让主进程在 App 切后台后不进 cached 状态。
 *
 * 2026-11-10 根修：App 切后台（进程未杀）会被 Cached Apps Freezer 整体冻结
 * —— Dart 引擎所有线程挂起，WS 心跳停摆，服务端主动消息/提醒全部静默丢失。
 * 前台服务进程不参与冻结，主聊天 WS 因此在后台持续在线；事件到达后的
 * 系统通知转化由 main.dart 各 WS 分发点负责。
 *
 * 必须在 App 前台时调用 start（Android 12+ 限制后台启动前台服务）；
 * bootstrap 与回前台 resumed 两个时机各补一次，START_STICKY 兜底自动重启。
 */
class KeepAlivePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    private var channel: MethodChannel? = null
    private var context: Context? = null

    companion object {
        @Volatile
        var running: Boolean = false
            private set
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "nextbot/keep_alive")
        channel?.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        context = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = context
        when (call.method) {
            "start" -> {
                if (ctx == null) {
                    result.success(false)
                    return
                }
                try {
                    ctx.startForegroundService(
                        Intent(ctx, MessageBridgeForegroundService::class.java),
                    )
                    running = true
                    result.success(true)
                } catch (e: Exception) {
                    android.util.Log.w("KeepAlive", "start keep-alive FGS failed", e)
                    result.success(false)
                }
            }
            "stop" -> {
                if (ctx != null) {
                    try {
                        ctx.stopService(Intent(ctx, MessageBridgeForegroundService::class.java))
                    } catch (_: Exception) {
                        // 服务未在运行时 stopService 是无害 no-op
                    }
                }
                running = false
                result.success(true)
            }
            "isRunning" -> result.success(running)
            else -> result.notImplemented()
        }
    }
}
