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
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * 闹钟响铃前台服务（foregroundServiceType=mediaPlayback）—— 触发主路的执行体：
 *  - 优先播服务端预合成的 TTS 叫醒话术；没有 mp3 时用系统 TextToSpeech 念 agent 话术；
 *    说完/失败都自动接系统闹铃循环 + 振动（绝不出现「说完一句就静音」）；
 *  - 最长 1 分钟自动停止（防耗电/扰人，2026-10-13 用户定调）；
 *  - 满屏通知（full-screen intent）锁屏直达响铃页；通知带「贪睡 10 分钟」「关闭」动作；
 *  - 持有 PARTIAL_WAKE_LOCK，保证锁屏 / Doze 下 CPU 不睡、语音播得完。
 *
 * 用户动作经 AlarmRingActionsReceiver 转回 Dart 侧 AlarmEngine.snooze/dismiss。
 */
class AlarmRingService : Service() {
    companion object {
        private const val TAG = "AlarmRingService"
        private const val CHANNEL_RING = "alarm_ring"
        private const val CHANNEL_FALLBACK = "alarm_fallback"
        private const val NOTIFICATION_ID_BASE = 47_000
        private const val MAX_RING_MS = 60_000L
        private const val TTS_INIT_TIMEOUT_MS = 3_500L
        private const val TTS_SPEAK_TIMEOUT_MS = 15_000L
        private const val UTTERANCE_ID = "nextbot_alarm_wake"

        private val ringing = ConcurrentHashMap<String, AlarmRingService>()

        fun start(
            context: Context,
            alarmId: String,
            label: String,
            ttsBase64: String?,
            ttsFile: String? = null,
            voiceText: String? = null,
        ) {
            val intent = Intent(context, AlarmRingService::class.java).apply {
                putExtra(AlarmClockPlugin.EXTRA_ALARM_ID, alarmId)
                putExtra(AlarmClockPlugin.EXTRA_LABEL, label)
                putExtra(AlarmClockPlugin.EXTRA_TTS_BASE64, ttsBase64)
                if (!ttsFile.isNullOrEmpty()) putExtra(AlarmClockPlugin.EXTRA_TTS_FILE, ttsFile)
                if (!voiceText.isNullOrBlank()) putExtra(AlarmClockPlugin.EXTRA_VOICE_TEXT, voiceText)
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

        /** 前台服务启动失败时的降级：仍发一条 bypassDnd 高优先级通知（Heads-up 展示） */
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
            voiceText: String? = null,
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
            val headline = label.ifEmpty { "时间到了" }
            val script = voiceText?.takeIf { it.isNotBlank() }
            return builder
                .setContentTitle("闹钟")
                // 锁屏直接显示 agent 叫醒话术：即使系统 TTS 引擎缺中文语音包 / 断网，
                // 用户仍能看到「agent 说了什么」，不会只剩一句干巴巴的「时间到了」
                .setContentText(script ?: headline)
                .setStyle(
                    Notification.BigTextStyle().bigText(
                        if (script != null) "$headline\n$script" else headline
                    ),
                )
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
    private var wakeLock: PowerManager.WakeLock? = null
    private var voiceTempFile: File? = null
    private var textToSpeech: TextToSpeech? = null
    private var ttsInitTimeout: Runnable? = null
    private var ttsSpeakTimeout: Runnable? = null

    @Volatile
    private var ringtoneStarted = false
    private val startedAt = System.currentTimeMillis()
    private val stopRunnable = Runnable {
        Log.i(TAG, "max ring duration reached, auto stop")
        // 响完 = 这份音频用完：立即删本端动态 mp3。贪睡会先停服务并 removeCallbacks，
        // 不走这里，文件保留给 10 分钟后的下一响。
        AlarmClockPlugin.releaseVoiceClip(this@AlarmRingService, alarmId)
        stopSelf()
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
        // 同一跳可能同时被本地 AlarmManager 主路、服务端 alarm.trigger 兜底、看门狗拉起。
        // 已在响铃就忽略重复 start，避免二次 TTS 与二次起铃（2026-11-09 实测发现）。
        if (ringing.containsKey(id)) {
            Log.i(TAG, "duplicate ring request ignored alarm=$id (already ringing)")
            return START_NOT_STICKY
        }
        alarmId = id
        val label = intent?.getStringExtra(AlarmClockPlugin.EXTRA_LABEL) ?: ""
        val tts = intent?.getStringExtra(AlarmClockPlugin.EXTRA_TTS_BASE64)
        val ttsFile = intent?.getStringExtra(AlarmClockPlugin.EXTRA_TTS_FILE)
        val voiceText = intent?.getStringExtra(AlarmClockPlugin.EXTRA_VOICE_TEXT)
        ringing[alarmId] = this

        acquireWakeLock()
        val notification = buildNotification(
            this, alarmId, label, tts, fullScreen = true, voiceText = voiceText
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                (NOTIFICATION_ID_BASE + alarmId.hashCode()).coerceAtMost(Int.MAX_VALUE - 1),
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground((NOTIFICATION_ID_BASE + alarmId.hashCode()).coerceAtMost(Int.MAX_VALUE - 1), notification)
        }

        startPlaying(tts, ttsFile, voiceText)
        startVibration()
        android.os.Handler(mainLooper).postDelayed(stopRunnable, MAX_RING_MS)
        return START_NOT_STICKY
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Nextbot:AlarmRing").apply {
                setReferenceCounted(false)
                acquire(MAX_RING_MS + 10_000L)
            }
        } catch (e: Exception) {
            Log.w(TAG, "acquire wake lock failed", e)
        }
    }

    /**
     * 语音叫醒四级降级（2026-11-09）：
     *  1. 本地缓存 mp3 —— 建钟时服务端预合成，本地 AlarmManager 主路，音质最好；
     *  2. alarm.trigger 下发的 base64 —— 在线兜底路；
     *  3. Android 系统 TextToSpeech 念 voiceText —— 外部 TTS 账户不可用 / 断网时仍能
     *     让 agent 开口；话术是建钟时 SpeechHub 生成的，到点不联网、不调 LLM；
     *  4. 纯系统闹铃循环 —— TTS 引擎缺失 / 初始化失败 / 中文语音包缺失。
     * 任何一级说完或失败都会接上系统闹铃循环，绝不静音；ringtoneStarted 保证不重复起铃。
     */
    private fun startPlaying(ttsBase64: String?, ttsFile: String?, voiceText: String?) {
        val voicePath = resolveVoicePath(ttsBase64, ttsFile)
        when {
            voicePath != null -> playVoiceClipThenRingtone(voicePath)
            !voiceText.isNullOrBlank() -> speakScriptThenRingtone(voiceText)
            else -> {
                Log.i(TAG, "no voice material, ringtone only alarm=$alarmId")
                startRingtoneLoop()
            }
        }
    }

    private fun resolveVoicePath(ttsBase64: String?, ttsFile: String?): String? {
        // 播放前最后一道质量关：缓存文件被清空/截断、下发的 base64 不是合法 mp3 时，
        // 直接跳到下一级降级，绝不让 MediaPlayer 播一片静音还以为 agent 说过话。
        ttsFile?.takeIf { it.isNotEmpty() && VoiceQuality.isPlayableAudioFile(File(it)) }
            ?.let { return it }
        if (ttsBase64.isNullOrEmpty()) return null
        return try {
            val bytes = android.util.Base64.decode(ttsBase64, android.util.Base64.DEFAULT)
            if (!VoiceQuality.isPlausibleMp3(bytes)) {
                Log.w(TAG, "trigger tts rejected by quality gate alarm=$alarmId")
                return null
            }
            val tmp = File.createTempFile("alarm_tts", ".mp3", cacheDir)
            tmp.writeBytes(bytes)
            voiceTempFile = tmp
            tmp.absolutePath
        } catch (e: Exception) {
            Log.w(TAG, "decode tts base64 failed", e)
            null
        }
    }

    private fun playVoiceClipThenRingtone(path: String) {
        try {
            player = MediaPlayer().apply {
                setAudioAttributes(voiceAudioAttributes())
                setDataSource(path)
                isLooping = false
                setOnCompletionListener { startRingtoneLoop() }
                // 准备成功但解码/输出中途失败也要接铃，不能停在静音
                setOnErrorListener { _, what, extra ->
                    Log.w(TAG, "voice clip playback error=$what/$extra alarm=$alarmId")
                    startRingtoneLoop()
                    true
                }
                prepare()
                start()
            }
            val source = if (path.endsWith(".wav", ignoreCase = true)) "wav" else "mp3"
            Log.i(TAG, "voice clip playing alarm=$alarmId source=$source")
        } catch (e: Exception) {
            Log.w(TAG, "play voice clip failed, fallback ringtone", e)
            startRingtoneLoop()
        }
    }

    /** 系统 TTS 念 agent 话术：初始化与朗读各有超时兜底，闹钟不会因 TTS 引擎异常而静音 */
    private fun speakScriptThenRingtone(text: String) {
        val handler = android.os.Handler(mainLooper)
        var initialized = false
        val initTimeout = Runnable {
            if (!initialized) {
                Log.w(TAG, "system TTS init timeout, fallback ringtone alarm=$alarmId")
                startRingtoneLoop()
            }
        }.also { ttsInitTimeout = it }
        val speakTimeout = Runnable {
            Log.w(TAG, "system TTS speak timeout, fallback ringtone alarm=$alarmId")
            startRingtoneLoop()
        }.also { ttsSpeakTimeout = it }

        try {
            textToSpeech = TextToSpeech(this) { status ->
                if (status != TextToSpeech.SUCCESS) {
                    Log.w(TAG, "system TTS init failed status=$status alarm=$alarmId")
                    handler.removeCallbacks(initTimeout)
                    handler.removeCallbacks(speakTimeout)
                    startRingtoneLoop()
                } else {
                    initialized = true
                    handler.removeCallbacks(initTimeout)
                    val engine = textToSpeech
                    if (engine == null) {
                        handler.removeCallbacks(speakTimeout)
                        startRingtoneLoop()
                    } else {
                        val lang = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
                        if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                            Log.w(TAG, "system TTS zh-CN unavailable code=$lang, use default locale alarm=$alarmId")
                            engine.setLanguage(Locale.getDefault())
                        }
                        engine.setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ALARM)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .setFlags(AudioAttributes.FLAG_AUDIBILITY_ENFORCED)
                                .build(),
                        )
                        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                            override fun onStart(utteranceId: String?) {}

                            override fun onDone(utteranceId: String?) {
                                if (utteranceId != UTTERANCE_ID) return
                                handler.removeCallbacks(speakTimeout)
                                Log.i(TAG, "system TTS wake script done alarm=$alarmId")
                                handler.post { startRingtoneLoop() }
                            }

                            @Suppress("OVERRIDE_DEPRECATION")
                            override fun onError(utteranceId: String?) {
                                handler.removeCallbacks(speakTimeout)
                                handler.post { startRingtoneLoop() }
                            }

                            override fun onError(utteranceId: String?, errorCode: Int) {
                                Log.w(TAG, "system TTS speak error=$errorCode alarm=$alarmId")
                                handler.removeCallbacks(speakTimeout)
                                handler.post { startRingtoneLoop() }
                            }
                        })
                        val rc = engine.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), UTTERANCE_ID)
                        if (rc != TextToSpeech.SUCCESS) {
                            Log.w(TAG, "system TTS speak rejected rc=$rc alarm=$alarmId")
                            handler.removeCallbacks(speakTimeout)
                            startRingtoneLoop()
                        } else {
                            Log.i(TAG, "system TTS speaking agent script chars=${text.length} alarm=$alarmId")
                        }
                    }
                }
            }
            handler.postDelayed(initTimeout, TTS_INIT_TIMEOUT_MS)
            handler.postDelayed(speakTimeout, TTS_SPEAK_TIMEOUT_MS)
        } catch (e: Exception) {
            Log.w(TAG, "system TTS unavailable, fallback ringtone", e)
            handler.removeCallbacks(initTimeout)
            handler.removeCallbacks(speakTimeout)
            startRingtoneLoop()
        }
    }

    /** 系统闹铃循环：每次重建 MediaPlayer，避开 reset 后状态机踩坑；ringtoneStarted 去重 */
    private fun startRingtoneLoop() {
        synchronized(this) {
            if (ringtoneStarted) return
            ringtoneStarted = true
        }
        try {
            player?.let { p ->
                try {
                    p.stop()
                    p.release()
                } catch (_: Exception) {
                }
            }
            player = MediaPlayer().apply {
                setAudioAttributes(alarmAudioAttributes())
                setDataSource(this@AlarmRingService, defaultAlarmUri())
                isLooping = true
                prepare()
                start()
            }
            Log.i(TAG, "ringtone loop started alarm=$alarmId")
        } catch (e: Exception) {
            Log.w(TAG, "start ringtone loop failed", e)
        }
    }

    /** 语音走 SPEECH 内容类型：系统按人声通路处理，避免被当成提示音压掉清晰度 */
    private fun voiceAudioAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

    private fun alarmAudioAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

    private fun defaultAlarmUri(): android.net.Uri =
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

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
        val handler = android.os.Handler(mainLooper)
        handler.removeCallbacks(stopRunnable)
        ttsInitTimeout?.let { handler.removeCallbacks(it) }
        ttsSpeakTimeout?.let { handler.removeCallbacks(it) }
        ttsInitTimeout = null
        ttsSpeakTimeout = null
        try {
            textToSpeech?.stop()
            textToSpeech?.shutdown()
        } catch (_: Exception) {
        }
        textToSpeech = null
        try {
            player?.stop()
            player?.release()
        } catch (_: Exception) {
        }
        player = null
        ringtoneStarted = false
        try {
            voiceTempFile?.delete()
        } catch (_: Exception) {
        }
        voiceTempFile = null
        try {
            vibrator?.cancel()
        } catch (_: Exception) {
        }
        vibrator = null
        try {
            wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
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
