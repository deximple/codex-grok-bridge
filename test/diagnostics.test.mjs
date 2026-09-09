import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiagnostics, redact } from "../src/diagnostics.mjs";

test("redacts bearer tokens, JWTs and home paths", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const text = redact(`Authorization: Bearer abc.def-ghi failed for ${jwt} at /Users/jane/.grok/auth.json`, "/Users/jane");
  assert.ok(!text.includes("abc.def-ghi"), "bearer survived");
  assert.ok(!text.includes(jwt), "jwt survived");
  assert.ok(!text.includes("/Users/jane"), "home path survived");
  assert.match(text, /~\/\.grok\/auth\.json/);
});

test("writes one 0600 JSONL record per turn and never throws", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "diag-"));
  const diagnostics = createDiagnostics({ dir, enabled: true });
  diagnostics.record({ event: "upstream_failed", kind: "dns", signature: "TypeError <- Error[EAI_AGAIN]", elapsedMs: 15071, requestBytes: 463779, items: 83, tools: 5, eventsSeen: 0, detail: "Bearer sekrit" });
  const written = readFileSync(diagnostics.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(written.length, 1);
  assert.equal(written[0].kind, "dns");
  assert.equal(written[0].elapsedMs, 15071);
  assert.equal(written[0].detail, "Bearer [redacted]");
  assert.equal(statSync(diagnostics.file).mode & 0o777, 0o600);
});

test("can be turned off entirely", () => {
  const diagnostics = createDiagnostics({ enabled: false });
  assert.equal(diagnostics.file, null);
  assert.doesNotThrow(() => diagnostics.record({ event: "x" }));
});

test("a completed turn is recorded too, so a silent log means the bridge was never called", async () => {
  const { createBridgeServer } = await import("../src/bridge.mjs");
  const { once } = await import("node:events");
  const dir = mkdtempSync(path.join(tmpdir(), "diag-turn-"));
  const home = mkdtempSync(path.join(tmpdir(), "grok-home-"));
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(home, ".grok"));
  writeFileSync(path.join(home, ".grok/auth.json"), JSON.stringify({ s: { key: "k" } }));

  const server = createBridgeServer({
    token: "b",
    grokHome: home,
    diagnosticsOptions: { dir, enabled: true },
    proxyFetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: response.completed\ndata: {"type":"response.completed"}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/responses`,
      {
        method: "POST",
        headers: { authorization: "Bearer b" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: [{ role: "user", content: "hi" }],
          tools: [],
        }),
      },
    );
    await response.text();
    const record = JSON.parse(
      readFileSync(path.join(dir, "bridge.jsonl"), "utf8").trim(),
    );
    assert.equal(record.event, "turn_ok");
    assert.equal(record.mode, "proxy");
    assert.equal(record.items, 1);
    assert.ok(record.requestBytes > 0, "request size must be recorded");
    assert.ok(typeof record.elapsedMs === "number");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a directly constructed bridge writes no operator log at all", async () => {
  const { createBridgeServer } = await import("../src/bridge.mjs");
  const { once } = await import("node:events");
  const { existsSync } = await import("node:fs");
  const server = createBridgeServer({ token: "b" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    // No diagnosticsOptions => the writer is inert and owns no file.
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/models`,
    );
    assert.equal(response.status, 200);
    await response.json();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const { createDiagnostics } = await import("../src/diagnostics.mjs");
  assert.equal(createDiagnostics().file, null, "default must be inert");
  assert.equal(createDiagnostics({ dir: "/tmp/never" }).file, null, "a dir alone must not enable it");
  assert.ok(!existsSync("/tmp/never"), "an inert writer must not create its directory");
});

test("the runtime turns diagnostics on, and GROK_BRIDGE_DIAGNOSTICS=off turns it back off", async () => {
  const { startRuntime } = await import("../src/runtime.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "diag-runtime-"));
  const previous = process.env.GROK_BRIDGE_DIAGNOSTICS;
  try {
    delete process.env.GROK_BRIDGE_DIAGNOSTICS;
    const on = await startRuntime({ diagnosticsOptions: { dir } });
    await on.close();
    const { readdirSync } = await import("node:fs");
    assert.ok(readdirSync(dir).length >= 0);

    process.env.GROK_BRIDGE_DIAGNOSTICS = "off";
    const off = await startRuntime({ diagnosticsOptions: { dir } });
    await off.close();
  } finally {
    if (previous === undefined) delete process.env.GROK_BRIDGE_DIAGNOSTICS;
    else process.env.GROK_BRIDGE_DIAGNOSTICS = previous;
  }
});
