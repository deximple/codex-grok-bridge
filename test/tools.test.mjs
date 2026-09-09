import assert from "node:assert/strict";
import test from "node:test";

import {
  TRANSPORT_PROVENANCE,
  flattenCodexTools,
  rewriteSseBlock,
  toProxyRequest,
} from "../src/tools.mjs";

test("keeps Codex image generation tools and does not cap large catalogs", () => {
  const many = Array.from({ length: 339 }, (_, i) => ({
    type: "function",
    name: `tool_${i}`,
    parameters: { type: "object", properties: {} },
  }));
  const { request } = toProxyRequest({
    input: [],
    tools: [
      ...many,
      { type: "image_generation", quality: "high" },
      {
        type: "namespace",
        name: "image_gen",
        tools: [
          {
            type: "function",
            name: "imagegen",
            description: "Generate or edit an image",
            parameters: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"],
            },
          },
        ],
      },
    ],
  });
  assert.equal(request.tools.length, 341);
  assert.equal(
    request.tools.find((tool) => tool.type === "image_generation")?.quality,
    "high",
  );
  assert.equal(
    request.tools.some(
      (tool) =>
        tool.type === "function" &&
        String(tool.description || "").includes("[image_gen]"),
    ),
    true,
  );
});

test("flattens namespaced Codex tools into function tools", () => {
  const { tools, map } = flattenCodexTools([
    {
      type: "function",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
      },
    },
    {
      type: "namespace",
      name: "mcp__exa",
      tools: [
        {
          type: "function",
          name: "web_search_exa",
          description: "Search",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    { type: "web_search", external_web_access: true },
  ]);
  assert.equal(tools.length, 3);
  assert.equal(tools[0].type, "function");
  assert.match(tools[0].name, /^codex_0_/);
  assert.equal(map.get(tools[1].name).namespace, "mcp__exa");
  assert.equal(map.get(tools[2].name).name, "web_search");
  assert.equal(tools[2].parameters.required[0], "query");
});

test("proxy request drops Codex client metadata and provider-opaque blobs", () => {
  const { request, map } = toProxyRequest({
    model: "grok-4.6",
    instructions: "stay in Codex",
    input: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
    tool_choice: { name: "exec_command" },
    reasoning: { effort: "xhigh", summary: "detailed" },
    prompt_cache_key: "thread-cache",
    client_metadata: { secret: "nope" },
    include: ["reasoning.encrypted_content", "file_search_call.results"],
    store: true,
    stream: false,
  });
  assert.equal(request.model, "grok-4.6");
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.reasoning.effort, "xhigh");
  assert.equal(request.prompt_cache_key, "thread-cache");
  assert.equal(request.include, undefined);
  assert.equal(request.client_metadata, undefined);
  assert.equal(request.tool_choice.type, "function");
  assert.equal(map.get(request.tool_choice.name).name, "exec_command");
});

test("keeps plain reasoning summaries but strips compaction and encrypted content", () => {
  const { request } = toProxyRequest({
    input: [
      {
        type: "reasoning",
        id: "reason-1",
        summary: [{ type: "summary_text", text: "visible summary" }],
        content: null,
        encrypted_content: "opaque-openai-reasoning",
      },
      {
        type: "compaction",
        encrypted_content: "opaque-openai-compaction",
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "visible" },
          { type: "encrypted_content", encrypted_content: "opaque-message" },
        ],
      },
    ],
    include: ["reasoning.encrypted_content"],
    tools: [],
  });
  assert.equal(request.include, undefined);
  assert.equal(request.input.length, 2);
  // The summary survives; Codex's item id, null content and the opaque blob do not.
  assert.deepEqual(request.input[0], {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "visible summary" }],
  });
  assert.deepEqual(request.input[1].content, [
    { type: "input_text", text: "visible" },
  ]);
});

test("drops a reasoning item that carries no readable summary", () => {
  const { request } = toProxyRequest({
    input: [
      { type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque" },
      { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "   " }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
    tools: [],
  });
  assert.equal(request.input.length, 1, "only the user message should remain");
  assert.equal(request.input[0].role, "user");
});

test("strips Codex passthrough metadata from items sent to Grok", () => {
  const { request } = toProxyRequest({
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "t1",
          content_item_kinds: ["unknown"],
        },
      },
      {
        type: "function_call",
        name: "exec_command",
        arguments: "{\"cmd\":\"pwd\"}",
        call_id: "call-1",
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: " /tmp\n",
        internal_chat_message_metadata_passthrough: { create_time: 1 },
      },
    ],
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }],
  });
  assert.equal(request.input.length, 3);
  for (const item of request.input) {
    assert.equal(item.internal_chat_message_metadata_passthrough, undefined);
  }
  assert.equal(request.input[1].type, "function_call");
  assert.equal(request.input[1].call_id, "call-1");
  assert.equal(request.input[2].type, "function_call_output");
  assert.equal(request.input[2].output, " /tmp\n");
});

