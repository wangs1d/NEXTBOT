pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        // CN 镜像优先（本机直连 google()/mavenCentral() 会超时，如 record_android
        // 钉死的 AGP 9.2.1），失败回落官方源。
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/central")
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        // HMS AGC 插件仓（agcp：构建期处理 agconnect-services.json）
        maven("https://developer.huawei.com/repo/")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    // agcp 无 plugin marker（gradle.plugin 元数据 404），用 useModule 直接映射构件。
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id == "com.huawei.agconnect") {
                useModule("com.huawei.agconnect:agcp:1.9.1.304")
            }
        }
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.11.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    id("com.huawei.agconnect") version "1.9.1.304" apply false
}

include(":app")
