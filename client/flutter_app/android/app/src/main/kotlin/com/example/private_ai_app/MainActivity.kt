package com.example.private_ai_app

import android.content.Intent
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Android 12+ 系统启动画面 = 主流 hold splash 的载体，不是要「秒关」：
        // Dart 侧已把会话读盘挪到 runApp 之前 await，这段等待期间系统 splash
        // 一直 hold（纯 #161616，与登录页/N 光扫同色）。本回调的触发时机恰好
        // 是 Flutter 首帧绘制完成——那时 main() 已决议完 StartupOutcome，首帧
        // 就是最终目标页（登录页或主壳+N 光扫）。此刻 remove() 即「hold 到路由
        // 决议完成再释放」，splash → 目标页无缝衔接，无空白、无闪帧。
        // 图标位透明占位、动画时长归零：前一层不带图标/停留/淡出。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            splashScreen.setOnExitAnimationListener { splashScreenView ->
                splashScreenView.remove()
            }
        }
        // 闹钟 fullScreenIntent 落点：锁屏时亮屏并显示响铃页（Manifest 属性在部分
        // 厂商 ROM 上会被忽略，这里再显式置一次；不影响正常冷启动的 N 光扫首帧）
        if (intent?.getStringExtra("source") == "alarm_ring" ||
            intent?.getStringExtra("source") == "alarm_clock"
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true)
                setTurnScreenOn(true)
            }
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        AppContextHolder.init(this)
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.plugins.add(MobileBriefingPlugin(this))
        flutterEngine.plugins.add(PhoneBridgePlugin())
        flutterEngine.plugins.add(MobilePushPlugin())
        flutterEngine.plugins.add(MessageCapturePlugin())
        flutterEngine.plugins.add(AlarmClockPlugin())
        flutterEngine.plugins.add(GeofencePlugin())
        flutterEngine.plugins.add(KeepAlivePlugin())
        // 高德定位（高精度单次取点）：Dart 侧优先走它，缺失 key 时自动回退 geolocator。
        flutterEngine.plugins.add(AmapLocationPlugin())
        // 用户自有模型 key 的跨卸载保活：稳定设备身份 + 公共目录加密备份。
        // 必须在 Dart 侧 applyBootChannel()/CloudModelBindingStore.load() 之前注册，
        // 否则首帧握手拿不到稳定 actorId，服务端那份加密绑定会认不出来。
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, DeviceKeyBackupPlugin.CHANNEL)
            .setMethodCallHandler(DeviceKeyBackupPlugin(this))
        // 支付宝 App 支付（额度充值）：已安装支付宝时唤起原生收银台。
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, AlipayPayPlugin.CHANNEL)
            .setMethodCallHandler(AlipayPayPlugin(this))
        // 平台登录 Cookie 读取（2026-11-22）：App 内 WebView 登录后把完整
        // Cookie（含 HttpOnly 的 PDDUserID）交回 Dart，再由客户端上传云端落库。
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, WebLoginCookiePlugin.CHANNEL)
            .setMethodCallHandler(WebLoginCookiePlugin())
        // 资料库预取文件本地打开（2026-11-23）：FileProvider 把 media_cache
        // 里已预载的产出文件转 content:// URI 交系统应用，离线秒开。
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, FileOpenPlugin.CHANNEL)
            .setMethodCallHandler(FileOpenPlugin(this))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getStringExtra("source") == "alarm_ring" ||
            intent.getStringExtra("source") == "alarm_clock"
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true)
                setTurnScreenOn(true)
            }
        }
    }
}
