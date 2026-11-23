package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 常驻通知「完成」按钮的落点（2026-11-23 §5.2）。
 *
 * 两条路，优先级分明：
 *  1. Dart 引擎在 → 交回 Dart，走的是与聊天卡按钮、主动消息通知按钮**同一条**
 *     executeNotifyAction 链路（同一份回执、同一份埋点），不在这儿重写业务；
 *  2. 引擎不在（进程被系统回收后前台服务自启，通知还挂着）→ 直接打执行端点。
 *     token 本身就是服务端签名的一次性授权，不需要登录态；执行失败也只可能是
 *     「这条日程已经不在了」，那就在通知上如实显示。
 *
 * 第 2 条必须开线程：onReceive 在主线程，Android 3.0+ 主线程发 HTTP 直接抛
 * NetworkOnMainThreadException（顺带一提，闹钟那条 REST 兜底是同步写的，
 * 真走到那一分支应该一直在静默失败）。
 */
class OngoingStatusReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != OngoingStatusNotifier.ACTION_COMPLETE) return
        val token = intent.getStringExtra(OngoingStatusNotifier.EXTRA_TOKEN) ?: return
        val actionId = intent.getStringExtra(OngoingStatusNotifier.EXTRA_ACTION_ID) ?: ""
        val taskId = intent.getStringExtra(OngoingStatusNotifier.EXTRA_TASK_ID) ?: ""

        val handler = OngoingStatusNotifier.dartTapHandler
        if (handler != null) {
            Log.i(TAG, "ongoing action -> dart action=$actionId task=$taskId")
            handler.invoke(actionId, token, taskId)
            return
        }
        Log.i(TAG, "dart detached, executing via rest action=$actionId task=$taskId")
        val pending = goAsync()
        Thread {
            val message = try {
                executeViaRest(context, token)
            } catch (e: Exception) {
                Log.w(TAG, "rest execute failed", e)
                null
            }
            if (message != null) OngoingStatusNotifier.markDone(context, message)
            pending.finish()
        }.start()
    }

    /** 成功返回回执文案（服务端给的），失败返回 null（保持原文案，不骗用户）。 */
    private fun executeViaRest(context: Context, token: String): String? {
        val base = OngoingStatusNotifier.httpBase(context) ?: return null
        val conn = (URL("$base/api/action-intents/execute").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json")
            doOutput = true
            connectTimeout = 5000
            readTimeout = 5000
        }
        try {
            conn.outputStream.use { it.write(JSONObject().put("token", token).toString().toByteArray()) }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            val json = runCatching { JSONObject(body) }.getOrNull()
            if (code != 200 || json?.optBoolean("ok") != true) return null
            return json.optString("message").takeIf { it.isNotBlank() } ?: "已完成 ✓"
        } finally {
            conn.disconnect()
        }
    }

    private companion object {
        const val TAG = "OngoingStatus"
    }
}
