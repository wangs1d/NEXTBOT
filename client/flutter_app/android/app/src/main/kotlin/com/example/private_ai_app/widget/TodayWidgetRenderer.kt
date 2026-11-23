package com.example.private_ai_app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import com.example.private_ai_app.MainActivity
import com.example.private_ai_app.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 把今日看板画到桌面（2026-11-23 主动触达 §5.3）。
 *
 * 只有两件事：**读同一帧看板**（[TodayWidgetData]）、**贴到 RemoteViews**。
 * 刷新不自己排队：常驻通知内容落盘的那一刻（`OngoingStatusNotifier.push` 这个唯一渲染出口）
 * 顺带调一次 [renderAll]；系统给的 `updatePeriodMillis`（30min）只当兜底。
 * 不引 WorkManager、不加定时器、不开第二条连接——小组件是同一块看板的第二个面。
 * 倒计时走字由 [android.widget.Chronometer] 自己完成，所以「还有 40 分钟」不会挂着不动。
 *
 * 隐私跟随 §5.2 的模式开关：用户把常驻通知设成极简/关闭，就是不想把日程摊在桌面上，
 * 小组件同步收成一行管家名。金额本来就不出服务端，这里无需额外处理。
 */
object TodayWidgetRenderer {

    private const val TAG = "TodayWidget"

    /** 只存「内容什么时候变的」这一个诊断量，不存业务数据（数据仍在 ongoing_status_prefs） */
    private const val RENDER_PREFS = "today_widget_render_state"
    private const val KEY_SIG = "content_sig"
    private const val KEY_AT = "content_at_ms"

    /** 超过这个时长就不走字：跨天残留宁可静止，也别显示一个来路不明的倒计时 */
    private const val MAX_COUNTDOWN_MS = 6L * 60 * 60 * 1000

    /**
     * 各区域的落点（PRD §5.3「各区域深链到对应页面」）。
     *
     * 路由值挂在 [ShareIntakeStore.EXTRA_ROUTE] 上，由 `MainActivity.forwardIntake`
     * 写进既有那条原生中转队列（与「记一下」的 entry 同一个队列、同一次 `take`），
     * Dart 侧按表切主壳 tab：schedule → 行程表，bill / parcel → 动态页。
     * 不新起深链解析、不加第二条通道：冷启动引擎没 attach 时值留在队列里，起来自取。
     */
    const val EXTRA_ROUTE = com.example.private_ai_app.ShareIntakeStore.EXTRA_ROUTE
    const val ROUTE_SCHEDULE = "schedule"
    const val ROUTE_PARCEL = "parcel"
    const val ROUTE_BILL = "bill"
    const val ROUTE_NOTE = "note"

    private const val REQ_SCHEDULE = 3420
    private const val REQ_PARCEL = 3421
    private const val REQ_BILL = 3422
    private const val REQ_NOTE = 3423

    enum class Size { Compact, Board }

    /** 看板一有新帧就被调用：把桌面上所有已添加的实例重画一遍 */
    fun renderAll(ctx: Context) {
        try {
            val mgr = AppWidgetManager.getInstance(ctx)
            render(ctx, mgr, mgr.getAppWidgetIds(ComponentName(ctx, TodayWidgetProvider::class.java)), Size.Compact)
            render(ctx, mgr, mgr.getAppWidgetIds(ComponentName(ctx, TodayBoardWidgetProvider::class.java)), Size.Board)
        } catch (e: Exception) {
            // 桌面繁忙 / 实例正在删除：下一次看板推送会再来一遍，不打扰用户
            Log.w(TAG, "widget render failed", e)
        }
    }

