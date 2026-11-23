package com.example.private_ai_app

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 分享内容交棒通道（2026-11-23 PRD §8）。
 *
 * Dart 侧（`lib/core/services/share_intake_service.dart`）只做两件事：
 *   - `take`：取走 [ShareIntakeStore] 里攒的分享内容 + 入口提示（取走即清空）；
 *   - `clean`：已经拼进消息的图片从缓存删掉。
 * 原生侧在有内容可取时推一次 `onReady`（引擎不在就安静地不推，Dart 起来后
 * 自己会 take 一次）——推送只是「省一次冷启动轮询」，不是正确性依赖。
 *
 * 不新建服务、不新建 WS：内容的消费全程在既有保活进程与既有聊天连接里。
 */
class ShareIntakePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "nextbot/share_intake"

        @Volatile
        private var channel: MethodChannel? = null
        private val mainHandler = Handler(Looper.getMainLooper())

        /** 有新内容 / 新入口：通知 Dart 来取。引擎未 attach 时静默丢弃（Dart 启动自取）。 */
        fun pushReady() {
            val c = channel ?: return
            mainHandler.post {
                try {
                    c.invokeMethod("onReady", null)
                } catch (e: Exception) {
                    android.util.Log.w("ShareIntake", "push onReady failed", e)
                }
            }
        }
    }

    private var context: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        // 目录提前建好：分享窗可能比引擎更早到（冷启动时恰恰如此）
        ShareIntakeStore.dir(binding.applicationContext)
        channel = MethodChannel(binding.binaryMessenger, CHANNEL)
            .also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        context = null
    }

    @Suppress("UNCHECKED_CAST")
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = context
        if (ctx == null) {
            result.success(null)
            return
        }
        when (call.method) {
            "take" -> result.success(ShareIntakeStore.drain(ctx))
            "clean" -> {
                val paths = (call.argument<Any>("paths") as? List<*>)
                    ?.mapNotNull { it as? String } ?: emptyList()
                ShareIntakeStore.cleanFiles(ctx, paths)
                result.success(true)
            }
            else -> result.notImplemented()
        }
    }
}
