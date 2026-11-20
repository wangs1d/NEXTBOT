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

# Flutter / HMS 等 JNI 入口的 native 方法不能重命名（通用规则）。
-keepclasseswithmembernames class * { native <methods>; }

# 高德定位 SDK（2026-11-18）：内部大量反射与 JNI 回调，必须整流保留。
# 官方只提供此通用规则，按包名整体 keep 是最稳的做法（体积影响有限）。
-keep class com.amap.api.** { *; }
-keep class com.autonavi.** { *; }
-dontwarn com.amap.api.**
-dontwarn com.autonavi.**

# 支付宝 App 支付 SDK（2026-11-19）：收银台/结果回调依赖反射与内部 Activity，
# release 开启 minify 后必须整体保留，否则支付结果无法回传。
-keep class com.alipay.** { *; }
-dontwarn com.alipay.**