    /** Provider 的 onUpdate / onEnabled / 系统周期刷新都汇到这一个入口 */
    fun render(ctx: Context, mgr: AppWidgetManager, ids: IntArray?, size: Size) {
        if (ids == null || ids.isEmpty()) return
        try {
            val board = TodayWidgetData.load(ctx)
            val updatedAt = trackContentChange(ctx, board)
            val views = build(ctx, board, size, updatedAt) ?: return
            for (id in ids) {
                try {
                    mgr.updateAppWidget(id, views)
                } catch (e: Exception) {
                    Log.w(TAG, "updateAppWidget($id) failed", e)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "widget build failed", e)
        }
    }

    // ── 构建 ────────────────────────────────────────────────────────────────

    private fun build(
        ctx: Context,
        board: TodayWidgetData.Board,
        size: Size,
        updatedAt: Long,
    ): RemoteViews? {
        // 极简 / 关闭：只留管家那一行，事项明细不上桌面
        val collapsed = board.mode == "minimal" || board.mode == "off"
        return when (size) {
            Size.Compact -> RemoteViews(ctx.packageName, R.layout.widget_today_2x2).also { v ->
                v.setTextView(
                    R.id.widget_caption,
                    if (collapsed) board.agentName else ctx.getString(R.string.widget_caption_today),
                )
                if (collapsed) {
                    v.setGone(R.id.widget_next)
                    v.setGone(R.id.widget_countdown)
                    v.setTextView(R.id.widget_butler, ctx.getString(R.string.widget_off_line))
                    v.setVisible(R.id.widget_butler)
                } else {
                    renderNextLine(ctx, v, board)
                    if (board.idle) {
                        v.setTextView(R.id.widget_butler, board.butler)
                        v.setVisible(R.id.widget_butler)
                    } else {
                        v.setGone(R.id.widget_butler)
                    }
                }
                v.setOnClick(R.id.widget_root, launch(ctx, ROUTE_SCHEDULE, REQ_SCHEDULE))
                stamp(v, ctx, updatedAt)
            }

            Size.Board -> RemoteViews(ctx.packageName, R.layout.widget_today_4x2).also { v ->
                v.setTextView(R.id.widget_caption, ctx.getString(R.string.widget_caption_today))
                v.setOnClick(R.id.widget_note, launch(ctx, ROUTE_NOTE, REQ_NOTE))
                if (collapsed) {
                    v.setTextView(R.id.widget_next, board.agentName)
                    v.setVisible(R.id.widget_next)
                    v.setGone(R.id.widget_countdown)
                    v.setGone(R.id.widget_parcel)
                    v.setGone(R.id.widget_bill)
                    v.setTextView(R.id.widget_butler, ctx.getString(R.string.widget_off_line))
                } else {
                    renderNextLine(ctx, v, board)
                    v.setTextView(R.id.widget_parcel, board.parcel)
                    if (board.parcel.isEmpty()) v.setGone(R.id.widget_parcel) else v.setVisible(R.id.widget_parcel)
                    v.setTextView(R.id.widget_bill, board.bill)
                    if (board.bill.isEmpty()) v.setGone(R.id.widget_bill) else v.setVisible(R.id.widget_bill)
                    v.setTextView(R.id.widget_butler, board.butler)
                    v.setVisible(R.id.widget_butler)
                    v.setOnClick(R.id.widget_parcel, launch(ctx, ROUTE_PARCEL, REQ_PARCEL))
                    v.setOnClick(R.id.widget_bill, launch(ctx, ROUTE_BILL, REQ_BILL))
                }
                v.setOnClick(R.id.widget_next_row, launch(ctx, ROUTE_SCHEDULE, REQ_SCHEDULE))
                v.setOnClick(R.id.widget_root, launch(ctx, ROUTE_SCHEDULE, REQ_SCHEDULE))
                stamp(v, ctx, updatedAt)
            }
        }
    }

    /** 下一件事那一行：能走字就走字，否则退回服务端给的那句静态倒计时 */
    private fun renderNextLine(ctx: Context, v: RemoteViews, board: TodayWidgetData.Board) {
        val next = board.next
        if (next.isEmpty()) {
            v.setGone(R.id.widget_next)
            v.setGone(R.id.widget_countdown)
            return
        }
        val remain = board.nextStartMs - System.currentTimeMillis()
        val live = board.nextStartMs > 0L && remain in 1L..MAX_COUNTDOWN_MS
        v.setVisible(R.id.widget_next)
        if (live) {
            v.setTextView(R.id.widget_next, next)
            v.setVisible(R.id.widget_countdown)
            // Chronometer 的 base 走 elapsedRealtime 时基：现在 + 剩余毫秒 = 到点归零
            v.setChronometer(
                R.id.widget_countdown,
                SystemClock.elapsedRealtime() + remain,
                // 模板原样交给系统：它每 tick 自己套一次「还有 %s」，这就是不刷新的代价为零的原因
                ctx.getString(R.string.widget_countdown_format),
                true,
            )
        } else {
            v.setTextView(
                R.id.widget_next,
                if (board.countdownText.isEmpty()) next else "$next · ${board.countdownText}",
            )
            v.setGone(R.id.widget_countdown)
        }
    }

    /** 断网时这一行就是「最后一次数据 + 更新时间」（§5.4） */
    private fun stamp(v: RemoteViews, ctx: Context, updatedAt: Long) {
        if (updatedAt <= 0L) {
            v.setGone(R.id.widget_updated)
            return
        }
        val label = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(updatedAt))
        v.setTextView(R.id.widget_updated, ctx.getString(R.string.widget_updated_format, label))
        v.setVisible(R.id.widget_updated)
    }

