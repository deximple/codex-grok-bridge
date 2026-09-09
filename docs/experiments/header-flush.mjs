// Does res.writeHead() alone put the status line on the wire, or does Node wait
// for the first body write? This decides whether a slow upstream leaves the
// Codex client with a completely silent socket for up to 10s (until keepalive).
import http from "node:http";
import { once } from "node:events";

for (const [label, flush] of [["writeHead only", false], ["writeHead + flushHeaders", true]]) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (flush) res.flushHeaders();
      setTimeout(() => { res.write("event: x\ndata: {}\n\n"); res.end(); }, 3000);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const t0 = Date.now();
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/" });
    req.on("response", (res) => {
      console.log(`${label.padEnd(26)} headers at ${((Date.now() - t0) / 1000).toFixed(2)}s`);
      res.resume();
      res.on("end", resolve);
    });
    req.end("{}");
  });
  server.close();
}
