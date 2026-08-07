import { app } from "./app.js";
import { config } from "./config.js";
import { connectStore } from "./store.js";
import { closeRedis, connectRedis } from "./redis.js";
import { createServer } from "node:http";
import { attachAgentEventServer } from "./agent-events.js";
import { initializeLangfuse, shutdownLangfuse } from "./langfuse.js";

const langfuse = initializeLangfuse();
const [store] = await Promise.all([connectStore(), connectRedis()]);
const server = createServer(app);
await attachAgentEventServer(server);
server.listen(config.port, () => console.log(`CraveLens API on http://localhost:${config.port} (${store.mode}, Socket.IO ready; Langfuse ${langfuse.enabled ? "enabled" : "disabled"})`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await shutdownLangfuse();
    await closeRedis();
    server.close(() => process.exit(0));
  });
}
