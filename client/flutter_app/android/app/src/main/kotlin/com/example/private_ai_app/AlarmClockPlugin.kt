package com.example.private_ai_app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 闹钟精确调度插件（AlarmClockPlugin）
 *
 * - scheduleNext: AlarmManager.setAlarmClock 预约下一跳（App 被杀也响）；
 *   同时把调度信息 + 预合成叫醒语音文件 + agent 叫醒话术写入 SharedPreferences，供开机重建。
 * - cancel: 取消预约、移除持久化条目与语音文件。
 * - ringNow: 服务端兜底触发 / 测试 —— 直接拉起响铃前台服务。
 * - canScheduleExact / openExactAlarmSettings / openAlarmReliabilitySettings: 权限探测与引导。
 *
 * 语音叫醒（2026-11-09 定稿）：话术由服务端 SpeechHub 在建钟时按当次上下文生成，
 * 云端 TTS 按这句动态话术实时合成 44.1kHz mp3，随 alarm.sync 下发、端侧落盘。
 * 端侧不再内置 ONNX 语音模型；三个内置 mp3 只是 A/B 测试基准（显式 builtinVoice 才用）。
 * 本地 AlarmManager 广播不依赖 WS / Dart 引擎 / 网络：有音频播音频，没有就由
 * 系统 TextToSpeech 念这段 agent 话术，再不济走系统闹铃循环。
 *
 * 「用完即删除」（两端对称）：mp3 落盘并排好精确闹钟后回报 voice/consume，云端立刻删
 * 内存与 voice-clips 目录下的缓存文件；端侧在关闭 / 60s 响完 / 取消时删私有 mp3 与 pending 引用，
 * 启动时再兜底清扫孤儿文件。TTL 只是两端都没能即时删时的异常兜底。
 */
class AlarmClockPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    companion object {
        private const val TAG = "AlarmClockPlugin"
        // 与 Dart AlarmPlatform._channel 必须逐字一致（2026-11-09 修复：此前两端分别为
        // nextbot/alarm_clock 与 private_ai_agent/alarm_clock，预约主路整体静默失效）
        private const val CHANNEL = "nextbot/alarm_clock"
        private const val PREFS = "alarm_clock_prefs"
        private const val KEY_PENDING = "pending_alarms"
        private const val FIRE_ACTION = "com.example.private_ai_app.alarm.FIRE"
        const val ACTION_SNOOZE = "com.example.private_ai_app.alarm.SNOOZE"
        const val ACTION_STOP = "com.example.private_ai_app.alarm.STOP"
        const val EXTRA_ALARM_ID = "alarmId"
        const val EXTRA_LABEL = "label"
        const val EXTRA_TTS_BASE64 = "ttsBase64"
        const val EXTRA_TTS_FILE = "ttsFile"
        const val EXTRA_VOICE_TEXT = "voiceText"
        /** 用户保留的三个固定音色随 APK 内置的 assets 子目录（字节与试听板逐字一致） */
        private const val ASSET_VOICE_DIR = "alarm_voices"

        @Volatile
        var instance: AlarmClockPlugin? = null
            private set

        /** 云端按动态话术实时合成的 mp3 落盘：过音质门禁后才写盘，是默认主音源 */
        fun storeVoiceClip(ctx: Context, alarmId: String, ttsBase64: String?): String? {
            if (ttsBase64.isNullOrEmpty()) return null
            return try {
                val bytes = Base64.decode(ttsBase64, Base64.DEFAULT)
                if (!VoiceQuality.isPlausibleMp3(bytes)) {
                    Log.w(TAG, "cloud voice clip rejected by quality gate alarm=$alarmId")
                    return null
                }
                val dir = File(ctx.filesDir, "alarm_voice").apply { mkdirs() }
                val file = File(dir, "alarm_${alarmId.hashCode()}.mp3")
                file.writeBytes(bytes)
                file.absolutePath
            } catch (e: Exception) {
                Log.w(TAG, "store voice clip failed", e)
                null
            }
        }

