import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createBridgeServer } from "../src/bridge.mjs";
import { toProxyRequest } from "../src/tools.mjs";
import {
  DEFAULT_VIDEO_API_BASE,
  GROK_VIDEO_TOOL_NAME,
  videoToolOutput,
} from "../src/videogen.mjs";

const TOKEN = "video-session-token";
const VIDEO_URL = "https://vid.example/clip.mp4";

function assertNoBearer(text) {
  assert.equal(String(text).includes(TOKEN), false, "bearer was printed");
}

test("a video tool call rejects a duration or aspect ratio the API will not accept", async () => {
  let called = false;
  const fetchImpl = () => {
    called = true;
    throw new Error("no");
  };
  const duration = await videoToolOutput(
    { arguments: JSON.stringify({ prompt: "a cat", duration: 30 }) },
    { token: TOKEN, fetchImpl },
  );
  const ratio = await videoToolOutput(
    { arguments: JSON.stringify({ prompt: "a cat", aspect_ratio: "2:1" }) },
    { token: TOKEN, fetchImpl },
  );
  const image = await videoToolOutput(
    { arguments: JSON.stringify({ prompt: "a cat", image_url: "/tmp/cat.png" }) },
    { token: TOKEN, fetchImpl },
  );
  assert.equal(called, false);
  assert.match(duration, /1 to 15/);
  assert.match(ratio, /16:9/);
  assert.match(image, /http\(s\) URL/);
  assertNoBearer(duration);
  assertNoBearer(ratio);
  assertNoBearer(image);
});

test("the video function is declared once and does not take a Codex tool name", () => {
  const { request } = toProxyRequest({
    input: [{ role: "user", content: "make a clip" }],
    tools: [
      {
        type: "function",
        name: GROK_VIDEO_TOOL_NAME,
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  const declared = request.tools.filter((tool) => tool.name === GROK_VIDEO_TOOL_NAME);
  assert.equal(declared.length, 1);
  assert.equal(declared[0].type, "function");
  assert.equal(declared[0].parameters.required[0], "prompt");
  assert.equal(typeof declared[0].parameters.properties.image_url, "object");
  assert.equal(typeof declared[0].parameters.properties.duration, "object");
  assert.equal(typeof declared[0].parameters.properties.aspect_ratio, "object");
  assert.equal(declared[0].name.startsWith("codex_"), false);
  const renamed = request.tools.find((tool) => tool.name.startsWith("codex_"));
  assert.ok(renamed);
  assert.notEqual(renamed.name, GROK_VIDEO_TOOL_NAME);
});

function sse(chunks) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function videoCallStream() {
  return sse([
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: GROK_VIDEO_TOOL_NAME,
        call_id: "call_video",
        arguments: JSON.stringify({
          prompt: "a red cube spinning",
          image_url: "https://example.com/still.png",
          duration: 6,
          aspect_ratio: "16:9",
        }),
      },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_video" },
    })}\n\n`,
  ]);
}

function replyStream(text) {
  return sse([
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_done" },
    })}\n\n`,
  ]);
}

