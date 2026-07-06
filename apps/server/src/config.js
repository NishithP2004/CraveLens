import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// npm workspace scripts execute with apps/server as their working directory.
// Resolve the repository-level environment file from this module so config is
// identical whether the server is launched from the root or the workspace.
dotenv.config({ path: new URL("../../../.env", import.meta.url) });

const agentModelProvider = (process.env.AGENT_MODEL_PROVIDER || process.env.MODEL_PROVIDER || "gemini").toLowerCase();

export const config = {
  port: Number(process.env.PORT || 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`,
  mongoUri: process.env.MONGODB_URI || "",
  mongoDatabase: process.env.MONGODB_DATABASE || "cravelens",
  localModelDirectory: process.env.LOCAL_MODEL_DIRECTORY || fileURLToPath(new URL("../models", import.meta.url)),
  agentModelProvider,
  agentModelName: process.env.AGENT_MODEL_NAME || process.env.MODEL_NAME || "gemini-2.5-flash",
  agentModelApiKey: process.env.AGENT_MODEL_API_KEY || (agentModelProvider === "openai" ? process.env.OPENAI_API_KEY || process.env.MODEL_API_KEY : process.env.GEMINI_API_KEY) || "",
  agentModelBaseUrl: process.env.AGENT_MODEL_BASE_URL || process.env.MODEL_BASE_URL || "https://api.openai.com/v1",
  swiggyFoodMcpUrl: process.env.SWIGGY_FOOD_MCP_URL || "https://mcp.swiggy.com/food",
  swiggyMcpAccessToken: process.env.SWIGGY_MCP_ACCESS_TOKEN || "",
};
