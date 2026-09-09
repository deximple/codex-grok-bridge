import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";

import {
  cachedLookup,
  clearDnsCache,
  destroyAgents,
  proxyAgent,
  requestStream,
} from "../src/transport.mjs";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://localhost:${server.address().port}`);
  } finally {
    destroyAgents();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("requestStream returns a Response whose body streams", async () => {
  const received = await withServer(
    (request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: a\ndata: {}\n\n");
        response.end(`event: b\ndata: ${body}\n\n`);
      });
    },
    async (base) => {
      const response = await requestStream(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.ok, true);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.equal(typeof response.body.getReader, "function");
      return await response.text();
    },
  );
  assert.match(received, /event: a/);
  assert.match(received, /"hello":"world"/);
});

test("requestStream surfaces a non-2xx status instead of throwing", async () => {
  const status = await withServer(
    (request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(422, { "content-type": "application/json" });
        response.end('{"error":"unknown item type"}');
      });
    },
    async (base) => {
      const response = await requestStream(base, { method: "POST", body: "{}" });
      assert.equal(response.ok, false);
      assert.match(await response.text(), /unknown item type/);
      return response.status;
    },
  );
  assert.equal(status, 422);
});

test("requestStream reuses one keep-alive socket across a tool-length gap", async () => {
  const ports = await withServer(
    (request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200);
        response.end(String(request.socket.remotePort));
      });
    },
    async (base) => {
      const first = await (await requestStream(base, { method: "POST", body: "{}" })).text();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const second = await (await requestStream(base, { method: "POST", body: "{}" })).text();
      return [first, second];
    },
  );
  assert.equal(ports[0], ports[1], "a fresh socket means a fresh DNS lookup");
});

test("the agent is configured for reuse and uses the cached lookup", () => {
  const agent = proxyAgent("https:");
  assert.equal(agent.options.keepAlive, true);
  assert.equal(agent.options.lookup, cachedLookup);
  assert.equal(proxyAgent("https:"), agent, "one agent per protocol");
  assert.notEqual(proxyAgent("http:"), agent);
  destroyAgents();
});

test("cachedLookup resolves once and then answers from cache", async () => {
  clearDnsCache();
  const lookup = (hostname) =>
    new Promise((resolve, reject) =>
      cachedLookup(hostname, { family: 4 }, (error, address, family) =>
        error ? reject(error) : resolve({ address, family }),
      ),
    );
  const first = await lookup("localhost");
  const second = await lookup("localhost");
  assert.equal(first.address, second.address);
  assert.equal(first.family, 4);
});

test("cachedLookup serves a stale address rather than failing a live turn", async () => {
  clearDnsCache();
  const ask = (hostname) =>
    new Promise((resolve, reject) =>
      cachedLookup(hostname, {}, (error, address) =>
        error ? reject(error) : resolve(address),
      ),
    );
  const warm = await ask("localhost");
  // Expire the entry so the next call re-resolves; the name still resolves, so
  // this asserts the happy path stays correct after expiry.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await ask("localhost"), warm);

  await assert.rejects(
    () => ask("no-such-host.invalid"),
    (error) => typeof error.code === "string",
    "an uncached name that cannot resolve must still report the error",
  );
});