        /**
         * 「用完即删除」（端侧主触发点）：删掉该闹钟唯一的动态音频副本
         * （云端按当次话术实时合成的 mp3），并抹掉 pending_alarms 里的路径 / 音源标记。
         * 话术文本保留，没有 mp3 时由系统 TTS 念出来。触发点：关闭 / 60s 响完 /
         * 取消 / 开机时已过期的预约。幂等，只删自己目录下的 alarm_*.mp3。
         */
        fun releaseVoiceClip(ctx: Context, alarmId: String) {
            if (alarmId.isEmpty()) return
            try {
                val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val map = readPending(prefs)
                val entry = map[alarmId]
                deleteOwnedVoiceFile(ctx, entry?.optString("ttsFile", "")?.takeIf { it.isNotEmpty() })
                deleteOwnedVoiceFile(
                    ctx,
                    File(ctx.filesDir, "alarm_voice/alarm_${alarmId.hashCode()}.mp3").absolutePath,
                )
                if (entry != null) {
                    entry.remove("ttsFile")
                    entry.remove("voiceSource")
                    val out = JSONObject()
                    for ((id, e) in map) out.put(id, e)
                    prefs.edit().putString(KEY_PENDING, out.toString()).apply()
                }
                Log.i(TAG, "voice clip released after use alarm=$alarmId")
            } catch (e: Exception) {
                Log.w(TAG, "release voice clip failed alarm=$alarmId", e)
            }
        }

        /** 只删应用私有 alarm_voice/ 下的动态音频，绝不误删内置测试音色或任意外部路径 */
        private fun deleteOwnedVoiceFile(ctx: Context, path: String?) {
            if (path.isNullOrEmpty()) return
            try {
                val dir = File(ctx.filesDir, "alarm_voice").canonicalFile
                val file = File(path).canonicalFile
                if (file.parentFile != dir || !file.name.startsWith("alarm_")) return
                if (file.exists()) file.delete()
            } catch (_: Exception) {
            }
        }

