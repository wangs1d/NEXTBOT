package com.example.private_ai_app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.util.Log

/**
 * 2×2 桌面小组件（2026-11-23 主动触达 §5.3）。
 *
 * 规格里这一档只要两样东西：下一件事 + 倒计时，空闲时换成管家一句话。
 * 渲染全在 [TodayWidgetRenderer]，本类只回答系统的问题「哪些实例该重画了」：
 *  - `onUpdate`：添加实例、系统 30min 周期刷新（兜底）、以及 [renderAll] 主动点名；
 *  - `onEnabled`：桌面上第一个实例落地，此时不该让用户等下一个周期——立刻读一次偏好；
 *  - `onDisabled`：最后一个实例被移除，没什么可清理的（我们没有自己的定时器）。
 */
class TodayWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        TodayWidgetRenderer.render(context, appWidgetManager, appWidgetIds, TodayWidgetRenderer.Size.Compact)
    }

    override fun onEnabled(context: Context) {
        Log.i(TAG, "2x2 widget enabled, first render from cached board")
        TodayWidgetRenderer.renderAll(context)
    }

    private companion object {
        const val TAG = "TodayWidget"
    }
}
