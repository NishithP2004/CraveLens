package page.nishithp.cravelens.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import page.nishithp.cravelens.core.api.DeviceSessionStore
import page.nishithp.cravelens.core.api.parseDeviceSession
import page.nishithp.cravelens.core.json.CraveJson
import page.nishithp.cravelens.core.model.DeviceSession
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class KeystoreSessionStore(context: Context) : DeviceSessionStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun load(): DeviceSession? {
        val packed = prefs.getString(KEY, null) ?: return null
        return try {
            parseDeviceSession(decrypt(Base64.decode(packed, Base64.NO_WRAP)))
        } catch (_: Exception) {
            null
        }
    }

    override fun save(session: DeviceSession) {
        val json = CraveJson.encodeToString(DeviceSession.serializer(), session)
        val packed = Base64.encodeToString(encrypt(json.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        if (!prefs.edit().putString(KEY, packed).commit()) throw IllegalStateException("Device session could not be stored")
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        return byteArrayOf(iv.size.toByte()) + iv + cipher.doFinal(plain)
    }

    private fun decrypt(packed: ByteArray): String {
        val ivLength = packed[0].toInt() and 0xff
        val iv = packed.copyOfRange(1, 1 + ivLength)
        val body = packed.copyOfRange(1 + ivLength, packed.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return cipher.doFinal(body).toString(Charsets.UTF_8)
    }

    private companion object {
        const val PREFS = "cravelens.device.session"
        const val KEY = "session"
        const val ALIAS = "cravelens.device.session"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
