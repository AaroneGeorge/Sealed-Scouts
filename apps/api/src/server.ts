import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const handle = createApp(cfg);
const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("request failed", e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.listen(cfg.port, cfg.host, () => {
  console.log(`sealed-scouts api on http://${cfg.host}:${cfg.port}  feed=${cfg.feedDir}  evidence=${cfg.evidenceDir}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));
