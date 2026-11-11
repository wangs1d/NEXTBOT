package com.example.private_ai_app

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Log
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 用户自有模型 key 的「跨卸载」保活通道（Android）。
 *
 * 背景：App 私有目录（getApplicationSupportDirectory）在卸载时被整体删除，
 * 明文 cloud_model_binding.json 跟着一起没；服务端的加密绑定按随机 inst_ 时间戳
 * 索引，重装后又换一个 id，也认不出来。两头都断，用户必须重新填一次 key。
 *
 * 本插件提供两件事：
 * ① stableInstallId：由 Settings.Secure.ANDROID_ID 派生的稳定安装标识。Android 8+
 *    按「设备 + 用户 + 应用签名」分区，同签名卸载重装保持不变，于是服务端
 *    model-keys/<actor>.enc 在重装后仍能被同一个 actorId 命中（聊天自动续用）。
 * ② 公共目录加密备份：三元组经 AES-256-GCM 加密后写 Downloads/NEXTBOT/，
 *    这个位置不属于 App 私有数据，卸载不会被清理；重装启动自动读回。
 *    密钥由 ANDROID_ID 派生，不落盘、不进日志；别的应用拿到的 SSAID 不同。
 *
 * 安全边界：这不是硬件级密钥库，能读到备份文件且能拿到同一应用签名下
 * ANDROID_ID 的攻击者可解密。绝不写明文到公共目录；用户「停用自有模型」时
 * 写一条 revoked 记录覆盖（而不是依赖删除——Android 11+ 删他人文件要用户确认）。
 */
