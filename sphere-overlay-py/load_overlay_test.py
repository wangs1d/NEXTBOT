"""用最小窗口外壳加载实际 overlay.html，定位是窗口外壳问题还是页面问题。"""
import sys
from pathlib import Path

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QApplication, QWidget, QVBoxLayout
from PySide6.QtWebEngineWidgets import QWebEngineView

app = QApplication(sys.argv)

w = QWidget()
w.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint)
w.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
w.resize(372, 464)
w.move(1140, 328)

lay = QVBoxLayout(w)
lay.setContentsMargins(0, 0, 0, 0)
view = QWebEngineView()
view.page().setBackgroundColor(QColor(0, 0, 0, 0))
overlay = Path(r"D:\ws-project\Private-Agent\agent-sphere-avatar\dist\overlay.html").resolve()
url = QUrl.fromLocalFile(str(overlay))
url.setQuery("offwork=23%3A59")
view.setUrl(url)
lay.addWidget(view)

w.show()
sys.exit(app.exec())
