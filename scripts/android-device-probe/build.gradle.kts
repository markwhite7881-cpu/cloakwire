plugins { id("com.android.application") version "8.11.0" }
android {
    namespace = "app.cloakwire.deviceprobe"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.cloakwire.deviceprobe"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "test-only"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}
