plugins {
    id("com.android.application")
}

android {
    namespace = "dev.stitch.hands"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.stitch.hands"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
