import java.util.Properties

plugins {
    id("com.android.application")
}

// The app's own version (android/version.properties – not the desktop app's): "1.2.3" → versionCode 10203.
val versionProps = Properties().apply { file("../version.properties").inputStream().use { load(it) } }
val appVersionName: String = versionProps.getProperty("versionName").trim()
val versionParts = appVersionName.split("-")[0].split(".").map { it.toInt() }
val appVersionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]

// nodejs-mobile (Node 18) is downloaded separately (node scripts/fetch-nodejs-mobile.mjs) and unpacked to app/libnode:
//   app/libnode/bin/<abi>/libnode.so   and   app/libnode/include/node/*.h
// Without it the app still builds, but the server can't start (the app says so).
val libnodeDir = file("libnode")
val hasLibnode = file("libnode/bin/arm64-v8a/libnode.so").exists()

// Phones are arm64; x86_64 is only for emulators on an Intel PC. The 3DS player exists for arm64 only.
// ./gradlew assembleRelease -PsouldewAbis=arm64-v8a  builds the phone-only APK (the release workflow does).
val abis = ((findProperty("souldewAbis") as String?) ?: "arm64-v8a,x86_64").split(",").map { it.trim() }

android {
    namespace = "app.souldew"
    compileSdk = 36
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "app.souldew"
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        ndk { abiFilters += abis }
        if (hasLibnode) {
            externalNativeBuild {
                cmake { arguments += listOf("-DLIBNODE_DIR=${libnodeDir.absolutePath}", "-DANDROID_STL=c++_shared") }
            }
        }
    }

    if (hasLibnode) {
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
        sourceSets["main"].jniLibs.srcDir("libnode/bin")
    }

    // The 3DS player: ctr/arm64-v8a/libctrhost.so (native/ctr-host built as an executable) and libazahar_libretro.so
    // (Azahar with native/azahar-patch; node scripts/build-ctr-android.mjs). Files named lib*.so are the only ones an
    // app may run (see docs/ANDROID.md).
    sourceSets["main"].jniLibs.srcDir("ctr")

    // Release signing: SOULDEW_KEYSTORE (a .jks / .p12 file), SOULDEW_KEYSTORE_PASSWORD, SOULDEW_KEY_ALIAS,
    // SOULDEW_KEY_PASSWORD (environment). Without them the release APK is signed with the debug key – it installs, but
    // is not the one to publish (an update over a differently signed app is refused by Android).
    val keystore = System.getenv("SOULDEW_KEYSTORE")
    signingConfigs {
        if (keystore != null && file(keystore).exists()) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("SOULDEW_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SOULDEW_KEY_ALIAS")
                keyPassword = System.getenv("SOULDEW_KEY_PASSWORD") ?: System.getenv("SOULDEW_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { jniLibs { useLegacyPackaging = true } }
}
