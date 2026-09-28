# CraveLens Cloudflare edge proxy

This Worker keeps the landing page on GitHub Pages while proxying only the
Node server routes through a Cloudflare Tunnel on the Raspberry Pi.

```text
https://cravelens.nishithp.page/             -> GitHub Pages
https://cravelens.nishithp.page/api/*        -> Worker -> Tunnel -> Pi server
https://cravelens.nishithp.page/socket.io/*  -> Worker -> Tunnel -> Pi server
```

`/socket.io/*` is essential: the extension uses Socket.IO over WebSocket for
agent events and the `/inference` namespace. The Socket.IO namespace is carried
inside the `/socket.io/*` handshake, so it does not need a separate `/inference`
route.

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
