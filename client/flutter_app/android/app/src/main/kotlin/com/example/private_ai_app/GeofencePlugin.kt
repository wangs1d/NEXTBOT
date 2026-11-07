package com.example.private_ai_app

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject

/**
 * 系统级地理围栏（GeofencePlugin）—— 持续感知架构的 Sense 层
 *
 * 为什么不用上报流在服务端判围栏：Android 8.0+ 应用在后台（非前台服务）时，
 * 系统把定位更新限制成「每小时几次」，请求更短的间隔也兑现不了。而「到达/
 * 离开」是事件型需求，只有系统托管的围栏能可靠触发。
 *
 * 实现选型：`LocationManager.addProximityAlert`
 *  - 系统 LocationService 托管，**App 被杀死也会唤醒广播**；
 *  - 零新增依赖（GeofencingClient 需要 play-services-location，本工程没有显式
 *    声明，避免引入版本冲突）；
 *  - 平台能力边界：proximity alert **只在「进入」时触发**，没有原生「离开」
 *    事件。因此本插件只上报 enter；leave 仍由服务端根据位置上报判定（软围栏，
 *    GeofenceService.processLocationReport）。这点不做假的「双向支持」。
 *
 * 投递策略（不丢事件）：
 *  1. Flutter 引擎存活（EventSink 已挂）→ 直接推给 Dart，走 WS 实时上报；
 *  2. App 被杀（无 Sink）→ 写 SharedPreferences 队列，下次启动 `drainPending`
 *     取走补报（带**原始触发时刻**，服务端按龄期如实标注「非实时」）。
 */
class GeofencePlugin : FlutterPlugin, MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler {

    companion object {
        private const val TAG = "GeofencePlugin"
        private const val METHOD_CHANNEL = "private_ai_agent/geofence"
        private const val EVENT_CHANNEL = "private_ai_agent/geofence_events"

        const val ACTION_TRIGGER = "com.example.private_ai_app.geofence.TRIGGER"
        const val EXTRA_FENCE_ID = "fenceId"
        const val EXTRA_NAME = "name"
        const val EXTRA_KIND = "kind"

        private const val PREFS = "geofence_prefs"
        private const val KEY_PENDING = "pending_events"
        private const val KEY_IDS = "registered_ids"

        @Volatile
        private var sink: EventChannel.EventSink? = null

        @Volatile
        private var appContext: Context? = null

        /**
         * 由 [GeofenceReceiver] 调用：优先实时推给 Dart，否则落盘队列。
         * 事件体是 JSON 字符串（Dart 侧解码），避免跨通道类型歧义。
         */
        fun deliver(context: Context, event: JSONObject) {
            val s = sink
            if (s != null) {
                Handler(Looper.getMainLooper()).post {
                    try {
                        s.success(event.toString())
                        Log.i(TAG, "围栏事件已推送 Dart: ${event.optString("fenceId")}")
                    } catch (e: Exception) {
                        Log.w(TAG, "推送 Dart 失败，转落队列", e)
                        enqueue(context, event)
                    }
                }
                return
            }
            enqueue(context, event)
        }

        private fun enqueue(context: Context, event: JSONObject) {
            try {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val raw = prefs.getString(KEY_PENDING, "[]") ?: "[]"
                val arr = try {
                    JSONArray(raw)
                } catch (e: Exception) {
                    JSONArray()
                }
                arr.put(event)
                // 队列上限：防止长期离线无限增长（服务端按围栏去重，丢旧留新）
                val trimmed = if (arr.length() > 200) {
                    JSONArray().apply {
                        for (i in (arr.length() - 200) until arr.length()) put(arr.get(i))
                    }
                } else {
                    arr
                }
                prefs.edit().putString(KEY_PENDING, trimmed.toString()).apply()
                Log.i(TAG, "围栏事件已入队（App 未运行）: ${event.optString("fenceId")}")
            } catch (e: Exception) {
                Log.e(TAG, "围栏事件入队失败", e)
            }
        }
    }

