import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeServer } from "../src/bridge.mjs";
import { DEFAULT_REALTIME_API_BASE, forwardRealtime } from "../src/realtime.mjs";

const BRIDGE = "bridge-token";
const GROK = "grok-login-token";
const OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
const ANSWER = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n";

function server(options = {}) {
  return createBridgeServer({
    token: BRIDGE,
    grokSession: { token: GROK, userId: null },
    ...options,
  });
}

async function withServer(options, run) {
  const httpServer = server(options);
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  try {
    return await run(httpServer.address().port);
  } finally {
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

function postRaw(port, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: {
          authorization: `Bearer ${BRIDGE}`,
          "content-type": "application/sdp",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("realtime calls and live forward raw SDP bytes to xAI", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const location = new URL(url).pathname.endsWith("/live")
      ? "/v1/live/rtc_live"
      : "/v1/realtime/calls/rtc_call";
    return new Response(ANSWER, {
      status: 201,
      headers: { location, "content-type": "application/sdp" },
    });
  };
  await withServer({ realtimeFetch: fetchImpl }, async (port) => {
    const search = "?intent=quicksilver&architecture=avas";
    const call = await postRaw(port, `/v1/realtime/calls${search}`, OFFER);
    assert.equal(call.status, 201);
    assert.equal(call.body.toString("utf8"), ANSWER);
    assert.equal(call.headers["content-type"], "application/sdp");
    assert.equal(call.headers.location, "/v1/realtime/calls/rtc_call");
    const live = await postRaw(port, `/v1/live${search}`, OFFER, {
      "content-type": "application/sdp",
    });
    assert.equal(live.status, 201);
    assert.equal(live.headers.location, "/v1/live/rtc_live");
    assert.equal(live.body.toString("utf8"), ANSWER);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${DEFAULT_REALTIME_API_BASE}/realtime/calls${"?intent=quicksilver&architecture=avas"}`);
  assert.equal(calls[1].url, `${DEFAULT_REALTIME_API_BASE}/live?intent=quicksilver&architecture=avas`);
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.headers.authorization, `Bearer ${GROK}`);
    assert.equal(call.init.headers["content-type"], "application/sdp");
    assert.equal(Buffer.from(call.init.body).toString("utf8"), OFFER);
    assert.equal(JSON.stringify(call.init.headers).includes("XAI_API_KEY"), false);
    assert.equal(JSON.stringify(call.init.headers).includes(BRIDGE), false);
    assert.equal(JSON.stringify(call.init.body).includes(BRIDGE), false);
  }
});

test("a non-2xx upstream body is returned unchanged", async () => {
  const upstreamBody = Buffer.from('{"error":"nope","sdp":"v=synthesized"}\n', "utf8");
  await withServer(
    {
      realtimeBaseUrl: "https://realtime.test/v1/",
      realtimeFetch: async (url, init) => {
        assert.equal(url, "https://realtime.test/v1/realtime/calls?model=grok");
        assert.equal(init.headers.authorization, `Bearer ${GROK}`);
        assert.equal(Buffer.from(init.body).equals(Buffer.from("not-json-sdp")), true);
        return new Response(upstreamBody, {
          status: 401,
          headers: {
            "content-type": "application/json",
            location: "/v1/realtime/calls/rtc_denied",
          },
        });
      },
    },
    async (port) => {
      const denied = await postRaw(port, "/v1/realtime/calls?model=grok", "not-json-sdp");
      assert.equal(denied.status, 401);
      assert.equal(denied.headers["content-type"], "application/json");
      assert.equal(denied.headers.location, "/v1/realtime/calls/rtc_denied");
      assert.equal(denied.body.equals(upstreamBody), true);
      assert.equal(denied.body.toString("utf8").includes("Grok login"), false);
    },
  );
  await withServer(
    {
      realtimeFetch: async () =>
        new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
    },
    async (port) => {
      const missing = await postRaw(port, "/v1/live", OFFER);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.toString("utf8"), "missing");
      assert.equal(missing.headers["content-type"], "text/plain");
      assert.equal(missing.headers.location, undefined);
    },
  );
});

test("missing login is a local 401 and a transport error is not an SDP answer", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-grok-realtime-"));
  let fetches = 0;
  await withServer(
    {
      grokSession: undefined,
      grokHome: home,
      realtimeFetch: async () => {
        fetches += 1;
        throw new Error("should not fetch");
      },
    },
    async (port) => {
      const response = await postRaw(port, "/v1/realtime/calls", OFFER);
      assert.equal(response.status, 401);
      assert.equal(response.headers["content-type"], "application/json");
      const body = JSON.parse(response.body.toString("utf8"));
      assert.match(body.error, /Grok login required/);
      assert.equal(response.body.toString("utf8").includes("v="), false);
    },
  );
  await withServer(
    {
      realtimeFetch: async () => {
        fetches += 1;
        throw new Error(`reset ${GROK}`);
      },
    },
    async (port) => {
      const response = await postRaw(port, "/v1/live", OFFER);
      assert.equal(response.status, 502);
      const body = JSON.parse(response.body.toString("utf8"));
      assert.equal(body.error, "Realtime call failed.");
      assert.equal(response.body.toString("utf8").includes(GROK), false);
      assert.equal(response.body.toString("utf8").includes("v="), false);
    },
  );
  assert.equal(fetches, 1);
});

test("realtime routes keep the bridge token gate", async () => {
  let fetches = 0;
  await withServer(
    {
      maxBodyBytes: 8,
      realtimeFetch: async () => {
        fetches += 1;
        throw new Error("should not fetch");
      },
    },
    async (port) => {
      const missing = await postRaw(port, "/v1/realtime/calls", OFFER, { authorization: "" });
      assert.equal(missing.status, 401);
      const browser = await postRaw(port, "/v1/live", OFFER, { origin: "https://evil.example" });
      assert.equal(browser.status, 403);
      const oversized = await postRaw(port, "/v1/realtime/calls", "0123456789");
      assert.equal(oversized.status, 413);
      const get = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/v1/live", method: "GET" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(get, 404);
    },
  );
  assert.equal(fetches, 0);
});

test("forwardRealtime uses the default base and an injected fetch", async () => {
  const seen = await forwardRealtime({
    path: "/realtime/calls",
    search: "?a=b",
    body: Buffer.from(OFFER),
    contentType: "application/sdp",
    token: GROK,
    fetchImpl: async (url, init) => {
      assert.equal(url, `${DEFAULT_REALTIME_API_BASE}/realtime/calls?a=b`);
      assert.equal(init.headers["content-type"], "application/sdp");
      return new Response(new Uint8Array(Buffer.from(ANSWER)), {
        status: 200,
        headers: { location: "/v1/realtime/calls/rtc_unit" },
      });
    },
  });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.toString("utf8"), ANSWER);
  assert.equal(seen.location, "/v1/realtime/calls/rtc_unit");
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${DEFAULT_REALTIME_API_BASE}/live`);
    assert.equal(Object.hasOwn(init.headers, "content-type"), false);
    return new Response(null, { status: 204 });
  };
  try {
    const empty = await forwardRealtime({ path: "/live", body: Buffer.alloc(0), token: GROK });
    assert.equal(empty.status, 204);
    assert.equal(empty.body.length, 0);
    assert.equal(empty.contentType, null);
    assert.equal(empty.location, null);
  } finally {
    globalThis.fetch = previous;
  }
});
