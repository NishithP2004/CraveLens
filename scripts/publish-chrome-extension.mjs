import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Google API documentation: https://developer.chrome.com/docs/webstore/using-api
async function main() {
  const required = [
    "CHROME_EXTENSION_ID", "CHROME_PUBLISHER_ID", "CHROME_CLIENT_ID",
    "CHROME_CLIENT_SECRET", "CHROME_REFRESH_TOKEN", "RELEASE_ASSET", "RELEASE_VERSION",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required configuration: ${key}`);
  }
  const env = process.env;
  const zip = await readFile(env.RELEASE_ASSET);
  const item = `publishers/${encodeURIComponent(env.CHROME_PUBLISHER_ID)}/items/${encodeURIComponent(env.CHROME_EXTENSION_ID)}`;
  const api = `https://chromewebstore.googleapis.com/v2/${item}`;

  async function request(url, options, label) {
    // Never automatically retry upload or publication requests.
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}); check the Google API configuration and Developer Dashboard.`);
    const body = await response.json();
    if (body.error) throw new Error(`${label} returned an API error.`);
    return body;
  }

  const credentials = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.CHROME_CLIENT_ID,
      client_secret: env.CHROME_CLIENT_SECRET,
      refresh_token: env.CHROME_REFRESH_TOKEN,
    }),
  }, "OAuth token refresh");
  if (!credentials.access_token) throw new Error("OAuth response did not contain an access token.");
  if (env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${credentials.access_token}`);
  const headers = { Authorization: `Bearer ${credentials.access_token}` };

  const upload = await request(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/zip" },
    body: zip,
  }, "Extension upload");
  let state = upload.uploadState;
  // Some Google documentation uses UPLOAD_IN_PROGRESS; the enum reference uses IN_PROGRESS.
  for (let attempt = 0; ["IN_PROGRESS", "UPLOAD_IN_PROGRESS"].includes(state) && attempt < 60; attempt++) {
    await delay(10_000);
    const status = await request(`${api}:fetchStatus`, { headers }, "Upload status check");
    state = status.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload did not succeed (${state || "missing state"}); publication was not requested.`);
  if (upload.crxVersion && upload.crxVersion !== env.RELEASE_VERSION) {
    throw new Error("Uploaded version does not match the release version; publication was not requested.");
  }

  const publication = await request(`${api}:publish`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
  }, "Publication request");
  if (!publication.state) throw new Error("Publication response did not contain a submission state; inspect the Developer Dashboard before rerunning.");
  console.log(`Chrome Web Store submission state: ${publication.state}. Approval and live availability must be checked separately.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
