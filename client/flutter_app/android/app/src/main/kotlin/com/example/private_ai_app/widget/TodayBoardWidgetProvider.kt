package com.example.private_ai_app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.util.Log

/**
 * 4×2 桌面小组件（2026-11-23 主动触达 §5.3）。
 *
 * 四档内容：下一件事 / 待取件取件码 / 今天到期 / 管家一句话；
 * 右上角「记一下」，各区域各自跳页。没有的那一行整行隐藏，不留空槽。
 * 与 2×2 共用同一份数据与同一个渲染器，差别只在布局，所以两档永远显示得一致。
 */
class TodayBoardWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        TodayWidgetRenderer.render(context, appWidgetManager, appWidgetIds, TodayWidgetRenderer.Size.Board)
    }

    override fun onEnabled(context: Context) {
        Log.i(TAG, "4x2 widget enabled, first render from cached board")
        TodayWidgetRenderer.renderAll(context)
    }

    private companion object {
        const val TAG = "TodayWidget"
    }
}
