package com.example.private_ai_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
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
 */
class MessageBridgeForegroundService : Service() {

    companion object {
        private const val TAG = "BridgeFgs"
        private const val CHANNEL_ID = "message_bridge"
        private const val NOTIFICATION_ID = 3408
    }

    override fun onCreate() {
        super.onCreate()
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY：被系统回收后尽量自动重启
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundCompat() {
        try {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        "消息桥接",
                        NotificationManager.IMPORTANCE_MIN,
                    ).apply {
                        description = "保持与电脑端 Agent 的连接"
                        setShowBadge(false)
                    },
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
            builder.setContentTitle("Agent 助手运行中")
                .setContentText("正在保持消息同步与远程控制通道")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // API 34+：specialUse 类型规避 dataSync 的 6h/24h 强停限额
                startForeground(
                    NOTIFICATION_ID, builder.build(),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                startForeground(NOTIFICATION_ID, builder.build(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, builder.build())
            }
        } catch (e: Exception) {
            // Android 15 对 BOOT_COMPLETED 起 dataSync 类型 FGS 有限制；失败不致命，
            // 通知监听服务本身由系统绑定不受影响
            Log.w(TAG, "startForeground failed", e)
            stopSelf()
        }
    }
}
