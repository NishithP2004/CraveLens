import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { authenticateDeviceToken } from "./device-auth.js";
import { createRedisDuplicate } from "./redis.js";
import { inferenceBroker } from "./inference-broker.js";

let io;
const STREAM_ID = /^[a-f0-9-]{36}$/i;

export async function attachAgentEventServer(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: true, credentials: false },
    transports: ["websocket"],
  });
  const [publisher, subscriber] = await Promise.all([createRedisDuplicate(), createRedisDuplicate()]);
  io.adapter(createAdapter(publisher, subscriber));
  io.on("connection", (socket) => {
    socket.on("agent:subscribe", (streamId, acknowledge) => {
      if (!STREAM_ID.test(String(streamId || ""))) {
        acknowledge?.({ ok: false, error: "Invalid event stream ID" });
        return;
      }
      socket.join(room(streamId));
      acknowledge?.({ ok: true });
    });
  });
  const inference = io.of("/inference");
  inference.use(async (socket, next) => {
    try { socket.data.deviceId = await authenticateDeviceToken(String(socket.handshake.auth?.token || "")); next(); }
    catch (error) { next(error); }
  });
  inferenceBroker.attach(inference);
  return io;
}

export function publishAgentEvent(streamId, event, details = {}) {
  if (!io || !STREAM_ID.test(String(streamId || ""))) return;
  io.to(room(streamId)).emit("agent:event", { event, details, timestamp: Date.now() });
}

function room(streamId) { return `agent:${streamId}`; }
