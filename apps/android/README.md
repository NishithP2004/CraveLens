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

The production API is `https://cravelens.nishithp.page`. The emulator can reach a local API at `http://10.0.2.2:8787` (cleartext is allowed only for that host and `localhost`).

## Shared assets

`npm run export:android` (or the Gradle `exportShared` task) writes prompts, constants, labels, JSON schemas, and Remote Config defaults from `packages/shared`. `SharedSchemaParityTest` fails if those exports drift from the strings the app tests.

## LiteRT Gemma

The LiteRT-LM engine is not linked in this build. If the model file is absent, background turns return `INFERENCE_UNAVAILABLE` and follow the saved failure policy. The Remote Config URLs for `.litertlm` files are placeholders and were not verified against Hugging Face.

## Visual system

The app uses Material 3 Expressive (`MaterialExpressiveTheme`, `MotionScheme.expressive()`) from Compose BOM `2026.11.01` (Material 3 1.5.0). Coral `#FF5B38` is the scheme seed. The generated light primary is `#B52605` so white labels stay readable; filled primary actions and the bubble still use bright coral and lime `#D9ED72`. Headlines use Manrope and body text uses DM Sans, both bundled under the SIL Open Font License (`app/src/main/assets/licenses/`). Light and dark follow the saved theme (`system`, `light`, or `dark`). **Use wallpaper colours** is off until the user turns it on, and only applies on Android 12 and later. Coral and lime stay on the bubble and those primary actions either way.

Home, Cart, History, and Settings are a navigation suite (a bottom navigation bar on a phone). Each screen uses a large flexible top app bar that collapses. The window is edge-to-edge. Predictive back is enabled (`enableOnBackInvokedCallback`); from Cart, History, or Settings it returns to Home with a small scale, and from Home the system finishes the activity. The Home status card and the Cart header share bounds (`status-card`) and move with the expressive spatial spring. Key presses use confirm, context-click, and toggle haptics.

The floating bubble morphs a Material shape for each status: Off is a circle, Watching a pill, Spotted food a cookie, Identifying a flower, Personalizing a clover with the wavy loading indicator, Preparing cart a sun with the same indicator, Cart ready a gem, Needs you a heart, Paused an oval, and Error a burst. Personalizing is lime and Preparing cart is coral. The overlay itself is still the view bubble; the morphing face is the in-app status.

Settings keep the extension section labels: **01 Personal context**, **02 Detection context**, **03 VLM configuration**, **04 Agentic orchestration**, **05 Cart experience**, and **06 Local AI setup**, plus an Android **Appearance** section (theme and wallpaper colours). Defaults match the extension, except the Android scan interval default of 1000 ms. Sliders cover sensitivity 0.35–0.8, scan interval 1–30 seconds, and context length 4096–32768. Segmented buttons cover the hosted-fallback, cart-experience, and theme choices.

Cart and History show rounded thumbnails only for `https` image URLs named `imageUrl`, `thumbnailUrl`, `image_url`, or `thumbnail_url` in the server response. Otherwise they show an original empty-plate illustration. The cart's floating toolbar checks the active cart. Order stays disabled until a verified under-cap cart exists.

A progress notification (`Notification.ProgressStyle` on API 36, `setProgress` before that) is posted only while the real watch status is Preparing cart or Cart ready, and it has no Order action. The quick settings tile label is CraveLens and its subtitle is the current status. The home-screen widget reads the saved watch label and cart summary, which stay "Off" and the empty-cart sentence until a real session writes them. The launcher icon has an adaptive foreground and a monochrome layer for themed icons.

Debug builds leave `FLAG_SECURE` off the floating bubble so a screen capture can show it. Release builds keep `FLAG_SECURE`. Debug builds also show a bubble design preview on Home. Those faces are the status designs, not a live detection. The bubble above that preview is the real state.

## Ordering

Checkout posts `/api/orchestrate/:threadId/decision` at most once, on a client with `retryOnConnectionFailure` set to false. Carts at or above ₹1,000 stay closed. The Order button stays disabled until a verified under-cap cart exists. Notifications have no Order action.
