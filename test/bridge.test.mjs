import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { MODEL_INFO, createBridgeServer } from "../src/bridge.mjs";

const TOKEN = "unit-test-token";

function requestBody(overrides = {}) {
  return {
    model: "grok-4.6",
    input: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/safe/project</cwd>\n</environment_context>",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix the parser" }],
      },
    ],
    reasoning: { effort: "high" },
    stream: true,
    ...overrides,
  };
}

async function withServer(options, callback) {
  const server = createBridgeServer({ token: TOKEN, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves the Grok model catalog", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/models?client_version=test`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.models[0].slug, "grok-4.6");
    assert.equal(data.models[0].display_name, "Grok 4.6 / xAI");
    assert.deepEqual(data.models[0], MODEL_INFO);
  });
});

test("rejects unauthenticated inference without spawning Grok", async () => {
  let called = false;
  await withServer(
    {
      runGrok: async () => {
        called = true;
        return { exitCode: 0, stdout: '{"text":"unexpected"}', stderr: "" };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      });
      assert.equal(response.status, 401);
      assert.equal(called, false);
    },
  );
});

test("translates a Grok result into a Codex-compatible SSE response", async () => {
  let capturedInvocation;
  await withServer(
    {
      isDirectory: () => true,
      runGrok: async (invocation) => {
        capturedInvocation = invocation;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            text: JSON.stringify({
              text: "Fixed through Grok Build CLI",
              calls: [],
            }),
            sessionId: "grok-session",
            usage: { inputTokens: 11, outputTokens: 7 },
          }),
          stderr: "",
        };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "thread-id": "thread-123",
        },
        body: JSON.stringify(requestBody()),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/event-stream/);
      const text = await response.text();
      assert.match(text, /event: response\.created/);
      assert.match(text, /event: response\.output_item\.done/);
      assert.match(text, /Fixed through Grok Build CLI/);
      assert.match(text, /event: response\.completed/);
      assert.equal(capturedInvocation.threadId, "thread-123");
      assert.equal(
        capturedInvocation.args[
          capturedInvocation.args.indexOf("--single") + 1
        ],
        "Fix the parser",
      );
    },
  );
});

test("returns a sanitized failed event when Grok exits unsuccessfully", async () => {
  await withServer(
    {
      isDirectory: () => true,
      runGrok: async () => ({
        exitCode: 9,
        stdout: "",
        stderr: "Authorization: Bearer SUPER_SECRET_VALUE",
      }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody()),
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /event: response\.failed/);
      assert.match(text, /Grok Build CLI exited with code 9/);
      assert.doesNotMatch(text, /SUPER_SECRET_VALUE/);
    },
  );
});

test("rejects unsupported models, invalid JSON, and oversized bodies", async () => {
  await withServer({ maxBodyBytes: 64 }, async (baseUrl) => {
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const unsupported = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-other", input: [] }),
    });
    assert.equal(unsupported.status, 400);

    const invalid = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: "{",
    });
    assert.equal(invalid.status, 400);

    const oversized = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "grok-4.6",
        input: [],
        padding: "x".repeat(100),
      }),
    });
    assert.equal(oversized.status, 413);
  });
});

test("concurrent inference is bounded, and the overflow waits instead of failing", async () => {
  const http = await import("node:http");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "grok-home-"));
  await mkdir(join(home, ".grok"));
  await writeFile(join(home, ".grok/auth.json"), JSON.stringify({ s: { key: "k" } }));

  let inFlight = 0;
  let peak = 0;
  const server = createBridgeServer({
    token: "t",
    grokHome: home,
    maxConcurrentInference: 2,
    maxQueuedInference: 2,
    proxyFetch: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 250));
      inFlight--;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("event: response.completed\ndata: {}\n\n"),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const payload = JSON.stringify({
    model: "grok-4.6",
    input: [{ role: "user", content: "x" }],
  });
  // Two chunks so the body read really suspends — the window the old guard,
  // which sat in front of it, let every concurrent request through.
  const fire = () =>
    new Promise((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.write(payload.slice(0, 20));
      setTimeout(() => request.end(payload.slice(20)), 30);
    });
  try {
    const statuses = await Promise.all(Array.from({ length: 4 }, fire));
    assert.ok(peak <= 2, `concurrency limit breached: ${peak} upstream calls at once`);
    assert.equal(
      statuses.filter((status) => status === 200).length,
      4,
      `queued requests must be served, not refused: ${statuses}`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a request beyond the queue is refused rather than held forever", async () => {
  const http = await import("node:http");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "grok-home-"));
  await mkdir(join(home, ".grok"));
  await writeFile(join(home, ".grok/auth.json"), JSON.stringify({ s: { key: "k" } }));

  const server = createBridgeServer({
    token: "t",
    grokHome: home,
    maxConcurrentInference: 1,
    maxQueuedInference: 0,
    proxyFetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: response.completed\ndata: {}\n\n"));
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const body = JSON.stringify({ model: "grok-4.6", input: [{ role: "user", content: "x" }] });
  const fire = () =>
    new Promise((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/responses",
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.end(body);
    });
  try {
    const first = fire();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await fire();
    assert.equal(second, 429, "a full queue must refuse, not hang");
    assert.equal(await first, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
