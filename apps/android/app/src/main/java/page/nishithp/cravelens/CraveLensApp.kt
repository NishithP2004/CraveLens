package page.nishithp.cravelens

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.remoteconfig.FirebaseRemoteConfig
import com.google.firebase.remoteconfig.remoteConfigSettings

class CraveLensApp : Application() {
    override fun onCreate() {
        super.onCreate()
        startupMessage = startFirebase(this)
    }

    companion object {
        var startupMessage: String = "Firebase has not started"
            private set
    }
}

fun startFirebase(app: Application): String = try {
    if (FirebaseApp.getApps(app).isEmpty()) {
        FirebaseApp.initializeApp(app, FirebaseOptions.Builder()
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .build())
    }
    installAppCheck()
    FirebaseAuth.getInstance().signInAnonymously()
    val remoteConfig = FirebaseRemoteConfig.getInstance()
    remoteConfig.setConfigSettingsAsync(remoteConfigSettings { minimumFetchIntervalInSeconds = if (BuildConfig.DEBUG) 0 else 3600 })
    remoteConfig.setDefaultsAsync(R.xml.remote_config_defaults)
    remoteConfig.fetchAndActivate()
    "App Check installed"
} catch (error: Throwable) {
    error.message ?: "Firebase setup failed"
}
