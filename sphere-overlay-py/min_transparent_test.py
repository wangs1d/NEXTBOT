"""最小测试：QWebEngineView 在透明无边框窗口里能否显示内容。"""
import sys

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QApplication, QWidget, QVBoxLayout
from PySide6.QtWebEngineWidgets import QWebEngineView

app = QApplication(sys.argv)

w = QWidget()
w.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint)
w.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
w.resize(400, 400)
w.move(100, 100)

lay = QVBoxLayout(w)
lay.setContentsMargins(0, 0, 0, 0)
view = QWebEngineView()
view.page().setBackgroundColor(QColor(0, 0, 0, 0))
# 红色背景 + 一个蓝色圆
html = """
<html><body style="margin:0;background:red;">
<div style="width:200px;height:200px;border-radius:100px;background:blue;margin:100px;"></div>
</body></html>
"""
view.setHtml(html)
lay.addWidget(view)

w.show()
sys.exit(app.exec())
