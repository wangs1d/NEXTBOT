package com.example.private_ai_app

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
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

    /**
     * 网络路径事件（2026-11-18 手机端「老是重连」治理）。
     *
     * Wi‑Fi ⇄ 蜂窝切换、飞行模式恢复时旧 TCP 连接会静默失效，Dart 侧心跳要
     * 75s 才判死。这里用 system 的 default network callback 在路径变化的第一
     * 时间推一帧给 Dart（值：wifi / mobile / ethernet / other / none），由连接
     * 层立即探活或重建，用户不再干等一分多钟。
     */
    private var networkEventChannel: EventChannel? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var networkSink: EventChannel.EventSink? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "nextbot/keep_alive")
        channel?.setMethodCallHandler(this)
        networkEventChannel = EventChannel(binding.binaryMessenger, "nextbot/network_events")
        networkEventChannel?.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                networkSink = events
                registerNetworkCallback()
                emitNetworkState()
            }

            override fun onCancel(arguments: Any?) {
                networkSink = null
                unregisterNetworkCallback()
            }
        })
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        networkEventChannel?.setStreamHandler(null)
        networkEventChannel = null
        networkSink = null
        unregisterNetworkCallback()
        context = null
    }

    private fun registerNetworkCallback() {
        val ctx = context ?: return
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        if (networkCallback != null) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val callback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) = emitNetworkState()
                    override fun onLost(network: Network) = emitNetworkState()
                    override fun onCapabilitiesChanged(
                        network: Network,
                        networkCapabilities: NetworkCapabilities,
                    ) = emitNetworkState()
                }
                cm.registerDefaultNetworkCallback(callback)
                networkCallback = callback
            }
        } catch (e: Exception) {
            // 权限缺失/系统限制：Dart 侧仍有心跳兜底，不影响业务。
            android.util.Log.w("KeepAlive", "register network callback failed", e)
        }
    }

    private fun unregisterNetworkCallback() {
        val ctx = context ?: return
        val callback = networkCallback ?: return
        networkCallback = null
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        try {
            cm.unregisterNetworkCallback(callback)
        } catch (_: Exception) {
            // 已注销 / 系统已回收：无害
        }
    }

    /** 当前生效网络的类型；回调可能来自任意线程，统一切回主线程再发。 */
    private fun emitNetworkState() {
        mainHandler.post {
            val sink = networkSink ?: return@post
            val ctx = context ?: return@post
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val type = when {
                cm == null -> "other"
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> {
                    val active = cm.activeNetwork
                    val caps = active?.let { cm.getNetworkCapabilities(it) }
                    when {
                        caps == null -> "none"
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                        else -> "other"
                    }
                }
                else -> if (cm.activeNetworkInfo?.isConnected == true) "other" else "none"
            }
            try {
                sink.success(type)
            } catch (e: Exception) {
                android.util.Log.w("KeepAlive", "emit network state failed", e)
            }
        }
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
                    // 不在这里置 running：startForegroundService 只代表「已请求启动」，
                    // 服务真正进入前台态由 MessageBridgeForegroundService 自己记账。
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
                result.success(true)
            }
            // 真实运行态（服务 onDestroy 会置假）：诊断信标与 60s 自愈都靠它，
            // 不能再把「请求过启动」当成「正在运行」。
            "isRunning" -> result.success(MessageBridgeForegroundService.running)
            /**
             * 电池优化豁免（2026-11-12）：部分 ROM 即使进程挂着前台服务，
             * 仍会按「电池优化白名单」之外的标准把 App 冻结/回收——保活服务
             * 在就等于没开。这里在未豁免时拉起系统确认对话框（用户点一次
             * 「允许」永久生效）；已豁免时空转返回 true。
             */
            "ensureBatteryExempt" -> {
                val ctx = context
                if (ctx == null) {
                    result.success(false)
                    return
                }
                try {
                    val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                    if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
                        result.success(true)
                        return
                    }
                    val intent =
                        Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(android.net.Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    ctx.startActivity(intent)
                    result.success(true)
                } catch (e: Exception) {
                    android.util.Log.w("KeepAlive", "request battery exemption failed", e)
                    result.success(false)
                }
            }
            "isBatteryExempt" -> {
                val ctx = context
                if (ctx == null) {
                    result.success(false)
                    return
                }
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                result.success(pm.isIgnoringBatteryOptimizations(ctx.packageName))
            }
            else -> result.notImplemented()
        }
    }
}
