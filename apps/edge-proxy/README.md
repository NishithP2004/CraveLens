# CraveLens Cloudflare edge proxy

This Worker keeps the landing page on GitHub Pages while proxying only the
Node server routes through a Cloudflare Tunnel on the Raspberry Pi.

```text
https://cravelens.nishithp.page/             -> GitHub Pages
https://cravelens.nishithp.page/api/*        -> Worker -> Tunnel -> Pi server
https://cravelens.nishithp.page/socket.io/*  -> Worker -> Tunnel -> Pi server
https://cravelens.nishithp.page/telegram/webhook -> Worker -> Tunnel -> Pi server
```

`/socket.io/*` is essential: the extension uses Socket.IO over WebSocket for
agent events and the `/inference` namespace. The Socket.IO namespace is carried
inside the `/socket.io/*` handshake, so it does not need a separate `/inference`
route.

Telegram linking, confirmation, disconnection, cart-experience settings and the preference builder’s start/progress endpoints use the existing `/api/*` route. Preference progress uses authenticated HTTP polling; no additional WebSocket route is required. The exact `/telegram/webhook` route forwards bot updates, including the POST body and `X-Telegram-Bot-Api-Secret-Token` header, to the API. The Worker adds the origin Access service-token headers; the API separately validates the Telegram secret. Other `/telegram/*` paths are not forwarded. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` on the server, not on the Worker. Redeploy this Worker after route changes. See [Telegram setup](../../TELEGRAM.md).

## One-time Cloudflare setup

1. Make `nishithp.page` an active Cloudflare zone and keep the DNS record for
   `cravelens.nishithp.page` **proxied**. Its origin remains the existing GitHub
   Pages hostname.
2. In Cloudflare Zero Trust, create a Tunnel on the Raspberry Pi and add a
   public hostname such as `origin.cravelens.nishithp.page` that targets the
   private server service (`http://server:8787` when `cloudflared` runs in the
   Compose network, or `http://127.0.0.1:8787` when it runs on the Pi host).
3. Create a Cloudflare Access application for
   `origin.cravelens.nishithp.page/*`. Allow only a service token; do not allow
   public users. Create that service token and retain its client ID and secret.
4. In `apps/edge-proxy`, authenticate Wrangler and set the Worker configuration:

   ```bash
   npx wrangler secret put TUNNEL_ORIGIN
   npx wrangler secret put ORIGIN_ACCESS_CLIENT_ID
   npx wrangler secret put ORIGIN_ACCESS_CLIENT_SECRET
   npm run deploy
   ```

   Enter `https://origin.cravelens.nishithp.page` for `TUNNEL_ORIGIN`.
   Use the Access service-token credentials for the other two secrets.

5. On the Pi, set the backend's public URL without a trailing slash:

   ```env
   PUBLIC_BASE_URL=https://cravelens.nishithp.page
   ```

6. Retain this exact Swiggy callback allowlist entry:

   ```text
   https://cravelens.nishithp.page/api/swiggy/auth/callback
   ```

## Validation

Before deployment, run `npm test` in `apps/edge-proxy` to check webhook forwarding, header preservation and path isolation. `npx wrangler deploy --dry-run` validates the Worker bundle without publishing.

After deployment, the public health endpoint should be served by the Pi rather
than GitHub Pages:

```bash
curl --fail --silent --show-error https://cravelens.nishithp.page/health
```

Then open the extension popup. Its `/api/swiggy/auth/start` request will reach
the Node server, which returns the Swiggy authorization URL; only then does the
extension open the Swiggy sign-in tab.

Do not expose MongoDB, Redis, or port 8787 to the public Internet. The Worker
is the only permitted public route to the Tunnel origin; Cloudflare Access
rejects direct traffic to that origin.

## Admin console on the same hostname

`/admin` and `/admin/*` are forwarded by the `cravelens.nishithp.page/admin*` Worker route. `/api/admin/*` uses the existing `/api/*` route. The UI comes from the Node server, not GitHub Pages. The Worker verifies the human `Cf-Access-Jwt-Assertion` and allowlisted email before forwarding; the API verifies it again via the Worker-supplied `X-CraveLens-Admin-Assertion`. This separate header preserves the admin identity while the origin's Access application authenticates the Worker service token. Client-supplied copies are always discarded. Public API behavior stays unchanged.

1. In Zero Trust, create a self-hosted admin Access application with both public destinations `cravelens.nishithp.page/admin` and `cravelens.nishithp.page/api/admin` (subpaths included), using the same application AUD. Limit the Allow policy to your admin email(s); do not use Everyone, Bypass or service-token access for admin routes.
2. Set `ADMIN_ACCESS_TEAM_DOMAIN` (HTTPS team domain), `ADMIN_ACCESS_AUDIENCE` (admin AUD) and `ADMIN_EMAILS` (comma-separated humans) in the server environment.
3. Set the same values on the Worker using `npx wrangler secret put ADMIN_ACCESS_TEAM_DOMAIN`, `npx wrangler secret put ADMIN_ACCESS_AUDIENCE`, and `npx wrangler secret put ADMIN_EMAILS`.
4. Deploy the server containing `apps/server/admin/` and redeploy the Worker after reviewing the diff. The configuration disables both `workers.dev` and preview URLs. No policy is created by Wrangler here.
5. Verify signed-out and non-admin visitors cannot retrieve UI assets or JSON. Verify an allowed admin can navigate to `/admin/`, refresh data and export aggregates. Test direct-origin and forged-header attempts. Cloudflare sign-in requires actual configured policies; local tests do not establish live policy protection.

Missing admin configuration returns 503; invalid or unauthorized assertions return 403. No public admin fallback exists. JWT verification rejects the Tunnel service-token audience for admin access. The existing origin service-token policy must stay in place. See the main README for analytics sources, retention, MongoDB persistence and Langfuse sampling limits.

### Admin assets, Access sessions and CSP troubleshooting

The public admin application and the Tunnel origin use different Access audiences. Admin requests forward the verified human assertion in `X-CraveLens-Admin-Assertion` and authenticate the Tunnel with the Worker service-token headers. The proxy removes browser cookies before this origin hop and strips origin `Set-Cookie` responses so an origin token cannot overwrite the public human Access session. An origin Access login redirect returns a diagnostic HTTP 503 instead of redirecting scripts, styles or images into a login page. Admin responses use `no-store, no-transform`; scripts opt out of Rocket Loader. The strict same-origin CSP remains in place.

If the HTML loads but styles/scripts redirect to `*.cloudflareaccess.com`, inspect the failing request's redirect chain. Keep `/admin` (including subpaths) and `/api/admin` in the same human Access application/AUD; avoid narrower applications overriding asset paths. Disable the Cookie Path Attribute for that multi-path application so its session covers both paths. Keep the origin application restricted to a Service Auth policy for the configured Worker token. After correcting policies and deploying this patch, sign out and sign in again to replace any incorrect Access cookie. Do not add Access login domains or `unsafe-inline` to the admin CSP to hide authentication failures.

Inline scripts are not present in the admin source. If they appear in the served HTML, check Cloudflare tag injection (Zaraz/Google tag gateway), Rocket Loader and browser extensions. Exclude `/admin` and `/admin/*` from tag injection and content optimization; do not disable Access or weaken the admin CSP. A signed-in admin should receive same-origin assets with HTTP 200, their proper MIME types and no login redirects. Tests do not verify deployed Cloudflare policies.
