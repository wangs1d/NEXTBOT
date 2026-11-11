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
        // Android 12+ 系统启动画面：图标位已是透明占位、图标动画时长归零。
        // 这里再去掉系统默认的退出淡出——app 首帧（N 光扫）一画出来就立刻
        // 接管屏幕，前一层连图标带停留/过渡时间整体不出现。
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
        // 用户自有模型 key 的跨卸载保活：稳定设备身份 + 公共目录加密备份。
        // 必须在 Dart 侧 applyBootChannel()/CloudModelBindingStore.load() 之前注册，
        // 否则首帧握手拿不到稳定 actorId，服务端那份加密绑定会认不出来。
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, DeviceKeyBackupPlugin.CHANNEL)
            .setMethodCallHandler(DeviceKeyBackupPlugin(this))
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
