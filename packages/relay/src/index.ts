import { createRelayServer } from "./server";

const port = Number(process.env.PORT ?? 8787);
const server = createRelayServer(port);

console.log(`[agentlink-relay] listening on :${server.port}  (ws path: /ws, health: /health)`);
