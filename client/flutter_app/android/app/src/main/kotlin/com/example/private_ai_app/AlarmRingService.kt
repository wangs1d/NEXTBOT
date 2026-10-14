package com.example.private_ai_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * 闹钟响铃前台服务（foregroundServiceType=mediaPlayback）—— 触发主路的执行体：
 *  - 循环播放系统默认闹铃 + 振动，最长 1 分钟自动停止（防耗电/扰人，2026-10-13 用户定调）；
 *  - 满屏通知（full-screen intent）锁屏直达响铃页；通知带「贪睡 10 分钟」「关闭」动作；
 *  - 服务端 alarm.trigger 下发的 TTS base64（二阶段语音叫醒）优先于系统铃声播放。
 *
 * 用户动作经 AlarmRingActionsReceiver 转回 Dart 侧 AlarmEngine.snooze/dismiss
 * （业务推进收口在 Dart：本地库推进 + REST 同步服务端）。
 */
class AlarmRingService : Service() {
    companion object {
        private const val TAG = "AlarmRingService"
        private const val CHANNEL_RING = "alarm_ring"
        private const val CHANNEL_FALLBACK = "alarm_fallback"
        private const val NOTIFICATION_ID_BASE = 47_000
        private const val MAX_RING_MS = 60_000L // 最长响 1 分钟自动停（2026-10-13 用户定调）
        private val ringing = ConcurrentHashMap<String, AlarmRingService>()

        fun start(context: Context, alarmId: String, label: String, ttsBase64: String?) {
            val intent = Intent(context, AlarmRingService::class.java).apply {
                putExtra(AlarmClockPlugin.EXTRA_ALARM_ID, alarmId)
                putExtra(AlarmClockPlugin.EXTRA_LABEL, label)
                putExtra(AlarmClockPlugin.EXTRA_TTS_BASE64, ttsBase64)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopAll(context: Context) {
            for (id in ringing.keys.toList()) {
                context.stopService(Intent(context, AlarmRingService::class.java).apply {
                    putExtra(AlarmClockPlugin.EXTRA_ALARM_ID, id)
                })
            }
        }

        /** 前台服务启动失败时的降级：仍发一条 bypassDnd 高优先级通知（ Heads-up 展示） */
        fun notifyFallback(context: Context, alarmId: String, label: String) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            ensureChannels(nm)
            nm.notify(
                (NOTIFICATION_ID_BASE + alarmId.hashCode()).coerceAtMost(Int.MAX_VALUE - 1),
                buildNotification(context, alarmId, label, null, fullScreen = false),
            )
        }

        private fun ensureChannels(nm: NotificationManager) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val ring = NotificationChannel(CHANNEL_RING, "闹钟响铃", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "NEXTBOT 闹钟到点响铃（突破免打扰）"
                setBypassDnd(true)
                enableVibration(true)
            }
            val fallback = NotificationChannel(CHANNEL_FALLBACK, "提醒通知", NotificationManager.IMPORTANCE_HIGH)
            nm.createNotificationChannel(ring)
            nm.createNotificationChannel(fallback)
        }

        private fun buildNotification(
            context: Context,
            alarmId: String,
            label: String,
            ttsBase64: String?,
            fullScreen: Boolean,
        ): Notification {
            val openApp = Intent(context, MainActivity::class.java).apply {
                putExtra(AlarmClockPlugin.EXTRA_ALARM_ID, alarmId)
                putExtra(AlarmClockPlugin.EXTRA_LABEL, label)
                putExtra("source", "alarm_ring")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val openPi = PendingIntent.getActivity(
                context, (alarmId.hashCode() + 1),
                openApp,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val snoozePi = actionPendingIntent(context, alarmId, label, ttsBase64, AlarmClockPlugin.ACTION_SNOOZE, 2)
            val stopPi = actionPendingIntent(context, alarmId, label, ttsBase64, AlarmClockPlugin.ACTION_STOP, 3)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_RING)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            return builder
                .setContentTitle("闹钟")
                .setContentText(label.ifEmpty { "时间到了" })
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentIntent(openPi)
                .setCategory(Notification.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
                .addAction(android.R.drawable.ic_menu_recent_history, "贪睡 10 分钟", snoozePi)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "关闭", stopPi)
                .apply {
                    if (fullScreen && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        setFullScreenIntent(openPi, true)
                    }
                }
                .build()
        }

        private fun actionPendingIntent(
            context: Context,
            alarmId: String,
            label: String,
            ttsBase64: String?,
            action: String,
            requestCode: Int,
        ): PendingIntent {
            val intent = Intent(context, AlarmRingActionsReceiver::class.java).apply {
                this.action = action
                putExtra(AlarmClockPlugin.EXTRA_ALARM_ID, alarmId)
                putExtra(AlarmClockPlugin.EXTRA_LABEL, label)
                putExtra(AlarmClockPlugin.EXTRA_TTS_BASE64, ttsBase64)
            }
            return PendingIntent.getBroadcast(
                context, requestCode xor alarmId.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }

    private var alarmId: String = ""
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val startedAt = System.currentTimeMillis()
    private val stopRunnable = object : Runnable {
        override fun run() {
            Log.i(TAG, "max ring duration reached, auto stop")
            stopSelf()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels(getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(AlarmClockPlugin.EXTRA_ALARM_ID) ?: ""
        if (id.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }
        alarmId = id
        val label = intent?.getStringExtra(AlarmClockPlugin.EXTRA_LABEL) ?: ""
        val tts = intent?.getStringExtra(AlarmClockPlugin.EXTRA_TTS_BASE64)
        ringing[alarmId] = this

        val notification = buildNotification(this, alarmId, label, tts, fullScreen = true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                (NOTIFICATION_ID_BASE + alarmId.hashCode()).coerceAtMost(Int.MAX_VALUE - 1),
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground((NOTIFICATION_ID_BASE + alarmId.hashCode()).coerceAtMost(Int.MAX_VALUE - 1), notification)
        }

        startPlaying(tts)
        startVibration()
        android.os.Handler(mainLooper).postDelayed(stopRunnable, MAX_RING_MS)
        return START_NOT_STICKY
    }

    private fun startPlaying(ttsBase64: String?) {
        try {
            player = MediaPlayer().apply {
                if (ttsBase64 != null) {
                    // 二阶段语音叫醒：服务端合成好的开场白先行
                    val bytes = android.util.Base64.decode(ttsBase64, android.util.Base64.DEFAULT)
                    val tmp = java.io.File.createTempFile("alarm_tts", ".mp3", cacheDir)
                    tmp.writeBytes(bytes)
                    setDataSource(tmp.absolutePath)
                } else {
                    setDataSource(
                        this@AlarmRingService,
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    )
                }
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                isLooping = ttsBase64 == null // TTS 播完接铃声循环由用户关闭/贪睡决定
                prepare()
                start()
            }
        } catch (e: Exception) {
            Log.w(TAG, "play alarm sound failed", e)
        }
    }

    private fun startVibration() {
        try {
            val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
            vibrator = v
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createWaveform(longArrayOf(600, 400), 0))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(longArrayOf(600, 400), 0)
            }
        } catch (_: Exception) {
        }
    }

    private fun releaseResources() {
        android.os.Handler(mainLooper).removeCallbacks(stopRunnable)
        try {
            player?.stop()
            player?.release()
        } catch (_: Exception) {
        }
        player = null
        try {
            vibrator?.cancel()
        } catch (_: Exception) {
        }
        vibrator = null
        if (alarmId.isNotEmpty()) ringing.remove(alarmId)
    }

    override fun onDestroy() {
        releaseResources()
        super.onDestroy()
    }

    override fun stopService(name: Intent?): Boolean {
        releaseResources()
        return super.stopService(name)
    }
}
