package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 开机/应用更新自启：拉起常驻前台服务尽快恢复桥接与消息捕捉上报。
 * Android 15 起 BOOT_COMPLETED 不允许启动 dataSync 类型前台服务，
 * 失败会被 MessageBridgeForegroundService 内部捕获并静默降级
 * （通知监听服务由系统绑定，不依赖本 receiver）。
 */
class BootReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        // 闹钟重建（docs/mobile-agent-reminder-alarm-design.md §10.1）：
        // 重挂 SharedPreferences 里全部未到点的精确闹钟；开机前错过的跳丢弃（服务端兜底推送触达）。
        try {
            AlarmClockPlugin.instance?.rescheduleAllOnBoot(context)
                ?: AlarmClockPluginBootHelper.rescheduleAll(context)
            Log.i(TAG, "alarm clock rescheduled on $action")
        } catch (e: Exception) {
            Log.w(TAG, "alarm clock reschedule failed", e)
        }
        try {
            val fgs = Intent(context, MessageBridgeForegroundService::class.java)
            androidx.core.content.ContextCompat.startForegroundService(context, fgs)
            Log.i(TAG, "bridge foreground service requested on $action")
        } catch (e: Exception) {
            Log.w(TAG, "start foreground service on boot failed", e)
        }
    }
}

/** 插件未实例化（Flutter 引擎未启动）时的开机重建兜底：直接读 prefs 重挂 */
private object AlarmClockPluginBootHelper {
    fun rescheduleAll(context: Context) {
        val prefs = context.getSharedPreferences("alarm_clock_prefs", Context.MODE_PRIVATE)
        val raw = prefs.getString("pending_alarms", null) ?: return
        val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        val obj = org.json.JSONObject(raw)
        val now = System.currentTimeMillis()
        for (alarmId in obj.keys()) {
            val entry = obj.getJSONObject(alarmId)
            val epochMs = entry.optLong("epochMs", 0L)
            if (epochMs <= now) continue
            val fireIntent = Intent(context, AlarmClockReceiver::class.java).apply {
                action = "com.example.private_ai_app.alarm.FIRE"
                putExtra(AlarmClockPlugin.EXTRA_ALARM_ID, alarmId)
                putExtra(AlarmClockPlugin.EXTRA_LABEL, entry.optString("label", ""))
                val ttsFile = entry.optString("ttsFile", "")
                if (ttsFile.isNotEmpty() && java.io.File(ttsFile).exists()) {
                    putExtra(AlarmClockPlugin.EXTRA_TTS_FILE, ttsFile)
                }
                val voiceText = entry.optString("voiceText", "")
                if (voiceText.isNotBlank()) {
                    putExtra(AlarmClockPlugin.EXTRA_VOICE_TEXT, voiceText)
                }
            }
            val pi = android.app.PendingIntent.getBroadcast(
                context,
                alarmId.hashCode(),
                fireIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
            am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, epochMs, pi)
        }
    }
}