test("converts desktop rollout item shapes into Grok-accepted input only", () => {
  const original = [
    {
      type: "message",
      id: "msg-1",
      role: "user",
      content: [{ type: "input_text", text: "check grok" }],
      internal_chat_message_metadata_passthrough: {
        turn_id: "t1",
        content_item_kinds: ["generic.developer_instructions"],
      },
    },
    {
      type: "function_call",
      id: "fc_abc_0",
      name: "exec_command",
      arguments: "{\"cmd\":\"pwd\"}",
      call_id: "call-0",
      internal_chat_message_metadata_passthrough: { turn_id: "t1" },
    },
    {
      type: "function_call_output",
      id: "fco_abc",
      call_id: "call-0",
      output: "BRIDGE_OK\n",
      internal_chat_message_metadata_passthrough: { create_time: 1 },
    },
    {
      type: "agent_message",
      id: "amsg-keep",
      content: [{ type: "input_text", text: "visible assistant" }],
      internal_chat_message_metadata_passthrough: { turn_id: "t1" },
    },
    {
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: "only-secret" }],
    },
    {
      type: "local_shell_call",
      call_id: "call-shell",
      status: "completed",
      action: { command: ["echo"] },
    },
  ];
  const snapshot = structuredClone(original);
  const { request } = toProxyRequest({
    input: original,
    tools: [
      {
        type: "function",
        name: "exec_command",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  const allowed = new Set([
    "message",
    "reasoning",
    "function_call",
    "function_call_output",
    "shell_call",
  ]);
  assert.deepEqual(original, snapshot);
  for (const item of request.input) {
    assert.equal(item.internal_chat_message_metadata_passthrough, undefined);
    assert.ok(item.type == null || allowed.has(item.type), item.type);
    assert.notEqual(item.type, "agent_message");
    assert.notEqual(item.type, "local_shell_call");
  }
  assert.ok(
    request.input.some(
      (item) =>
        item.type === "message" &&
        item.role === "assistant" &&
        JSON.stringify(item.content).includes("visible assistant"),
    ),
  );
  assert.equal(
    request.input.some((item) => JSON.stringify(item).includes("only-secret")),
    false,
  );
});

test("rewrites Codex agent_message items into Grok assistant messages", () => {
  const { request } = toProxyRequest({
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "agent_message",
        id: "amsg-1",
        author: "worker",
        recipient: "user",
        content: [
          { type: "input_text", text: "done" },
          { type: "encrypted_content", encrypted_content: "opaque" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
      {
        type: "agent_message",
        text: "sdk shape",
      },
      {
        type: "agent_message",
        author: "worker",
        recipient: "user",
        content: [{ type: "encrypted_content", encrypted_content: "only-secret" }],
      },
      {
        type: "local_shell_call",
        call_id: "call-1",
        status: "completed",
        action: { command: ["pwd"] },
      },
    ],
    tools: [],
  });
  assert.deepEqual(request.input, [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "input_text", text: "done" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "input_text", text: "sdk shape" }],
    },
  ]);
});

test("omits tool choice fields when the request has no tools", () => {
  const { request } = toProxyRequest({
    input: [{ role: "user", content: "hi" }],
    tools: [],
  });
  // Grok's own image tool is always declared, so the model can generate an
  // image without Codex offering a tool for it.
  assert.deepEqual(request.tools, [{ type: "image_generation" }]);
  assert.equal(request.tool_choice, undefined);
  assert.equal(request.parallel_tool_calls, undefined);
});

test("normalizes custom tools and prior history for the Grok proxy", () => {
  const patch = "*** Begin Patch\n*** Add File: bridge.txt\n+ok\n*** End Patch\n";
  const { request } = toProxyRequest({
    input: [
      {
        type: "function_call",
        call_id: "exec-1",
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
      },
      {
        type: "function_call_output",
        call_id: "exec-1",
        name: "exec_command",
        output: "/tmp/project",
      },
      {
        type: "custom_tool_call",
        call_id: "patch-1",
        namespace: "functions",
        name: "apply_patch",
        input: patch,
      },
      {
        type: "custom_tool_call_output",
        call_id: "patch-1",
        output: "Done!",
      },
    ],
    tools: [
      {
        type: "function",
        name: "exec_command",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "namespace",
        name: "functions",
        tools: [{ type: "custom", name: "apply_patch" }],
      },
    ],
  });
  const [execCall, execOutput, patchCall, patchOutput] = request.input;
  assert.match(execCall.name, /^codex_0_exec_command$/);
  assert.equal(execOutput.name, execCall.name);
  assert.equal(patchCall.type, "function_call");
  assert.match(patchCall.name, /^codex_1_apply_patch$/);
  assert.equal(patchCall.namespace, undefined);
  assert.deepEqual(JSON.parse(patchCall.arguments), { input: patch });
  assert.equal(patchCall.input, undefined);
  assert.equal(patchOutput.type, "function_call_output");

  const patchTool = request.tools.find((tool) => tool.name === patchCall.name);
  assert.equal(patchTool.parameters.required[0], "input");
  assert.equal(patchTool.parameters.properties.input.type, "string");
});

