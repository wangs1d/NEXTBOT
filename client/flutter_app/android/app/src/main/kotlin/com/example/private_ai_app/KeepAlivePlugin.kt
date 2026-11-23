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

    /**
     * 手机状态事件（2026-11-23 主动触达 M1）：亮灭屏 / 解锁 / 通话 / 勿扰 / 充电变化
     * 推给 Dart（PhoneStateReporter），由它经主连接上报 client.presence_state。
     * 与网络事件同一个插件、同一个保活进程，不另起服务。
     */
    private var phoneStateEventChannel: EventChannel? = null
    private var phoneStateSink: EventChannel.EventSink? = null
    private var phoneStateMonitor: PhoneStateMonitor? = null

    /**
     * 常驻状态栏通知（2026-11-23 §5.2）：Dart 推看板 → 原生重画同一条通知；
     * 通知上的「完成」按钮反向回到 Dart（引擎不在时由 [OngoingStatusReceiver] 兜底）。
     */
    private var ongoingChannel: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "nextbot/keep_alive")
        channel?.setMethodCallHandler(this)
        ongoingChannel = MethodChannel(binding.binaryMessenger, "nextbot/ongoing_status")
        ongoingChannel?.setMethodCallHandler { call, result -> onOngoingCall(call, result) }
        context?.let { OngoingStatusNotifier.ensureChannel(it) }
        OngoingStatusNotifier.dartTapHandler = { actionId, token, taskId ->
            // invokeMethod 只能在平台线程调；广播已经在主线程，仍显式 post 一次，
            // 免得以后有人从别的线程复用这个槽位。
            mainHandler.post {
                try {
                    ongoingChannel?.invokeMethod(
                        "ongoingTap",
                        mapOf("actionId" to actionId, "token" to token, "taskId" to taskId),
                    )
                } catch (e: Exception) {
                    android.util.Log.w("KeepAlive", "ongoing tap -> dart failed", e)
                }
            }
        }
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
        phoneStateEventChannel = EventChannel(binding.binaryMessenger, "nextbot/phone_state")
        phoneStateEventChannel?.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                phoneStateSink = events
                val ctx = context ?: return
                if (phoneStateMonitor == null) {
                    phoneStateMonitor = PhoneStateMonitor(ctx) { state ->
                        // PhoneStateMonitor 已在主线程回调
                        phoneStateSink?.success(state)
                    }
                }
                phoneStateMonitor?.start()
            }

            override fun onCancel(arguments: Any?) {
                phoneStateSink = null
                phoneStateMonitor?.stop()
            }
        })
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        ongoingChannel?.setMethodCallHandler(null)
        ongoingChannel = null
        OngoingStatusNotifier.dartTapHandler = null
        networkEventChannel?.setStreamHandler(null)
        networkEventChannel = null
        networkSink = null
        unregisterNetworkCallback()
        phoneStateEventChannel?.setStreamHandler(null)
        phoneStateEventChannel = null
        phoneStateSink = null
        phoneStateMonitor?.stop()
        phoneStateMonitor = null
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

    /**
     * 常驻通知的三件事：贴内容、切模式、重画。
     * 都不新建通知（同 id 原地更新），也不改变服务生命周期——服务挂了这条也就没了。
     */
    private fun onOngoingCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = context
        if (ctx == null) {
            result.success(false)
            return
        }
        when (call.method) {
            "update" -> {
                val args = call.arguments
                if (args !is Map<*, *>) {
                    result.success(false)
                    return
                }
                OngoingStatusNotifier.update(ctx, args)
                result.success(true)
            }
            "setMode" -> {
                OngoingStatusNotifier.setMode(ctx, call.argument<String>("mode") ?: "full")
                result.success(true)
            }
            // 模式的存在真相在原生偏好里（App 被杀后状态栏仍要正确），设置页读它回显
            "getMode" -> result.success(OngoingStatusNotifier.mode(ctx))
            "redraw" -> {
                OngoingStatusNotifier.push(ctx)
                result.success(true)
            }
            else -> result.notImplemented()
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
            // 手机状态即时快照（心跳上报用；不经去重，监听未开时也能查）
            "getPhoneState" -> {
                val ctx = context
                if (ctx == null) {
                    result.success(null)
                    return
                }
                result.success((phoneStateMonitor ?: PhoneStateMonitor(ctx) {}).snapshot())
            }
            // 只读查询电池优化豁免状态（诊断信标用），不拉起系统对话框。
            "isBatteryExempt" -> {
                val ctx = context
                if (ctx == null) {
                    result.success(false)
                    return
                }
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                result.success(pm.isIgnoringBatteryOptimizations(ctx.packageName))
            }
            /**
             * 电池优化豁免授权框（2026-11-22 手机端「连接断开」根因治理）。
             *
             * 生产日志实证：断开的同一秒进程消失（死前 0.4s 还在写存活心跳），
             * 2~4s 后进程重启 —— 是系统回收进程，不是网络断、也不是服务端踢。
             * 而 batteryExempt 全程 false：应用从未申请过豁免。这里直接弹系统
             * 授权框；已豁免时返回 true，不重复弹。
             */
            "requestBatteryExempt" -> {
                val ctx = context
                if (ctx == null) {
                    result.success(false)
                    return
                }
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                    result.success(true) // M 以下没有电池优化机制
                    return
                }
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
                    result.success(true)
                    return
                }
                try {
                    ctx.startActivity(
                        Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(android.net.Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    result.success(true)
                } catch (e: Exception) {
                    // 部分 ROM 裁剪了这个系统页：回落到应用详情页，用户仍可手动改电池项
                    android.util.Log.w("KeepAlive", "request battery exempt failed", e)
                    try {
                        ctx.startActivity(
                            Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                                .setData(android.net.Uri.parse("package:${ctx.packageName}"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                        result.success(true)
                    } catch (_: Exception) {
                        result.success(false)
                    }
                }
            }
            /**
             * 厂商「应用启动管理」页（自启动 / 关联启动 / 后台活动）。
             *
             * 国产 ROM 的这层管理不受 AOSP 的进程优先级约束，是"前台服务在跑却
             * 照样被杀"的真正开关（见 2026-11-22 断连诊断）。AOSP 没有统一入口，
             * 按厂商逐个尝试，全部失败时回落本应用详情页。
             */
            "openAppStartupSettings" -> {
                val ctx = context
                if (ctx == null) {
                    result.success(false)
                    return
                }
                val candidates = listOf(
                    // 华为 / 荣耀（EMUI / HarmonyOS 兼容 Android）
                    "com.huawei.systemmanager" to
                        "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity",
                    "com.huawei.systemmanager" to
                        "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                    // 小米 / Redmi
                    "com.miui.securitycenter" to
                        "com.miui.permcenter.autostart.AutoStartManagementActivity",
                    // OPPO / 一加 / realme
                    "com.coloros.safecenter" to
                        "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                    "com.oplus.safecenter" to
                        "com.oplus.safecenter.permission.startup.StartupAppListActivity",
                    // vivo / iQOO
                    "com.vivo.permissionmanager" to
                        "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                )
                for ((pkg, cls) in candidates) {
                    try {
                        ctx.startActivity(
                            Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                        result.success(true)
                        return
                    } catch (_: Exception) {
                        // 该厂商页面不存在，继续试下一个
                    }
                }
                try {
                    ctx.startActivity(
                        Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                            .setData(android.net.Uri.parse("package:${ctx.packageName}"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    result.success(true)
                } catch (_: Exception) {
                    result.success(false)
                }
            }
            /**
             * 「始终允许」定位引导页（2026-11-20）：Android 11+ 运行时弹窗没有
             * 「始终允许」选项（Google 刻意移除），最终授权只能用户在系统设置里点。
             * Android 12+ 深链直达本应用的「位置权限」单页（含「允许所有时间」，
             * 少点 3 层）；Android 10-11 回退应用详情页；失败由 Dart 侧兜底
             * geolocator.openAppSettings。
             */
            "openAlwaysLocationSettings" -> {
                val ctx = context
                if (ctx == null) {
                    result.success(false)
                    return
                }
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        // compileSdk 低于 31 时无这两个常量，用字符串字面量等价
                        // （ACTION_MANAGE_APP_PERMISSIONS = "android.settings.MANAGE_APP_PERMISSIONS"，
                        //   EXTRA_PERMISSION_NAME = "android.provider.extra.PERMISSION_NAME"），
                        // 本分支已有 SDK_INT >= S 守卫，运行时必然可解析。
                        val intent =
                            Intent("android.settings.MANAGE_APP_PERMISSIONS")
                                .putExtra(
                                    "android.provider.extra.PERMISSION_NAME",
                                    android.Manifest.permission.ACCESS_BACKGROUND_LOCATION,
                                )
                                .putExtra(Intent.EXTRA_PACKAGE_NAME, ctx.packageName)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        ctx.startActivity(intent)
                    } else {
                        ctx.startActivity(
                            Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                                .setData(android.net.Uri.parse("package:${ctx.packageName}"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                    result.success(true)
                } catch (e: Exception) {
                    android.util.Log.w("KeepAlive", "open always-location settings failed", e)
                    result.success(false)
                }
            }
            else -> result.notImplemented()
        }
    }
}
