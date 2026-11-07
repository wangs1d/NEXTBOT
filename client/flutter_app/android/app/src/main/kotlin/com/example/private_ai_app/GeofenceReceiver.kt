package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.time.Instant

/**
 * 系统围栏触发接收器。
 *
 * 触发链路：LocationManager(系统服务) → PendingIntent 广播 → 本 Receiver。
 * App 已被杀时系统会拉起进程投递这条广播（这也是必须用系统围栏而非轮询的原因）。
 *
 * 只负责「把事实记录下来」：事件带**原始触发时刻**（不是收到时刻），交给
 * [GeofencePlugin.deliver] 决定实时推送还是落队列。业务动作一律由服务端决定。
 */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != GeofencePlugin.ACTION_TRIGGER) return
        val fenceId = intent.getStringExtra(GeofencePlugin.EXTRA_FENCE_ID) ?: return
        if (fenceId.isEmpty()) return
        val name = intent.getStringExtra(GeofencePlugin.EXTRA_NAME) ?: ""
        val kind = intent.getStringExtra(GeofencePlugin.EXTRA_KIND) ?: "enter"
        val event = JSONObject().apply {
            put("fenceId", fenceId)
            put("name", name)
            put("kind", kind)
            // ISO8601 绝对时刻：服务端据此计算龄期，如实标注「非实时」
            put("at", Instant.now().toString())
        }
        try {
            GeofencePlugin.deliver(context, event)
        } catch (e: Exception) {
            Log.e("GeofenceReceiver", "围栏事件投递失败", e)
        }
    }
}