    /**
     * 内容签名 → 内容最后一次真正变化的时刻。
     * 看板没变（断网反复重画）时时间戳保持不动，桌面上写的就是真实的数据时间。
     */
    private fun trackContentChange(ctx: Context, board: TodayWidgetData.Board): Long {
        if (board.boardUpdatedAtMs > 0L) return board.boardUpdatedAtMs
        val sig = listOf(
            board.mode, board.agentName, board.next, board.nextStartMs,
            board.parcel, board.bill, board.butler,
        ).joinToString("|")
        val p = ctx.getSharedPreferences(RENDER_PREFS, Context.MODE_PRIVATE)
        val last = p.getString(KEY_SIG, "") ?: ""
        if (last == sig) return p.getLong(KEY_AT, 0L)
        val now = System.currentTimeMillis()
        p.edit().putString(KEY_SIG, sig).putLong(KEY_AT, now).apply()
        return now
    }

    private fun launch(ctx: Context, route: String, requestCode: Int): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_ROUTE, route)
        // 右上角「记一下」（§8.1）：与常驻通知那个按钮同一个入口——落到原生队列，
        // Dart 起来弹半屏速记卡。route 照带（note 在 Dart 侧不切页，只有 entry 生效）。
        if (route == ROUTE_NOTE) {
            intent.putExtra(
                com.example.private_ai_app.ShareIntakeStore.EXTRA_ENTRY,
                com.example.private_ai_app.ShareIntakeStore.ENTRY_QUICK_NOTE,
            )
        }
        // requestCode 逐区域固定 + FLAG_UPDATE_CURRENT：同一区域连点只会刷新那一个
        // PendingIntent，不会攒出一叠待投递的重复导航。
        return PendingIntent.getActivity(ctx, requestCode, intent, pendingFlags())
    }

    private fun pendingFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0)
}

/** RemoteViews 的三个小别名：调用点少一层噪音（成员函数优先，不会递归） */
private fun RemoteViews.setTextView(id: Int, text: String) = setTextViewText(id, text)

private fun RemoteViews.setVisible(id: Int) = setViewVisibility(id, View.VISIBLE)

private fun RemoteViews.setGone(id: Int) = setViewVisibility(id, View.GONE)

private fun RemoteViews.setOnClick(id: Int, pi: PendingIntent) = setOnClickPendingIntent(id, pi)
