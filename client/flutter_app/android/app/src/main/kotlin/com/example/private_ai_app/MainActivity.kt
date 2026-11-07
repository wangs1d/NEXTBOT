package com.example.private_ai_app

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        AppContextHolder.init(this)
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.plugins.add(MobileBriefingPlugin(this))
        flutterEngine.plugins.add(PhoneBridgePlugin())
        flutterEngine.plugins.add(MobilePushPlugin())
        flutterEngine.plugins.add(MessageCapturePlugin())
        flutterEngine.plugins.add(AlarmClockPlugin())
        flutterEngine.plugins.add(GeofencePlugin())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }
}
