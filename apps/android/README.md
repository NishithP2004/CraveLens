# CraveLens Android

Kotlin app in `apps/android`, package `page.nishithp.cravelens`. It mirrors the Chrome extension: the same tool names, prompts, schemas, settings labels and defaults, failure policy, and server contracts. Firebase AI Logic is used for vision. The cart agent loop and Swiggy tools stay on the server. The phone joins the existing `/inference` socket as a second model provider.

## What runs where

- On-device YOLO (`best_dynamic.onnx`, copied from the extension at build time and not committed) gates frames.
- Firebase AI Logic identifies food. Gemini Nano is requested with `ONLY_ON_DEVICE` or `PREFER_ON_DEVICE`. Cloud Gemini (`gemini-3.5-flash-lite`) is used only when the saved failure policy is **Automatically use a hosted model**, or the user approves one cloud call.
- Cart turns: Gemini Nano 4 through the ML Kit Prompt API while CraveLens is in the foreground, LiteRT-LM Gemma 4 when a model file is present in the background, and Firebase cloud (`gemini-3.5-flash`, `ONLY_IN_CLOUD`) when the failure policy is automatic. The device never executes Swiggy tools and never calls `place_food_order`.
- **Ask before using a hosted model** stays on the server, matching the extension. This app does not re-invoke Firebase for that approval.
- The scan interval default on Android is 1000 ms. The adaptive sampler never goes faster than that setting, so a 500 ms burst is capped by the saved interval.

## Build

Requires JDK 17+, Android SDK platform 37 (compileSdk; Material 3 1.5 requires it), and Node.js (the Gradle `exportShared` task regenerates the shared JSON assets). `targetSdk` stays 36. The Android Gradle Plugin is 9.1.0 and the wrapper is Gradle 9.3.1. `android.builtInKotlin=false` keeps the Kotlin 2.3 plugin; that flag is deprecated and goes away in AGP 10.

```bash
cd apps/android
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > local.properties
./gradlew assembleDebug testDebugUnitTest
```

`local.properties` is gitignored. Do not commit `google-services.json`, API keys, or debug tokens.

Without a Firebase project, debug builds still compile. `BuildConfig` uses placeholders (`YOUR_FIREBASE_API_KEY`, `your-firebase-project`). Firebase and App Check are initialized at startup and any failure is shown on the onboarding screen. To use a real project, put these in `local.properties` (not in git):

```properties
FIREBASE_API_KEY=...
FIREBASE_APP_ID=1:000000000000:android:0000000000000000
FIREBASE_PROJECT_ID=your-firebase-project
```

Or drop `google-services.json` next to `app/build.gradle.kts`. The Google Services plugin applies only when that file exists.

Debug builds install the App Check debug provider. Logcat prints the debug token the first time the app talks to Firebase; register that token in the Firebase console. Release builds reference Play Integrity. Play Integrity is not configured in this repository, and sideloaded release builds will not pass it until a Play Console app exists.

