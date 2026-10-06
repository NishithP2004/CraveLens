# CraveLens product vision

CraveLens connects a visual food craving to a personalized, reviewable Swiggy cart while preserving the user's viewing flow. It identifies food in supported videos and user-selected webpage regions on-device, considers explicit preferences, relevance and availability, and prepares a verified cart. Users choose on-screen progress, a small cart-ready nudge or delivery to a verified private Telegram chat. Preparing a cart must never place an order: the user reviews the actual receipt and explicitly confirms checkout.

## Product requirements

- Never use mock data unless the user explicitly requests it. Build functioning integrations, not simulated product flows. Test fixtures must remain isolated from production behavior.
- Keep video frames and lasso images on-device. Describe precisely which structured context reaches the server, Swiggy, hosted cart models or Telegram.
- Ground personalization and explanations in explicit preferences and evidence actually retrieved during the run. Do not invent order-history evidence or expose hidden model reasoning. History retrieval is currently prompted, not enforced for every run; document any future change accurately.
- Preserve explicit order confirmation, live payment availability, verified cart contents and payable amount, ownership checks and duplicate-submission protection across browser and Telegram checkout. Never automatically retry non-idempotent order placement.
- Quiet modes should preserve the viewing experience. Local inference still requires a running browser; avoid claims of entirely offline shopping or automatic ordering.
- Keep new settings consistent with the popup's light/dark themes, accordion behavior, accessible labels and visible states. Respect saved preferences; Silent Telegram messages defaults to off.

## Extension versioning

Whenever introducing an extension feature or patch, update `apps/extension/public/manifest.json` to an appropriate new version. Use a patch increment for fixes, a minor increment for additive features, and a major increment for breaking changes. Keep release tags, package filenames and any documented version references consistent. Build the extension and verify the packaged manifest contains the new version. Do not create a release or publish without authorization.

## Documentation must accompany features

Whenever introducing or materially changing a feature, update the relevant documentation in the same change:

- `README.md`: behavior, architecture diagram when data flow changes, configuration, API routes, deployment and limitations.
- `apps/web/guide/index.html`: practical instructions using actual UI labels, prerequisites, defaults, privacy implications and troubleshooting.
- `TELEGRAM.md`: linking, delivery, payment behavior, persistence and bot configuration when Telegram changes.
- `apps/edge-proxy/README.md` and `wrangler.jsonc`: public routing and deployment instructions when backend endpoints change. Keep the proxy's path allowlist consistent with configured routes.
- Landing-page and privacy/terms copy when the change affects advertised capability or data handling. Keep new public pages linked, canonical, crawlable and listed in the sitemap and robots discovery configuration.

Everyday users install the Chrome extension and use the production service. Keep terminal commands and local-server setup in developer/operator documentation, not public installation instructions.

Keep tests in each workspace’s dedicated `tests/` folder, outside `src/`. Update test imports and runner commands when moving files. The root `npm test` must include all workspace test suites.

## Verification and reporting

Trace changed features across extension, shared contracts, API, persistent state and production edge routing. Run checks appropriate to the change: extension build for popup edits, web build for guide edits, and focused tests for consequential server or proxy behavior. Check visual changes in their actual UI where possible, including dark theme and long names or dropdown labels.

Report what was verified and any remaining limitations. A build or dry run does not establish successful live delivery, payment, deployment or search-engine indexing. Do not deploy, commit or claim a live integration is verified unless that work is authorized and actually completed.

## External docs - Swiggy Builders Club
 
This project integrates Swiggy MCP servers. Before writing Swiggy code,
fetch the authoritative docs:
 
- Index:     https://mcp.swiggy.com/builders/llms.txt
- Full text: https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:  append `.md` to any https://mcp.swiggy.com/builders/docs/... URL
 
Use `/docs/reference/{food,instamart,dineout,scenes}` for tool schemas and
`/docs/operate/errors` for the canonical error taxonomy. Do not invent
tool names or parameters.