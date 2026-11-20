# CraveLens Android

Kotlin app in `apps/android`, package `page.nishithp.cravelens`. It mirrors the Chrome extension: the same tool names, prompts, schemas, settings labels and defaults, failure policy, and server contracts. Firebase AI Logic is used for vision. The cart agent loop and Swiggy tools stay on the server. The phone joins the existing `/inference` socket as a second model provider.

## What runs where

- On-device YOLO (`best_dynamic.onnx`, copied from the extension at build time and not committed) gates frames.
- Firebase AI Logic identifies food. Gemini Nano is requested with `ONLY_ON_DEVICE` or `PREFER_ON_DEVICE`. Cloud Gemini (`gemini-3.5-flash-lite`) is used only when the saved failure policy is **Automatically use a hosted model**, or the user approves one cloud call.
- Cart turns: Gemini Nano 4 through the ML Kit Prompt API while CraveLens is in the foreground, LiteRT-LM Gemma 4 when a model file is present in the background, and Firebase cloud (`gemini-3.5-flash`, `ONLY_IN_CLOUD`) when the failure policy is automatic. The device never executes Swiggy tools and never calls `place_food_order`.
- **Ask before using a hosted model** stays on the server, matching the extension. This app does not re-invoke Firebase for that approval.
- The scan interval default on Android is 1000 ms. The adaptive sampler never goes faster than that setting, so a 500 ms burst is capped by the saved interval.

## Build

Requires JDK 17+, Android SDK 36, and Node.js (the Gradle `exportShared` task regenerates the shared JSON assets).

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

## Ordering

Checkout posts `/api/orchestrate/:threadId/decision` at most once, on a client with `retryOnConnectionFailure` set to false. Carts at or above ₹1,000 stay closed. The Order button stays disabled until a verified under-cap cart exists. Notifications have no Order action.
