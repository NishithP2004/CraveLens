import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("node", ["scripts/export-shared.mjs"], { cwd: root, stdio: "inherit" });
execFileSync("git", ["diff", "--exit-code", "--", "apps/android/core/src/main/assets/shared", "apps/android/app/src/main/res/xml/remote_config_defaults.xml", "apps/android/firebase/remoteconfig.template.json", "apps/android/tests/fixtures/identity-golden.json", "apps/android/tests/fixtures/agent-events.json"], { cwd: root, stdio: "inherit" });
