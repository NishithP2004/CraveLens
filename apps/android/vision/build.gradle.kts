plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "page.nishithp.cravelens.vision"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

val copyFoodModel = tasks.register<Copy>("copyFoodModel") {
    from(rootProject.projectDir.resolve("../extension/public/models/food-detector/best_dynamic.onnx"))
    into(layout.projectDirectory.dir("src/main/assets/models/food-detector"))
}

tasks.named("preBuild") { dependsOn(copyFoodModel, rootProject.tasks.named("exportShared")) }

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines)
    implementation(libs.onnx)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.ai)
    implementation(libs.firebase.ai.ondevice)
    implementation(libs.firebase.config)
}
