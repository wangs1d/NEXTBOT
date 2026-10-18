package com.example.private_ai_app

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * 通知监听服务：捕捉微信/QQ/飞书/短信等入站通知 → 批量推给 Dart
 * （经 [MessageCapturePlugin] 的 pai/phone_msg_events 通道）→ WS 上报服务端消息聚合中心。
 *
 * - 包名 → 平台映射见 [platformForPackage]；非白名单包一律忽略。
 * - 常驻/无文本/自家包通知跳过；externalMessageId = 包名|会话|正文|postTime 的哈希，
 *   服务端二次判重（重复 repost 的同一条通知不会重复计数）。
 * - Dart 侧不可达（引擎未运行/通道断开）时写入 JSONL 队列文件，Dart 启动后经
 *   MessageCapturePlugin.drainQueue 取走补报。
 * - 通知使用权（notification listener access）需用户在系统设置授予，设置页有引导。
 */
class MessageCaptureListenerService : NotificationListenerService() {

    companion object {
        private const val TAG = "MsgCapture"

        /** 批量合并窗口：通知到达后最多等这么久凑一批（毫秒） */
        private const val FLUSH_DELAY_MS = 1500L
        /** 单批上限，超出立即 flush */
        private const val BATCH_MAX = 30

        /** 包名 → 聚合平台（服务端 MessageHubPlatform） */
        private val PACKAGE_PLATFORM = mapOf(
            "com.tencent.mm" to "wechat",
            "com.tencent.mobileqq" to "qq",
            "com.ss.android.lark" to "feishu",
            "com.ss.android.lark.hd" to "feishu",
            "com.alibaba.android.rimet" to "feishu", // 钉钉按飞书域归类（办公 IM）
            // 支付宝（2026-09-18）：支付/收款推送 → 财务实时入账（钱迹模式，零 Cookie）。
            // 营销/积分类推送由服务端 alipay-payment-notice 的噪音规则排除，不误记账。
            "com.eg.android.AlipayGphone" to "alipay",
            // ── 国内生态扩展（2026-10-18）：邮箱/电商物流/社区互动通知兜底捕捉。
            // 国外源（Gmail/Outlook 等）按约定暂不接入，未知包默认忽略或走 captureAll 兜底。
            "com.tencent.androidqqmail" to "email",  // QQ 邮箱
            "com.netease.mail" to "email",           // 网易邮箱大师
            "com.netease.mobile.mail" to "email",    // 网易邮箱（163/126）
            "com.taobao.taobao" to "generic",        // 淘宝（订单/物流通知）
            "com.jingdong.app.mall" to "generic",    // 京东
            "com.xunmeng.pinduoduo" to "generic",    // 拼多多
            "com.sankuai.meituan" to "generic",      // 美团
            "me.ele" to "generic",                   // 饿了么
            "com.cainiao.wireless" to "generic",     // 菜鸟裹裹（物流）
            "com.sf.activity" to "generic",          // 顺丰速运
            "com.ss.android.ugc.aweme" to "generic", // 抖音（私信/互动）
            "tv.danmaku.bili" to "generic",          // 哔哩哔哩（回复/私信）
            "com.xingin.xhs" to "generic",           // 小红书
            "com.sina.weibo" to "generic",           // 微博
        )
        /** 已知短信 app 包名片段：命中按 sms 归类 */
        private val SMS_PACKAGE_HINTS = listOf("mms", "messaging")

        // ── 动态捕捉配置（Dart setCaptureConfig 下发，SharedPreferences 持久化）──
        private const val CONFIG_SP = "pai_capture_config"
        private const val KEY_EXTRA_RULES = "extra_rules_json"
        private const val KEY_CAPTURE_ALL = "capture_all"
        private val configLock = Any()

        @Volatile
        private var cachedExtraRules: List<Pair<String, String>> = emptyList()

        @Volatile
        private var cachedCaptureAll: Boolean = false

        @Volatile
        private var configLoaded = false

        /**
         * 下发动态捕捉配置：[rules] 为用户自定义「包名 → 平台」规则（银行等长尾 App），
         * [captureAllEnabled] 开启后未识别包也按 generic 兜底捕捉（默认关闭防噪音）。
         */
        fun applyConfig(context: android.content.Context, rules: List<Pair<String, String>>, captureAllEnabled: Boolean) {
            val json = org.json.JSONArray().apply {
                for ((pkg, platform) in rules) {
                    put(org.json.JSONObject().put("pkg", pkg).put("platform", platform))
                }
            }.toString()
            context.getSharedPreferences(CONFIG_SP, android.content.Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_EXTRA_RULES, json)
                .putBoolean(KEY_CAPTURE_ALL, captureAllEnabled)
                .apply()
            synchronized(configLock) {
                cachedExtraRules = rules.toList()
                cachedCaptureAll = captureAllEnabled
                configLoaded = true
            }
        }

        /** 读取当前动态捕捉配置（设置页回显用）。 */
        fun readConfig(context: android.content.Context): Map<String, Any?> {
            loadConfigIfNeeded(context)
            synchronized(configLock) {
                return mapOf(
                    "extraRules" to cachedExtraRules.map { mapOf("pkg" to it.first, "platform" to it.second) },
                    "captureAll" to cachedCaptureAll,
                )
            }
        }

        private fun loadConfigIfNeeded(context: android.content.Context) {
            if (configLoaded) return
            synchronized(configLock) {
                if (configLoaded) return
                val sp = context.getSharedPreferences(CONFIG_SP, android.content.Context.MODE_PRIVATE)
                val rules = mutableListOf<Pair<String, String>>()
                try {
                    val arr = org.json.JSONArray(sp.getString(KEY_EXTRA_RULES, "[]") ?: "[]")
                    for (i in 0 until arr.length()) {
                        val obj = arr.optJSONObject(i) ?: continue
                        val pkg = obj.optString("pkg").trim()
                        if (pkg.isNotEmpty()) {
                            rules.add(pkg to obj.optString("platform", "generic").ifEmpty { "generic" })
                        }
                    }
                } catch (_: Exception) {
                    // 配置损坏按空规则处理，不影响内置白名单
                }
                cachedExtraRules = rules
                cachedCaptureAll = sp.getBoolean(KEY_CAPTURE_ALL, false)
                configLoaded = true
            }
        }

        /** Dart 侧是否在线（MessageCapturePlugin attach/detach 维护） */
        @Volatile
        var dartChannelReady: Boolean = false

        /** 最近已上报指纹（防同一条通知 repost 重复推送；容量有限的 LRU 近似） */
        private val recentKeys = object : LinkedHashMap<String, Boolean>(64, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>): Boolean =
                size > 256
        }

