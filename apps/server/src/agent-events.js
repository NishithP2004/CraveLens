import { Server } from "socket.io";

let io;
const STREAM_ID = /^[a-f0-9-]{36}$/i;

export function attachAgentEventServer(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: true, credentials: false },
    transports: ["websocket"],
  });
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
  return io;
}

export function publishAgentEvent(streamId, event, details = {}) {
  if (!io || !STREAM_ID.test(String(streamId || ""))) return;
  io.to(room(streamId)).emit("agent:event", { event, details, timestamp: Date.now() });
}

function room(streamId) { return `agent:${streamId}`; }
