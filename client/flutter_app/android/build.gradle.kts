// HMS AGC 插件（2026-10-14）：构建期把 agconnect-services.json 处理进资源。
// agcp 1.9.1.304 兼容 AGP 8；它启动时检查 buildscript classpath 里必须有
// com.android.tools.build:gradle，所以这里同时显式挂 AGP 8.11.1。
// 注意：root .kts 一旦声明 buildscript，脚本就按 buildscript 类路径编译，
// AGP 类型（LibraryExtension 等）必须在这条 classpath 上，缺了会 Unresolved reference。
buildscript {
    repositories {
        maven("https://developer.huawei.com/repo/")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/central")
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.1")
        classpath("com.huawei.agconnect:agcp:1.9.1.304")
    }
}

allprojects {
    repositories {
        // CN 镜像优先，失败回落官方源（与 settings.gradle.kts 的 pluginManagement 对应）
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/central")
        google()
        mavenCentral()
        // 华为 HMS 仓库：厂商通道 plugin:huawei 的 HMS push 依赖在此
        // （com.huawei.hms:* 不在 Maven Central）
        maven("https://developer.huawei.com/repo/")
    }
    // 某插件 POM 声明了动态版本 androidx.test:runner:1.2+，每次解析都要在线查
    // 元数据；而本机直连 maven.google.com/download.flutter.io 会被挂死（无可用
    // 代理）。缓存里已有 1.2.0，钉死成静态版本后可离线解析。
    configurations.all {
        resolutionStrategy {
            force("androidx.test:runner:1.3.0")
            force("androidx.test:monitor:1.3.0")
            // integration_test 的 POM 同样声明了动态版本 androidx.test:rules:1.2+，
            // 每次构建都要去 dl.google.com 查 maven-metadata —— 直连超时直接让
            // assembleDebug 失败（2026-11-06 实测：Read timed out）。钉死成静态
            // 版本后走本地缓存，构建不再依赖这一次网络往返。
            force("androidx.test:rules:1.3.0")
        }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")

    // 旧版 Flutter 插件(如 isar_flutter_libs 3.x)未声明 namespace,
    // AGP 8.11+ 强制要求,这里为缺失 namespace 的 library 模块兜底注入。
    project.plugins.withId("com.android.library") {
        project.extensions.configure<com.android.build.gradle.LibraryExtension>("android") {
            if (namespace.isNullOrBlank()) {
                namespace = "com.nextbot.plugin." + project.name.replace(Regex("[^a-zA-Z0-9_.]"), "_")
            }
        }
    }

    // isar_flutter_libs 3.1.0 硬编码 compileSdkVersion 30,但其资源引用了
    // android:lStar(API 33+ 才存在),低版本 SDK 下 AAPT 链接报错。
    // 需在插件自己的 build.gradle(android{} 块)执行完后、AGP 固化 DSL 之前改掉,
    // 因此在 root 的 subprojects 阶段先注册 afterEvaluate(先于 AGP 注册的回调执行)。
    if (!project.state.executed) {
        project.afterEvaluate {
            project.plugins.withId("com.android.library") {
                project.extensions.configure<com.android.build.gradle.LibraryExtension>("android") {
                    if ((compileSdk ?: 0) < 33) {
                        compileSdk = 35
                    }
                }
            }
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