        private val pending = mutableListOf<Map<String, Any?>>()
        private val mainHandler = Handler(Looper.getMainLooper())
        private val flushRunnable = Runnable { flush() }

        /** 通知使用权是否已授予（设置页检测用） */
        fun isListenerEnabled(): Boolean = try {
            val enabledPackages = androidx.core.app.NotificationManagerCompat
                .getEnabledListenerPackages(AppContextHolder.app)
            enabledPackages.contains(AppContextHolder.app.packageName)
        } catch (_: Exception) {
            false
        }

        fun platformForPackage(pkg: String, context: android.content.Context? = null): String? {
            PACKAGE_PLATFORM[pkg]?.let { return it }
            if (SMS_PACKAGE_HINTS.any { pkg.contains(it) }) return "sms"
            if (pkg.contains("lark")) return "feishu"
            // 动态配置：用户自定义包名规则优先，其次「未识别包全量捕捉」按 generic 兜底
            if (context != null) loadConfigIfNeeded(context)
            synchronized(configLock) {
                cachedExtraRules.firstOrNull { it.first == pkg }?.let { return it.second }
                if (cachedCaptureAll) return "generic"
            }
            return null
        }

        /** 监听服务回调：入队一批捕获消息 */
        fun enqueue(items: List<Map<String, Any?>>) {
            if (items.isEmpty()) return
            synchronized(pending) {
                pending.addAll(items)
                if (pending.size >= BATCH_MAX) {
                    mainHandler.removeCallbacks(flushRunnable)
                    flushLocked()
                    return
                }
            }
            mainHandler.removeCallbacks(flushRunnable)
            mainHandler.postDelayed(flushRunnable, FLUSH_DELAY_MS)
        }

