package com.example.private_ai_app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import java.io.File

/**
 * 系统分享 / 选中文字的落地窗（2026-11-23 PRD §8.1）。
 *
 * 它只做原生才能做的事，别的一件不做：
 *  1. 在这一次授权还有效的时候把 `content://` 附件读进本应用缓存
 *     （离开这个 Activity 就没有权限了，Dart 再想去读会 SecurityException）；
 *  2. 把文本 + 图片路径落进 [ShareIntakeStore]；
 *  3. 把 App 带到前台并交棒给 Dart —— 「打算怎么做」是管家（Agent）说的话，
 *     只能由既有的聊天链路（`chat.user_message` → Agent → 建日程/待办/笔记）产出，
 *     在这里另起一条 HTTP + 另一套话术就是第二个入口，PRD §8.2 明确不要。
 *
 * 主题是 `DialConfirmTheme`（半透明、无标题）：从别的 App 点「分享 → 管家」
 * 不应该闪一屏黑再跳走，用户看到的直接是管家收到内容的对话页。
 */
class ShareIntakeActivity : Activity() {

    companion object {
        private const val TAG = "ShareIntake"
        /** 一次最多带进来的图片张数（与服务端 visionFrames 上限同量级，留冗余） */
        private const val MAX_IMAGES = 8
        /** 单张上限：超过就不带，避免把别人相册的原图整份抄进缓存 */
        private const val MAX_IMAGE_BYTES = 20L * 1024 * 1024
        /** 文本截断：分享内容可能是整篇文章，聊天链路有自己的长度预算 */
        private const val MAX_TEXT_CHARS = 12000
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = intent
        try {
            consume(intent)
        } catch (e: Exception) {
            // 解析失败也必须给用户一个落点：直接打开 App，不至于点了分享没反应
            Log.w(TAG, "share intent parse failed: ${intent?.action}", e)
        } finally {
            handOff()
        }
    }

    private fun consume(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_PROCESS_TEXT -> consumeProcessText(intent)
            Intent.ACTION_SEND_MULTIPLE -> consumeSend(intent, multiple = true)
            else -> consumeSend(intent, multiple = false)
        }
    }

    /**
     * 选中文字 → 管家（§8.1 第二行）：与系统分享完全同一条队列、同一个流程，
     * 只是来源标成 process_text，Dart 侧措辞不同（「你圈给我的这段」）。
     */
    private fun consumeProcessText(intent: Intent) {
        val text = (intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)
            ?: intent.getStringExtra(Intent.EXTRA_TEXT))?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        ShareIntakeStore.enqueue(
            this,
            text.take(MAX_TEXT_CHARS),
            emptyList(),
            ShareIntakeStore.SOURCE_PROCESS_TEXT,
        )
    }

    private fun consumeSend(intent: Intent?, multiple: Boolean) {
        if (intent == null) return
        val text = (intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
            ?: intent.getStringExtra(Intent.EXTRA_TEXT))?.toString()?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim()
        // 浏览器分享网页时 title 在 subject、url 在 text，两个都带给管家才有上下文
        val uris: List<Uri> = if (multiple) {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
        } else {
            @Suppress("DEPRECATION")
            listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        }
        val images = ArrayList<String>()
        for (uri in uris.take(MAX_IMAGES)) {
            stageImage(uri)?.let { images.add(it) }
        }
        val capped = text.take(MAX_TEXT_CHARS)
        if (capped.isEmpty() && images.isEmpty()) return
        val source = when {
            images.isEmpty() -> ShareIntakeStore.SOURCE_SHARE_TEXT
            capped.isEmpty() -> ShareIntakeStore.SOURCE_SHARE_IMAGE
            else -> ShareIntakeStore.SOURCE_SHARE_MIXED
        }
        ShareIntakeStore.enqueue(this, capped, images, source, subject)
    }

    /**
     * content:// → 缓存文件。授权只在这个 Activity 活着的时候有效，
     * 所以必须在原生读出来，不能把 uri 丢给 Dart 让它自己去读。
     */
    private fun stageImage(uri: Uri): String? = try {
        val mime = contentResolver.getType(uri)
            ?: if (uri.scheme == "file") guessMime(uri.path) else null
        if (mime != null && !mime.startsWith("image/")) null
        else {
            val size = querySize(uri)
            if (size != null && size > MAX_IMAGE_BYTES) {
                Log.i(TAG, "skip oversized image: $size")
                null
            } else {
                val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "jpg"
                val out = File(
                    ShareIntakeStore.dir(this),
                    "share_${System.currentTimeMillis()}_${(0..9999).random()}.$ext",
                )
                contentResolver.openInputStream(uri)?.use { input ->
                    out.outputStream().use { input.copyTo(it) }
                } ?: run {
                    if (uri.scheme == "file") File(uri.path ?: "").copyTo(out, overwrite = true)
                    else null
                }
                if (out.exists() && out.length() > 0) out.absolutePath else null
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "stage image failed: $uri", e)
        null
    }

    private fun querySize(uri: Uri): Long? = try {
        contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.SIZE), null, null, null)
            ?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
            }
    } catch (_: Exception) {
        null
    }

    private fun guessMime(path: String?): String? = when {
        path == null -> null
        else -> MimeTypeMap.getFileExtensionFromUrl(path)
            ?.lowercase()?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
    }

    private fun handOff() {
        try {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP,
                    ),
            )
        } catch (e: Exception) {
            Log.w(TAG, "hand off to MainActivity failed", e)
        }
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}
