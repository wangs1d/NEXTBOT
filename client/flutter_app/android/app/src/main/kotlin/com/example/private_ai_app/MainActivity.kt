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
        // 分享给管家（§8）：冷启动时分享内容/入口提示已经在 ShareIntakeActivity
        // 或快捷方式那一步落进原生队列，这里只是把 intent 上的入口 extra 补进
        // 同一个队列，再催 Dart 来取（引擎此时可能还没 attach，取不到就等
        // Dart 启动自取——队列在 SharedPreferences 里，不会丢）。
        forwardIntake(intent)
    }

    /**
     * 把「入口提示」+「跳页路由」写进原生中转队列并催 Dart 取件。
     * onCreate / onNewIntent 两个时机共用：热启动（App 在后台）与冷启动
     * 走的必须是同一条路，否则从通知栏「记一下」进来的行为会跟
     * 从桌面图标进来不一样。
     *
     * 小组件各区域的落点（PRD §5.3「各区域深链到对应页面」）也走这一条队列，
     * 不再另开一套深链解析：route 与 entry 同存同取，冷启动时引擎还没 attach、
     * onReady 推空了也没关系——值在 SharedPreferences 里，Dart 起来自取。
     */
    private fun forwardIntake(intent: Intent?) {
        val entry = intent?.getStringExtra(ShareIntakeStore.EXTRA_ENTRY)
        if (!entry.isNullOrEmpty()) {
            ShareIntakeStore.setEntry(this, entry)
        }
        val route = intent?.getStringExtra(ShareIntakeStore.EXTRA_ROUTE)
        if (!route.isNullOrEmpty()) {
            ShareIntakeStore.setRoute(this, route)
        }
        // 厂商推送点击深链（2026-11-25）：华为 click_action.type=1 带下来的
        // intentId / deliveryId，落同一条中转队列，Dart 取件后拉取意图端决策半屏页。
        val pushIntent = intent?.getStringExtra("nb_push_intent")
        val pushDelivery = intent?.getStringExtra("nb_push_delivery")
        if (!pushIntent.isNullOrEmpty() || !pushDelivery.isNullOrEmpty()) {
            ShareIntakeStore.setPushTarget(this, pushIntent, pushDelivery)
        }
        ShareIntakePlugin.pushReady()
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
        // 分享给管家（2026-11-23 §8）：原生中转队列 → Dart（内容进既有聊天链路）
        flutterEngine.plugins.add(ShareIntakePlugin())
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
        // 热启动的分享/快捷方式/磁贴/通知按钮/桌面小组件落点：singleTop 下只会走这里
        forwardIntake(intent)
    }
}
