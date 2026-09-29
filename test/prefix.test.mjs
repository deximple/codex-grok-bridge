import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBridgeServer } from "../src/bridge.mjs";
import {
  applyCacheUsage,
  createPrefixMemory,
  readCacheUsage,
  stableConvId,
} from "../src/prefix.mjs";
import { createSlots } from "../src/slots.mjs";
import { rewriteSseBlock, toProxyRequest } from "../src/tools.mjs";

const tools = [
  {
    type: "function",
    name: "exec_command",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" }, workdir: { type: "string" } },
    },
  },
  { type: "custom", name: "apply_patch" },
];

test("one conv id per Codex thread, independent of a rotating prompt_cache_key", () => {
  assert.equal(stableConvId(" thread-a ", "cache-1"), "thread-a");
  assert.equal(stableConvId(" thread-a ", "cache-2"), "thread-a");
  assert.equal(stableConvId("", " cache-only "), "cache-only");
  assert.equal(stableConvId(undefined, undefined), null);
});

test("a second turn resends the same prefix bytes and still appends the new items", () => {
  const memory = createPrefixMemory();
  const first = toProxyRequest({
    model: "grok-4.7",
    input: [
      { role: "user", content: "hi" },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "think" }],
        encrypted_content: "blob-1",
      },
      {
        type: "function_call",
        name: "exec_command",
        call_id: "c1",
        arguments: "{}",
      },
    ],
    tools,
  });
  const sent1 = memory.reuse("thread-a", first.projected);
  const second = toProxyRequest({
    model: "grok-4.7",
    tools: [...tools].reverse(),
    input: [
      {
        type: "message",
        id: "m1",
        status: "completed",
        role: "user",
        content: [{ type: "input_text", text: "hi", annotations: [] }],
      },
      {
        type: "reasoning",
        id: "r1",
        summary: [{ type: "summary_text", text: "think" }],
        encrypted_content: "blob-2",
        content: null,
      },
      {
        type: "function_call",
        id: "fc1",
        status: "completed",
        name: "exec_command",
        call_id: "c1",
        arguments: "{}",
        internal_chat_message_metadata_passthrough: { turn_id: "t" },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "next" }],
      },
    ],
  });
  const sent2 = memory.reuse("thread-a", second.projected);
  assert.equal(
    JSON.stringify(sent2.slice(0, sent1.length)),
    JSON.stringify(sent1),
  );
  assert.equal(sent2.length, sent1.length + 1);
  assert.equal(sent2[1].type, "reasoning");
  assert.equal(sent2[1].summary[0].text, "think");
  assert.equal(sent2.at(-1).content[0].text, "next");
  assert.equal(sent2[2].name, sent1[2].name);
  assert.ok(second.request.tools.some((tool) => tool.name === sent2[2].name));
  assert.equal(second.request.store, false);
});

test("an edited earlier message is not kept from the previous prefix", () => {
  const memory = createPrefixMemory();
  const first = toProxyRequest({
    model: "grok-4.7",
    input: [{ role: "user", content: "hi" }],
    tools: [],
  });
  memory.reuse("thread-a", first.projected);
  const second = toProxyRequest({
    model: "grok-4.7",
    input: [{ role: "user", content: "changed" }, { role: "user", content: "next" }],
    tools: [],
  });
  const sent = memory.reuse("thread-a", second.projected);
  assert.equal(sent[0].content, "changed");
  assert.equal(sent[1].content, "next");
});

