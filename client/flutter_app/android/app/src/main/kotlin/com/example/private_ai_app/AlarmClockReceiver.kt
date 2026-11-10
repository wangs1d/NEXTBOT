package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 闹钟到点广播接收器 —— AlarmManager 精确闹钟触发后拉起响铃前台服务。
 * 语音叫醒不走 WS：预约时已由 AlarmClockPlugin 把 mp3 落到应用私有文件、把 agent
 * 话术写进 PendingIntent extra / pending_alarms，这里只取路径与文本交给响铃服务。
 * App 进程被杀、锁屏、断网时这条链仍然成立（无 mp3 时由系统 TTS 念话术）。
 */
class AlarmClockReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "AlarmClockReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "com.example.private_ai_app.alarm.FIRE") return
        val alarmId = intent.getStringExtra(AlarmClockPlugin.EXTRA_ALARM_ID) ?: return
        val label = intent.getStringExtra(AlarmClockPlugin.EXTRA_LABEL) ?: ""
        // 优先读持久化条目：音频在建钟时落盘后写回 pending_alarms，
        // PendingIntent extra 只是预约那一刻的快照，改期/重建后可能已过期。
        val ttsFile = AlarmClockPlugin.pendingTtsFile(context, alarmId)
            ?: intent.getStringExtra(AlarmClockPlugin.EXTRA_TTS_FILE)
        val voiceText = AlarmClockPlugin.pendingVoiceText(context, alarmId)
            ?: intent.getStringExtra(AlarmClockPlugin.EXTRA_VOICE_TEXT)
        try {
            AlarmRingService.start(context, alarmId, label, null, ttsFile, voiceText)
            Log.i(
                TAG,
                "ring service requested alarm=$alarmId " +
                    "voiceFile=${ttsFile != null} script=${!voiceText.isNullOrBlank()}",
            )
        } catch (e: Exception) {
            Log.w(TAG, "start ring service failed, fallback notification", e)
            AlarmRingService.notifyFallback(context, alarmId, label)
        }
    }
}
