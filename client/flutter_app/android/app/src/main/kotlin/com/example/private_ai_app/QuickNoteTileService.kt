package com.example.private_ai_app

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService
import android.util.Log

/**
 * 快捷设置磁贴「语音记一下」（2026-11-23 PRD §8.1 第四行）。
 *
 * 磁贴的价值是「不用解锁进 App 就能开口」，所以它自己不录音、不起服务：
 * 只往 [ShareIntakeStore] 写一个 `voice_note` 入口，把 App 拉到前台。
 * Dart 侧看到入口就弹半屏速记卡并直接开始听写（`QuickNoteSheet`）。
 * 这样它和长按快捷方式、常驻通知的「记一下」是同一条流程的四个门牌，
 * 而不是四套实现。
 */
class QuickNoteTileService : TileService() {

    override fun onClick() {
        super.onClick()
        ShareIntakeStore.setEntry(this, ShareIntakeStore.ENTRY_VOICE)
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP,
            )
            .putExtra(ShareIntakeStore.EXTRA_ENTRY, ShareIntakeStore.ENTRY_VOICE)
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                // Android 14 起 startActivityAndCollapse(Intent) 被移除权限语义，
                // 只接受 PendingIntent（数字常量：compileSdk 未锁死 34 时常量名可能缺）
                val pi = PendingIntent.getActivity(
                    this,
                    3412,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                startActivityAndCollapse(pi)
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        } catch (e: Exception) {
            // 部分 ROM 裁剪了折叠动画那一步：直接拉起来，用户只关心「点了一下能不能记」
            Log.w("QuickNoteTile", "startActivityAndCollapse failed", e)
            try {
                startActivity(intent)
            } catch (_: Exception) {
                // 锁屏未解锁时后台拉起 Activity 会被系统拒绝：内容已在队列里，
                // 用户解锁进 App 时 MainActivity 会照常取到入口
            }
        }
    }
}
