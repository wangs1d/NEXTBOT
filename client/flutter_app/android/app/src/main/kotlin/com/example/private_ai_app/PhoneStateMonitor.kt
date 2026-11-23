package com.example.private_ai_app

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.telephony.TelephonyManager

/**
 * 手机状态采样（2026-11-23 主动触达 M1）—— KeepAlivePlugin 的 nextbot/phone_state 事件源。
 *
 * 为什么要有：前台服务让主 WS 常连，服务端按「连着」判在场，手机揣兜里也算 active。
 * 这里把服务端判断「此刻能不能打扰」真正需要的五个状态采出来，交给 Dart 经主连接上报：
 *   interactive 亮屏且已解锁（人正拿着手机）
 *   screenOn    亮屏
 *   inCall      通话中（含微信等 VoIP：看 AudioManager 模式，无需电话权限）
 *   dnd         系统勿扰开启（中断过滤器不是 ALL）
 *   charging    充电中（夜间入睡判定的辅助信号）
 *
 * 设计约束：
 *   - 不新开服务、不新开连接：寄生在已有的保活进程里（前台服务保证进程不被冻结），
 *     只注册动态广播（亮灭屏这类广播只能动态注册）；
 *   - 原始事件不出端：只有「状态变了」才回调，且 300ms 去抖合并连发广播；
 *   - 只读系统状态，不需要新权限（PHONE_STATE 广播在已有 READ_PHONE_STATE 授权时
 *     才会收到，没授权就靠 AudioManager 模式 + 心跳兜底）。
 */
class PhoneStateMonitor(
    private val context: Context,
    private val onChanged: (Map<String, Any>) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var receiver: BroadcastReceiver? = null
    private var modeListener: Any? = null
    private var lastEmitted: Map<String, Any>? = null
    private val emitRunnable = Runnable { emitIfChanged() }

    fun start() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) = scheduleEmit()
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(TelephonyManager.ACTION_PHONE_STATE_CHANGED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // 只收系统广播：NOT_EXPORTED 不影响系统投递，也不让其他应用伪造状态
                context.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                context.registerReceiver(r, filter)
            }
            receiver = r
        } catch (e: Exception) {
            android.util.Log.w(TAG, "register phone state receiver failed", e)
        }
        registerAudioModeListener()
        // 启动即报一次当前值（订阅方据此建立基线）
        scheduleEmit()
    }

    fun stop() {
        handler.removeCallbacks(emitRunnable)
        receiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (_: Exception) {
                // 已注销 / 进程收尾：无害
            }
        }
        receiver = null
        unregisterAudioModeListener()
        lastEmitted = null
    }

    /** 当前快照（心跳与 getPhoneState 查询用，不走去重） */
    fun snapshot(): Map<String, Any> {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

        val screenOn = pm?.isInteractive ?: true
        val locked = km?.isKeyguardLocked ?: false
        val mode = am?.mode ?: AudioManager.MODE_NORMAL
        val inCall = mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
        val dnd = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && nm != null) {
            val f = nm.currentInterruptionFilter
            f != NotificationManager.INTERRUPTION_FILTER_ALL &&
                f != NotificationManager.INTERRUPTION_FILTER_UNKNOWN
        } else {
            false
        }
        val charging = isCharging()
        return mapOf(
            "interactive" to (screenOn && !locked),
            "screenOn" to screenOn,
            "inCall" to inCall,
            "dnd" to dnd,
            "charging" to charging,
        )
    }

    private fun isCharging(): Boolean {
        return try {
            // 粘性广播：传 null receiver 只读当前值，不产生注册
            val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        } catch (_: Exception) {
            false
        }
    }

    private fun scheduleEmit() {
        handler.removeCallbacks(emitRunnable)
        handler.postDelayed(emitRunnable, DEBOUNCE_MS)
    }

    private fun emitIfChanged() {
        val now = snapshot()
        if (now == lastEmitted) return
        lastEmitted = now
        try {
            onChanged(now)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "emit phone state failed", e)
        }
    }

    /** API 31+ 有音频模式回调，通话（含 VoIP）开始/结束即时感知；低版本靠广播与心跳兜底 */
    private fun registerAudioModeListener() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        try {
            val listener = AudioManager.OnModeChangedListener { scheduleEmit() }
            am.addOnModeChangedListener(context.mainExecutor, listener)
            modeListener = listener
        } catch (e: Exception) {
            android.util.Log.w(TAG, "add audio mode listener failed", e)
        }
    }

    private fun unregisterAudioModeListener() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val listener = modeListener as? AudioManager.OnModeChangedListener ?: return
        modeListener = null
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        try {
            am.removeOnModeChangedListener(listener)
        } catch (_: Exception) {
            // 无害
        }
    }

    companion object {
        private const val TAG = "PhoneState"
        private const val DEBOUNCE_MS = 300L
    }
}
