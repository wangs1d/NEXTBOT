package com.example.private_ai_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Build
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
 *
 * 2026-11-13 修两处硬伤：
 *  1. **离开事件被丢弃**：Android 的 `addProximityAlert` 用广播 Intent 里的
 *     `LocationManager.KEY_PROXIMITY_ENTERING`（true=进入 / false=离开）区分方向。
 *     此前代码从自塞的 EXTRA_KIND 读 kind，而 EXTRA_KIND 在
 *     [GeofencePlugin.buildPendingIntent] 里被**硬编码为 "enter"** —— 于是所有
 *     离开事件都被谎报成进入，「到家」能触发、「出门上班」永远不触发。
 *     现在改为读系统给的 KEY_PROXIMITY_ENTERING。
 *  2. **事件体没有坐标**：此前事件只带 fenceId/name/kind/at，服务端拿不到触发点
 *     的经纬度，只能拿客户端「事后新拉的 GPS」当触发位置 —— App 被杀几小时后
 *     补报时，人早就走了，位置完全对不上。
 *
 *     关于触发点坐标的来源：**Android 的邻近警报广播本身不携带 Location**
 *     （SDK 里没有 KEY_LOCATION 常量，只有 KEY_PROXIMITY_ENTERING）。但广播
 *     触发的那一刻，系统位置服务刚完成过一次定位，`getLastKnownLocation` 拿到的
 *     就是跨越边界那一刻附近的 fix —— 这正是我们需要的触发点。
 *     所以这里在收到广播的瞬间读系统 last-known（只取足够新的：≤2 分钟），
 *     连同精度一并上报；拿不到就如实不带坐标，交客户端回落到实时 GPS。
 */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != GeofencePlugin.ACTION_TRIGGER) return
        val fenceId = intent.getStringExtra(GeofencePlugin.EXTRA_FENCE_ID) ?: return
        if (fenceId.isEmpty()) return
        val name = intent.getStringExtra(GeofencePlugin.EXTRA_NAME) ?: ""

        // 进入/离开：读系统判定的结果（true=进入）。取不到时回退到自塞的 kind。
        val entering = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, true)
        } else {
            true
        }

        val event = JSONObject().apply {
            put("fenceId", fenceId)
            put("name", name)
            put("kind", if (entering) "enter" else "leave")
            // ISO8601 绝对时刻：服务端据此计算龄期，如实标注「非实时」
            put("at", Instant.now().toString())
        }

        // 补上触发点坐标与精度（系统 last-known，刚定位过）
        try {
            val loc = readFreshLastKnownLocation(context)
            if (loc != null) {
                event.put("latitude", loc.latitude)
                event.put("longitude", loc.longitude)
                if (loc.hasAccuracy()) event.put("accuracyMeters", loc.accuracy.toDouble())
                if (loc.hasAltitude()) event.put("altitudeMeters", loc.altitude)
                if (loc.hasSpeed()) event.put("speedMps", loc.speed.toDouble())
                if (loc.hasBearing()) event.put("headingDegrees", loc.bearing.toDouble())
                // Android LocationManager 出来的是 WGS-84
                event.put("coordSystem", "wgs84")
                event.put("capturedAt", Instant.ofEpochMilli(loc.time).toString())
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "读取系统最后已知位置失败（无定位权限，忽略）")
        } catch (e: Exception) {
            Log.w(TAG, "读取系统最后已知位置失败（忽略）", e)
        }

        try {
            GeofencePlugin.deliver(context, event)
        } catch (e: Exception) {
            Log.e(TAG, "围栏事件投递失败", e)
        }
    }

    /**
     * 读系统位置服务的最后已知位置，只接受足够新（≤2 分钟）且有精度的 fix。
     *
     * 邻近警报触发时系统刚定位过，此刻的 last-known 就是触发点附近的位置。
     * 多个 provider 里取最新的一个；GPS 与 NETWORK 各取一次按时间取新。
     */
    private fun readFreshLastKnownLocation(context: Context): Location? {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        val now = System.currentTimeMillis()
        var best: Location? = null
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (!lm.isProviderEnabled(provider)) continue
                val loc = lm.getLastKnownLocation(provider) ?: continue
                if (now - loc.time > MAX_FIX_AGE_MS) continue
                if (best == null || loc.time > best.time) best = loc
            } catch (_: SecurityException) {
                // 无该 provider 权限：跳过
            }
        }
        return best
    }

    private companion object {
        const val TAG = "GeofenceReceiver"

        /** last-known fix 的最大可信龄期：超过它宁可让客户端重新拉 */
        const val MAX_FIX_AGE_MS = 2 * 60 * 1000L
    }
}
