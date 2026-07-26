import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";
import { getSwiggySession } from "./swiggy-auth.js";

export async function connectSwiggyFood(sessionId) {
  const sdkSession = sessionId && await getSwiggySession(sessionId);
  if (sdkSession) return wrapClient(sdkSession.client, false);
  const accessToken = config.swiggyMcpAccessToken;
  if (!accessToken) throw new Error("Swiggy is not connected. Complete OAuth in the CraveLens extension.");
  const client = new Client({ name: "cravelens", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.swiggyFoodMcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  try {
    await client.connect(transport);
  } catch (error) {
    if (isAuthError(error)) throw new Error("Swiggy authorization expired. Run the OAuth 2.1 PKCE flow again.");
    throw error;
  }
  return wrapClient(client, true);
}

function wrapClient(client, closeWhenDone) {
  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools || [];
    },
    async call(name, args = {}) {
      try {
        const result = await client.callTool({ name, arguments: args });
        if (name === "fetch_food_coupons") logCouponDiagnostic("mcp_raw", result);
        if (result.isError) throw new Error(readError(result));
        const value = unwrap(result);
        if (name === "fetch_food_coupons") logCouponDiagnostic("unwrapped", value);
        return value;
      } catch (error) {
        if (isAuthError(error)) throw new Error("Swiggy authorization expired. Run the OAuth 2.1 PKCE flow again.");
        throw error;
      }
    },
    close: () => closeWhenDone ? client.close() : Promise.resolve(),
  };
}

function logCouponDiagnostic(stage, value) {
  console.log(`[swiggy:coupon] ${stage}\n${safeDiagnosticJson(value)}`);
}

function safeDiagnosticJson(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, child) => {
      if (/authorization|access.?token|refresh.?token|cookie|session/i.test(key)) return "[redacted]";
      if (child && typeof child === "object") {
        if (seen.has(child)) return "[circular]";
        seen.add(child);
      }
      return child;
    }, 2);
  } catch {
    return String(value);
  }
}

export function unwrap(result) {
  if (hasContent(result.structuredContent)) {
    const value = result.structuredContent;
    return value.success === false ? (() => { throw new Error(value.error?.message || "Swiggy tool failed"); })() : value.data ?? value;
  }
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) return result;
  try {
    const value = JSON.parse(text);
    if (value.success === false) throw new Error(value.error?.message || "Swiggy tool failed");
    return value.data ?? value;
  } catch (error) {
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}

function hasContent(value) {
  if (!value || typeof value !== "object") return false;
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}

function readError(result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  return text || "Swiggy MCP tool failed";
}

function isAuthError(error) {
  const value = `${error?.code || ""} ${error?.message || error}`;
  return /401|419|-32001|unauthori[sz]ed|session revoked/i.test(value);
}
