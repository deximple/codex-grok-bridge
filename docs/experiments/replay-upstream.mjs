// Replay a recorded Codex turn against the real Grok proxy, with full timing
// and error-chain instrumentation. Same endpoint and login the bridge uses, and
// the same payload the desktop already sent — nothing new leaves the machine.
//
// Modes: full-xhigh (items only) · xxl (items + world_state) · burst (12 calls
// on one conv id, the shape of a real multi-call turn).
//
// This consumes real Grok quota.
import fs from "node:fs";
import { readGrokBearerToken } from "../../src/auth.mjs";
import { openProxyStream } from "../../src/proxy.mjs";
import { toProxyRequest } from "../../src/tools.mjs";

// A rollout to replay. Pass one as the first argument, or drop a copy next to
// this script. Codex writes them to ~/.codex/sessions/<yyyy>/<mm>/<dd>/.
const F = process.argv[2];
if (!F) {
  console.error("usage: <script> <path-to-rollout.jsonl> [mode]");
  console.error("  rollouts live under ~/.codex/sessions/<yyyy>/<mm>/<dd>/");
  process.exit(2);
}
const rows = fs.readFileSync(F, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const allItems = rows.filter((r) => r.type === "response_item").map((r) => r.payload);

const TOOLS = [
  { type: "function", name: "exec_command", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } }, workdir: { type: "string" }, timeout_ms: { type: "number" } }, required: ["command"] } },
  { type: "function", name: "apply_patch", description: "Apply a patch", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } },
  { type: "namespace", name: "mcp__memory", tools: [
    { type: "function", name: "read_graph", description: "Read the memory graph", parameters: { type: "object", properties: {} } },
    { type: "function", name: "search_nodes", description: "Search memory nodes", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  ]},
  { type: "namespace", name: "mcp__sequential_thinking", tools: [
    { type: "function", name: "sequentialthinking", description: "Sequential thinking", parameters: { type: "object", properties: { thought: { type: "string" }, nextThoughtNeeded: { type: "boolean" }, thoughtNumber: { type: "number" }, totalThoughts: { type: "number" } }, required: ["thought", "nextThoughtNeeded", "thoughtNumber", "totalThoughts"] } },
  ]},
];

const session = readGrokBearerToken();

async function run(label, { items, effort }) {
  const body = { model: "grok-4.6", input: items, tools: TOOLS, reasoning: { effort }, prompt_cache_key: "diag-" + label };
  const { request } = toProxyRequest(body);
  const bytes = Buffer.byteLength(JSON.stringify(request));
  const t0 = Date.now();
  const mark = () => ((Date.now() - t0) / 1000).toFixed(2) + "s";
  console.log(`\n=== ${label} | items=${request.input.length} bodyBytes=${bytes} effort=${effort} ===`);
  let firstByte = null, events = 0, chars = 0;
  try {
    const proxy = await openProxyStream({ token: session.token, userId: session.userId, body: request, convId: "diag-" + label });
    console.log(`  headers at ${mark()} status=${proxy.status}`);
    const reader = proxy.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByte === null) { firstByte = mark(); console.log(`  FIRST BYTE at ${firstByte}`); }
      const text = dec.decode(value, { stream: true });
      chars += text.length;
      for (const line of text.split("\n")) if (line.startsWith("event:")) { events++; if (events <= 4 || events % 50 === 0) console.log(`    [${mark()}] ${line.trim()}`); }
    }
    console.log(`  STREAM ENDED CLEANLY at ${mark()} events=${events} chars=${chars}`);
  } catch (error) {
    console.log(`  *** THREW at ${mark()} (firstByte=${firstByte ?? "none"} events=${events})`);
    let e = error, d = 0;
    while (e && d < 5) { console.log(`      ${"  ".repeat(d)}${e.constructor?.name} name=${e.name} code=${e.code ?? "-"} msg=${String(e.message).slice(0, 160)}`); e = e.cause; d++; }
  }
}

const which = process.argv[3] ?? "full-xhigh";
if (which === "full-xhigh") await run("full-xhigh", { items: allItems, effort: "xhigh" });
if (which === "full-low") await run("full-low", { items: allItems, effort: "low" });
if (which === "small-xhigh") await run("small-xhigh", { items: allItems.slice(0, 3).concat(allItems.slice(-6)), effort: "xhigh" });

if (which === "xxl") {
  const rowsAll = fs.readFileSync(F, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ws = rowsAll.find((r) => r.type === "world_state");
  const wsText = JSON.stringify(ws.payload.state);
  const items = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<world_state>\n" + wsText + "\n</world_state>" }] },
    ...allItems,
  ];
  await run("xxl", { items, effort: "xhigh" });
}

if (which === "burst") {
  // Mimic a real desktop turn: same conv-id, full-size payload, back-to-back calls
  // separated by a short "tool execution" gap, over the SAME undici connection pool.
  const rowsAll = fs.readFileSync(F, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ws = rowsAll.find((r) => r.type === "world_state");
  const base = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<world_state>\n" + JSON.stringify(ws.payload.state) + "\n</world_state>" }] },
    ...allItems,
  ];
  const conv = "diag-burst-fixed";
  for (let n = 1; n <= 12; n++) {
    const body = { model: "grok-4.6", input: base, tools: TOOLS, reasoning: { effort: "xhigh" }, prompt_cache_key: conv };
    const { request } = toProxyRequest(body);
    const t0 = Date.now();
    const mk = () => ((Date.now() - t0) / 1000).toFixed(2);
    let firstByte = null, events = 0;
    try {
      const proxy = await openProxyStream({ token: session.token, userId: session.userId, body: request, convId: conv, sessionId: conv });
      const reader = proxy.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByte === null) firstByte = mk();
        for (const line of dec.decode(value, { stream: true }).split("\n")) if (line.startsWith("event:")) events++;
      }
      console.log(`call ${String(n).padStart(2)}  OK      total=${mk()}s firstByte=${firstByte}s events=${events}`);
    } catch (error) {
      console.log(`call ${String(n).padStart(2)}  FAILED  at=${mk()}s firstByte=${firstByte ?? "none"} events=${events}`);
      let e = error, d = 0;
      while (e && d < 4) { console.log(`        ${"  ".repeat(d)}${e.constructor?.name} name=${e.name} code=${e.code ?? "-"} msg=${String(e.message).slice(0, 140)}`); e = e.cause; d++; }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