test("cache counters are copied only when the upstream sent them", () => {
  assert.equal(readCacheUsage({ input_tokens: 10 }), null);
  const untouched = { input_tokens: 10, output_tokens: 2 };
  applyCacheUsage(untouched);
  assert.equal(untouched.input_tokens_details, undefined);
  assert.equal(untouched.cached_prompt_tokens, undefined);

  const miss = {
    input_tokens: 10,
    cached_prompt_tokens: 0,
    cache_read_input_tokens: 12,
    cache_creation_input_tokens: 4,
  };
  applyCacheUsage(miss);
  assert.equal(miss.cached_prompt_tokens, 0);
  assert.equal(miss.cache_read_input_tokens, 12);
  assert.equal(miss.input_tokens_details.cached_tokens, 0);

  const readOnly = { cache_read_input_tokens: 15 };
  applyCacheUsage(readOnly);
  assert.equal(readOnly.cached_prompt_tokens, undefined);
  assert.equal(readOnly.input_tokens_details.cached_tokens, 15);

  const block = rewriteSseBlock(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", usage: { input_tokens: 3, output_tokens: 1 } },
    })}\n`,
    new Map(),
  );
  assert.doesNotMatch(block, /cached_prompt_tokens/);
  assert.doesNotMatch(block, /cached_tokens/);
});

test("the proxy keeps one conv id, the full prefix, and real cache counters", async () => {
  assert.equal(createSlots().limit, 4);
  const home = await mkdtemp(join(tmpdir(), "grok-home-"));
  const logs = await mkdtemp(join(tmpdir(), "diag-"));
  await mkdir(join(home, ".grok"));
  await writeFile(
    join(home, ".grok/auth.json"),
    JSON.stringify({ "https://auth.x.ai::test": { key: "session-token-value" } }),
  );
  const bodies = [];
  const convIds = [];
  let turn = 0;
  const server = createBridgeServer({
    token: "bridge",
    grokHome: home,
    diagnosticsOptions: { dir: logs, enabled: true },
    proxyFetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      convIds.push(init.headers["x-grok-conv-id"]);
      turn += 1;
      const usage =
        turn === 1
          ? { input_tokens: 10, output_tokens: 2 }
          : {
              input_tokens: 4,
              output_tokens: 3,
              cached_prompt_tokens: 0,
              cache_read_input_tokens: 12,
              cache_creation_input_tokens: 4,
            };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: { id: "resp_" + turn, usage },
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
  const post = (body, cacheKey) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge",
        "thread-id": "thread-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, prompt_cache_key: cacheKey }),
    });
  try {
    const first = await post(
      {
        model: "grok-4.7",
        input: [{ role: "user", content: "hi" }],
        tools,
      },
      "cache-1",
    );
    const firstText = await first.text();
    const second = await post(
      {
        model: "grok-4.7",
        input: [
          {
            type: "message",
            id: "m1",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
          { role: "user", content: "next" },
        ],
        tools: [...tools].reverse(),
      },
      "cache-2",
    );
    const secondText = await second.text();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(bodies.length, 2);
    assert.deepEqual(convIds, ["thread-a", "thread-a"]);
    assert.equal(bodies[0].prompt_cache_key, "thread-a");
    assert.equal(bodies[1].prompt_cache_key, "thread-a");
    assert.equal(bodies[0].store, false);
    assert.equal(
      JSON.stringify(bodies[1].input.slice(0, bodies[0].input.length)),
      JSON.stringify(bodies[0].input),
    );
    assert.ok(bodies[1].input.length > bodies[0].input.length);
    assert.match(JSON.stringify(bodies[1].input), /next/);
    assert.doesNotMatch(firstText, /cached_prompt_tokens/);
    assert.match(secondText, /"cached_prompt_tokens":0/);
    assert.match(secondText, /"cache_read_input_tokens":12/);
    assert.match(secondText, /"cache_creation_input_tokens":4/);
    assert.match(secondText, /"cached_tokens":0/);
    const records = (await readFile(join(logs, "bridge.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].event, "turn_ok");
    assert.equal(records[0].cached_prompt_tokens, undefined);
    assert.equal(records[1].cached_prompt_tokens, 0);
    assert.equal(records[1].cache_read_input_tokens, 12);
    assert.equal(records[1].cache_creation_input_tokens, 4);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});
