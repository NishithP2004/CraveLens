package page.nishithp.cravelens

import android.app.Application
import android.content.Context
import com.google.firebase.FirebaseApp
import page.nishithp.cravelens.agent.AicoreChat
import page.nishithp.cravelens.agent.FirebaseCloudChat
import page.nishithp.cravelens.agent.InferenceBridge
import page.nishithp.cravelens.agent.LiteRtLmChat
import page.nishithp.cravelens.data.CraveApi
import page.nishithp.cravelens.data.KeystoreSessionStore
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.remoteconfig.FirebaseRemoteConfig
import com.google.firebase.remoteconfig.remoteConfigSettings

class CraveLensApp : Application() {
    lateinit var api: CraveApi
        private set
    private val inference by lazy { InferenceBridge(AicoreChat(), LiteRtLmChat(null), FirebaseCloudChat()) { appOnTop } }

    override fun onCreate() {
        super.onCreate()
        api = CraveApi(BuildConfig.API_BASE_URL, KeystoreSessionStore(this))
        startupMessage = startFirebase(this)
    }

    fun connectInference(providers: List<Map<String, Any?>>) {
        inference.connect(BuildConfig.API_BASE_URL, { api.bearer() }, providers)
    }

    companion object {
        var startupMessage: String = "Firebase has not started"
            private set
        @Volatile var appOnTop: Boolean = false
    }
}

fun Context.craveApi(): CraveApi = (applicationContext as CraveLensApp).api

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
