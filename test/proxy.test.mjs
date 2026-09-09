import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBridgeServer } from "../src/bridge.mjs";
import { pipeProxySse, openProxyStreamWithRetry } from "../src/proxy.mjs";

test("proxy path streams rewritten Responses events without spawning CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-home-"));
  await mkdir(join(home, ".grok"));
  await writeFile(
    join(home, ".grok/auth.json"),
    JSON.stringify({
      "https://auth.x.ai::test": { key: "session-token-value" },
    }),
  );
  let captured;
  const server = createBridgeServer({
    token: "bridge",
    grokHome: home,
    proxyFetch: async (url, init) => {
      captured = { url, init };
      const body = JSON.parse(init.body);
      const name = body.tools[0].name;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(
            enc.encode(
              `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
            ),
          );
          controller.enqueue(
            enc.encode(
              `event: response.output_item.done\ndata: ${JSON.stringify({
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  name,
                  arguments: '{"cmd":"pwd"}',
                  call_id: "call_1",
                },
              })}\n\n`,
            ),
          );
          controller.enqueue(
            enc.encode(
              `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: { id: "resp_1", usage: { input_tokens: 9, output_tokens: 3 } },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer bridge",
          "thread-id": "thread-xyz",
        },
        body: JSON.stringify({
          model: "grok-4.6",
          prompt_cache_key: "cache-1",
          input: [{ role: "user", content: "pwd" }],
          tools: [
            {
              type: "function",
              name: "exec_command",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      },
    );
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(captured.url, /\/responses$/);
    assert.match(captured.init.headers.authorization, /session-token-value/);
    assert.equal(captured.init.headers["x-grok-conv-id"], "cache-1");
    assert.equal(captured.init.headers["x-grok-session-id"], "thread-xyz");
    assert.ok(captured.init.headers["x-grok-client-version"]);
    assert.equal(
      captured.init.headers["x-grok-client-identifier"],
      "grok-shell",
    );
    const proxyBody = JSON.parse(captured.init.body);
    assert.equal(proxyBody.store, false);
    assert.doesNotMatch(proxyBody.tools[0].name, /^exec_command$/);
    assert.match(text, /"name":"exec_command"/);
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /codex_0_/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("proxy path reports a destroyed SSE write as abort, not generic validation", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-home-"));
  await mkdir(join(home, ".grok"));
  await writeFile(
    join(home, ".grok/auth.json"),
    JSON.stringify({
      "https://auth.x.ai::test": { key: "session-token-value" },
    }),
  );
  const server = createBridgeServer({
    token: "bridge",
    grokHome: home,
    proxyFetch: async () => {
      const error = new Error("Cannot call write after a stream was destroyed");
      error.name = "Error";
      error.code = "ERR_STREAM_DESTROYED";
      throw error;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/responses`,
      {
        method: "POST",
        headers: { authorization: "Bearer bridge" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: [{ role: "user", content: "hi" }],
        }),
      },
    );
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /event: response\.failed/);
    assert.match(text, /Grok request was aborted/);
    assert.doesNotMatch(text, /failed validation or execution/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("proxy path reports abort instead of a generic validation error", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-home-"));
  await mkdir(join(home, ".grok"));
  await writeFile(
    join(home, ".grok/auth.json"),
    JSON.stringify({
      "https://auth.x.ai::test": { key: "session-token-value" },
    }),
  );
  const server = createBridgeServer({
    token: "bridge",
    grokHome: home,
    proxyFetch: async () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/responses`,
      {
        method: "POST",
        headers: { authorization: "Bearer bridge" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: [{ role: "user", content: "hi" }],
        }),
      },
    );
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /event: response\.failed/);
    assert.match(text, /Grok request was aborted/);
    assert.doesNotMatch(text, /failed validation or execution/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("the SSE pipe respects backpressure instead of buffering the whole response", async () => {
  const { Writable } = await import("node:stream");
  const written = [];
  let pending = null;
  // A consumer that never drains on its own: write() returns false and stays
  // false until the test releases it.
  const slow = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      pending = callback;
    },
  });
  const blocks = [
    'event: a\ndata: {"type":"a"}\n\n',
    'event: b\ndata: {"type":"b"}\n\n',
    'event: c\ndata: {"type":"c"}\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const block of blocks)
        controller.enqueue(new TextEncoder().encode(block));
      controller.close();
    },
  });
  const piping = pipeProxySse(stream, slow, new Map());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.length, 1, "must stop after the first un-drained write");
  while (pending) {
    const release = pending;
    pending = null;
    release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await piping;
  assert.equal(written.length, 3, "every block must still arrive, in order");
  assert.match(written[2], /"type":"c"/);
});

test("the SSE pipe stops and reports when the client disappears mid-stream", async () => {
  const { Writable } = await import("node:stream");
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  let cancelled = null;
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new TextEncoder().encode('event: a\ndata: {}\n\n'));
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  sink.destroy();
  await assert.rejects(
    () => pipeProxySse(stream, sink, new Map()),
    (error) => error.code === "ERR_STREAM_PREMATURE_CLOSE",
  );
  assert.ok(cancelled, "the upstream body must be cancelled, not left open");
  assert.ok(pulled <= 2, `must stop pulling from Grok, pulled ${pulled}`);
});

const networkFailure = (code, name = "Error") => {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error("boom"), { code, name });
  return error;
};

const okStream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.completed\ndata: {}\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

test("a stream that dies before it opens is re-sent once", async () => {
  let attempts = 0;
  const retries = [];
  const response = await openProxyStreamWithRetry({
    token: "t",
    body: {},
    baseUrl: "https://example.invalid/v1",
    onRetry: (info) => retries.push(info),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw networkFailure("EAI_AGAIN");
      return okStream();
    },
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(retries, [{ attempt: 1, kind: "dns" }]);
});

test("a rejected payload is never re-sent", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      openProxyStreamWithRetry({
        token: "t",
        body: {},
        baseUrl: "https://example.invalid/v1",
        fetchImpl: async () => {
          attempts += 1;
          return new Response('{"error":"unknown item type"}', { status: 422 });
        },
      }),
    /Grok Responses proxy failed \(422\)/,
  );
  assert.equal(attempts, 1, "422 is deterministic; retrying only burns quota");
});

test("an aborted turn is never re-sent", async () => {
  let attempts = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    openProxyStreamWithRetry({
      token: "t",
      body: {},
      baseUrl: "https://example.invalid/v1",
      signal: controller.signal,
      fetchImpl: async () => {
        attempts += 1;
        throw networkFailure("UND_ERR_SOCKET", "SocketError");
      },
    }),
  );
  assert.equal(attempts, 1);
});

test("retries are bounded and the original failure is what surfaces", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      openProxyStreamWithRetry({
        token: "t",
        body: {},
        baseUrl: "https://example.invalid/v1",
        fetchImpl: async () => {
          attempts += 1;
          throw networkFailure("EAI_AGAIN");
        },
      }),
    (error) => error.cause.code === "EAI_AGAIN",
  );
  assert.equal(attempts, 2);
});
