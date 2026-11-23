package com.example.private_ai_app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 分享进来的内容在原生侧的中转队列（2026-11-23 PRD §8.1「分享给管家」）。
 *
 * 为什么要在原生落一份：分享窗（[ShareIntakeActivity]）拿到 `content://` 授权的
 * 那一刻是唯一能读到附件的时机，而收到内容时 Flutter 引擎可能根本还没起来
 * （进程冷启动要一两百毫秒，Dart 侧的 handler 更晚）。直接在 Activity 里
 * invokeMethod 给 Dart，等于把用户分享的东西扔给一个可能不在线的监听者。
 * 所以：原生先把内容落到 [PREFS]（文本）与本应用缓存目录（图片文件），
 * Dart 起来之后自己取一次——[drain] 是取走即清空的语义，重复调用不会重发。
 *
 * 「入口提示」（[ENTRY_QUICK_NOTE] 等）走同一条队列：长按快捷方式 / 快捷设置磁贴 /
 * 常驻通知上的「记一下」都只往这里写一个字符串，App 起来后由 Dart 弹半屏速记卡。
 * 这样五种入口在原生只有一个落点，在 Dart 只有一个消费者。
 */
object ShareIntakeStore {

    private const val PREFS = "share_intake_prefs"
    private const val KEY_QUEUE = "queue"
    private const val KEY_ENTRY = "entry"
    private const val KEY_ROUTE = "route"

    /** 队列上限：一次分享最多 8 张图，攒 8 条已经远超正常使用 */
    private const val MAX_RECORDS = 8

    /** 落在 cacheDir 下的分享中转目录（图片在这进程被杀之前必须还可读） */
    private const val DIR = "share_intake"

    /** MainActivity 收到的入口提示 extra（快捷方式 / 磁贴 / 通知按钮共用） */
    const val EXTRA_ENTRY = "nb_entry"

    /**
     * MainActivity 收到的「跳哪个页」extra（桌面小组件各区域，PRD §5.3）。
     * 与 [EXTRA_ENTRY] 分开的理由：entry 的语义是「弹哪张速记卡」，route 的语义
     * 是「落到哪个 tab」；一条点按可以两个都带（小组件「记一下」就是如此）。
     */
    const val EXTRA_ROUTE = "nb_widget_route"

    /** 半屏速记卡的四种入口，Dart 侧按它决定初始焦点与是否直接开录音 */
    const val ENTRY_QUICK_NOTE = "quick_note"
    const val ENTRY_CAMERA = "camera_note"
    const val ENTRY_ASK = "ask_note"
    const val ENTRY_VOICE = "voice_note"

    /** 来源标记：Dart 据此措辞（分享文本 / 分享图片 / 选中文字） */
    const val SOURCE_SHARE_TEXT = "share_text"
    const val SOURCE_SHARE_IMAGE = "share_image"
    const val SOURCE_SHARE_MIXED = "share_mixed"
    const val SOURCE_PROCESS_TEXT = "process_text"

    fun dir(ctx: Context): File =
        File(ctx.cacheDir, DIR).apply { if (!exists()) mkdirs() }

    /** 落一条分享内容。images 传缓存目录里的绝对路径。 */
    fun enqueue(
        ctx: Context,
        text: String?,
        images: List<String>,
        source: String,
        subject: String? = null,
    ) {
        val o = JSONObject()
        o.put("text", text ?: "")
        o.put("subject", subject ?: "")
        o.put("source", source)
        o.put("at", System.currentTimeMillis())
        o.put("images", JSONArray(images))
        val arr = readQueue(ctx)
        // 新的排到尾部：Dart 取走时按用户分享的时间顺序进对话流
        while (arr.length() >= MAX_RECORDS) arr.remove(0)
        arr.put(o)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_QUEUE, arr.toString())
            .apply()
    }

    /** 写入口提示（覆盖上一次未消费的：连点两次「记一下」只弹一张卡） */
    fun setEntry(ctx: Context, entry: String) {
        if (entry.isEmpty()) return
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_ENTRY, entry)
            .apply()
    }

    /**
     * 写跳页路由（覆盖上一次未消费的）：与 [setEntry] 同一套语义——连点两次
     * 同一个小组件只会留最后一条，Dart 起来后取到一次，不会攒出一串重复导航。
     */
    fun setRoute(ctx: Context, route: String) {
        if (route.isEmpty()) return
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_ROUTE, route)
            .apply()
    }

    /**
     * 一次取走全部待发内容：`{"shares": [...], "entry": String?, "route": String?}`。
     * 取走即清空——Dart 拿到之后负责删掉缓存图片（[cleanFiles]），
     * 半途而废（App 崩了）时内容还在原生，下次启动补投。
     */
    fun drain(ctx: Context): Map<String, Any?> {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = readQueue(ctx)
        val shares = ArrayList<Map<String, Any?>>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val images = ArrayList<String>()
            val ia = o.optJSONArray("images")
            if (ia != null) for (j in 0 until ia.length()) images.add(ia.optString(j))
            shares.add(
                mapOf(
                    "text" to o.optString("text"),
                    "subject" to o.optString("subject"),
                    "source" to o.optString("source", SOURCE_SHARE_TEXT),
                    "images" to images,
                ),
            )
        }
        val entry = p.getString(KEY_ENTRY, null)
        val route = p.getString(KEY_ROUTE, null)
        p.edit().remove(KEY_QUEUE).remove(KEY_ENTRY).remove(KEY_ROUTE).apply()
        return mapOf("shares" to shares, "entry" to entry, "route" to route)
    }

    /** 已交给 Dart 的中转图片就地删掉：缓存目录不该长期留着别人的截图 */
    fun cleanFiles(ctx: Context, paths: List<String>) {
        val root = dir(ctx).canonicalPath
        for (path in paths) {
            try {
                val f = File(path)
                // 只删自己缓存目录里的文件，别拿路径去删别的（Dart 传什么是它的自由）
                if (f.canonicalPath.startsWith(root)) f.delete()
            } catch (_: Exception) {
                // 删不掉就是等系统清缓存，无害
            }
        }
    }

    private fun readQueue(ctx: Context): JSONArray {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_QUEUE, null) ?: return JSONArray()
        return try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
    }
}