The production API is `https://cravelens.nishithp.page`. The app calls `API_BASE_URL` from `local.properties` when that key is set, and production otherwise. Cleartext is allowed only for `10.0.2.2`, `localhost`, and `127.0.0.1`. See [Testing on a device](#testing-on-a-device).

## Shared assets

`npm run export:android` (or the Gradle `exportShared` task) writes prompts, constants, labels, JSON schemas, and Remote Config defaults from `packages/shared`. `SharedSchemaParityTest` fails if those exports drift from the strings the app tests.

## LiteRT Gemma

The LiteRT-LM engine is not linked in this build. If the model file is absent, background turns return `INFERENCE_UNAVAILABLE` and follow the saved failure policy. The Remote Config URLs for `.litertlm` files are placeholders and were not verified against Hugging Face.

## Visual system

The app uses Material 3 Expressive (`MaterialExpressiveTheme`, `MotionScheme.expressive()`) from Compose BOM `2026.11.01` (Material 3 1.5.0). Coral `#FF5B38` is the scheme seed. The generated light primary is `#B52605` so white labels stay readable; filled primary actions and the bubble still use bright coral and lime `#D9ED72`. Headlines use Manrope and body text uses DM Sans, both bundled under the SIL Open Font License (`app/src/main/assets/licenses/`). Light and dark follow the saved theme (`system`, `light`, or `dark`). **Use wallpaper colours** is off until the user turns it on, and only applies on Android 12 and later. Coral and lime stay on the bubble and those primary actions either way.

Home, Cart, History, and Settings are a navigation suite (a bottom navigation bar on a phone). Each screen uses a large flexible top app bar that collapses. The window is edge-to-edge. Predictive back is enabled (`enableOnBackInvokedCallback`); from Cart, History, or Settings it returns to Home with a small scale, and from Home the system finishes the activity. The Home status card and the Cart header share bounds (`status-card`) and move with the expressive spatial spring. Key presses use confirm, context-click, and toggle haptics.

The floating bubble morphs a Material shape for each status: Off is a circle, Watching a pill, Spotted food a cookie, Identifying a flower, Personalizing a clover with the wavy loading indicator, Preparing cart a sun with the same indicator, Cart ready a gem, Needs you a heart, Paused an oval, and Error a burst. Personalizing is lime and Preparing cart is coral. The overlay itself is still the view bubble; the morphing face is the in-app status.

Settings keep the extension section labels: **01 Personal context**, **02 Detection context**, **03 VLM configuration**, **04 Agentic orchestration**, **05 Cart experience**, and **06 Local AI setup**, plus an Android **Appearance** section (theme and wallpaper colours). Defaults match the extension, except the Android scan interval default of 1000 ms. Sliders cover sensitivity 0.35–0.8, scan interval 1–30 seconds, and context length 4096–32768. Segmented buttons cover the hosted-fallback, cart-experience, and theme choices.

**Connect Swiggy** on the last onboarding page, on Home, and at the top of Settings calls `POST /api/swiggy/auth/start` and opens the returned `authorizationUrl` in a Custom Tab. The app polls `GET /api/swiggy/auth/status` every 1.2 seconds for 5 minutes and again when the activity resumes. **Disconnect** in Settings calls `DELETE /api/swiggy/auth` and clears the saved inferred profile. **01 Personal context** uses the same preference routes as the extension. After that sign-in, a delivery address and no typed preferences calls `POST /api/preferences/build` when nothing usable is saved, the saved address differs, the connection was observed to change, or the profile is older than 30 days (24 hours when the saved text is empty). A profile with empty text, checked orders, and incomplete history counts as missing. Typed preferences always win and are not replaced. **Rebuild personal context** on Home and in Settings runs the same request on demand, shows the server progress, and asks for **Use suggestion** or **Keep original** before saving a manual draft. A ready job with no matched orders is shown as no history. A running job that asks for a hosted model shows **Allow hosted model** and **Stop**, posting `/api/orchestrate/:runId/fallback`. A cart response that includes `suggestion.preferenceProfile` is stored as the tentative profile, which is what the extension does when the server builds preferences during cart preparation. The phone cannot see the Swiggy credential timestamp, so a connection change that happens entirely on the server is still rebuilt during the next cart preparation even if the phone's copy looks fresh. Last updated uses the profile time. Nothing here places an order.

Home keeps **Start watching** as the coral action. **Lasso** and **Bubble** are lighter tonal buttons. The status card is full width. Every Material type slot uses Manrope (display, headline, title, large labels) or DM Sans (body and smaller labels).

Cart and History show rounded thumbnails only for `https` image URLs named `imageUrl`, `thumbnailUrl`, `image_url`, or `thumbnail_url` in the server response. Otherwise they show an original empty-plate illustration. The cart's floating toolbar checks the active cart. Order stays disabled until a verified under-cap cart exists.

A progress notification (`Notification.ProgressStyle` on API 36, `setProgress` before that) is posted only while the real watch status is Preparing cart or Cart ready, and it has no Order action. The quick settings tile label is CraveLens and its subtitle is the current status. The home-screen widget reads the saved watch label and cart summary, which stay "Off" and the empty-cart sentence until a real session writes them. The launcher icon is the official mark from `apps/web/public/icon-512.png`. The adaptive foreground keeps that eye inside the 66dp safe zone, and the background is the icon's cream `#FAF3E7`. The monochrome layer is the same silhouette for Android 13 themed icons. Legacy and round mipmaps are the same artwork. Notification and Quick Settings icons stay on `ic_tile`, because the eye does not stay legible at 24dp.

Debug builds leave `FLAG_SECURE` off the floating bubble so a screen capture can show it. Release builds keep `FLAG_SECURE`. Debug builds also show a bubble design preview on Home. Those faces are the status designs, not a live detection. The bubble above that preview is the real state.

## Ordering

Checkout posts `/api/orchestrate/:threadId/decision` at most once, on a client with `retryOnConnectionFailure` set to false. Carts at or above ₹1,000 stay closed. The Order button stays disabled until a verified under-cap cart exists. Notifications have no Order action.

## Testing on a device

The debug APK is `app/build/outputs/apk/debug/app-debug.apk` after `./gradlew :app:assembleDebug`. It is not committed. That package includes every ABI. A Pixel 10 only needs arm64:

```bash
./gradlew :app:assembleDebug -Pabi=arm64-v8a
```

The output path is the same. Do not commit the APK.

Install from a computer with the phone in USB debugging:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or copy that APK onto the Pixel and open it. Android asks you to allow installs from that app. This is a debug build, so Play App Signing is not involved.

Android Studio: open `apps/android`, let Gradle sync, choose the Pixel, and run the `app` configuration. That uses the same debug variant.

Firebase: put `google-services.json` next to `app/build.gradle.kts`, or set `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, and `FIREBASE_PROJECT_ID` in `local.properties`. Do not commit either. Debug builds use the App Check debug provider. The first Firebase call prints a debug secret in logcat under `DebugAppCheckProvider`. Register that secret in the Firebase console for this Android app. Do not paste it into git, the README, or a bug report. Release builds reference Play Integrity, which is not configured here.

Point the app at a server with `API_BASE_URL` in `local.properties`, then rebuild. Leave it unset to use `https://cravelens.nishithp.page`.

A phone can reach a server on the same computer with `adb reverse`, then this URL:

```properties
API_BASE_URL=http://127.0.0.1:8787
```

```bash
adb reverse tcp:8787 tcp:8787
```

`http://localhost:8787` is the same idea. The emulator uses `http://10.0.2.2:8787` instead of `adb reverse`. A deployed URL uses `https://` and needs no cleartext exception.

Swiggy sign-in uses the same routes as the extension. This debug build is version `0.1.1`. **Connect Swiggy** is on the last onboarding page, under the Firebase status and above **Save settings →**. It is also the first block on Home until the account is connected, and the first block in Settings. Settings shows **Disconnect** once the status is connected.

The button creates a device session if this phone does not have one, checks `GET /api/swiggy/auth/status`, and when that is not `connected` calls `POST /api/swiggy/auth/start`. The returned `authorizationUrl` opens in a Chrome Custom Tab. The server callback page stays the redirect target. Come back to CraveLens when that page says you can close the tab. The app polls `GET /api/swiggy/auth/status` every 1.2 seconds for up to 5 minutes, stops early if `expiresAt` has passed, and checks again whenever the app resumes. **Disconnect** calls `DELETE /api/swiggy/auth` and clears the saved inferred preferences on this phone. A connected account then loads the delivery address and can build personal context. Nothing in sign-in places an order.

Gemini Nano on a Pixel 10 comes from Android AICore. This app does not download it. Update the AICore app (and Android System Intelligence) from the Play Store, then leave the phone on Wi-Fi until the model finishes downloading. Identification reports the on-device status, including `AVAILABLE`. Any other status stays on the phone and does not invent a dish. Cloud identification still follows the saved failure policy. A computer build cannot show that Pixel status.
