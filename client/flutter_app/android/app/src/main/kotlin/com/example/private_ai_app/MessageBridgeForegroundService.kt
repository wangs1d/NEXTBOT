package com.example.private_ai_app

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * 消息桥接常驻前台服务：拉一条低优先级常驻通知保持进程存活，
 * 让通知监听服务、桥接 WS 与捕获消息上报不被系统回收。
 * 具体的 WS/上报/定时定位逻辑都在 Dart 侧（PhoneBridgeService），本服务只负责保活。
 *
 * 2026-11-10 起兼作主聊天 WS 的后台保活（KeepAlivePlugin 拉起）：Android 14+
 * 对 dataSync 类型有 6h/24h 累计限额，超时系统会强停服务——故 API 34+ 改用
 * specialUse 类型（Manifest 已声明 PROPERTY_SPECIAL_USE_FGS_SUBTYPE），
 * 限额不适用；低版本仍走 dataSync。
 *
 * 2026-11-23（§5.2）：这条通知的内容交给 [OngoingStatusNotifier] 渲染成今日状态，
 * 服务只负责把它挂在前台态上。
 */
class MessageBridgeForegroundService : Service() {

    companion object {
        private const val TAG = "BridgeFgs"

        /**
         * 保活服务的真实运行态（2026-11-14 诊断修复）。
         *
         * 旧实现由 KeepAlivePlugin 在调用 startForegroundService() 成功后就置
         * true——那只是「已请求启动」，startForeground() 抛异常时服务会 stopSelf，
         * 标志却仍是 true。于是 ws.client_boot 上报的 fgsRunning 恒为真，把
         * 「保活根本没起来、后台必被冻结」这条最可能的断连根因完全掩盖掉。
         * 现在只在本服务真正进入前台态后置真，onDestroy 置假。
         */
        @Volatile
        var running: Boolean = false
            private set
    }

    override fun onCreate() {
        super.onCreate()
        startForegroundCompat()
    }

    override fun onDestroy() {
        running = false
        Log.i(TAG, "foreground service destroyed")
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY：被系统回收后尽量自动重启
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundCompat() {
        try {
            // 同一条通知从此由 OngoingStatusNotifier 渲染（§5.2）：保活占位文案
            // 变成「今天的第一眼」。服务重建（START_STICKY / 开机自启）时 Dart
            // 还没起来，内容从端侧偏好里恢复，不会先闪一帧占位文字。
            val notification = OngoingStatusNotifier.build(this)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // API 34+：specialUse 类型规避 dataSync 的 6h/24h 强停限额
                startForeground(
                    OngoingStatusNotifier.NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                startForeground(
                    OngoingStatusNotifier.NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(OngoingStatusNotifier.NOTIFICATION_ID, notification)
            }
            running = true
        } catch (e: Exception) {
            // Android 15 对 BOOT_COMPLETED 起 dataSync 类型 FGS 有限制；失败不致命，
            // 通知监听服务本身由系统绑定不受影响
            Log.w(TAG, "startForeground failed", e)
            stopSelf()
        }
    }
}
