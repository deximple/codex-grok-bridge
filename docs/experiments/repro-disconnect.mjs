// M1: what does the bridge tell the user when the upstream fails for real?
//
// Each scenario stands up a localhost server that plays the part of
// cli-chat-proxy and then fails in a specific way, so the error that reaches
// publicBridgeError() is a genuine undici/Node error rather than a hand-thrown
// stand-in. Before Phase 0 every one of these collapsed into the single string
// "Grok response failed validation or execution".
//
//   node docs/experiments/repro-disconnect.mjs
import http from "node:http";
import { once } from "node:events";
import { Writable } from "node:stream";

const ROOT = new URL("../../../src/", import.meta.url);
const { openProxyStream, pipeProxySse } = await import(new URL("proxy.mjs", ROOT));
const { publicBridgeError } = await import(new URL("bridge.mjs", ROOT));

function describe(error, depth = 0) {
  if (!error || depth > 4) return "";
  const pad = "    " + "  ".repeat(depth);
  const line = `${pad}${error.constructor?.name} name=${error.name} code=${error.code ?? "-"} msg=${JSON.stringify(String(error.message).slice(0, 90))}`;
  return error.cause ? `${line}\n${describe(error.cause, depth + 1)}` : line;
}

async function scenario(label, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const sink = new Writable({ write: (chunk, encoding, done) => done() });
  let thrown = null;
  try {
    const proxy = await openProxyStream({
      token: "stub",
      body: { model: "grok-4.6" },
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    });
    await pipeProxySse(proxy.body, sink, new Map());
  } catch (error) {
    thrown = error;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log(`\n=== ${label} ===`);
  if (!thrown) return console.log("    (no throw)");
  console.log(describe(thrown));
  console.log(`    >>> ${JSON.stringify(publicBridgeError(thrown))}`);
}

await scenario("upstream drops the socket mid-SSE", (request, response) => {
  request.resume();
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  setTimeout(() => response.socket.destroy(), 50);
});

await scenario("upstream truncates a chunked body", (request, response) => {
  request.resume();
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "transfer-encoding": "chunked",
  });
  response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  setTimeout(() => {
    response.socket.write("\r\n");
    response.socket.destroy();
  }, 50);
});

await scenario("upstream closes before sending headers", (request, response) => {
  request.resume();
  response.socket.destroy();
});

await scenario("upstream rejects the payload", (request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(422, { "content-type": "application/json" });
    response.end('{"error":{"message":"unknown item type \\"agent_message\\""}}');
  });
});

// Failures that never reach a server at all.
for (const [label, baseUrl] of [
  ["connection refused", "http://127.0.0.1:1/v1"],
  ["name does not resolve", "http://no-such-host.invalid/v1"],
]) {
  let thrown = null;
  try {
    await openProxyStream({ token: "stub", body: {}, baseUrl });
  } catch (error) {
    thrown = error;
  }
  console.log(`\n=== ${label} ===`);
  console.log(describe(thrown));
  console.log(`    >>> ${JSON.stringify(publicBridgeError(thrown))}`);
}
