// Replay a recorded Codex turn THROUGH the real bridge HTTP server — keepalive,
// abort wiring, toProxyRequest, the transport and the SSE pipe — to the real
// upstream. Exercises every segment end to end.
//
// This consumes real Grok quota.
import fs from "node:fs";
import { once } from "node:events";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createBridgeServer } from "../../src/bridge.mjs";

// A rollout to replay. Pass one as the first argument, or drop a copy next to
// this script. Codex writes them to ~/.codex/sessions/<yyyy>/<mm>/<dd>/.
const F = process.argv[2];
if (!F) {
  console.error("usage: <script> <path-to-rollout.jsonl> [mode]");
  console.error("  rollouts live under ~/.codex/sessions/<yyyy>/<mm>/<dd>/");
  process.exit(2);
}
const rows = fs.readFileSync(F, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const items = rows.filter((r) => r.type === "response_item").map((r) => r.payload);
const ws = rows.find((r) => r.type === "world_state");

const TOOLS = [
  { type: "function", name: "exec_command", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } }, workdir: { type: "string" } }, required: ["command"] } },
  { type: "custom", name: "apply_patch", description: "Apply a freeform patch" },
  { type: "namespace", name: "mcp__memory", tools: [
    { type: "function", name: "read_graph", description: "Read the memory graph", parameters: { type: "object", properties: {} } },
    { type: "function", name: "search_nodes", description: "Search nodes", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }]},
  { type: "namespace", name: "mcp__sequential_thinking", tools: [
    { type: "function", name: "sequentialthinking", description: "Sequential thinking", parameters: { type: "object", properties: { thought: { type: "string" }, nextThoughtNeeded: { type: "boolean" }, thoughtNumber: { type: "number" }, totalThoughts: { type: "number" } }, required: ["thought", "nextThoughtNeeded", "thoughtNumber", "totalThoughts"] } }]},
];

const token = randomBytes(16).toString("hex");
const server = createBridgeServer({ token });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

const body = JSON.stringify({
  model: "grok-4.6",
  instructions: "You are Grok 4.6 by xAI, running as the Codex model. Use the tools provided by Codex and respect its permissions.".repeat(60),
  input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "<world_state>\n" + JSON.stringify(ws.payload.state) + "\n</world_state>" }] }, ...items],
  tools: TOOLS,
  reasoning: { effort: "xhigh" },
  tool_choice: "auto",
  parallel_tool_calls: true,
  prompt_cache_key: "diag-through-bridge",
  stream: true,
});
console.log(`request bytes to bridge: ${Buffer.byteLength(body)}`);

const t0 = Date.now();
const mark = () => ((Date.now() - t0) / 1000).toFixed(2) + "s";
const req = http.request({ host: "127.0.0.1", port, path: "/v1/responses", method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "thread-id": "diag-thread", "content-length": Buffer.byteLength(body) } });
req.on("response", (res) => {
  console.log(`[${mark()}] bridge status=${res.statusCode}`);
  let events = 0, keepalives = 0, failed = null, completed = false, buf = "";
  res.on("data", (c) => {
    buf += c;
    const parts = buf.split("\n\n"); buf = parts.pop();
    for (const p of parts) {
      if (p.startsWith(": keepalive")) { keepalives++; console.log(`[${mark()}] keepalive #${keepalives}`); continue; }
      events++;
      const m = p.match(/^event: (\S+)/m);
      if (m && /created|failed|completed|incomplete|error/.test(m[1])) console.log(`[${mark()}] ${m[1]}`);
      if (m && m[1] === "response.failed") { failed = p.slice(0, 400); }
      if (m && m[1] === "response.completed") completed = true;
    }
  });
  res.on("end", () => {
    console.log(`[${mark()}] STREAM END events=${events} keepalives=${keepalives} completed=${completed}`);
    if (failed) console.log("FAILED EVENT:\n" + failed);
    server.close(); process.exit(0);
  });
  res.on("error", (e) => { console.log(`[${mark()}] client res error ${e.code} ${e.message}`); });
});
req.on("error", (e) => { console.log(`[${mark()}] client req error ${e.code} ${e.message}`); server.close(); process.exit(1); });
req.end(body);
