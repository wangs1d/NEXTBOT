package com.example.private_ai_app

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * 用系统应用打开本机缓存文件（2026-11-23 资料库全量预取配套）。
 *
 * Dart 侧把 MediaDiskCache 落盘的绝对路径 + MIME 传进来；这里经
 * androidx.core FileProvider 把私有目录文件转成带临时读授权的 content:// URI，
 * 再发 ACTION_VIEW。任何失败都回 false，Dart 侧回退在线浏览器打开。
 */
class FileOpenPlugin(private val context: Context) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "com.nextbot.app/file_open"
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method != "open") {
            result.notImplemented()
            return
        }
        val path = call.argument<String>("path")
        val mime = call.argument<String>("mime") ?: "*/*"
        if (path.isNullOrEmpty()) {
            result.success(false)
            return
        }
        try {
            val file = File(path)
            if (!file.exists() || file.length() == 0L) {
                result.success(false)
                return
            }
            val uri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            // 没有能打开该类型的应用时静默失败，交回 Dart 回退在线。
            if (intent.resolveActivity(context.packageManager) == null) {
                result.success(false)
                return
            }
            context.startActivity(intent)
            result.success(true)
        } catch (e: Exception) {
            result.success(false)
        }
    }
}
