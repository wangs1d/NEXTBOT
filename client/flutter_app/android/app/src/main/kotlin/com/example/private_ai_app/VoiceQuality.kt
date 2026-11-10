package com.example.private_ai_app

import android.util.Log
import java.io.File
import kotlin.math.min

/**
 * 叫醒语音的音源门禁（2026-11-09）。
 *
 * 端侧不再内置 ONNX 语音模型：默认音源是服务端按动态话术实时合成的 44.1kHz mp3。
 * 这里只保留两道与音频文件有关的防线：
 *  1) 落盘前校验 mp3 帧结构，挡住错误 JSON、全零占位、截断流（云端下发或 APK 内置音色）；
 *  2) 播放前校验文件头，文件被截断/清空时直接跳到下一级降级，不让 MediaPlayer 静音卡住。
 *
 * 24kHz 只告警不拒绝（有声音优先）。PCM 生成门禁与响度/高频增强随端侧本地模型一并移除；
 * 服务端 `voice-quality.ts` 仍对每路云端 TTS 返回做同源帧结构判定。
 */
object VoiceQuality {
    private const val TAG = "VoiceQuality"

    private data class Mp3Frame(
        val next: Int,
        val sampleRate: Int,
        val bitrateKbps: Int,
        val samplesPerFrame: Int,
    )

    private val MPEG1_L3_BITRATES =
        intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
    private val MPEG2_L3_BITRATES =
        intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)

    private fun b(bytes: ByteArray, i: Int): Int = bytes[i].toInt() and 0xFF

    private fun parseMp3Frame(bytes: ByteArray, at: Int): Mp3Frame? {
        if (at + 4 > bytes.size) return null
        val b1 = b(bytes, at + 1)
        val b2 = b(bytes, at + 2)
        if (b(bytes, at) != 0xFF || (b1 and 0xE0) != 0xE0) return null
        val version = (b1 shr 3) and 0x03
        val layer = (b1 shr 1) and 0x03
        if (version == 1 || layer != 1) return null
        val bitrateIdx = (b2 shr 4) and 0x0F
        val srIdx = (b2 shr 2) and 0x03
        if (bitrateIdx == 0 || bitrateIdx == 15 || srIdx == 3) return null
        val sampleRate = when (version) {
            3 -> intArrayOf(44100, 48000, 32000)[srIdx]
            2 -> intArrayOf(22050, 24000, 16000)[srIdx]
            0 -> intArrayOf(11025, 12000, 8000)[srIdx]
            else -> return null
        }
        val bitrate = if (version == 3) MPEG1_L3_BITRATES[bitrateIdx] else MPEG2_L3_BITRATES[bitrateIdx]
        val padding = (b2 shr 1) and 0x01
        val frameLen = (if (version == 3) 144 else 72) * bitrate * 1000 / sampleRate + padding
        if (frameLen < 24 || at + frameLen > bytes.size) return null
        return Mp3Frame(at + frameLen, sampleRate, bitrate, if (version == 3) 1152 else 576)
    }

    /** 结构级校验：挡住错误 JSON、全零占位、截断流；24kHz 只告警不拒绝（有声音优先）。 */
    fun isPlausibleMp3(bytes: ByteArray?): Boolean {
        if (bytes == null || bytes.size < 1024) {
            Log.w(TAG, "mp3 rejected: too short (${bytes?.size ?: 0}B)")
            return false
        }
        var at = 0
        if (bytes.size >= 10 && b(bytes, 0) == 0x49 && b(bytes, 1) == 0x44 && b(bytes, 2) == 0x33) {
            val size = ((b(bytes, 6) and 0x7F) shl 21) or ((b(bytes, 7) and 0x7F) shl 14) or
                ((b(bytes, 8) and 0x7F) shl 7) or (b(bytes, 9) and 0x7F)
            val footer = if ((b(bytes, 5) and 0x10) != 0) 10 else 0
            at = min(bytes.size, 10 + size + footer)
        }
        var frames = 0
        var duration = 0.0
        var sampleRate = 0
        var payloadBytes = 0L
        var nonZero = 0L
        var zeroFrames = 0
        val distinct = BooleanArray(256)
        var distinctCount = 0
        while (at + 4 <= bytes.size) {
            val frame = parseMp3Frame(bytes, at)
            if (frame == null) {
                at += 1
                continue
            }
            frames += 1
            duration += frame.samplesPerFrame.toDouble() / frame.sampleRate
            sampleRate = frame.sampleRate
            var frameNonZero = 0
            for (i in (at + 4) until frame.next) {
                val v = b(bytes, i)
                if (v != 0) frameNonZero += 1
                if (!distinct[v]) {
                    distinct[v] = true
                    distinctCount += 1
                }
            }
            payloadBytes += (frame.next - at - 4).toLong()
            nonZero += frameNonZero.toLong()
            if (frameNonZero == 0) zeroFrames += 1
            at = frame.next
        }
        val nonZeroRatio = if (payloadBytes > 0) nonZero.toDouble() / payloadBytes else 0.0
        val zeroFrameRatio = if (frames > 0) zeroFrames.toDouble() / frames else 1.0
        if (sampleRate in 1 until 32000) {
            Log.w(TAG, "mp3 degraded: low sampleRate=${sampleRate}Hz (kept, not rejected)")
        }
        val ok = frames >= 8 && duration >= 0.5 && nonZeroRatio > 0.15 &&
            distinctCount >= 24 && zeroFrameRatio <= 0.4
        if (!ok) {
            Log.w(
                TAG,
                "mp3 rejected: frames=$frames dur=${"%.2f".format(duration)}s " +
                    "nonZero=${"%.3f".format(nonZeroRatio)} distinct=$distinctCount zeroFrames=$zeroFrameRatio",
            )
        }
        return ok
    }

    /** 播放前最后的防线：文件被截断/清空时直接跳到下一级降级，不让 MediaPlayer 静音卡住。 */
    fun isPlayableAudioFile(file: File): Boolean {
        if (!file.exists() || file.length() < 1024) return false
        return try {
            val head = ByteArray(12)
            file.inputStream().use { it.read(head) }
            val riff = head[0] == 'R'.code.toByte() && head[1] == 'I'.code.toByte() &&
                head[2] == 'F'.code.toByte() && head[3] == 'F'.code.toByte() &&
                head[8] == 'W'.code.toByte() && head[9] == 'A'.code.toByte() &&
                head[10] == 'V'.code.toByte() && head[11] == 'E'.code.toByte()
            val id3 = head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() &&
                head[2] == '3'.code.toByte()
            val sync = b(head, 0) == 0xFF && (b(head, 1) and 0xE0) == 0xE0
            riff || id3 || sync
        } catch (e: Exception) {
            Log.w(TAG, "audio head check failed", e)
            false
        }
    }
}
