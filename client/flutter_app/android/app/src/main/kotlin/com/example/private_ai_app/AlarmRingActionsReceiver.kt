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
        val actionRaw = intent.action
        // 只认贪睡/关闭两个动作；其余忽略
        val action: String = when (actionRaw) {
            AlarmClockPlugin.ACTION_SNOOZE -> "snooze"
            AlarmClockPlugin.ACTION_STOP -> "dismiss"
            else -> return
        }
        val alarmId = intent.getStringExtra(AlarmClockPlugin.EXTRA_ALARM_ID) ?: ""
        Log.i(TAG, "notification action=$actionRaw alarm=$alarmId")

        // 第一优先：无论 alarmId 是否解析成功，先物理停铃。
        // 「关闭按钮点了没反应」先被这一步兜住——停铃不依赖任何业务 id。
        AlarmRingService.stopAll(context)

        if (alarmId.isEmpty()) {
            Log.w(TAG, "alarmId missing, ringing stopped but business sync skipped")
            return
        }
        // 关闭 = 这一跳用完：立即删端侧动态音频（Dart 侧的 dismiss 也会调一次，幂等）。
        // 贪睡要再响一次，音频必须保留。
        if (action == "dismiss") {
            AlarmClockPlugin.releaseVoiceClip(context, alarmId)
        }

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
