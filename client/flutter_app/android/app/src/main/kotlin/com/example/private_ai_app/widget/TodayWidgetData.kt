package com.example.private_ai_app.widget

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.regex.Pattern

/**
 * 小组件读到的那一帧「今日看板」（2026-11-23 主动触达 §5.3）。
 *
 * 数据源不新建：读的就是常驻通知那份偏好 `ongoing_status_prefs`
 * （`OngoingStatusNotifier.update()` 在服务端看板落盘那一刻写的），键名与它一一对应。
 * 小组件不发请求、不起定时器、不建第二个存储——「同一块看板，两个面」是这一节的全部要点。
 *
 * 读法分两层，能拿到多权威就拿多权威：
 *  1. 整帧看板（`widget_state`，或 `board_lines_json` + `next_start_ms`）：
 *     直接用服务端排好序、脱好敏的 `lines` 与 `nextEvent.startMs`；
 *  2. 只有 `title` / `text` 两行字时（现在 Dart 只透传这两个字段）：按分隔符把行归位、
 *     从「HH:mm」前缀还原倒计时基准。
 * 第 2 层是**展示层拆解**，不是业务判断：哪几条、什么顺序、金额脱敏仍在服务端
 * `services/today-board.ts`。第 1 层一旦出现，拆解分支自动退让。
 */
object TodayWidgetData {

    /** 与 OngoingStatusNotifier.PREFS 同名：刻意复用，不留第二个偏好文件 */
    const val PREFS = "ongoing_status_prefs"
    private const val KEY_MODE = "mode"
    private const val KEY_TITLE = "title"
    private const val KEY_TEXT = "text"
    private const val KEY_MINIMAL = "minimal_title"

    // 可选增强键：整帧看板透传时才有；缺席就走 title/text 拆解（小组件照样出字）。
    // 三种写法都认，方便与 Dart 侧的桥接方式解耦：
    //   widget_state      —— 整个 /api/widget/today 响应（JSONObject）
    //   board_lines_json  —— 只给 lines 数组
    //   next_start_ms / board_updated_at —— 倒计时基准与那一帧的时刻
    private const val KEY_STATE = "widget_state"
    private const val KEY_LINES = "board_lines_json"
    private const val KEY_NEXT_START_MS = "next_start_ms"
    private const val KEY_BOARD_UPDATED_AT = "board_updated_at"

    /** 有下一件事时服务端给的标题形如「15:00 牙医」 */
    private val TIME_HEAD = Pattern.compile("^(\\d{1,2}:\\d{2})\\s+\\S.*$")

    /** 倒计时在行内出现时的样子：「… · 还有 40 分钟」「马上」 */
    private val COUNTDOWN = Pattern.compile(".*(还有\\s*\\d|马上).*")

    private val TIME_PREFIX = Regex("^(\\d{1,2}):(\\d{2})")

    private const val DEFAULT_AGENT = "管家在"
    private const val DEFAULT_IDLE = "今天没什么要操心的"

    /** 一行字的归位结果（拆解层用） */
    enum class Slot { Next, Parcel, Bill, Butler, Countdown }

    /** 权威帧：lines 已排好序；nextLabel/nextStartMs 来自 nextEvent */
    private data class Snapshot(
        val lines: List<Pair<String, String>>,
        val nextLabel: String,
        val nextStartMs: Long,
        val updatedAtMs: Long,
    )

    data class Board(
        val mode: String,
        val agentName: String,
        /** 下一件事那一行（已剥掉倒计时，倒计时交给 Chronometer） */
        val next: String,
        /** 下一件事的开始时刻（epoch ms）；0 = 未知或已过点，不出走字 */
        val nextStartMs: Long,
        /** 没有 Chronometer 可用时的静态倒计时文案（可为空） */
        val countdownText: String,
        val parcel: String,
        val bill: String,
        /** 管家一句话 / 空态那一行 */
        val butler: String,
        /** 服务端那一帧的更新时刻；0 = 端侧不知道，由渲染器按内容变化时刻记 */
        val boardUpdatedAtMs: Long,
    ) {
        /** 「什么都没有」的空态：2×2 要退到管家那一行 */
        val idle: Boolean get() = next.isEmpty() && parcel.isEmpty() && bill.isEmpty()
    }

