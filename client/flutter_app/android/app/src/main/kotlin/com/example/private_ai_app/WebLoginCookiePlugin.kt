package com.example.private_ai_app

import android.webkit.CookieManager
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 手机端平台登录 Cookie 读取（2026-11-22）。
 *
 * 为什么必须走原生：手机端没有桌面那种「用户自己的 WebView2」，比价只能跑在
 * 云端无头 Chromium 里；拼多多这类平台不向无头浏览器兑现登录态（扫码确认
 * 一万次，云端 context 里也没有 PDDUserID）。唯一可行凭证来源是「App 内
 * WebView 真登录一次，把 Cookie 交回云端落库」。
 *
 * WebView 的 HttpOnly Cookie（PDDUserID 就是）拿不到 `document.cookie`，
 * 但 CookieManager.getCookie(url) 返回的是「请求会带的那串 Cookie」，
 * 包含 HttpOnly——这是唯一能拿到完整登录态的入口。
 */
class WebLoginCookiePlugin : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "nextbot/web_login_cookies"
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getCookie" -> {
                val url = call.argument<String>("url").orEmpty()
                if (url.isBlank()) {
                    result.success("")
                    return
                }
                try {
                    val cm = CookieManager.getInstance()
                    cm.setAcceptCookie(true)
                    cm.flush()
                    result.success(cm.getCookie(url) ?: "")
                } catch (e: Exception) {
                    result.error("COOKIE_READ_FAILED", e.message ?: "读取 Cookie 失败", null)
                }
            }
            // 退出登录 / 换号时清干净，避免下次登录沿用上一个人的会话
            "clear" -> {
                try {
                    val cm = CookieManager.getInstance()
                    cm.removeAllCookies(null)
                    cm.flush()
                    result.success(true)
                } catch (e: Exception) {
                    result.error("COOKIE_CLEAR_FAILED", e.message ?: "清理 Cookie 失败", null)
                }
            }
            else -> result.notImplemented()
        }
    }
}