class DeviceKeyBackupPlugin(private val context: Context) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "com.nextbot.app/device_key_backup"
        private const val TAG = "DeviceKeyBackup"
        private const val BACKUP_NAME = "nextbot-model-binding.bak"
        private const val NAME_PREFIX = "nextbot-model-binding"
        private const val BACKUP_DIR = "Download/NEXTBOT/"
        private const val ID_SALT = "nextbot-stable-install-v1"
        private const val KEY_SALT = "nextbot-byok-backup-v1"
        private const val BAD_ANDROID_ID = "9774d56d682e549c"
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "stableInstallId" -> result.success(stableInstallId())
                "readBackup" -> result.success(readBackup())
                "writeBackup" -> {
                    val json = call.argument<String>("json")
                    result.success(!json.isNullOrEmpty() && writeBackup(json))
                }
                "deleteBackup" -> result.success(deleteBackup())
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            Log.w(TAG, "${call.method} failed: ${e.message}")
            when (call.method) {
                "writeBackup", "deleteBackup" -> result.success(false)
                else -> result.success(null)
            }
        }
    }

    /** 稳定安装标识；拿不到 ANDROID_ID 时返回 null，Dart 侧回落随机 id。 */
    private fun stableInstallId(): String? {
        val id = androidId() ?: return null
        return "inst_" + sha256Hex("$ID_SALT|$id|${context.packageName}").take(24)
    }

    private fun androidId(): String? {
        val raw = try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (e: Exception) {
            null
        }
        if (raw.isNullOrBlank() || raw == BAD_ANDROID_ID) return null
        return raw
    }

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun cipherKey(): SecretKeySpec? {
        val id = androidId() ?: return null
        val raw = MessageDigest.getInstance("SHA-256")
            .digest("$KEY_SALT|$id|${context.packageName}".toByteArray(Charsets.UTF_8))
        return SecretKeySpec(raw, "AES")
    }

    /** Base64(12-byte IV || AES-GCM ciphertext+tag)，不落明文。 */
    private fun encrypt(plain: String): String? {
        val key = cipherKey() ?: return null
        return try {
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            val payload = iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            Base64.encodeToString(payload, Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.w(TAG, "encrypt failed: ${e.message}")
            null
        }
    }

    private fun decrypt(encoded: String): String? {
        val key = cipherKey() ?: return null
        return try {
            val payload = Base64.decode(encoded, Base64.NO_WRAP)
            if (payload.size <= 12) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                key,
                GCMParameterSpec(128, payload.copyOfRange(0, 12)),
            )
            String(cipher.doFinal(payload.copyOfRange(12, payload.size)), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    private fun writeBackup(json: String): Boolean {
        val encoded = encrypt(json) ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            writeMediaStore(encoded)
        } else {
            writeLegacy(encoded)
        }
    }

    /** 返回第一条能解开的备份明文；revoked 记录由 Dart 侧按字段缺失忽略。 */
    private fun readBackup(): String? {
        val candidates = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            readMediaStoreEncoded()
        } else {
            listOfNotNull(readLegacy())
        }
        for (encoded in candidates) {
            val plain = decrypt(encoded)
            if (plain != null) return plain
        }
        return null
    }

    private fun deleteBackup(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            deleteMediaStore()
        } else {
            try {
                legacyFile().delete()
            } catch (e: Exception) {
                false
            }
        }
    }

    private fun writeMediaStore(encoded: String): Boolean {
        val resolver = context.contentResolver
        // Android 11+ 删除「非本应用创建」的公共文件会抛 RecoverableSecurityException；
        // 删不掉无妨：读时按 _ID 倒序取最新，清配置时写 revoked 覆盖语义。
        try {
            deleteMediaStore()
        } catch (e: Exception) {
            Log.w(TAG, "cleanup before write skipped: ${e.message}")
        }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, BACKUP_NAME)
            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, BACKUP_DIR)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri: Uri = try {
            resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        } catch (e: Exception) {
            null
        } ?: return false
        val written = try {
            resolver.openOutputStream(uri)?.use { it.write(encoded.toByteArray(Charsets.US_ASCII)) }
            true
        } catch (e: Exception) {
            false
        }
        if (!written) {
            try {
                resolver.delete(uri, null, null)
            } catch (e: Exception) {
                // best effort
            }
            return false
        }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return true
    }

    /** 按文件名前缀扫描 Downloads，_ID 倒序（最新优先），返回密文候选。 */
    private fun readMediaStoreEncoded(): List<String> {
        val resolver = context.contentResolver
        val cursor = try {
            resolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Downloads._ID),
                "${MediaStore.Downloads.DISPLAY_NAME} LIKE ?",
                arrayOf("$NAME_PREFIX%"),
                "${MediaStore.Downloads._ID} DESC",
            )
        } catch (e: Exception) {
            Log.w(TAG, "query downloads failed: ${e.message}")
            return emptyList()
        } ?: return emptyList()
        val out = mutableListOf<String>()
        cursor.use {
            while (it.moveToNext()) {
                val id = it.getLong(0)
                val uri = ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id)
                val text = try {
                    resolver.openInputStream(uri)?.use { stream ->
                        String(stream.readBytes(), Charsets.US_ASCII)
                    }
                } catch (e: Exception) {
                    null
                }
                if (!text.isNullOrBlank()) out.add(text)
            }
        }
        return out
    }

    private fun deleteMediaStore(): Boolean {
        return try {
            context.contentResolver.delete(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                "${MediaStore.Downloads.DISPLAY_NAME} LIKE ?",
                arrayOf("$NAME_PREFIX%"),
            ) > 0
        } catch (e: Exception) {
            false
        }
    }

    private fun legacyFile(): File {
        val dir = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "NEXTBOT",
        )
        return File(dir, BACKUP_NAME)
    }

    private fun writeLegacy(encoded: String): Boolean {
        return try {
            val file = legacyFile()
            file.parentFile?.mkdirs()
            file.writeText(encoded, Charsets.US_ASCII)
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun readLegacy(): String? {
        return try {
            val file = legacyFile()
            if (file.exists()) file.readText(Charsets.US_ASCII) else null
        } catch (e: Exception) {
            null
        }
    }
}
