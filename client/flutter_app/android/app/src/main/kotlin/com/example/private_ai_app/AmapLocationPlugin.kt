package com.example.private_ai_app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.amap.api.location.AMapLocation
import com.amap.api.location.AMapLocationClient
import com.amap.api.location.AMapLocationClientOption
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 高德定位（2026-11-18）：单次高精度取点。
 *
 * 为什么不直接用 geolocator：Android 端不依赖 GMS 时它只能退回原生
 * LocationManager，GPS 冷启动慢、且没有 WiFi/基站/传感器融合；高德
 * AMapLocationClient 的 Hight_Accuracy 模式会做融合，是设备可达到的精度上限。
 *
 * 精度口径：
 *  - 只关掉缓存 fix（isLocationCacheEnable=false）与模拟位置；
 *  - 连续 1s 一个 fix，拿到 ≤ maxAccuracyMeters 的即刻返回，否则在预算内
 *    返回其中精度最好的一个，并如实带 accuracy();
 *  - 坐标高德返回 GCJ-02，这里转回 WGS-84——服务端逆地理前会再做 WGS→GCJ，
 *    口径必须统一，否则会叠加一次火星偏移。
 *
 * 失败策略：未配置 key / SDK 初始化失败立即回错误码，Dart 侧静默回退 geolocator。
 */
class AmapLocationPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    companion object {
        private const val CHANNEL = "private_ai_agent/amap_location"
        private const val META_KEY = "com.amap.api.v2.apikey"
    }

    private var context: Context? = null
    private var channel: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        context = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "getCurrentLocation") {
            result.notImplemented()
            return
        }
        val ctx = context
        if (ctx == null) {
            result.error("no_context", "高德定位插件未绑定上下文", null)
            return
        }
        // key 在 manifest 里以 ${amapApiKey} 占位注入；缺失时直接失败，
        // 让 Dart 立刻回退 geolocator，而不是等 SDK 内部超时。
        if (apiKey(ctx).isBlank()) {
            result.error("amap_key_missing", "未配置高德 Android 定位 key（android/amap.properties）", null)
            return
        }
        val timeoutMs = (call.argument<Number>("timeoutMs") ?: 5000).toLong().coerceIn(1000L, 15_000L)
        val maxAccuracy = (call.argument<Number>("maxAccuracyMeters") ?: 10.0).toDouble()
        requestBestFix(ctx, timeoutMs, maxAccuracy, result)
    }

    private fun apiKey(ctx: Context): String {
        return try {
            val info = ctx.packageManager.getApplicationInfo(ctx.packageName, PackageManager.GET_META_DATA)
            info.metaData?.getString(META_KEY).orEmpty()
        } catch (_: Throwable) {
            ""
        }
    }

    private fun requestBestFix(
        ctx: Context,
        timeoutMs: Long,
        maxAccuracyMeters: Double,
        result: MethodChannel.Result,
    ) {
        // 隐私合规（高德 5.0+ 强制）：必须在 SDK 初始化前声明已展示并同意隐私政策。
        // 应用自身的定位同意在 Dart 层已经拿到，这里是对 SDK 的合规声明。
        try {
            AMapLocationClient.updatePrivacyShow(ctx, true, true)
            AMapLocationClient.updatePrivacyAgree(ctx, true)
        } catch (_: Throwable) {
            // 老版本 SDK 没有这两个静态方法：忽略，不影响定位。
        }

        val client = try {
            AMapLocationClient(ctx)
        } catch (e: Throwable) {
            result.error("amap_init_failed", e.message ?: "高德定位初始化失败", null)
            return
        }

        val handler = Handler(Looper.getMainLooper())
        var finished = false
        var best: AMapLocation? = null

        fun finish() {
            if (finished) return
            finished = true
            handler.removeCallbacksAndMessages(null)
            try {
                client.stopLocation()
            } catch (_: Throwable) {
            }
            try {
                client.onDestroy()
            } catch (_: Throwable) {
            }
            val loc = best
            if (loc != null && loc.errorCode == 0) {
                result.success(locationToMap(loc))
            } else {
                result.error(
                    "amap_no_fix",
                    "高德定位未取到坐标（code=${loc?.errorCode ?: -1}）",
                    null,
                )
            }
        }

        client.setLocationListener { location: AMapLocation? ->
            if (finished || location == null) return@setLocationListener
            if (location.errorCode != 0) return@setLocationListener
            if (location.latitude == 0.0 && location.longitude == 0.0) return@setLocationListener
            val current = best
            if (current == null || location.accuracy < current.accuracy) {
                best = location
            }
            if (location.accuracy > 0 && location.accuracy <= maxAccuracyMeters) {
                finish()
            }
        }

        val option = AMapLocationClientOption().apply {
            // Hight_Accuracy = GPS + WiFi + 基站融合；GpsFirst 让有星时优先 GPS。
            setLocationMode(AMapLocationClientOption.AMapLocationMode.Hight_Accuracy)
            setGpsFirst(true)
            // GPS 优先最多等 3s：等不到就先回来网络/融合 fix，避免整段预算被冷启动吃满。
            setGpsFirstTimeout(3000L)
            setSensorEnable(true)
            setWifiScan(true)
            // 不要缓存 fix：缓存可能是几分钟前、几十米外的位置，直接与「此刻」矛盾。
            setLocationCacheEnable(false)
            setOnceLocation(false)
            setNeedAddress(false)
            setMockEnable(false)
            setHttpTimeOut(timeoutMs.coerceAtMost(8000L))
            setInterval(1000L)
        }

        try {
            client.setLocationOption(option)
            client.startLocation()
        } catch (e: Throwable) {
            finished = true
            try {
                client.onDestroy()
            } catch (_: Throwable) {
            }
            result.error("amap_start_failed", e.message ?: "高德定位启动失败", null)
            return
        }

        handler.postDelayed({ finish() }, timeoutMs)
    }

    private fun locationToMap(location: AMapLocation): Map<String, Any?> {
        // 坐标系按 SDK 自报为准（COORD_TYPE_GCJ02 / COORD_TYPE_WGS84）；
        // 缺省按 GCJ-02 处理——服务端只认 WGS-84，多转一次就是几十到几百米的偏移。
        val coordType: String? = location.coordType
        val isGcj02 = coordType == null ||
            coordType.equals(AMapLocation.COORD_TYPE_GCJ02, ignoreCase = true)
        val wgs = if (isGcj02) {
            gcj02ToWgs84(location.latitude, location.longitude)
        } else {
            location.latitude to location.longitude
        }
        return mapOf(
            "latitude" to wgs.first,
            "longitude" to wgs.second,
            "accuracyMeters" to if (location.accuracy > 0f) location.accuracy.toDouble() else null,
            "altitudeMeters" to location.altitude,
            "speedMps" to if (location.speed >= 0f) location.speed.toDouble() else null,
            "headingDegrees" to if (location.bearing >= 0f) location.bearing.toDouble() else null,
            "capturedAtMs" to location.time,
            "locationType" to location.locationType,
            "coordType" to coordType,
            "source" to "amap",
        )
    }

    // ─── GCJ-02 → WGS-84 ─────────────────────────────────────────────
    // 高德坐标是 GCJ-02；服务端按 WGS-84 处理并在逆地理前转回 GCJ。
    // 这里做逆变换（迭代 3 次即可收敛到亚米级），保证整条链路只有一次坐标基准。

    private fun gcj02ToWgs84(lat: Double, lon: Double): Pair<Double, Double> {
        if (outOfChina(lat, lon)) return lat to lon
        var wgsLat = lat
        var wgsLon = lon
        repeat(3) {
            val gcj = wgs84ToGcj02(wgsLat, wgsLon)
            wgsLat -= gcj.first - lat
            wgsLon -= gcj.second - lon
        }
        return wgsLat to wgsLon
    }

    private fun outOfChina(lat: Double, lon: Double): Boolean {
        return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
    }

    private fun wgs84ToGcj02(lat: Double, lon: Double): Pair<Double, Double> {
        val a = 6378245.0
        val ee = 0.006693421622965943
        var dLat = transformLat(lon - 105.0, lat - 35.0)
        var dLon = transformLon(lon - 105.0, lat - 35.0)
        val radLat = lat / 180.0 * Math.PI
        var magic = Math.sin(radLat)
        magic = 1 - ee * magic * magic
        val sqrtMagic = Math.sqrt(magic)
        dLat = dLat * 180.0 / (a * (1 - ee) / (magic * sqrtMagic) * Math.PI)
        dLon = dLon * 180.0 / (a / sqrtMagic * Math.cos(radLat) * Math.PI)
        return (lat + dLat) to (lon + dLon)
    }

    private fun transformLat(x: Double, y: Double): Double {
        var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
        ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0
        ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0
        return ret
    }

    private fun transformLon(x: Double, y: Double): Double {
        var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
        ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0
        ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0
        return ret
    }
}
