import test from "node:test";
import assert from "node:assert/strict";
import proxy from "../src/index.js";

const env = {
  TUNNEL_ORIGIN: "https://origin.cravelens.nishithp.page",
  ORIGIN_ACCESS_CLIENT_ID: "test-service-id",
  ORIGIN_ACCESS_CLIENT_SECRET: "test-service-secret",
};

test("Telegram webhook forwards body and secret while replacing origin Access credentials", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  let options;
  globalThis.fetch = async (request, init) => {
    forwarded = request;
    options = init;
    return new Response(null, { status: 204 });
  };
  try {
    const body = JSON.stringify({ update_id: 1 });
    const request = new Request("https://cravelens.nishithp.page/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
        "cf-access-client-id": "untrusted-client-id",
        "cf-access-client-secret": "untrusted-client-secret",
      },
      body,
    });
    const response = await proxy.fetch(request, env);
    assert.equal(response.status, 204);
    assert.equal(forwarded.url, "https://origin.cravelens.nishithp.page/telegram/webhook");
    assert.equal(forwarded.method, "POST");
    assert.equal(await forwarded.text(), body);
    assert.equal(forwarded.headers.get("x-telegram-bot-api-secret-token"), "test-webhook-secret");
    assert.equal(forwarded.headers.get("cf-access-client-id"), env.ORIGIN_ACCESS_CLIENT_ID);
    assert.equal(forwarded.headers.get("cf-access-client-secret"), env.ORIGIN_ACCESS_CLIENT_SECRET);
    assert.equal(options.redirect, "manual");
  } finally { globalThis.fetch = originalFetch; }
});

test("Telegram webhook forwarding is limited to the exact configured path", async () => {
  for (const path of ["/telegram/", "/telegram/webhook/", "/telegram/other", "/guide/"]) {
    const response = await proxy.fetch(new Request(`https://cravelens.nishithp.page${path}`), env);
    assert.equal(response.status, 404, path);
  }
});

test("Telegram webhook requires the configured protected origin", async () => {
  const request = new Request("https://cravelens.nishithp.page/telegram/webhook");
  assert.equal((await proxy.fetch(request, {})).status, 503);
  assert.equal((await proxy.fetch(request, { ...env, ORIGIN_ACCESS_CLIENT_SECRET: "" })).status, 503);
});

test("admin UI and API fail closed before upstream forwarding", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded = false;
  globalThis.fetch = async () => {forwarded=true;return new Response('private');};
  try {
    for (const path of ['/admin','/admin/','/admin/style.css','/api/admin','/api/admin/summary']) {
      const response=await proxy.fetch(new Request(`https://cravelens.nishithp.page${path}`,{headers:{'X-CraveLens-Admin-Assertion':'forged','Cf-Access-Authenticated-User-Email':'admin@example.com'}}),env);
      assert.equal(response.status,503);
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    assert.equal(forwarded,false);
    const response=await proxy.fetch(new Request('https://cravelens.nishithp.page/admin/',{headers:{'Cf-Access-Jwt-Assertion':'forged'}}),{...env,ADMIN_ACCESS_TEAM_DOMAIN:'https://example.cloudflareaccess.com',ADMIN_ACCESS_AUDIENCE:'admin',ADMIN_EMAILS:'admin@example.com'});
    assert.equal(response.status,403);
    assert.equal(forwarded,false);
  } finally {globalThis.fetch=originalFetch;}
});

test("verified admin identity is preserved separately from the origin service token", async () => {
  const {generateKeyPair,exportJWK,SignJWT}=await import('jose');
  const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='admin-test';
  const settings={...env,ADMIN_ACCESS_TEAM_DOMAIN:'https://admin-test.cloudflareaccess.com',ADMIN_ACCESS_AUDIENCE:'admin-aud',ADMIN_EMAILS:'admin@example.com'};
  const token=await new SignJWT({email:'admin@example.com'}).setProtectedHeader({alg:'RS256',kid:'admin-test'}).setIssuer(settings.ADMIN_ACCESS_TEAM_DOMAIN).setAudience(settings.ADMIN_ACCESS_AUDIENCE).setSubject('admin-human').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const originalFetch=globalThis.fetch;let forwarded;
  globalThis.fetch=async(request)=>{
    const url=new URL(request.url || request.toString());
    if(url.pathname==='/cdn-cgi/access/certs')return new Response(JSON.stringify({keys:[jwk]}),{headers:{'content-type':'application/json'}});
    forwarded=request;return new Response('private dashboard');
  };
  try{
    const response=await proxy.fetch(new Request('https://cravelens.nishithp.page/admin/',{headers:{'Cf-Access-Jwt-Assertion':token,'X-CraveLens-Admin-Assertion':'attacker','Cf-Access-Client-Id':'attacker'}}),settings);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(forwarded.headers.get('X-CraveLens-Admin-Assertion'),token);
    assert.equal(forwarded.headers.get('Cf-Access-Jwt-Assertion'),null);
    assert.equal(forwarded.headers.get('Cf-Access-Client-Id'),env.ORIGIN_ACCESS_CLIENT_ID);
    assert.equal(new URL(forwarded.url).pathname,'/admin/');
  }finally{globalThis.fetch=originalFetch;}
});