    fun load(ctx: Context): Board {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val mode = p.getString(KEY_MODE, "full") ?: "full"
        val agent = p.getString(KEY_MINIMAL, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_AGENT
        val title = p.getString(KEY_TITLE, "")?.trim().orEmpty()
        val text = p.getString(KEY_TEXT, "")?.trim().orEmpty()

        var next = ""
        var parcel = ""
        var bill = ""
        var butler = ""
        var countdown = ""
        var startMs = 0L
        var updatedAt = 0L

        val snap = readSnapshot(p)
        if (snap != null) {
            // ① 权威帧：kind 就是服务端给的档位，逐条归位
            for ((kind, body) in snap.lines) {
                when (kind) {
                    "next_event" -> if (next.isEmpty()) {
                        val parts = splitCountdown(body)
                        next = parts.first
                        countdown = parts.second
                    }
                    "parcel_pending" -> if (parcel.isEmpty()) parcel = body
                    "bill_due" -> if (bill.isEmpty()) bill = body
                    else -> if (butler.isEmpty()) butler = body
                }
            }
            if (snap.nextLabel.isNotEmpty()) {
                next = snap.nextLabel
                countdown = ""
            }
            startMs = snap.nextStartMs
            updatedAt = snap.updatedAtMs
        } else {
            // ② 拆解帧：两行字归位到四个槽
            val slots = ArrayList<Pair<Slot, String>>()
            if (title.isNotEmpty()) slots += classify(title)
            for (seg in text.split('·', '•')) {
                val s = seg.trim()
                if (s.isNotEmpty()) slots += classify(s)
            }
            for ((slot, body) in slots) {
                when (slot) {
                    Slot.Next -> if (next.isEmpty()) {
                        val parts = splitCountdown(body)
                        next = parts.first
                        if (parts.second.isNotEmpty()) countdown = parts.second
                    }
                    Slot.Parcel -> if (parcel.isEmpty()) parcel = body
                    Slot.Bill -> if (bill.isEmpty()) bill = body
                    Slot.Butler -> if (butler.isEmpty()) butler = body
                    Slot.Countdown -> if (countdown.isEmpty()) countdown = body
                }
            }
            // 倒计时基准从「HH:mm」前缀还原：纯展示换算，不含业务判断
            if (next.isNotEmpty() && TIME_HEAD.matcher(next).matches()) startMs = todayAtMs(next)
        }

        if (butler.isEmpty()) {
            butler = if (next.isEmpty() && parcel.isEmpty() && bill.isEmpty()) DEFAULT_IDLE else agent
        }
        return Board(
            mode = mode,
            agentName = agent,
            next = next,
            nextStartMs = startMs,
            countdownText = countdown,
            parcel = parcel,
            bill = bill,
            butler = butler,
            boardUpdatedAtMs = updatedAt,
        )
    }

    /** 有整帧就用整帧；没有（或读不动）返回 null，让调用方退到拆解层 */
    private fun readSnapshot(p: SharedPreferences): Snapshot? = try {
        snapshotOf(p)
    } catch (e: Exception) {
        // 键被别的写法占了（类型不符）也不能连累小组件：退到拆解层
        null
    }

    private fun snapshotOf(p: SharedPreferences): Snapshot? {
        val rawState = p.getString(KEY_STATE, null)
        if (!rawState.isNullOrBlank()) {
            val o = JSONObject(rawState)
            val lines = readLines(o.optJSONArray("lines")) ?: emptyList()
            val ev = o.optJSONObject("nextEvent")
            val label = ev?.let {
                (it.optString("startLabel").trim() + " " + it.optString("title").trim()).trim()
            }.orEmpty()
            if (lines.isEmpty() && label.isEmpty()) return null
            return Snapshot(
                lines = lines,
                nextLabel = label,
                nextStartMs = ev?.optLong("startMs", 0L) ?: 0L,
                updatedAtMs = o.optLong("updatedAt", 0L),
            )
        }
        val lines = parseLines(p.getString(KEY_LINES, null)) ?: return null
        return Snapshot(
            lines = lines,
            nextLabel = "",
            nextStartMs = p.getLong(KEY_NEXT_START_MS, 0L),
            updatedAtMs = p.getLong(KEY_BOARD_UPDATED_AT, 0L),
        )
    }

    private fun readLines(arr: JSONArray?): List<Pair<String, String>>? {
        if (arr == null || arr.length() == 0) return null
        val out = ArrayList<Pair<String, String>>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val text = o.optString("text").trim()
            if (text.isNotEmpty()) out += o.optString("kind") to text
        }
        return if (out.isEmpty()) null else out
    }

    private fun parseLines(raw: String?): List<Pair<String, String>>? {
        if (raw.isNullOrEmpty()) return null
        return try {
            readLines(JSONArray(raw))
        } catch (e: Exception) {
            null
        }
    }

    /** 一行字属于哪个槽。判据只有字面关键词——真正的判断在服务端那侧。 */
    private fun classify(line: String): Pair<Slot, String> = when {
        TIME_HEAD.matcher(line).matches() -> Slot.Next to line
        line.contains("快递") || line.contains("取件") || line.contains("驿站") -> Slot.Parcel to line
        line.contains("到期") || line.contains("还款") || line.contains("账单") -> Slot.Bill to line
        COUNTDOWN.matcher(line).matches() -> Slot.Countdown to line
        else -> Slot.Butler to line
    }

    /** 「15:00 牙医 · 还有 40 分钟」→（「15:00 牙医」，「还有 40 分钟」） */
    private fun splitCountdown(body: String): Pair<String, String> {
        val idx = body.lastIndexOf('·')
        if (idx > 0) {
            val tail = body.substring(idx + 1).trim()
            if (COUNTDOWN.matcher(tail).matches()) return body.substring(0, idx).trim() to tail
        }
        return body to ""
    }

    /** 「15:00 xxx」→ 今天 15:00 的 epoch ms（过点与否由渲染器判定要不要走字） */
    private fun todayAtMs(line: String): Long {
        val m = TIME_PREFIX.find(line) ?: return 0L
        val hour = m.groupValues[1].toIntOrNull() ?: return 0L
        val minute = m.groupValues[2].toIntOrNull() ?: return 0L
        val now = Calendar.getInstance()
        val cal = Calendar.getInstance()
        cal.set(
            now.get(Calendar.YEAR),
            now.get(Calendar.MONTH),
            now.get(Calendar.DAY_OF_MONTH),
            hour,
            minute,
            0,
        )
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }
}