    private var channel: MethodChannel? = null
    private var eventChannel: EventChannel? = null
    private var context: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        appContext = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, METHOD_CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        eventChannel = EventChannel(binding.binaryMessenger, EVENT_CHANNEL).also {
            it.setStreamHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        eventChannel?.setStreamHandler(null)
        channel = null
        eventChannel = null
        sink = null
        context = null
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        sink = events
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "sync" -> {
                val fences = call.argument<List<Map<String, Any?>>>("fences") ?: emptyList()
                val ok = try {
                    syncFences(fences)
                } catch (e: SecurityException) {
                    Log.w(TAG, "缺少定位权限，无法注册围栏", e)
                    false
                } catch (e: Exception) {
                    Log.e(TAG, "注册围栏失败", e)
                    false
                }
                result.success(ok)
            }
            "clear" -> {
                try {
                    clearAll()
                } catch (e: Exception) {
                    Log.w(TAG, "清除围栏失败", e)
                }
                result.success(null)
            }
            "drainPending" -> result.success(drainPending())
            else -> result.notImplemented()
        }
    }

    private fun locationManager(): LocationManager? =
        context?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

    /** 幂等同步：先撤销本应用注册过的全部围栏，再按最新配置重建。 */
    private fun syncFences(fences: List<Map<String, Any?>>): Boolean {
        val lm = locationManager() ?: return false
        if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER) &&
            !lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        ) {
            Log.w(TAG, "系统定位已关闭，围栏无法注册")
            return false
        }
        clearAll()

        val ids = JSONArray()
        var registered = 0
        for (fence in fences) {
            val id = fence["id"] as? String ?: continue
            val name = fence["name"] as? String ?: ""
            val lat = (fence["latitude"] as? Number)?.toDouble() ?: continue
            val lon = (fence["longitude"] as? Number)?.toDouble() ?: continue
            val radius = (fence["radiusMeters"] as? Number)?.toFloat() ?: 200f
            // 平台只支持「进入」；event=leave 的围栏不注册（服务端软围栏兜底）
            val kind = fence["event"] as? String ?: "enter"
            if (kind == "leave") {
                Log.i(TAG, "围栏 $id 只关心离开，系统围栏不注册（服务端判定）")
                continue
            }
            try {
                lm.addProximityAlert(lat, lon, radius, -1L, buildPendingIntent(id, name))
                ids.put(id)
                registered++
            } catch (e: Exception) {
                Log.w(TAG, "围栏 $id 注册失败", e)
            }
        }
        context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            ?.edit()?.putString(KEY_IDS, ids.toString())?.apply()
        Log.i(TAG, "已注册 $registered/${fences.size} 个系统围栏")
        return true
    }

    private fun clearAll() {
        val lm = locationManager() ?: return
        val prefs = context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE) ?: return
        val raw = prefs.getString(KEY_IDS, "[]") ?: "[]"
        val ids = try {
            JSONArray(raw)
        } catch (e: Exception) {
            JSONArray()
        }
        for (i in 0 until ids.length()) {
            val id = ids.optString(i, "")
            if (id.isEmpty()) continue
            try {
                lm.removeProximityAlert(buildPendingIntent(id, ""))
            } catch (e: Exception) {
                Log.w(TAG, "移除围栏 $id 失败", e)
            }
        }
        prefs.edit().putString(KEY_IDS, "[]").apply()
    }

    /** PendingIntent 必须逐围栏唯一：requestCode 用 id 的稳定 hash（跨进程可复现）。 */
    private fun buildPendingIntent(fenceId: String, name: String): PendingIntent {
        val ctx = context ?: throw IllegalStateException("Context 未初始化")
        val intent = Intent(ctx, GeofenceReceiver::class.java).apply {
            action = ACTION_TRIGGER
            putExtra(EXTRA_FENCE_ID, fenceId)
            putExtra(EXTRA_NAME, name)
            putExtra(EXTRA_KIND, "enter")
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        return PendingIntent.getBroadcast(ctx, fenceId.hashCode(), intent, flags)
    }

    private fun drainPending(): List<Map<String, Any?>> {
        val ctx = context ?: return emptyList()
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_PENDING, "[]") ?: "[]"
        prefs.edit().putString(KEY_PENDING, "[]").apply()
        val out = ArrayList<Map<String, Any?>>()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val map = HashMap<String, Any?>()
                map["fenceId"] = obj.optString("fenceId")
                map["name"] = obj.optString("name")
                map["kind"] = obj.optString("kind", "enter")
                map["at"] = obj.optString("at")
                out.add(map)
            }
        } catch (e: Exception) {
            Log.w(TAG, "解析围栏队列失败", e)
        }
        return out
    }
}
