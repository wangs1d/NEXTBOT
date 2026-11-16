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
        /**
         * 围栏完整定义（2026-11-13）：开机重建用。
         *
         * Android 的 `addProximityAlert` 注册是**易失**的——设备重启后系统会清空
         * 本应用注册的全部邻近警报。此前 KEY_IDS 只存了 id 列表，连坐标都拿不回来，
         * 于是「设好到公司/到家的围栏后手机重启一次，围栏就静默失效」，
         * 而端上没有任何迹象（服务端只会看到"从此不再有事件"）。
         * 现在把 id/name/坐标/半径/方向整体落盘，开机按这份定义重建。
         */
        private const val KEY_FENCES = "fence_definitions"

        @Volatile
        private var sink: EventChannel.EventSink? = null

        @Volatile
        private var appContext: Context? = null

        /**
         * 开机/应用更新后重建系统围栏（2026-11-13）。
         *
         * 由 [BootReceiver] 调用。引擎未启动、插件未实例化也能工作——因此这里是
         * 静态方法，走自己的 Context 与 LocationManager，不依赖插件实例状态。
         *
         * 幂等：先撤销上次注册的，再按落盘定义重建。
         */
        fun restoreOnBoot(context: Context): Int {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                ?: return 0
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_FENCES, "[]") ?: "[]"
            val arr = try {
                JSONArray(raw)
            } catch (e: Exception) {
                JSONArray()
            }
            if (arr.length() == 0) return 0

            // 先清掉残留（重启后系统本应已清，但应用更新/部分 ROM 会保留）
            val oldIds = try {
                JSONArray(prefs.getString(KEY_IDS, "[]") ?: "[]")
            } catch (e: Exception) {
                JSONArray()
            }
            for (i in 0 until oldIds.length()) {
                val id = oldIds.optString(i, "")
                if (id.isEmpty()) continue
                try {
                    lm.removeProximityAlert(buildPendingIntent(context, id, ""))
                } catch (e: Exception) {
                    Log.w(TAG, "开机清理围栏 $id 失败", e)
                }
            }

            val ids = JSONArray()
            var registered = 0
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val id = obj.optString("id", "")
                if (id.isEmpty()) continue
                val lat = obj.optDouble("latitude", Double.NaN)
                val lon = obj.optDouble("longitude", Double.NaN)
                if (lat.isNaN() || lon.isNaN()) continue
                val radius = obj.optDouble("radiusMeters", 200.0).toFloat()
                val kind = obj.optString("event", "enter")
                val name = obj.optString("name", "")
                try {
                    lm.addProximityAlert(lat, lon, radius, -1L, buildPendingIntent(context, id, name, kind))
                    ids.put(id)
                    registered++
                } catch (e: Exception) {
                    Log.w(TAG, "开机重建围栏 $id 失败", e)
                }
            }
            prefs.edit().putString(KEY_IDS, ids.toString()).apply()
            Log.i(TAG, "开机重建系统围栏 $registered/${arr.length()} 个")
            return registered
        }

        /**
         * PendingIntent 工厂（静态版）：显式接收 Context，开机重建路径
         * （BootReceiver → Flutter 引擎未启动、插件实例不存在）也能用。
         *
         * PendingIntent 必须逐围栏唯一：requestCode 用 id 的稳定 hash（跨进程可复现）。
         *
         * 2026-11-13：`kind` 不再硬编码为 "enter"，而是带上该围栏**配置的方向**
         * （enter/leave/both），仅作参考与排障信息。事件实际是进入还是离开，由
         * 系统在广播里给的 `KEY_PROXIMITY_ENTERING` 判定（见 GeofenceReceiver）。
         * 注意 PendingIntent 的相等性不看 extras（只看 action/data/type/categories），
         * 所以这里改 extras 不影响 clearAll 里的 removeProximityAlert 匹配。
         */
        fun buildPendingIntent(
            ctx: Context,
            fenceId: String,
            name: String,
            kind: String = "enter",
        ): PendingIntent {
            val intent = Intent(ctx, GeofenceReceiver::class.java).apply {
                action = ACTION_TRIGGER
                putExtra(EXTRA_FENCE_ID, fenceId)
                putExtra(EXTRA_NAME, name)
                putExtra(EXTRA_KIND, kind)
            }
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags = flags or PendingIntent.FLAG_IMMUTABLE
            }
            return PendingIntent.getBroadcast(ctx, fenceId.hashCode(), intent, flags)
        }

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
        // 围栏完整定义落盘：开机重建用（系统注册是易失的，重启即丢）
        val definitions = JSONArray()
        var registered = 0
        for (fence in fences) {
            val id = fence["id"] as? String ?: continue
            val name = fence["name"] as? String ?: ""
            val lat = (fence["latitude"] as? Number)?.toDouble() ?: continue
            val lon = (fence["longitude"] as? Number)?.toDouble() ?: continue
            val radius = (fence["radiusMeters"] as? Number)?.toFloat() ?: 200f
            // 2026-11-13：leave 围栏现在也注册。
            // 原注释「平台只支持进入」是错的——Android `addProximityAlert` 对 enter/leave
            // 都会触发，靠广播里的 KEY_PROXIMITY_ENTERING 区分。此前把 leave 围栏
            // 直接跳过注册，等于「出门上班」这类离开事件在端上永远不会发生。
            val kind = fence["event"] as? String ?: "enter"
            definitions.put(
                JSONObject().apply {
                    put("id", id)
                    put("name", name)
                    put("latitude", lat)
                    put("longitude", lon)
                    put("radiusMeters", radius.toDouble())
                    put("event", kind)
                },
            )
            try {
                lm.addProximityAlert(lat, lon, radius, -1L, buildPendingIntent(id, name, kind))
                ids.put(id)
                registered++
            } catch (e: Exception) {
                Log.w(TAG, "围栏 $id 注册失败", e)
            }
        }
        context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            ?.edit()?.putString(KEY_IDS, ids.toString())
            ?.putString(KEY_FENCES, definitions.toString())?.apply()
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
        // 围栏定义一并清掉：定义没了，开机重建也无从谈起
        prefs.edit().putString(KEY_IDS, "[]").putString(KEY_FENCES, "[]").apply()
    }

    /**
     * PendingIntent 必须逐围栏唯一：requestCode 用 id 的稳定 hash（跨进程可复现）。
     *
     * 2026-11-13：改为委托给 companion 的静态版本——开机重建路径里 Flutter 引擎
     * 尚未启动，插件实例还不存在，不能用实例字段拿 Context。
     */
    private fun buildPendingIntent(
        fenceId: String,
        name: String,
        kind: String = "enter",
    ): PendingIntent {
        val ctx = context ?: throw IllegalStateException("Context 未初始化")
        return buildPendingIntent(ctx, fenceId, name, kind)
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
                // 2026-11-13：补报时必须带上触发点坐标与精度。
                // 此前只取上面 4 个字段，把系统给的经纬度/精度整段丢了 ——
                // 于是「App 被杀后补报」永远只能退化成"事后重新拉一次 GPS"，
                // 位置对不上触发点，服务端判围栏必错。
                obj.optDouble("latitude").takeIf { !it.isNaN() }?.let { map["latitude"] = it }
                obj.optDouble("longitude").takeIf { !it.isNaN() }?.let { map["longitude"] = it }
                obj.optDouble("accuracyMeters").takeIf { !it.isNaN() }?.let { map["accuracyMeters"] = it }
                obj.optDouble("altitudeMeters").takeIf { !it.isNaN() }?.let { map["altitudeMeters"] = it }
                obj.optDouble("speedMps").takeIf { !it.isNaN() }?.let { map["speedMps"] = it }
                obj.optDouble("headingDegrees").takeIf { !it.isNaN() }?.let { map["headingDegrees"] = it }
                obj.optString("capturedAt").takeIf { it.isNotEmpty() }?.let { map["capturedAt"] = it }
                out.add(map)
            }
        } catch (e: Exception) {
            Log.w(TAG, "解析围栏队列失败", e)
        }
        return out
    }
}
