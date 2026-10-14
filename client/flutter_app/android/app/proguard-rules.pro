# NextBot R8 规则（2026-10-13，华为 HMS Push 集成所需）
# HMS SDK 引用一批设备侧/可选类（hianalytics、libcore、BuildEx、bouncycastle），
# 编译期不在 classpath 上，属正常现象，dontwarn 放行即可（运行时路径有守卫）。
-ignorewarnings
-dontwarn com.huawei.android.os.BuildEx$VERSION
-dontwarn com.huawei.hianalytics.**
-dontwarn com.huawei.hms.**
-dontwarn com.huawei.libcore.**
-dontwarn org.bouncycastle.**
-dontwarn com.xiaomi.push.**
-keep class com.huawei.hms.** { *; }