        private fun flush() {
            synchronized(pending) { flushLocked() }
        }

        private fun flushLocked() {
            if (pending.isEmpty()) return
            val batch = ArrayList(pending)
            pending.clear()
            if (dartChannelReady) {
                val delivered = MessageCapturePlugin.dispatchToDart(batch)
                if (delivered) return
            }
            // Dart 不可达或投递失败：落盘等待补报
            CaptureQueueStore.append(batch)
        }

        private fun fingerprint(pkg: String, title: String, text: String, postTime: Long): String =
            "$pkg|$title|$text|$postTime"
    }

    private val appContext by lazy { AppContextHolder.app }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "notification listener connected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            val pkg = sbn.packageName ?: return
            if (pkg == applicationContext.packageName) return
            val platform = platformForPackage(pkg, appContext) ?: return
            if (sbn.isOngoing) return // 音乐/下载等常驻通知

            val extras = sbn.notification?.extras ?: return

            // 群名（MessagingStyle 会话标题）：群聊多人消息聚合进同一个会话
            val conversationTitle = try {
                extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim().orEmpty()
            } catch (_: Exception) {
                ""
            }

            // 逐条解析（2026-10-18）：MessagingStyle 群通知遍历 EXTRA_MESSAGES 的全部消息，
            // 不再只取最后一条；反序列化失败退回通用字段
            val parsed = mutableListOf<Pair<String?, String>>() // sender to text
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    @Suppress("DEPRECATION")
                    val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
                    if (messages != null) {
                        for (raw in messages) {
                            val b = raw as? android.os.Bundle ?: continue
                            val text = b.getCharSequence("text")?.toString()?.trim().orEmpty()
                            if (text.isNotEmpty()) {
                                parsed.add(b.getCharSequence("sender")?.toString()?.trim() to text)
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                // 反序列化失败退回通用字段
            }
            if (parsed.isEmpty()) {
                val fallback = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
                    ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())?.trim().orEmpty()
                if (fallback.isNotEmpty()) parsed.add(null to fallback)
            }

            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()

            val batch = mutableListOf<Map<String, Any?>>()
            for (msg in parsed) {
                val msgText = msg.second
                // 「N条新消息」这类纯计数通知没有内容价值
                if (msgText.length < 2) continue

                val key = fingerprint(pkg, msg.first ?: title, msgText, sbn.postTime)
                val fresh = synchronized(recentKeys) {
                    if (recentKeys.containsKey(key)) false else {
                        recentKeys[key] = true
                        true
                    }
                }
                if (!fresh) continue

                val item = mutableMapOf<String, Any?>(
                    "platform" to platform,
                    // channelId：群名 > 发送人 > 标题 > 包名
                    "channelId" to conversationTitle.ifEmpty { msg.first ?: title.ifEmpty { pkg } },
                    "text" to msgText.take(500),
                    "externalMessageId" to stableHash(key),
                    "capturedAt" to java.time.Instant.ofEpochMilli(System.currentTimeMillis()).toString(),
                    "packageName" to pkg,
                )
                if (title.isNotEmpty()) item["title"] = title.take(100)
                val senderName = msg.first ?: title
                if (senderName.isNotEmpty()) item["senderName"] = senderName.take(100)
                batch.add(item)
            }
            enqueue(batch)
        } catch (e: Exception) {
            Log.w(TAG, "onNotificationPosted failed", e)
        }
    }

    private fun stableHash(input: String): String = try {
        val md = java.security.MessageDigest.getInstance("SHA-1")
        md.digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(20)
    } catch (_: Exception) {
        input.hashCode().toUInt().toString()
    }
}
