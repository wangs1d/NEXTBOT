import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // HMS AGC 插件：构建期把 app/agconnect-services.json 处理进资源（须在 AGP 之后应用）
    id("com.huawei.agconnect")
}

// 签名凭据只从本机忽略文件或环境变量读取，绝不写进版本库。
// 优先级：CI 环境变量 > android/key.properties（已被 .gitignore 忽略）> 明确报错。
// debug/release 共用正式签名（HMS AGC 指纹强校验），缺凭据时不静默降级到 debug.keystore。
// 注意：脚本作用域里 `java` 是 Gradle 的 Java 扩展，不能用 java.util.Properties 全限定名，
// 必须走顶部 import；同理避免 takeIf/it 的类型推断歧义，写成显式 if。
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.isFile) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

fun signingCredential(envName: String, propKey: String): String {
    val fromEnv = System.getenv(envName)
    if (!fromEnv.isNullOrBlank()) return fromEnv
    val fromFile = keystoreProperties.getProperty(propKey)
    if (!fromFile.isNullOrBlank()) return fromFile
    throw org.gradle.api.GradleException(
        "缺少 Android 签名口令：请设置环境变量 $envName，或在 android/key.properties 中配置 " +
            "$propKey=<口令>（该文件已被 .gitignore 忽略，禁止提交）。"
    )
}

android {
    namespace = "com.example.private_ai_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    // CameraX 的 ProcessCameraProvider 暴露 ListenableFuture 类型。占位包
    // listenablefuture:1.0 与 guava 33+（自带 ListenableFuture）重复类冲突
    // （checkDebugDuplicateClasses 炸），全局排除占位包，类型统一由 guava 提供。
    configurations.all {
        resolutionStrategy {
            exclude(mapOf("group" to "com.google.guava", "module" to "listenablefuture"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications 22+ 要求开启 core library desugaring
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        // 应用身份 = NextBot 品牌包名（2026-10-13 用户定调）。华为 AGC 注册的包名必须与此
        // 完全一致。注意 namespace（Kotlin 源码包）仍为 com.example.private_ai_app，
        // AGP 8 允许二者不同，勿混淆。
        applicationId = "com.nextbot.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // NextBot 正式签名（2026-10-13）：nextbot-release.jks 与华为 AGC 登记的
    // SHA-256 指纹绑定（HMS 注册强校验），debug/release 统一用它——任何构建
    // 的签名指纹都与 AGC 登记一致。keystore 备份在桌面 nextbot-signing/。
    // 口令不落版本库：见文件顶部的 signingCredential（key.properties / 环境变量）。
    signingConfigs {
        create("nextbot") {
            storeFile = file("nextbot-release.jks")
            storePassword = signingCredential("NEXTBOT_STORE_PASSWORD", "storePassword")
            keyAlias = "nextbot"
            keyPassword = signingCredential("NEXTBOT_KEY_PASSWORD", "keyPassword")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("nextbot")
            // R8：此前只声明 proguardFiles 却没开 minify，规则从未生效。
            // 开启后 DEX 会被压缩/改名；HMS、JNI 的 keep 规则见 proguard-rules.pro。
            // isShrinkResources 暂不开启：Flutter 插件资源误删风险高于体积收益，待 release 冒烟后再评估。
            isMinifyEnabled = true
            // HMS 可选类 dontwarn 规则（proguard-rules.pro）
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            // 调试构建也带正式身份：HMS/指纹校验对 debug 运行同样生效
            signingConfig = signingConfigs.getByName("nextbot")
        }
    }

    // Gradle 层产物命名 NEXTBOT.apk（不带版本号/变体后缀）。注意 flutter 工具链
    // 构建后仍会把产物拷到 flutter-apk/app-release.apk（工具侧行为拦不住），
    // 对外分发统一走 build_apk.ps1 → 桌面 NEXTBOT.apk。
    applicationVariants.all {
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl)
                .outputFileName = "NEXTBOT.apk"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    // 厂商推送：华为 HMS Push 直连（2026-10-13 用户定调：移除极光，高可控直连）。
    // 客户端 HmsInstanceId 取 token 上报服务端；服务端经华为 OAuth + Push Kit API 直推。
    // 前置条件（均已就位）：app/agconnect-services.json + AGC 指纹登记。
    implementation("com.huawei.hms:push:6.12.0.300")
    // AGC SDK 基础包（AGC 控制台「添加SDK」引导项；agcp 插件构建期消费上面的 json）
    implementation("com.huawei.agconnect:agconnect-core:1.9.1.304")

    // 远程拍照（camera_capture）：CameraX 后台拍照（前台服务 + camera 类型）
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    // LifecycleService：让 CameraCaptureService 持有生命周期绑定 CameraX
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    // CameraX ProcessCameraProvider.getInstance 返回 ListenableFuture（由 guava 提供）
    implementation("com.google.guava:guava:33.5.0-android")
}

flutter {
    source = "../.."
}
