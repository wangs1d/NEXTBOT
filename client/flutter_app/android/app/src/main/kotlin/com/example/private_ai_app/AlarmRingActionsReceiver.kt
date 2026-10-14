package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 闹钟通知动作接收器 —— 通知上的「贪睡 / 关闭」按钮：
 *  1. 停掉响铃前台服务；
 *  2. 通过已缓存的 FlutterEngine 把动作转回 Dart 侧 AlarmEngine（本地库推进 + REST 同步服务端）；
 *  3. Dart 侧不在前台（引擎已销毁）时经 AlarmChannelProxy 兜底直发 REST（引擎冷启动后对账）。
 */
class AlarmRingActionsReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "AlarmRingActions"

        /** Dart 侧注册的动作回调（AlarmEngine.attachNativeActions） */
        @Volatile
        var dartActionHandler: ((action: String, alarmId: String) -> Unit)? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        val alarmId = intent.getStringExtra(AlarmClockPlugin.EXTRA_ALARM_ID) ?: return
        val action = when (intent.action) {
            AlarmClockPlugin.ACTION_SNOOZE -> "snooze"
            AlarmClockPlugin.ACTION_STOP -> "dismiss"
            else -> return
        }
        // 无论 Dart 是否存活，先物理停铃
        AlarmRingService.stopAll(context)

        val handler = dartActionHandler
        if (handler != null) {
            handler.invoke(action, alarmId)
            Log.i(TAG, "action=$action forwarded to dart alarm=$alarmId")
        } else {
            // Dart 侧不可达：直接 REST 兜底（本地库由引擎下次启动时对账）
            AlarmRestFallback.report(context, action, alarmId)
            Log.i(TAG, "action=$action via rest fallback alarm=$alarmId")
        }
    }
}

/** Dart 引擎不在时的最小 REST 兜底（AlarmClockPlugin.configure 落盘的网关基址） */
private object AlarmRestFallback {
    private const val TAG = "AlarmRestFallback"

    fun report(context: Context, action: String, alarmId: String) {
        try {
            val prefs = context.getSharedPreferences("alarm_clock_prefs", Context.MODE_PRIVATE)
            val base = prefs.getString("http_base", null) ?: return
            val path = if (action == "snooze") "/api/alarms/$alarmId/snooze" else "/api/alarms/$alarmId/dismiss"
            val body = if (action == "snooze") """{"minutes":10}""" else "{}"
            val conn = (java.net.URL(base + path).openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                connectTimeout = 4000
                readTimeout = 4000
            }
            conn.outputStream.use { it.write(body.toByteArray()) }
            conn.responseCode
            conn.disconnect()
        } catch (e: Exception) {
            Log.w(TAG, "rest fallback failed", e)
        }
    }
}
