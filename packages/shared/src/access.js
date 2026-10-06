import { createRemoteJWKSet, jwtVerify } from "jose";

export function createAdminAccessVerifier({ teamDomain, audience, emails }, keySet) {
  let issuer;
  try {
    const url = new URL(teamDomain);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error();
    issuer = url.origin;
  } catch { throw Object.assign(new Error("Admin Access team domain is not configured correctly"), {statusCode: 503}); }
  const allowed = String(emails || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!audience || !allowed.length) throw Object.assign(new Error("Admin Access audience and email allowlist are required"), {statusCode: 503});
  const keys = keySet || createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
  return async (token) => {
    try {
      if (!token) throw Error();
      const {payload} = await jwtVerify(token, keys, {issuer, audience, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub"]});
      if (typeof payload.email !== "string" || !allowed.includes(payload.email.toLowerCase())) throw Error();
      return payload;
    } catch { throw Object.assign(new Error("Administrator Access authentication required"), {statusCode: 403}); }
  };
}
