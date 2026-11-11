package com.example.private_ai_app

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.telephony.SmsManager
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 短信代发确认全屏窗：Agent 远程发起 send_sms（短信会话）时先弹此窗，
 * 展示接收号码与完整内容，用户点「确认发送」才走 SmsManager 真发；
 * 取消 / 超时 / 授权被拒 / 发送异常都回执 cancelled 或 send_failed，绝不静默发送。
 */
class SmsSendConfirmActivity : Activity() {

    companion object {
        const val EXTRA_NUMBER = "number"
        const val EXTRA_TEXT = "text"
        const val EXTRA_CONTACT_NAME = "contactName"
        const val EXTRA_REASON = "reason"
        const val EXTRA_TIMEOUT_SEC = "confirmTimeoutSec"
        private const val REQUEST_SEND_SMS = 9201
    }

    private var number = ""
    private var text = ""
    private var finished = false

    private val timeoutRunnable = Runnable {
        complete(ok = false, state = "cancelled", reason = "confirm_timeout")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            applyLegacyLockFlags()
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        number = intent.getStringExtra(EXTRA_NUMBER)?.trim() ?: ""
        text = intent.getStringExtra(EXTRA_TEXT)?.trim() ?: ""
        if (number.isEmpty() || text.isEmpty()) {
            complete(ok = false, state = "cancelled", error = "empty_number_or_text")
            return
        }
        setContentView(buildUi())
        val timeoutSec = intent.getIntExtra(EXTRA_TIMEOUT_SEC, 25).coerceIn(10, 28)
        window.decorView.postDelayed(timeoutRunnable, timeoutSec * 1000L)
    }

    override fun onDestroy() {
        window.decorView.removeCallbacks(timeoutRunnable)
        super.onDestroy()
    }

    /** API 27 以下没有 setShowWhenLocked，用窗口 flag 兜底 */
    @Suppress("DEPRECATION")
    private fun applyLegacyLockFlags() {
        window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
        )
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        complete(ok = false, state = "cancelled", reason = "user_cancel")
    }

    private fun buildUi(): View {
        val contactName = intent.getStringExtra(EXTRA_CONTACT_NAME) ?: ""
        val reason = intent.getStringExtra(EXTRA_REASON) ?: ""
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        fun label(
            text: String,
            sizeSp: Float,
            bold: Boolean,
            color: Int,
            topDp: Int,
        ): TextView = TextView(this).apply {
            this.text = text
            textSize = sizeSp
            setTextColor(color)
            gravity = Gravity.CENTER
            setTypeface(typeface, if (bold) Typeface.BOLD else Typeface.NORMAL)
            setPadding(0, dp(topDp), 0, 0)
        }

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0xFF1C1C1E.toInt())
            setPadding(dp(24), dp(24), dp(24), dp(20))
        }

        card.addView(label("Agent 请求代发短信", 14f, false, 0xFF9E9E9E.toInt(), 0))
        card.addView(
            label(
                contactName.ifEmpty { number },
                24f,
                true,
                0xFFFFFFFF.toInt(),
                14,
            ),
        )
        if (contactName.isNotEmpty()) {
            card.addView(label(number, 15f, false, 0xFFBDBDBD.toInt(), 4))
        }
        // 完整内容必须展示：用户确认的是「这段文字发给他」
        card.addView(label(text, 16f, false, 0xFFEDEDED.toInt(), 12))
        if (reason.isNotEmpty()) {
            card.addView(label("事由：$reason", 13f, false, 0xFF9E9E9E.toInt(), 10))
        }

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(20), 0, 0)
        }
        val cancel = Button(this).apply {
            text = "取消"
            setOnClickListener {
                complete(ok = false, state = "cancelled", reason = "user_cancel")
            }
        }
        val send = Button(this).apply {
            text = "确认发送"
            setOnClickListener { onConfirmClicked() }
        }
        row.addView(cancel, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
            marginEnd = dp(8)
        })
        row.addView(send, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
            marginStart = dp(8)
        })
        card.addView(
            row,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xB3000000.toInt())
            setPadding(dp(24), 0, dp(24), 0)
            addView(
                card,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
    }

    private fun onConfirmClicked() {
        if (!hasSmsPermission()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                requestPermissions(arrayOf(Manifest.permission.SEND_SMS), REQUEST_SEND_SMS)
                return
            }
        }
        sendNow()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_SEND_SMS) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            sendNow()
        } else {
            complete(ok = false, state = "cancelled", reason = "permission_denied")
        }
    }

    private fun hasSmsPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) ==
            PackageManager.PERMISSION_GRANTED

    private fun sendNow() {
        try {
            val manager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                this.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }
            if (manager == null) {
                complete(ok = false, state = "send_failed", error = "no_sms_manager")
                return
            }
            // 长短信按大小限制自动分段发送
            val parts = manager.divideMessage(text)
            if (parts.size <= 1) {
                manager.sendTextMessage(number, null, text, null, null)
            } else {
                manager.sendMultipartTextMessage(number, null, parts, null, null)
            }
            complete(ok = true, state = "sent")
        } catch (e: Exception) {
            complete(ok = false, state = "send_failed", error = "sms_error:${e.message}")
        }
    }

    private fun complete(
        ok: Boolean,
        state: String,
        reason: String? = null,
        error: String? = null,
    ) {
        if (finished) return
        finished = true
        window.decorView.removeCallbacks(timeoutRunnable)
        PhoneBridgePlugin.completeSmsPending(
            mutableMapOf<String, Any?>(
                "ok" to ok,
                "state" to state,
                "number" to number,
            ).apply {
                if (reason != null) this["reason"] = reason
                if (error != null) this["error"] = error
            },
        )
        finish()
    }
}
