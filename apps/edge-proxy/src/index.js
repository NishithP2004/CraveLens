import { createAdminAccessVerifier } from "@cravelens/shared/access";

let adminVerifier;
let adminSettings;

const PROXIED_PATHS = ["/admin/", "/api/", "/socket.io/", "/models/"];
const PROXIED_EXACT_PATHS = new Set(["/health", "/telegram/webhook", "/admin"]);

function isProxiedPath(pathname) {
  return PROXIED_EXACT_PATHS.has(pathname) || PROXIED_PATHS.some((prefix) => pathname.startsWith(prefix));
}

function configurationError(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    if (!isProxiedPath(requestUrl.pathname)) return new Response("Not found", { status: 404 });

    const admin = requestUrl.pathname === "/admin" || requestUrl.pathname.startsWith("/admin/") || requestUrl.pathname === "/api/admin" || requestUrl.pathname.startsWith("/api/admin/");
    let adminAssertion;
    if (admin) {
      try {
        const settings = {teamDomain: env.ADMIN_ACCESS_TEAM_DOMAIN, audience: env.ADMIN_ACCESS_AUDIENCE, emails: env.ADMIN_EMAILS};
        const signature = JSON.stringify(settings);
        if (signature !== adminSettings) { adminVerifier = createAdminAccessVerifier(settings); adminSettings = signature; }
        adminAssertion = request.headers.get("Cf-Access-Jwt-Assertion");
        await adminVerifier(adminAssertion);
      } catch (error) { return new Response(JSON.stringify({error: error.message}), {status: error.statusCode || 403, headers: {"content-type": "application/json", "cache-control": "no-store"}}); }
    }

    if (!env.TUNNEL_ORIGIN) {
      return configurationError("The CraveLens Tunnel origin is not configured.");
    }
    if (!env.ORIGIN_ACCESS_CLIENT_ID || !env.ORIGIN_ACCESS_CLIENT_SECRET) {
      return configurationError("The CraveLens origin Access service token is not configured.");
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(env.TUNNEL_ORIGIN);
    } catch {
      return configurationError("TUNNEL_ORIGIN must be an absolute HTTPS URL.");
    }
    if (upstreamUrl.protocol !== "https:") {
      return configurationError("TUNNEL_ORIGIN must use HTTPS.");
    }

    upstreamUrl.pathname = requestUrl.pathname;
    upstreamUrl.search = requestUrl.search;

    // Constructing a Request from the original preserves its method, streaming body,
    // and WebSocket upgrade. The route list ensures ordinary landing-page traffic
    // continues to GitHub Pages instead of reaching this Worker.
    const upstreamRequest = new Request(upstreamUrl, request);
    upstreamRequest.headers.delete("host");
    upstreamRequest.headers.delete("X-CraveLens-Admin-Assertion");
    upstreamRequest.headers.delete("Cf-Access-Jwt-Assertion");
    upstreamRequest.headers.delete("Cf-Access-Authenticated-User-Email");
    if (adminAssertion) upstreamRequest.headers.set("X-CraveLens-Admin-Assertion", adminAssertion);
    upstreamRequest.headers.delete("cf-access-client-id");
    upstreamRequest.headers.delete("cf-access-client-secret");
    upstreamRequest.headers.set("CF-Access-Client-Id", env.ORIGIN_ACCESS_CLIENT_ID);
    upstreamRequest.headers.set("CF-Access-Client-Secret", env.ORIGIN_ACCESS_CLIENT_SECRET);
    upstreamRequest.headers.set("X-Forwarded-Host", requestUrl.host);
    upstreamRequest.headers.set("X-Forwarded-Proto", requestUrl.protocol.replace(":", ""));

    const response = await fetch(upstreamRequest, { redirect: "manual" });
    if (!admin) return response;
    const protectedResponse = new Response(response.body, response);
    protectedResponse.headers.set("Cache-Control", "no-store");
    protectedResponse.headers.set("X-Robots-Tag", "noindex, nofollow");
    return protectedResponse;
  },
};
