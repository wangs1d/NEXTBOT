package com.example.private_ai_app

import android.content.Context
import com.huawei.hms.push.HmsMessageService

/**
 * HMS Push token 事件回调（系统标准机制）：
 * token 就绪/刷新时系统主动回调 onNewToken（App 在后台也会送达），写入
 * SharedPreferences——MobilePushPlugin.getPushToken 与 Dart 侧注册器随取随用，
 * 用户无需保持 App 前台等待。
 */
class PushTokenService : HmsMessageService() {
    override fun onNewToken(token: String?) {
        if (token.isNullOrEmpty()) return
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TOKEN, token)
            .apply()
    }

    companion object {
        const val PREFS = "pai_push"
        const val KEY_TOKEN = "hms_token"
    }
}
