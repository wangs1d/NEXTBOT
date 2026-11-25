package com.example.private_ai_app

import android.content.Context
import com.huawei.hms.push.HmsMessageService
import com.huawei.hms.push.RemoteMessage
import org.json.JSONArray
import org.json.JSONObject

/**
 * HMS Push 回调（系统标准机制）。
 *
 * 1) onNewToken：token 就绪/刷新时系统主动回调（App 在后台也会送达），写入
 *    SharedPreferences——MobilePushPlugin.getPushToken 与 Dart 侧注册器随取随用。
 *
 * 2) onMessageReceived（2026-11-25「透传写穿」）：服务端在通知消息之后补发一条
 *    data-only 消息。App 被杀/后台时 HMS 会把进程拉起来投递到这里，本类只把内容
 *    攒进原生队列，**不在这里弹通知**——同一件事的系统弹窗由服务端那条通知消息
 *    负责，避免一次事件弹两条。Dart 启动/回前台取件后写进本地对话，
 *    做到「不点通知，打开 App 也能看到内容」。
 *
 * 注意：用户在系统里「强行停止」过 App 后，HMS 既不会拉起进程、也不会送达透传，
 * 这是系统限制，不是本类能兜住的。
 */
class PushTokenService : HmsMessageService() {
    override fun onNewToken(token: String?) {
        if (token.isNullOrEmpty()) return
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TOKEN, token)
            .apply()
    }

    override fun onMessageReceived(message: RemoteMessage?) {
        val data = message?.data ?: return
        if (data.isBlank()) return
        try {
            val obj = JSONObject(data)
            val text = obj.optString("body").ifEmpty { obj.optString("title") }
            if (text.isEmpty()) return
            val record = JSONObject()
                .put("title", obj.optString("title"))
                .put("text", text)
                .put("deliveryId", obj.optString("deliveryId"))
                .put("intentId", obj.optString("intentId"))
                .put("kind", obj.optString("kind"))
                .put("stableKey", obj.optString("stableKey"))
                .put("ts", obj.optLong("ts", System.currentTimeMillis()))
            enqueue(this, record)
        } catch (_: Exception) {
            // 载荷解析失败：当作普通透传丢弃，不影响通知消息那条通路
        }
    }

    companion object {
        const val PREFS = "pai_push"
        const val KEY_TOKEN = "hms_token"

        private const val KEY_PENDING = "pending_messages"
        /** 队列上限：离线期间攒太多说明用户长期没开 App，留最近 50 条足够 */
        private const val MAX_PENDING = 50
        private val LOCK = Any()

        /** 入队（同 stableKey 去重：推送重试不会在对话里落两条） */
        fun enqueue(ctx: Context, record: JSONObject) {
            synchronized(LOCK) {
                val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val arr = try {
                    JSONArray(prefs.getString(KEY_PENDING, "[]") ?: "[]")
                } catch (_: Exception) {
                    JSONArray()
                }
                val key = record.optString("stableKey")
                if (key.isNotEmpty()) {
                    for (i in 0 until arr.length()) {
                        if (arr.optJSONObject(i)?.optString("stableKey") == key) return
                    }
                }
                arr.put(record)
                while (arr.length() > MAX_PENDING) arr.remove(0)
                prefs.edit().putString(KEY_PENDING, arr.toString()).apply()
            }
        }

        /** 取走全部待写穿消息并清空队列（Dart 取件即消费） */
        fun takeAll(ctx: Context): List<Map<String, Any?>> {
            synchronized(LOCK) {
                val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val arr = try {
                    JSONArray(prefs.getString(KEY_PENDING, "[]") ?: "[]")
                } catch (_: Exception) {
                    JSONArray()
                }
                val out = ArrayList<Map<String, Any?>>(arr.length())
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    out.add(
                        mapOf(
                            "title" to o.optString("title"),
                            "text" to o.optString("text"),
                            "deliveryId" to o.optString("deliveryId"),
                            "intentId" to o.optString("intentId"),
                            "kind" to o.optString("kind"),
                            "stableKey" to o.optString("stableKey"),
                            "ts" to o.optLong("ts", System.currentTimeMillis()),
                        ),
                    )
                }
                prefs.edit().remove(KEY_PENDING).apply()
                return out
            }
        }
    }
}
