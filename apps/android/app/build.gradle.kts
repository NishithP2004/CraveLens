import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val googleServices = file("google-services.json")
if (googleServices.exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "page.nishithp.cravelens"
    compileSdk = 37
    defaultConfig {
        applicationId = "page.nishithp.cravelens"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        val local = Properties()
        val localFile = rootProject.file("local.properties")
        if (localFile.exists()) localFile.inputStream().use { local.load(it) }
        fun config(name: String, fallback: String) = (local.getProperty(name) ?: fallback).replace("\"", "")
        buildConfigField("String", "FIREBASE_API_KEY", "\"${config("FIREBASE_API_KEY", "YOUR_FIREBASE_API_KEY")}\"")
        buildConfigField("String", "FIREBASE_APP_ID", "\"${config("FIREBASE_APP_ID", "1:000000000000:android:0000000000000000")}\"")
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"${config("FIREBASE_PROJECT_ID", "your-firebase-project")}\"")
        buildConfigField("String", "PROD_API_URL", "\"https://cravelens.nishithp.page\"")
        buildConfigField("String", "DEV_API_URL", "\"http://10.0.2.2:8787\"")
        buildConfigField("String", "API_BASE_URL", "\"${config("API_BASE_URL", "https://cravelens.nishithp.page")}\"")
        val requestedAbi = providers.gradleProperty("abi").orNull
        if (!requestedAbi.isNullOrBlank()) ndk.abiFilters += requestedAbi
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    buildTypes {
        debug {
            isDebuggable = true
        }
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("test") {
        java.setSrcDirs(listOf("../tests/unit/app"))
    }
    packaging {
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/INDEX.LIST", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

tasks.named("preBuild") { dependsOn(rootProject.tasks.named("exportShared")) }

dependencies {
    implementation(project(":core"))
    implementation(project(":vision"))
    implementation(project(":agent"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.viewmodel)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.material3)
    implementation(libs.compose.material3.navsuite)
    implementation(libs.compose.material.icons)
    implementation(libs.graphics.shapes)
    implementation(libs.glance.appwidget)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.kotlinx.serialization)
    implementation(libs.kotlinx.coroutines)
    implementation(libs.datastore)
    implementation(libs.browser)
    implementation(libs.coil)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.ai)
    implementation(libs.firebase.ai.ondevice)
    implementation(libs.firebase.appcheck)
    implementation(libs.firebase.auth)
    implementation(libs.firebase.firestore)
    implementation(libs.firebase.config)
    debugImplementation(libs.firebase.appcheck.debug)
    releaseImplementation(libs.firebase.appcheck.playintegrity)
    testImplementation(libs.junit)
}