        /**
         * 端侧消费回执：mp3 已落盘 + 本地精确闹钟已排好 → 通知云端立即删内存与磁盘缓存。
         * 失败不重试（云端还有兜底 TTL 兜着），也不影响本地主路（到点零网络）。
         */
        fun ackVoiceConsumed(ctx: Context, alarmId: String) {
            val base = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString("http_base", null)?.trimEnd('/')
            if (base.isNullOrEmpty()) return
            Thread {
                try {
                    val url = "$base/api/alarms/${java.net.URLEncoder.encode(alarmId, "UTF-8")}/voice/consume"
                    val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                        requestMethod = "POST"
                        setRequestProperty("Content-Type", "application/json")
                        doOutput = true
                        connectTimeout = 4000
                        readTimeout = 4000
                    }
                    conn.outputStream.use { it.write("{}".toByteArray()) }
                    val code = conn.responseCode
                    conn.disconnect()
                    Log.i(TAG, "voice consume ack alarm=$alarmId http=$code")
                } catch (e: Exception) {
                    Log.w(TAG, "voice consume ack failed alarm=$alarmId", e)
                }
            }.apply { isDaemon = true }.start()
        }

        /**
         * 端侧兜底清扫（App 启动 / 开机）：上次被杀进程没来得及删的音频在这里收口。
         * 只保留「仍在 pending 且未过期」条目引用的文件，其余动态音频与内置音色副本一律删。
         */
        fun sweepOrphanVoiceClips(ctx: Context) {
            try {
                val dir = File(ctx.filesDir, "alarm_voice")
                if (!dir.exists()) return
                val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val map = readPending(prefs)
                val staleBefore = System.currentTimeMillis() - 2 * 60 * 60_000L
                val keep = mutableSetOf<String>()
                for ((id, entry) in map) {
                    val epoch = entry.optLong("epochMs", 0L)
                    if (epoch in 1L until staleBefore) {
                        releaseVoiceClip(ctx, id)
                        continue
                    }
                    val p = entry.optString("ttsFile", "")
                    if (p.isNotEmpty()) {
                        try {
                            keep.add(File(p).canonicalPath)
                        } catch (_: Exception) {
                        }
                    }
                }
                var removed = 0
                for (f in dir.listFiles() ?: return) {
                    val owned = f.name.startsWith("alarm_") || f.name.startsWith("builtin_")
                    if (owned && !keep.contains(f.canonicalPath) && f.delete()) removed++
                }
                if (removed > 0) Log.i(TAG, "swept orphan voice clips count=$removed")
            } catch (e: Exception) {
                Log.w(TAG, "sweep orphan voice clips failed", e)
            }
        }

        /** 持久化条目（开机重建 / 音频清扫共用） */
        fun readPending(prefs: android.content.SharedPreferences): MutableMap<String, JSONObject> {
            val out = mutableMapOf<String, JSONObject>()
            val raw = prefs.getString(KEY_PENDING, null) ?: return out
            try {
                val obj = JSONObject(raw)
                for (key in obj.keys()) out[key] = obj.getJSONObject(key)
            } catch (_: Exception) {
            }
            return out
        }

        /** 从持久化条目取语音文件路径（AlarmClockReceiver / 开机重建共用） */
        fun pendingTtsFile(ctx: Context, alarmId: String): String? = try {
            val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_PENDING, null) ?: return null
            JSONObject(raw).optJSONObject(alarmId)?.optString("ttsFile", "")
                ?.takeIf { it.isNotEmpty() && File(it).exists() }
        } catch (_: Exception) {
            null
        }

        /** 从持久化条目取 agent 叫醒话术（无 mp3 时交系统 TTS 念出来） */
        fun pendingVoiceText(ctx: Context, alarmId: String): String? = try {
            val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_PENDING, null) ?: return null
            JSONObject(raw).optJSONObject(alarmId)?.optString("voiceText", "")
                ?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }

        /** 音源标记：builtin=APK 内置固定测试音色 / cloud=服务端按话术实时合成的 mp3 */
        fun pendingVoiceSource(ctx: Context, alarmId: String): String? = try {
            val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_PENDING, null) ?: return null
            JSONObject(raw).optJSONObject(alarmId)?.optString("voiceSource", "")
                ?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }

        /**
         * 用户 2026-11-09 在音色试听板保留的三个声音（#1 diana / #6 anna / #2 alex）。
         * **仅作 A/B 测试基准**，不是交付音源：默认叫醒走云端按话术实时合成的 mp3，
         * 只有显式传 builtinVoice 时才用这三份固定字节，保证对照可复现。
         */
        fun builtinVoiceCatalog(ctx: Context): List<Map<String, Any?>> =
            BuiltinVoice.values().map { v ->
                val size = try {
                    ctx.assets.open("$ASSET_VOICE_DIR/${v.asset}").use { it.readBytes().size }
                } catch (_: Exception) {
                    -1
                }
                mapOf(
                    "id" to v.id,
                    "title" to v.title,
                    "tone" to v.tone,
                    "asset" to "$ASSET_VOICE_DIR/${v.asset}",
                    "bytes" to size,
                )
            }

        /** assets → 私有可播放文件；过音质门禁后才落盘，失败返回 null（自动回退其它音源） */
        fun resolveBuiltinVoice(ctx: Context, id: String?): String? {
            val voice = BuiltinVoice.from(id) ?: return null
            return try {
                val bytes = ctx.assets.open("$ASSET_VOICE_DIR/${voice.asset}").use { it.readBytes() }
                if (!VoiceQuality.isPlausibleMp3(bytes)) {
                    Log.w(TAG, "builtin voice rejected by quality gate id=${voice.id}")
                    return null
                }
                val dir = File(ctx.filesDir, "alarm_voice").apply { mkdirs() }
                val file = File(dir, "builtin_${voice.id}.mp3")
                file.writeBytes(bytes)
                Log.i(TAG, "builtin voice ready id=${voice.id} bytes=${bytes.size} path=${file.absolutePath}")
                file.absolutePath
            } catch (e: Exception) {
                Log.w(TAG, "builtin voice unavailable id=${voice.id}", e)
                null
            }
        }
    }

    private var channel: MethodChannel? = null
    private var appContext: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        // 上次被杀进程/崩溃没走到「响完即删」的音频，在这里兜底清掉
        sweepOrphanVoiceClips(binding.applicationContext)
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        // 通知动作（贪睡/关闭）→ Dart AlarmEngine（响铃 UI 与业务推进收口在 Dart 侧）
        AlarmRingActionsReceiver.dartActionHandler = { action: String, alarmId: String ->
            channel?.invokeMethod("alarmAction", mapOf("action" to action, "alarmId" to alarmId))
        }
        instance = this
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        AlarmRingActionsReceiver.dartActionHandler = null
        if (instance === this) instance = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = appContext
        if (ctx == null) {
            result.error("NO_CONTEXT", "application context unavailable", null)
            return
        }
        when (call.method) {
            "configure" -> {
                val httpBase = call.argument<String>("httpBase") ?: ""
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("http_base", httpBase).apply()
                result.success(true)
            }
            "scheduleNext" -> {
                val alarmId = call.argument<String>("alarmId") ?: ""
                val epochMs = call.argument<Number>("epochMs")?.toLong() ?: 0L
                val label = call.argument<String>("label") ?: ""
                val tts = call.argument<String>("ttsBase64")
                val voiceText = call.argument<String>("voiceText")
                val builtinVoice = call.argument<String>("builtinVoice")
                if (alarmId.isEmpty() || epochMs <= 0L) {
                    result.error("BAD_ARGS", "alarmId/epochMs required", null)
                    return
                }
                // Dart 侧契约是 invokeMethod<bool>：true=精确闹钟，false=降级窗口/桥不可用
                result.success(scheduleExact(ctx, alarmId, epochMs, label, tts, voiceText, builtinVoice))
            }
            "cancel" -> {
                cancelAlarm(ctx, call.argument<String>("alarmId") ?: "")
                result.success(true)
            }
            // 响完 / 关闭：立即删本端动态音频（贪睡不调，下一跳还要用）
            "releaseVoice" -> {
                releaseVoiceClip(ctx, call.argument<String>("alarmId") ?: "")
                result.success(true)
            }
            "canScheduleExact" -> result.success(canScheduleExact(ctx))
            "openExactAlarmSettings" -> {
                openExactAlarmSettings(ctx)
                result.success(true)
            }
            "openAlarmReliabilitySettings" -> {
                openAlarmReliabilitySettings(ctx)
                result.success(true)
            }
            "isBatteryOptimizationIgnored" -> result.success(isBatteryOptimizationIgnored(ctx))
            "listBuiltinVoices" -> result.success(builtinVoiceCatalog(ctx))
            "ringNow" -> {
                val alarmId = call.argument<String>("alarmId") ?: ""
                val label = call.argument<String>("label") ?: ""
                val tts = call.argument<String>("ttsBase64")
                // 指定 builtinVoice 时跑三个固定测试音色之一（仅 A/B 对照用）；
                // 默认用服务端下发的云端 mp3，没音频则交系统 TTS 念 voiceText。
                val builtinFile = resolveBuiltinVoice(ctx, call.argument<String>("builtinVoice"))
                AlarmRingService.start(
                    ctx, alarmId, label, tts, builtinFile, call.argument<String>("voiceText")
                )
                result.success(true)
            }
            "stopRing" -> {
                AlarmRingService.stopAll(ctx)
                result.success(true)
            }
            else -> result.notImplemented()
        }
    }

    private fun canScheduleExact(ctx: Context): Boolean {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.canScheduleExactAlarms() else true
    }

    private fun openExactAlarmSettings(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                    .setData(Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(intent)
            } catch (e: Exception) {
                Log.w(TAG, "open exact alarm settings failed", e)
            }
        }
    }

    /** Android 14+ 全屏意图授权 + 电池优化白名单（原生闹钟可靠性的两个系统开关） */
    private fun openAlarmReliabilitySettings(ctx: Context) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ctx.startActivity(
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                        .setData(Uri.parse("package:${ctx.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                return
            }
        } catch (e: Exception) {
            Log.w(TAG, "open full screen intent settings failed", e)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !isBatteryOptimizationIgnored(ctx)) {
                ctx.startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                        .setData(Uri.parse("package:${ctx.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "open battery optimization settings failed", e)
        }
    }

    private fun isBatteryOptimizationIgnored(ctx: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(ctx.packageName)
        } else {
            true
        }

    /** 返回 true=精确闹钟已预约，false=权限缺失退化为 ±10min 窗口 */
    private fun scheduleExact(
        ctx: Context,
        alarmId: String,
        epochMs: Long,
        label: String,
        ttsBase64: String?,
        voiceText: String? = null,
        builtinVoiceId: String? = null,
    ): Boolean {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val script = voiceText?.takeIf { it.isNotBlank() } ?: pendingVoiceText(ctx, alarmId)
        // 默认主路 = 服务端按动态话术实时合成的云端 mp3（建钟时下发、端侧落盘）。
        // 端侧不再内置 ONNX 模型；三个内置 mp3 只在显式 builtinVoice 的 A/B 测试里生效。
        val builtinFile = resolveBuiltinVoice(ctx, builtinVoiceId)
        val cloudFile = storeVoiceClip(ctx, alarmId, ttsBase64)
        // 无新 base64 时沿用开机重建 / 重复 sync 留下的音频路径（含升级前遗留的本地 WAV）
        val ttsFile = builtinFile ?: cloudFile ?: pendingTtsFile(ctx, alarmId)
        val voiceSource = when {
            builtinFile != null -> "builtin:${BuiltinVoice.from(builtinVoiceId)?.id}"
            cloudFile != null -> "cloud"
            ttsFile != null -> pendingVoiceSource(ctx, alarmId) ?: "unknown"
            else -> null
        }
        persistPending(ctx, alarmId, epochMs, label, ttsFile, script, voiceSource)
        val pi = alarmPendingIntent(ctx, alarmId, label, ttsFile, script)
        val exact = canScheduleExact(ctx)
        if (exact) {
            // setAlarmClock 比 setExactAndAllowWhileIdle 更抗 Doze，且会进入系统闹钟列表
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                am.setAlarmClock(AlarmManager.AlarmClockInfo(epochMs, showIntent(ctx)), pi)
            } else {
                @Suppress("DEPRECATION")
                am.setExact(AlarmManager.RTC_WAKEUP, epochMs, pi)
            }
        } else {
            am.setWindow(AlarmManager.RTC_WAKEUP, epochMs, 10 * 60_000L, pi)
        }
        val whenTxt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(epochMs))
        Log.i(
            TAG,
            "scheduled alarm=$alarmId mode=${if (exact) "exact" else "window10m"} " +
                "tts=${ttsFile != null} source=$voiceSource script=${script != null} at=$whenTxt",
        )
        // 云端音频已被本端安全接管（落盘 + 本地精确闹钟排好）→ 通知云端立即删掉那份缓存。
        // 只在本次确实落盘了云端 mp3 时回报；内置测试音色 / 开机重建不触发。
        if (cloudFile != null) ackVoiceConsumed(ctx, alarmId)
        return exact
    }

    private fun showIntent(ctx: Context): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            putExtra("source", "alarm_clock")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        return PendingIntent.getActivity(
            ctx, 7, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun cancelAlarm(ctx: Context, alarmId: String) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = alarmPendingIntent(ctx, alarmId, "", null, null)
        try {
            am.cancel(pi)
        } catch (_: Exception) {
        }
        // 取消 = 音频再也不会被用：删私有 mp3 与 pending 里的音频引用，不等任何定时清扫
        releaseVoiceClip(ctx, alarmId)
        removePending(ctx, alarmId)
        Log.i(TAG, "cancelled alarm=$alarmId")
    }

    private fun alarmPendingIntent(
        ctx: Context,
        alarmId: String,
        label: String,
        ttsFile: String?,
        voiceText: String? = null,
    ): PendingIntent {
        val intent = Intent(ctx, AlarmClockReceiver::class.java).apply {
            action = FIRE_ACTION
            putExtra(EXTRA_ALARM_ID, alarmId)
            putExtra(EXTRA_LABEL, label)
            if (!ttsFile.isNullOrEmpty()) putExtra(EXTRA_TTS_FILE, ttsFile)
            if (!voiceText.isNullOrBlank()) putExtra(EXTRA_VOICE_TEXT, voiceText)
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        return PendingIntent.getBroadcast(ctx, alarmId.hashCode(), intent, flags)
    }

    // ─── 持久化（开机重建用）：SharedPreferences 存 JSON map ───

    private fun persistPending(
        ctx: Context,
        alarmId: String,
        epochMs: Long,
        label: String,
        ttsFile: String?,
        voiceText: String? = null,
        voiceSource: String? = null,
    ) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val map = readPending(prefs)
        val previousSource = map[alarmId]?.optString("voiceSource", "")?.takeIf { it.isNotBlank() }
        val entry = JSONObject().put("epochMs", epochMs).put("label", label)
        if (!ttsFile.isNullOrEmpty()) entry.put("ttsFile", ttsFile)
        if (!voiceText.isNullOrBlank()) entry.put("voiceText", voiceText)
        // 不传时沿用旧值：开机重建 / 只改状态不能把 cloud 标记抹成 unknown
        (voiceSource ?: previousSource)?.let { entry.put("voiceSource", it) }
        map.put(alarmId, entry)
        prefs.edit().putString(KEY_PENDING, map.toString()).apply()
    }

    private fun removePending(ctx: Context, alarmId: String) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val map = readPending(prefs)
        map.remove(alarmId)
        prefs.edit().putString(KEY_PENDING, map.toString()).apply()
    }

    /** 开机重建：重挂全部持久化条目（BootReceiver 调用），语音文件与话术沿用磁盘缓存 */
    fun rescheduleAllOnBoot(ctx: Context) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        for ((alarmId, entry) in readPending(prefs)) {
            val epochMs = entry.optLong("epochMs", 0L)
            if (epochMs <= now) {
                // 开机前错过的跳按设计丢弃，对应音频也一并删掉，不留在磁盘上
                releaseVoiceClip(ctx, alarmId)
                removePending(ctx, alarmId)
                continue
            }
            val ttsFile = entry.optString("ttsFile", "").takeIf { it.isNotEmpty() && File(it).exists() }
            val voiceText = entry.optString("voiceText", "").takeIf { it.isNotBlank() }
            val voiceSource = entry.optString("voiceSource", "").takeIf { it.isNotBlank() }
            val label = entry.optString("label", "")
            scheduleExact(ctx, alarmId, epochMs, label, null, voiceText)
            // scheduleExact 在无新 base64 时会沿用 pendingTtsFile，这里再兜一次防 JSONObject 覆盖丢字段
            if (ttsFile != null) {
                persistPending(ctx, alarmId, epochMs, label, ttsFile, voiceText, voiceSource)
            }
        }
    }
}

/** 与 `data/tts_samples/tts-voice-samples.html` 保留的 #1/#6/#2 一一对应，仅测试基准，非默认音源 */
enum class BuiltinVoice(val id: String, val asset: String, val title: String, val tone: String) {
    DIANA("diana", "diana_44k.mp3", "#1 diana", "最亮、电平健康 · 44.1kHz（云端对照样本）"),
    ANNA("anna", "current_anna_24k.mp3", "#6 anna", "旧对照 · 24kHz，偏沙哑，仅作退化对照"),
    ALEX("alex", "alex_44k.mp3", "#2 alex", "候选音色 · 44.1kHz");

    companion object {
        fun from(id: String?): BuiltinVoice? = values().firstOrNull { it.id == id }
    }
}
