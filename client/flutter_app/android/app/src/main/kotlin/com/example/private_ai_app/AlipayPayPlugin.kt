package com.example.private_ai_app

import android.app.Activity
import android.content.pm.PackageManager
import com.alipay.sdk.app.PayTask
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

/**
 * 支付宝 App 支付通道（渠道名 nextbot/alipay）。
 *
 * 用途：额度充值时若手机已安装支付宝，直接唤起支付宝原生收银台，
 * 不再跳系统浏览器。订单串由服务端用 alipay.trade.app.pay 签名生成，
 * 客户端只负责调用 SDK；支付结果最终仍以服务端查单为准。
 *
 * - isInstalled：检测支付宝包是否安装（Android 11+ 依赖 Manifest <queries>）。
 * - pay：在后台线程调用 PayTask.payV2(orderInfo, true)，结果回主线程返回。
 */
class AlipayPayPlugin(private val activity: Activity?) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "nextbot/alipay"
        private const val ALIPAY_PACKAGE = "com.eg.android.AlipayGphone"
    }

    private val executor = Executors.newSingleThreadExecutor()

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "isInstalled" -> result.success(isAlipayInstalled())
            "pay" -> {
                val orderInfo = call.argument<String>("orderInfo")?.trim().orEmpty()
                val host = activity
                if (host == null || orderInfo.isEmpty()) {
                    result.error("INVALID_ARGUMENT", "缺少支付宝订单串或页面已关闭", null)
                    return
                }
                executor.execute {
                    val payload: Map<String, String> = try {
                        PayTask(host).payV2(orderInfo, true)
                    } catch (e: Throwable) {
                        mapOf(
                            "resultStatus" to "4000",
                            "memo" to (e.message ?: "支付宝支付异常"),
                            "result" to "",
                        )
                    }
                    host.runOnUiThread {
                        try {
                            result.success(payload)
                        } catch (_: Throwable) {
                            // Activity 已销毁时 Flutter 侧回调失效，忽略即可。
                        }
                    }
                }
            }
            else -> result.notImplemented()
        }
    }

    private fun isAlipayInstalled(): Boolean {
        val ctx = activity?.applicationContext ?: return false
        return try {
            ctx.packageManager.getPackageInfo(ALIPAY_PACKAGE, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }
}
