package com.example.private_ai_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 常驻状态栏通知（2026-11-23 主动触达 §5.2）。
 *
 * 它不是一条新通知——就是保活前台服务原来那条占位通知（同一个 id [NOTIFICATION_ID]），
 * 只是从此只说有用的话：下一件事 + 倒计时、待取件、今天到期。三条约束：
 *  - 渠道 [CHANNEL_ID] 是 MIN：不响、不震、不弹横幅。常驻的东西再发出声音就是打扰；
 *  - **只更新，不新发**（同 id notify）。Android 14 起用户可以划掉前台服务通知，
 *    划掉不影响服务本身，下次看板推送时它会带着新内容回来；
 *  - 内容全部来自服务端 today-board，原生只贴字。排序、脱敏（金额不出服务端）
 *    都在服务端做，否则 Android/iOS/桌面卡片要各拼一套业务逻辑。
 *
 * 模式（§5.2「用户可改成极简 / 关闭」）存在端侧偏好里，切换即刻重画：
 *  - `full`：看板两行 + 两个按钮；
 *  - `minimal`：只显示管家名一行；
 *  - `off`：回到纯保活占位文案（服务还需要一条通知，这条不能没有）。
 */
object OngoingStatusNotifier {
    const val CHANNEL_ID = "ongoing_status"
    private const val LEGACY_CHANNEL_ID = "message_bridge"

    /** 与 [MessageBridgeForegroundService] 共用同一条通知 id：只更新不新发 */
    const val NOTIFICATION_ID = 3408

    const val ACTION_COMPLETE = "com.example.private_ai_app.action.ONGOING_COMPLETE"
    const val EXTRA_TOKEN = "nb_action_token"
    const val EXTRA_ACTION_ID = "nb_action_id"
    const val EXTRA_TASK_ID = "nb_task_id"

    private const val REQ_CONTENT = 3408
    private const val REQ_QUICK_NOTE = 3409
    private const val REQ_COMPLETE = 3410

    private const val PREFS = "ongoing_status_prefs"
    private const val KEY_MODE = "mode"
    private const val KEY_TITLE = "title"
    private const val KEY_TEXT = "text"
    private const val KEY_MINIMAL = "minimal_title"
    private const val KEY_ACTION_ID = "action_id"
    private const val KEY_TOKEN = "token"
    private const val KEY_TASK_ID = "task_id"
    private const val KEY_LABEL = "action_label"
    private const val KEY_HTTP_BASE = "http_base"

    private const val DEFAULT_TITLE = "管家在"
    private const val DEFAULT_TEXT = "正在保持消息同步与远程控制通道"

