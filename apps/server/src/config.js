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
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  swiggyFoodMcpUrl: process.env.SWIGGY_FOOD_MCP_URL || "https://mcp.swiggy.com/food",
  swiggyMcpAccessToken: process.env.SWIGGY_MCP_ACCESS_TOKEN || "",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379/0",
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || "",
  deviceSessionSigningKey: process.env.DEVICE_SESSION_SIGNING_KEY || "",
  localInferenceTimeoutMs: Number(process.env.LOCAL_INFERENCE_TIMEOUT_MS || 120_000),
  localInferenceQueueLimit: Number(process.env.LOCAL_INFERENCE_QUEUE_LIMIT || 4),
  localTraceContent: process.env.LANGFUSE_LOCAL_CONTENT === "true",
};
