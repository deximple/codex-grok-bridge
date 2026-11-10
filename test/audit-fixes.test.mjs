import assert from "node:assert/strict";
import { symlink, mkdtemp, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BRIDGE_ERROR, classifyBridgeError } from "../src/errors.mjs";
import { createDiagnostics, redact } from "../src/diagnostics.mjs";
import { saveGeneratedImage } from "../src/imagegen.mjs";
import { completeBlocks, isFailedSseBlock } from "../src/proxy.mjs";
import {
  alignConfiguredProvider,
  applyModelProvider,
  captureProviderBaseline,
  readModelProvider,
  renderModelProvider,
  restoreProviderBaseline,
  rewriteSavedModelProvider,
} from "../src/provider-align.mjs";
import { migrateRolloutFile, rewriteRolloutText } from "../src/rollout.mjs";
import { toProxyRequest } from "../src/tools.mjs";
import {
  addUsage,
  retainedInputItems,
  stripVideoToolEvents,
} from "../src/videogen.mjs";
import { encodeServerFrame, forgetLocalCall, isLocalVoiceSideband, rememberLocalCall } from "../src/voice.mjs";

test("voice frames of 64 KiB use the 64-bit length", () => {
  const payload = Buffer.alloc(65536, 7);
  const frame = encodeServerFrame(0x1, payload);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 127);
  assert.equal(frame.readBigUInt64BE(2), 65536n);
  assert.equal(frame.length, 10 + payload.length);
  const id = rememberLocalCall("call-leak");
  assert.equal(isLocalVoiceSideband(`ws://127.0.0.1/v1/realtime?call_id=${id}`), true);
  forgetLocalCall(id);
  assert.equal(isLocalVoiceSideband(`ws://127.0.0.1/v1/realtime?call_id=${id}`), false);
});

test("a cyclic MCP schema does not fail the whole turn", () => {
  const { request } = toProxyRequest({
    model: "grok-4.7",
    input: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        name: "tree",
        parameters: {
          type: "object",
          properties: { child: { $ref: "#/$defs/Node" } },
          $defs: {
            Node: {
              type: "object",
              properties: { child: { $ref: "#/$defs/Node" } },
            },
          },
        },
      },
      {
        type: "function",
        name: "remote",
        parameters: { $ref: "https://example.com/schema.json" },
      },
    ],
  });
  assert.equal(request.tools.length >= 2, true);
});

test("SSE blocks split on CRLF and a failed event is visible", () => {
  const split = completeBlocks("event: response.created\r\ndata: {}\r\n\r\nevent: response.failed\r\ndata: {\"type\":\"response.failed\"}\r\n\r\npartial");
  assert.equal(split.parts.length, 2);
  assert.equal(isFailedSseBlock(split.parts[1]), true);
  assert.equal(split.rest, "partial");
});

test("HTTP status errors are auth, payload, or upstream status", () => {
  assert.equal(classifyBridgeError(Object.assign(new Error("no"), { status: 401 })), BRIDGE_ERROR.AUTH);
  assert.equal(classifyBridgeError(Object.assign(new Error("no"), { name: "GrokAuthError" })), BRIDGE_ERROR.AUTH);
  assert.equal(classifyBridgeError(Object.assign(new Error("no"), { status: 422 })), BRIDGE_ERROR.PAYLOAD);
  assert.equal(classifyBridgeError(Object.assign(new Error("no"), { status: 503 })), BRIDGE_ERROR.UPSTREAM_STATUS);
  assert.match(redact("authorization: bearer sekrit-token"), /bearer \[redacted\]/i);
});

test("RIFF without WEBP is not saved as webp", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "riff-"));
  const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(16)]);
  const saved = saveGeneratedImage({
    id: "ig_riff",
    type: "image_generation_call",
    result: bytes.toString("base64"),
  }, { dir, now: 1 });
  assert.equal(saved.extension, "bin");
});

test("a model-only GPT line leaves Grok and a symlink is not replaced", async () => {
  const text = [
    JSON.stringify({ type: "session_meta", payload: { model_provider: "grok_build_cli", model: "grok-4.7" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", model: "gpt-5", encrypted_content: "keep" } }),
    "",
  ].join("\n");
  const rewritten = rewriteRolloutText(text);
  assert.equal(rewritten.includes("keep"), true);
  const dir = await mkdtemp(path.join(tmpdir(), "rollout-link-"));
  const file = path.join(dir, "rollout.jsonl");
  const link = path.join(dir, "link.jsonl");
  await writeFile(file, text);
  await symlink(file, link);
  assert.equal(await migrateRolloutFile(link), false);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await rm(dir, { recursive: true, force: true });
});

test("provider config and saved thread provider can be switched without dropping other keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "provider-align-"));
  const original = "# keep\nmodel = \"gpt-5\"\n\n[notice]\nmodel_provider = \"hidden\"\n";
  assert.equal(readModelProvider(original), null);
  const next = renderModelProvider(original, "grok_build_cli");
  assert.equal(readModelProvider(next), "grok_build_cli");
  assert.match(next, /model = "gpt-5"/);
  assert.match(next, /\[notice\]\nmodel_provider = "hidden"/);
  await writeFile(path.join(dir, "config.toml"), original);
  captureProviderBaseline(dir);
  assert.equal(alignConfiguredProvider(dir, "grok_build_cli"), true);
  assert.equal(alignConfiguredProvider(dir, "grok_build_cli"), false);
  const dbPath = path.join(dir, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
  db.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("thread-1", "openai");
  db.close();
  assert.equal(await rewriteSavedModelProvider({
    codexHome: dir,
    threadId: "thread-1",
    provider: "grok_build_cli",
  }), true);
  const check = new DatabaseSync(dbPath);
  assert.equal(check.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-1").model_provider, "grok_build_cli");
  check.close();
  restoreProviderBaseline(dir);
  assert.equal(readModelProvider(readFileSync(path.join(dir, "config.toml"), "utf8")), null);
  applyModelProvider(dir, null);
  await rm(dir, { recursive: true, force: true });
});

test("video follow-up keeps the other tool call and drops the bridge tool at the limit", () => {
  const parts = [
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "function_call", name: "shell", call_id: "c1", arguments: "{\"cmd\":\"ls\"}" },
    })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "function_call", name: "grok_bridge_generate_video", call_id: "c2", arguments: "{}" },
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        output: [
          { type: "function_call", name: "grok_bridge_generate_video", call_id: "c2" },
          { type: "message", role: "assistant" },
        ],
      },
    })}`,
  ];
  const kept = retainedInputItems(parts);
  assert.equal(kept.some((item) => item.name === "shell"), true);
  assert.equal(kept.some((item) => item.name === "grok_bridge_generate_video"), false);
  const stripped = stripVideoToolEvents(parts).join("\n");
  assert.equal(stripped.includes("grok_bridge_generate_video"), false);
  assert.equal(stripped.includes("shell") || stripped.includes("message"), true);
  assert.deepEqual(addUsage({ input_tokens: 2 }, { input_tokens: 3, output_tokens: 1 }), {
    input_tokens: 5,
    output_tokens: 1,
  });
});

test("diagnostics rotate a full log", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-log-"));
  const diagnostics = createDiagnostics({ enabled: true, dir });
  writeFileSync(diagnostics.file, Buffer.alloc(4 * 1024 * 1024 + 10, 120));
  diagnostics.record({ event: "turn_ok" });
  assert.equal(statSync(`${diagnostics.file}.1`).size > 4 * 1024 * 1024, true);
  const line = readFileSync(diagnostics.file, "utf8").trim();
  assert.equal(JSON.parse(line).event, "turn_ok");
});