    /**
     * Dart 引擎在 => 点击交回 Dart（与聊天卡按钮同一条 executeNotifyAction 链路）。
     * 由 [KeepAlivePlugin] 在 attach 时注入、detach 时清空。
     */
    @Volatile
    var dartTapHandler: ((actionId: String, token: String, taskId: String) -> Unit)? = null

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 渠道只需建一次；顺带清掉改名前的旧渠道，设置页里不留「消息桥接」僵尸项。 */
    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "今日状态", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "常驻显示下一件事与待办，不响不震"
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                },
            )
        }
        nm.deleteNotificationChannel(LEGACY_CHANNEL_ID)
    }

    /** Dart 推来一帧看板（title/text 已由服务端算好），落偏好并重画同一条通知。 */
    fun update(ctx: Context, args: Map<*, *>) {
        val e = prefs(ctx).edit()
        (args["mode"] as? String)?.let { e.putString(KEY_MODE, it) }
        (args["title"] as? String)?.let { e.putString(KEY_TITLE, it) }
        (args["text"] as? String)?.let { e.putString(KEY_TEXT, it) }
        (args["minimalTitle"] as? String)?.let { e.putString(KEY_MINIMAL, it) }
        (args["httpBase"] as? String)?.let { e.putString(KEY_HTTP_BASE, it) }
        // 按钮：三个字段缺一个就当没有——半个按钮按下去没反应比没有按钮更糟
        val token = args["token"] as? String
        val actionId = args["actionId"] as? String
        e.putString(KEY_TOKEN, if (token.isNullOrEmpty() || actionId.isNullOrEmpty()) "" else token)
        if (!token.isNullOrEmpty() && !actionId.isNullOrEmpty()) {
            e.putString(KEY_ACTION_ID, actionId)
            e.putString(KEY_LABEL, (args["label"] as? String)?.takeIf { it.isNotBlank() } ?: "完成")
            e.putString(KEY_TASK_ID, (args["taskId"] as? String) ?: "")
        }
        e.apply()
        push(ctx)
    }

    fun setMode(ctx: Context, mode: String) {
        prefs(ctx).edit().putString(KEY_MODE, mode).apply()
        push(ctx)
    }

    fun mode(ctx: Context): String = prefs(ctx).getString(KEY_MODE, "full") ?: "full"

    /** 动作已在原生兜底通道执行成功：就地改成回执文案，等下一次看板推送换回来。 */
    fun markDone(ctx: Context, message: String) {
        prefs(ctx).edit().putString(KEY_TOKEN, "").putString(KEY_TEXT, message).apply()
        push(ctx)
    }

    /** 前台服务起通知与 Dart 推送共用这一个渲染入口：进程重启后内容从偏好里恢复。 */
    fun build(ctx: Context): Notification {
        ensureChannel(ctx)
        val p = prefs(ctx)
        val mode = p.getString(KEY_MODE, "full") ?: "full"
        val title: String
        val text: String
        when (mode) {
            "minimal" -> {
                title = p.getString(KEY_MINIMAL, DEFAULT_TITLE) ?: DEFAULT_TITLE
                text = ""
            }
            "off" -> {
                title = DEFAULT_TITLE
                text = DEFAULT_TEXT
            }
            else -> {
                title = p.getString(KEY_TITLE, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE
                text = p.getString(KEY_TEXT, "") ?: ""
            }
        }

        val launch = PendingIntent.getActivity(
            ctx,
            REQ_CONTENT,
            Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            pendingFlags(),
        )
        val b = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOf(title, text).joinToString(" · ")))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(launch)
        if (mode == "full") {
            // 「记一下」（§8.1 第五行）：带上入口提示进 [MainActivity]，Dart 侧
            // 弹半屏速记卡（文本/语音/拍照三选一）。「记什么」必须在 App 里问，
            // 内容只能从既有聊天链路走一遍才有「打算怎么做」的回执。
            b.addAction(
                NotificationCompat.Action(
                    android.R.drawable.ic_menu_edit,
                    "记一下",
                    PendingIntent.getActivity(
                        ctx,
                        REQ_QUICK_NOTE,
                        Intent(ctx, MainActivity::class.java)
                            .addFlags(
                                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP,
                            )
                            .putExtra(
                                ShareIntakeStore.EXTRA_ENTRY,
                                ShareIntakeStore.ENTRY_QUICK_NOTE,
                            ),
                        pendingFlags(),
                    ),
                ),
            )
            val token = p.getString(KEY_TOKEN, "") ?: ""
            if (token.isNotEmpty()) {
                val intent = Intent(ctx, OngoingStatusReceiver::class.java)
                    .setAction(ACTION_COMPLETE)
                    .putExtra(EXTRA_TOKEN, token)
                    .putExtra(EXTRA_ACTION_ID, p.getString(KEY_ACTION_ID, "") ?: "")
                    .putExtra(EXTRA_TASK_ID, p.getString(KEY_TASK_ID, "") ?: "")
                b.addAction(
                    NotificationCompat.Action(
                        android.R.drawable.checkbox_on_background,
                        p.getString(KEY_LABEL, "完成") ?: "完成",
                        PendingIntent.getBroadcast(ctx, REQ_COMPLETE, intent, pendingFlags()),
                    ),
                )
            }
        }
        return b.build()
    }

    /** 同 id notify = 原地更新。Android 14 允许用户划掉前台服务通知，这里不做抵抗。 */
    fun push(ctx: Context) {
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, build(ctx))
        } catch (e: Exception) {
            // 通知权限被关掉时 notify 会抛：保活服务不受影响，状态栏这行少一次刷新而已
            android.util.Log.w("OngoingStatus", "notify failed", e)
        }
        // 桌面小组件（§5.3）挂在同一次落盘上：这块看板变的那一刻，两个面一起变。
        // 小组件因此不需要自己的定时器 / WorkManager / 请求链路。
        com.example.private_ai_app.widget.TodayWidgetRenderer.renderAll(ctx)
    }

    fun httpBase(ctx: Context): String? = prefs(ctx).getString(KEY_HTTP_BASE, null)?.trimEnd('/')

    private fun pendingFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0)
}
