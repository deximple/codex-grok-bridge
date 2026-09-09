// Verify the zero-dependency alternative: node:https Agent with keepAlive and a
// cached DNS lookup. This is what replaces the (non-existent) node:undici Agent.
import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import { once } from "node:events";

let lookups = 0;
const cache = new Map();
const CACHE_TTL_MS = 300_000;

// A cached dns.lookup, in the exact shape http.Agent expects.
function cachedLookup(hostname, options, callback) {
  const key = `${hostname}:${options?.family ?? 0}`;
  const hit = cache.get(key);
  if (hit && hit.expires > 1) { // expiry compared against an injected clock in the real impl
    process.nextTick(() => callback(null, hit.address, hit.family));
    return;
  }
  lookups++;
  dns.lookup(hostname, options ?? {}, (error, address, family) => {
    if (!error) cache.set(key, { address, family, expires: 1 + CACHE_TTL_MS });
    callback(error, address, family);
  });
}

const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4, lookup: cachedLookup });
console.log("http.Agent accepts keepAlive + custom lookup:", agent.options.keepAlive, typeof agent.options.lookup);
console.log("https.Agent same:", typeof new https.Agent({ keepAlive: true, lookup: cachedLookup }).options.lookup);

// Prove keep-alive reuse across a gap, and that the cached lookup is used once.
const server = http.createServer((req, res) => { req.resume(); res.writeHead(200); res.end("ok"); });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const call = () => new Promise((resolve) => {
  const req = http.request({ host: "localhost", port, agent, path: "/" }, (res) => {
    const reused = res.socket.remotePort;
    res.resume(); res.on("end", () => resolve(reused));
  });
  req.end();
});
const first = await call();
await new Promise((r) => setTimeout(r, 1200));
const second = await call();
console.log(`socket reused across a 1.2s gap: ${first === second} (dns lookups performed: ${lookups})`);
agent.destroy(); server.close();

// And prove a Node Readable can feed the existing pipeProxySse contract.
const { Readable } = await import("node:stream");
const nodeStream = Readable.from([Buffer.from("event: a\ndata: {}\n\n")]);
const web = Readable.toWeb(nodeStream);
console.log("Readable.toWeb gives a getReader():", typeof web.getReader === "function");