test("rewrites streamed function names back to Codex namespaces", () => {
  const { tools, map } = flattenCodexTools([
    {
      type: "namespace",
      name: "functions",
      tools: [{ type: "custom", name: "apply_patch" }],
    },
  ]);
  const block = rewriteSseBlock(
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: tools[0].name,
        arguments: "*** Begin Patch",
        call_id: "c1",
      },
    })}`,
    map,
  );
  const payload = JSON.parse(block.split("data: ")[1]);
  assert.equal(payload.item.type, "custom_tool_call");
  assert.equal(payload.item.namespace, "functions");
  assert.equal(payload.item.name, "apply_patch");
  assert.equal(payload.item.input, "*** Begin Patch");
});

test("rewrites Grok proxy custom tool calls back to Codex freeform input", () => {
  const patch = "*** Begin Patch\n*** Add File: bridge.txt\n+ok\n*** End Patch\n";
  const { tools, map } = flattenCodexTools([
    {
      type: "namespace",
      name: "functions",
      tools: [{ type: "custom", name: "apply_patch" }],
    },
  ]);
  const block = rewriteSseBlock(
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: tools[0].name,
        arguments: JSON.stringify({ input: patch }),
        call_id: "patch-1",
      },
    })}`,
    map,
  );
  const payload = JSON.parse(block.split("data: ")[1]);
  assert.equal(payload.item.type, "custom_tool_call");
  assert.equal(payload.item.namespace, "functions");
  assert.equal(payload.item.name, "apply_patch");
  assert.equal(payload.item.input, patch);
  assert.equal(payload.item.arguments, undefined);
});

test("the bridge states its own provenance so the model need not go looking", () => {
  const withInstructions = toProxyRequest({
    instructions: "Follow the project guidelines.",
    input: [{ role: "user", content: "hi" }],
    tools: [],
  }).request;
  assert.match(withInstructions.instructions, /^Follow the project guidelines\./);
  assert.match(withInstructions.instructions, /grok_build_cli/);
  assert.match(withInstructions.instructions, /no tool call is needed/);

  // Codex does not always send instructions; the provenance must survive anyway.
  const bare = toProxyRequest({ input: [], tools: [] }).request;
  assert.equal(bare.instructions, TRANSPORT_PROVENANCE);
});

test("Grok's image tool is declared once, and can be turned off", async () => {
  const { request } = toProxyRequest({ input: [], tools: [] });
  assert.equal(
    request.tools.filter((tool) => tool.type === "image_generation").length,
    1,
  );

  // A request that already asks for it is left alone rather than doubled.
  const explicit = toProxyRequest({
    input: [],
    tools: [{ type: "image_generation", quality: "high" }],
  }).request;
  assert.deepEqual(explicit.tools, [{ type: "image_generation", quality: "high" }]);

  const previous = process.env.GROK_BRIDGE_IMAGE_GEN;
  try {
    process.env.GROK_BRIDGE_IMAGE_GEN = "off";
    assert.deepEqual(toProxyRequest({ input: [], tools: [] }).request.tools, []);
  } finally {
    if (previous === undefined) delete process.env.GROK_BRIDGE_IMAGE_GEN;
    else process.env.GROK_BRIDGE_IMAGE_GEN = previous;
  }
});

test("a generated image is saved and handed to Codex as an assistant message", async () => {
  const { createSseRewriter } = await import("../src/tools.mjs");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const dir = mkdtempSync(nodePath.join(tmpdir(), "sse-imagegen-"));
  const rewrite = createSseRewriter(new Map(), { imageOptions: { dir } });

  const bytes = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.alloc(512, 1)]);
  const done = rewrite(
    "event: response.output_item.done\n" +
      "data: " +
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "ig_1",
          type: "image_generation_call",
          status: "completed",
          result: bytes.toString("base64"),
          prompt: "a red circle",
        },
      }),
  );
  const payload = JSON.parse(done.split("data: ")[1]);
  assert.equal(payload.item.type, "message", "Codex has no image_generation_call type");
  assert.equal(payload.item.role, "assistant");
  const text = payload.item.content[0].text;
  assert.match(text, /Image generated by Grok and saved to/);
  const file = text.match(/saved to (\S+) \(/)[1];
  assert.ok(readFileSync(file).equals(bytes), "the bytes must reach disk intact");
});

test("image tool progress chatter is not forwarded to Codex", async () => {
  const { createSseRewriter } = await import("../src/tools.mjs");
  const rewrite = createSseRewriter(new Map());
  for (const type of [
    "response.image_generation_call.in_progress",
    "response.image_generation_call.generating",
    "response.image_generation_call.completed",
  ])
    assert.equal(
      rewrite(`event: ${type}\ndata: ${JSON.stringify({ type })}`),
      null,
      `${type} must be dropped`,
    );

  // The announcement before any bytes exist is dropped too; the .done block
  // carries the result.
  assert.equal(
    rewrite(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"image_generation_call","id":"ig_1"}}',
    ),
    null,
  );

  // Ordinary events still pass through.
  assert.ok(
    rewrite('event: response.completed\ndata: {"type":"response.completed"}'),
  );
});
