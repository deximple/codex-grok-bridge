import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createBridgeServer } from "../src/bridge.mjs";
import {
  DEFAULT_IMAGINE_API_BASE,
  IMAGINE_MODEL,
  codexImageResponse,
  imagineEditBody,
  imagineGenerationBody,
} from "../src/imagine.mjs";

const BRIDGE = "bridge-token";
const GROK = "grok-login-token";
const PNG = "aGVsbG8=";

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

function post(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BRIDGE}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("generation rewrites Codex's image body onto the Imagine API", () => {
  assert.deepEqual(
    imagineGenerationBody({
      prompt: "  a red cube  ",
      model: "gpt-image-2",
      background: "opaque",
      quality: "auto",
      size: "auto",
    }),
    {
      model: IMAGINE_MODEL,
      prompt: "a red cube",
      n: 1,
      resolution: "1k",
      response_format: "b64_json",
    },
  );
  assert.equal(imagineGenerationBody({ prompt: "wide", size: "1536x1024" }).aspect_ratio, "3:2");
  assert.equal(imagineGenerationBody({ prompt: "tall", size: "1024x1536" }).aspect_ratio, "2:3");
  assert.equal(imagineGenerationBody({ prompt: "square", size: "1024x1024" }).aspect_ratio, "1:1");
});

test("edits map image_url references and refuse OpenAI file ids", () => {
  assert.deepEqual(
    imagineEditBody({
      prompt: "make it blue",
      images: [{ image_url: "data:image/png;base64,YQ==" }],
      model: "gpt-image-2",
    }).image,
    { url: "data:image/png;base64,YQ==" },
  );
  const many = imagineEditBody({
    prompt: "combine",
    images: [{ image_url: "data:image/png;base64,YQ==" }, { image_url: "data:image/png;base64,Yg==" }],
  });
  assert.equal(many.images.length, 2);
  assert.equal(many.aspect_ratio, "auto");
  assert.equal(Object.hasOwn(many, "image"), false);
  assert.throws(() => imagineEditBody({ prompt: "x", images: [{ file_id: "file_123" }] }), /file ids/);
  assert.throws(
    () => imagineEditBody({ prompt: "x", images: [{ image_url: "/tmp/cat.png" }] }),
    /http\(s\) URL/,
  );
});

test("a missing created timestamp is filled and empty images are refused", () => {
  const response = codexImageResponse({ data: [{ b64_json: PNG, url: "https://drop.example" }] });
  assert.equal(response.data[0].b64_json, PNG);
  assert.equal(Object.hasOwn(response.data[0], "url"), false);
  assert.equal(Number.isInteger(response.created), true);
  assert.throws(() => codexImageResponse({ data: [{ url: "https://only.example" }] }), /no image/);
});

test("the bridge forwards generations and returns b64_json", async () => {
  const calls = [];
  const { status, body } = await withServer(
    {
      imagineFetch: async (url, init) => {
        calls.push({ url, init, parsed: JSON.parse(init.body) });
        return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { status: 200 });
      },
    },
    async (port) => {
      const response = await post(port, "/v1/images/generations", {
        prompt: "a red cube",
        model: "gpt-image-2",
        size: "auto",
      });
      return { status: response.status, body: await response.json() };
    },
  );
  assert.equal(status, 200);
  assert.equal(body.data[0].b64_json, PNG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_IMAGINE_API_BASE}/images/generations`);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${GROK}`);
  assert.equal(calls[0].parsed.model, IMAGINE_MODEL);
  assert.equal(calls[0].parsed.prompt, "a red cube");
  assert.equal(JSON.stringify(calls[0].parsed).includes("gpt-image-2"), false);
  assert.equal(JSON.stringify(calls[0]).includes(BRIDGE), false);
});

test("edits post to /images/edits and a file id never leaves the bridge", async () => {
  let fetches = 0;
  await withServer(
    {
      imagineFetch: async (url, init) => {
        fetches += 1;
        assert.equal(url, `${DEFAULT_IMAGINE_API_BASE}/images/edits`);
        assert.deepEqual(JSON.parse(init.body).image, { url: "data:image/png;base64,YQ==" });
        return new Response(JSON.stringify({ created: 9, data: [{ b64_json: PNG }] }), {
          status: 200,
        });
      },
    },
    async (port) => {
      const ok = await post(port, "/v1/images/edits", {
        prompt: "crop",
        images: [{ image_url: "data:image/png;base64,YQ==" }],
      });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).created, 9);
      const refused = await post(port, "/v1/images/edits", {
        prompt: "crop",
        images: [{ file_id: "file_123" }],
      });
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error, /file ids/);
    },
  );
  assert.equal(fetches, 1);
});

test("upstream auth failure and redirects do not leak the login bearer", async () => {
  await withServer(
    {
      imagineFetch: async () =>
        new Response(JSON.stringify({ error: `bad ${GROK}` }), { status: 401 }),
    },
    async (port) => {
      const response = await post(port, "/v1/images/generations", { prompt: "x" });
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.match(body.error, /grok login/i);
      assert.equal(JSON.stringify(body).includes(GROK), false);
    },
  );
  await withServer(
    {
      imagineFetch: async () =>
        new Response("", { status: 302, headers: { location: "https://evil.example" } }),
    },
    async (port) => {
      const response = await post(port, "/v1/images/generations", { prompt: "x" });
      const body = await response.json();
      assert.equal(response.status, 502);
      assert.match(body.error, /redirect/);
      assert.equal(JSON.stringify(body).includes("evil.example"), false);
    },
  );
});

test("image routes keep the bridge token gate and leave other paths at 404", async () => {
  await withServer({ imagineFetch: async () => { throw new Error("should not fetch"); } }, async (port) => {
    const missing = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    assert.equal(missing.status, 401);
    const browser = await post(port, "/v1/images/generations", { prompt: "x" }, { origin: "https://evil.example" });
    assert.equal(browser.status, 403);
    const unknown = await post(port, "/v1/audio/speech", { sdp: "v=0" });
    assert.equal(unknown.status, 404);
    const get = await fetch(`http://127.0.0.1:${port}/v1/images/generations`);
    assert.equal(get.status, 404);
  });
});