async function withBridge(options, run) {
  const server = createBridgeServer({
    token: "bridge",
    grokSession: { token: TOKEN, userId: null },
    videoPause: async () => {
      throw new Error("poll slept");
    },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(port) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer bridge" },
    body: JSON.stringify({
      model: "grok-4.7",
      input: [{ role: "user", content: "animate a red cube" }],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  return text;
}

test("a 202 and a completed poll become a tool result containing the URL", async () => {
  const videoCalls = [];
  let followUp;
  let rounds = 0;
  const text = await withBridge(
    {
      proxyFetch: async (_url, init) => {
        rounds += 1;
        const body = JSON.parse(init.body);
        if (rounds === 1) {
          assert.equal(
            body.tools.some((tool) => tool.name === GROK_VIDEO_TOOL_NAME),
            true,
          );
          return videoCallStream();
        }
        followUp = body;
        return replyStream("The clip is ready.");
      },
      videoFetch: async (url, init) => {
        const sent =
          init.headers.authorization === `Bearer ${TOKEN}` &&
          !JSON.stringify(init.body ?? "").includes(TOKEN);
        videoCalls.push({ url, method: init.method, sent, body: init.body });
        if (init.method === "POST") {
          return new Response(JSON.stringify({ request_id: "req_1" }), { status: 202 });
        }
        return new Response(
          JSON.stringify({ status: "done", video: { url: VIDEO_URL } }),
          { status: 200 },
        );
      },
    },
    post,
  );
  assert.equal(videoCalls.length, 2);
  assert.equal(videoCalls[0].method, "POST");
  assert.equal(videoCalls[0].url, `${DEFAULT_VIDEO_API_BASE}/videos/generations`);
  assert.equal(videoCalls[0].sent, true);
  const posted = JSON.parse(videoCalls[0].body);
  assert.equal(posted.prompt, "a red cube spinning");
  assert.equal(posted.image.url, "https://example.com/still.png");
  assert.equal(posted.duration, 6);
  assert.equal(posted.aspect_ratio, "16:9");
  assert.equal(videoCalls[1].method, "GET");
  assert.equal(videoCalls[1].url, `${DEFAULT_VIDEO_API_BASE}/videos/req_1`);
  const output = followUp.input.find((item) => item.type === "function_call_output");
  assert.match(output.output, new RegExp(VIDEO_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assertNoBearer(output.output);
  assertNoBearer(JSON.stringify(followUp.input));
  assert.match(text, /The clip is ready/);
  assert.match(text, /response\.completed/);
  assert.doesNotMatch(text, /response\.failed/);
  assert.doesNotMatch(text, /grok_bridge_generate_video/);
  assertNoBearer(text);
});

test("a 401 from the videos API is a tool error and the turn continues", async () => {
  let followUp;
  let rounds = 0;
  const text = await withBridge(
    {
      proxyFetch: async (_url, init) => {
        rounds += 1;
        if (rounds === 1) return videoCallStream();
        followUp = JSON.parse(init.body);
        return replyStream("I could not generate the video.");
      },
      videoFetch: async () =>
        new Response(`unauthorized ${TOKEN}`, {
          status: 401,
          headers: { "www-authenticate": `Bearer ${TOKEN}` },
        }),
    },
    post,
  );
  const output = followUp.input.find((item) => item.type === "function_call_output");
  assert.match(output.output, /Video generation failed \(401\)/);
  assertNoBearer(output.output);
  assertNoBearer(JSON.stringify(followUp));
  assert.match(text, /I could not generate the video/);
  assert.match(text, /response\.completed/);
  assert.doesNotMatch(text, /response\.failed/);
  assertNoBearer(text);
});

test("a finished video withheld by moderation is explained", async () => {
  const output = await videoToolOutput(
    {
      name: GROK_VIDEO_TOOL_NAME,
      call_id: "c",
      arguments: JSON.stringify({ prompt: "waves" }),
    },
    {
      token: TOKEN,
      pause: async () => {},
      fetchImpl: async (_url, init) => {
        if (init.method === "POST") {
          return new Response(JSON.stringify({ request_id: "req_mod" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ status: "done", video: { respect_moderation: false } }),
          { status: 200 },
        );
      },
    },
  );
  assert.equal(output, "Video generation finished, but moderation withheld the URL.");
  assertNoBearer(output);
});

test("video tool output does not echo the bearer", async () => {
  const output = await videoToolOutput(
    {
      name: GROK_VIDEO_TOOL_NAME,
      call_id: "c",
      arguments: JSON.stringify({ prompt: "waves" }),
    },
    {
      token: TOKEN,
      pause: async () => {
        throw new Error("poll slept");
      },
      fetchImpl: async () => new Response(`no ${TOKEN}`, { status: 401 }),
    },
  );
  assert.equal(output, "Video generation failed (401).");
  assertNoBearer(output);
});
