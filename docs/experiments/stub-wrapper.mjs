#!/usr/bin/env node
// codex-wrapper.mjs with the upstream replaced by a stub that stalls N seconds
// before emitting anything. Everything else is the real code path.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { startRuntime } from "../../src/runtime.mjs";
import { Router } from "../../src/router.mjs";

const STALL_MS = Number(process.env.STUB_STALL_MS ?? 40000);
const proxyFetch = async () => {
  process.stderr.write(`[stub] upstream request received, stalling ${STALL_MS}ms\n`);
  const stream = new ReadableStream({
    start(c) {
      setTimeout(() => {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stub"}}\n\n'));
        c.enqueue(enc.encode('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","id":"m1","role":"assistant","content":[{"type":"output_text","text":"PONG"}]}}\n\n'));
        c.enqueue(enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stub","usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}\n\n'));
        c.close();
        process.stderr.write(`[stub] emitted after ${STALL_MS}ms\n`);
      }, STALL_MS);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const binary = "/Applications/Codex.app/Contents/Resources/codex";
const args = process.argv.slice(2);
import { MODEL_INFO } from "../../src/bridge.mjs";
if (process.env.CTX_WINDOW) MODEL_INFO.context_window = Number(process.env.CTX_WINDOW);
const runtime = await startRuntime({ proxyFetch, grokHome: "/tmp/grok-bridge-diag/fakehome" });
const router = new Router(runtime.catalogPath);
const child = spawn(binary, [...args, ...runtime.args], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CODEX_GROK_BRIDGE_TOKEN: runtime.token },
});
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const pending = new Map(); const timedOut = new Set(); const queues = new Map();
const write = (m) => child.stdin.write(JSON.stringify(router.outgoing(m)) + "\n");
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = `grok-bridge-${randomUUID()}`;
  const timer = setTimeout(() => { pending.delete(id); router.pending.delete(id); timedOut.add(id); reject(new Error(`Provider transition timed out: ${method}`)); }, 30000);
  pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
  write({ id, method, params });
});
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const threadId = m.method && m.params?.threadId;
  if (!threadId) { try { write(m); } catch {} return; }
  const next = (queues.get(threadId) ?? Promise.resolve())
    .then(async () => { await router.prepare(m, rpc); write(m); })
    .catch((e) => { if (m.id !== undefined) send({ id: m.id, error: { code: -32600, message: e.message } }); })
    .finally(() => { if (queues.get(threadId) === next) queues.delete(threadId); });
  queues.set(threadId, next);
});
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const m = router.incoming(JSON.parse(line));
    if (!m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (!m.method && timedOut.delete(m.id)) {}
    else send(m);
  } catch {}
});
input.on("close", () => child.stdin.end());
child.on("close", async (c) => { input.close(); await runtime.close(); process.exit(c ?? 1); });
