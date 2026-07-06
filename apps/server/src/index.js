import { app } from "./app.js";
import { config } from "./config.js";
import { connectStore } from "./store.js";
import { createServer } from "node:http";
import { attachAgentEventServer } from "./agent-events.js";

const store = await connectStore();
const server = createServer(app);
attachAgentEventServer(server);
server.listen(config.port, () => console.log(`CraveLens API on http://localhost:${config.port} (${store.mode}, Socket.IO ready)`));
