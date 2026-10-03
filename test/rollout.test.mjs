import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateRolloutFile, migrateSessionRollouts } from "../src/rollout.mjs";

const wrapper = fileURLToPath(new URL("../scripts/codex-wrapper.mjs", import.meta.url));

const reasoning = {
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "response_item",
  payload: {
    type: "reasoning",
    id: "rs_fixture",
    summary: [{ type: "summary_text", text: "plain-summary" }],
    content: [
      { type: "reasoning_text", text: "plain-note" },
      { type: "encrypted_content", encrypted_content: "cipher-part" },
    ],
    encrypted_content: "cipher-blob",
    encrypted_function_args: "cipher-args",
    internal_chat_message_metadata_passthrough: { turn_id: "t1" },
  },
};

const message = {
  timestamp: "2026-01-01T00:00:01.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "plain-message" }],
  },
};

const messageLine = JSON.stringify(message);
const brokenLine = 'not-json {"encrypted_content":"cipher-blob"}';
const grokMetaLine = JSON.stringify({
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "session_meta",
  payload: { id: "thread-fixture", model_provider: "grok_build_cli", model: "grok-4.7" },
});

function dirtyText() {
  return `${grokMetaLine}\n${JSON.stringify(reasoning)}\n${messageLine}\n${brokenLine}\n`;
}

const cleanText =
  '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"plain-message"}],"summary":[{"type":"summary_text","text":"plain-summary"}]}}\n';

test("a fixture rollout loses ciphertext fields and keeps summary and message text", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-rollout-fixture-"));
  const file = path.join(home, "sessions", "2026", "10", "03", "rollout-fixture.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, dirtyText(), { mode: 0o600 });
  try {
    assert.equal(await migrateRolloutFile(file), true);
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    assert.equal(lines[0], grokMetaLine);
    assert.equal(lines[2], messageLine);
    assert.equal(lines[3], brokenLine);
    const stored = JSON.parse(lines[1]);
    assert.deepEqual(stored, {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "rs_fixture",
        summary: [{ type: "summary_text", text: "plain-summary" }],
        content: [{ type: "reasoning_text", text: "plain-note" }],
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
    });
    assert.equal(lines[1].includes("cipher-blob"), false);
    assert.equal(lines[1].includes("cipher-args"), false);
    assert.equal(lines[1].includes("cipher-part"), false);
    const once = await readFile(file);
    assert.equal(await migrateRolloutFile(file), false);
    assert.deepEqual(await readFile(file), once);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a fixture rollout with no ciphertext stays byte-identical", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-rollout-clean-"));
  const file = path.join(home, "sessions", "rollout-clean.jsonl");
  const prose = `${cleanText}{"text":"mentions encrypted_content in prose"}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, prose, { mode: 0o600 });
  const before = await stat(file);
  try {
    assert.equal(await migrateRolloutFile(file), false);
    assert.equal(await readFile(file, "utf8"), prose);
    const after = await stat(file);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenAI session_meta keeps encrypted_content and Grok session_meta strips it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-rollout-provider-"));
  const openaiFile = path.join(home, "sessions", "rollout-openai.jsonl");
  const grokFile = path.join(home, "sessions", "rollout-grok.jsonl");
  const openaiText = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "oa", model_provider: "openai", model: "gpt-5" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "plain-summary" }],
        encrypted_content: "openai-cipher",
      },
    }),
    "",
  ].join("\n");
  const switchedText = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "oa", model_provider: "openai", model: "gpt-5" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "plain-summary" }],
        encrypted_content: "openai-cipher",
      },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { model: "grok-4.7", model_provider: "grok_build_cli" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "later-summary" }],
        encrypted_content: "cipher-blob",
      },
    }),
    "",
  ].join("\n");
  const grokText = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "gk", model_provider: "grok_build_cli", model: "grok-4.7" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "plain-summary" }],
        encrypted_content: "cipher-blob",
        encrypted_function_args: "cipher-args",
      },
    }),
    "",
  ].join("\n");
  const switchedFile = path.join(home, "sessions", "rollout-switched.jsonl");
  await mkdir(path.dirname(openaiFile), { recursive: true });
  await writeFile(openaiFile, openaiText, { mode: 0o600 });
  await writeFile(grokFile, grokText, { mode: 0o600 });
  await writeFile(switchedFile, switchedText, { mode: 0o600 });
  try {
    assert.equal(await migrateRolloutFile(openaiFile), false);
    assert.equal(await readFile(openaiFile, "utf8"), openaiText);
    const switchedLines = (await readFile(switchedFile, "utf8")).split("\n");
    assert.equal(await migrateRolloutFile(switchedFile), true);
    const switchedAfter = (await readFile(switchedFile, "utf8")).split("\n");
    assert.equal(switchedAfter[0], switchedLines[0]);
    assert.equal(switchedAfter[1], switchedLines[1]);
    assert.equal(JSON.parse(switchedAfter[1]).payload.encrypted_content, "openai-cipher");
    assert.equal(JSON.parse(switchedAfter[3]).payload.encrypted_content, undefined);
    assert.equal(JSON.parse(switchedAfter[3]).payload.summary[0].text, "later-summary");
    assert.equal(await migrateRolloutFile(grokFile), true);
    const grokLines = (await readFile(grokFile, "utf8")).split("\n");
    assert.equal(grokLines[0], grokText.split("\n")[0]);
    const grokItem = JSON.parse(grokLines[1]);
    assert.equal(grokItem.payload.encrypted_content, undefined);
    assert.equal(grokItem.payload.encrypted_function_args, undefined);
    assert.equal(grokItem.payload.summary[0].text, "plain-summary");
    const grokBytes = await readFile(grokFile);
    assert.equal(await migrateRolloutFile(grokFile), false);
    assert.deepEqual(await readFile(grokFile), grokBytes);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("session walk skips auth.json and .grok and rewrites rollout files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-rollout-walk-"));
  const rollout = path.join(home, "sessions", "2026", "10", "03", "rollout-old.jsonl");
  const auth = path.join(home, "sessions", "auth.json");
  const grok = path.join(home, ".grok", "auth.json");
  const nested = path.join(home, "sessions", ".grok", "rollout-hidden.jsonl");
  const authText = `${JSON.stringify({ encrypted_content: "cipher-blob" })}\n`;
  await mkdir(path.dirname(rollout), { recursive: true });
  await mkdir(path.dirname(grok), { recursive: true });
  await mkdir(path.dirname(nested), { recursive: true });
  await writeFile(rollout, dirtyText(), { mode: 0o600 });
  await writeFile(auth, authText, { mode: 0o600 });
  await writeFile(grok, authText, { mode: 0o600 });
  await writeFile(nested, dirtyText(), { mode: 0o600 });
  try {
    await migrateSessionRollouts(home);
    const walked = (await readFile(rollout, "utf8")).split("\n");
    assert.equal(walked[1].includes("cipher-blob"), false);
    assert.equal(walked[1].includes("plain-summary"), true);
    assert.equal(walked[3], brokenLine);
    assert.equal(await readFile(auth, "utf8"), authText);
    assert.equal(await readFile(grok, "utf8"), authText);
    assert.equal(await readFile(nested, "utf8"), dirtyText());
    assert.equal(await migrateRolloutFile(grok), false);
    assert.equal(await readFile(grok, "utf8"), authText);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("wrapper strips rollouts before spawn and before resume or fork write", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-rollout-wrapper-"));
  const dir = path.join(home, "sessions", "2026", "10", "03");
  const early = path.join(dir, "rollout-early.jsonl");
  const clean = path.join(dir, "rollout-clean.jsonl");
  const later = path.join(dir, "rollout-later.jsonl");
  const fork = path.join(dir, "rollout-fork.jsonl");
  const stub = path.join(home, "codex-stub.mjs");
  const ready = path.join(home, "ready");
  const log = path.join(home, "stdin.log");
  await mkdir(dir, { recursive: true });
  const stored = `${grokMetaLine}\n${JSON.stringify(reasoning)}\n${messageLine}\n`;
  await writeFile(early, stored, { mode: 0o600 });
  await writeFile(clean, cleanText, { mode: 0o600 });
  await writeFile(
    stub,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.env.STUB_READY, "ready\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(process.env.STUB_LOG, line + "\\n");
});
`,
  );
  await chmod(stub, 0o755);
  const server = spawn(process.execPath, [wrapper, "app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CODEX_BINARY: stub,
      GROK_BRIDGE_DIAGNOSTICS: "off",
      STUB_READY: ready,
      STUB_LOG: log,
    },
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitFor(async () => {
      try {
        return (await readFile(ready, "utf8")).includes("ready");
      } catch {
        return false;
      }
    });
    const earlyText = await readFile(early, "utf8");
    assert.equal(earlyText.includes("cipher-blob"), false);
    assert.equal(earlyText.includes("plain-summary"), true);
    assert.equal(earlyText.includes("plain-message"), true);
    assert.equal(await readFile(clean, "utf8"), cleanText);

    await writeFile(later, stored, { mode: 0o600 });
    await writeFile(fork, stored, { mode: 0o600 });
    const threadId = "thread-fixture";
    server.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "thread/resume",
        params: { threadId, path: later },
      })}\n`,
    );
    await waitFor(async () => {
      try {
        return (await readFile(log, "utf8")).includes('"method":"thread/resume"');
      } catch {
        return false;
      }
    });
    assert.equal((await readFile(later, "utf8")).includes("cipher-blob"), false);
    assert.equal((await readFile(later, "utf8")).includes("plain-summary"), true);

    server.stdin.write(
      `${JSON.stringify({
        id: 2,
        method: "thread/fork",
        params: { threadId, path: fork },
      })}\n`,
    );
    await waitFor(async () => {
      try {
        return (await readFile(log, "utf8")).includes('"method":"thread/fork"');
      } catch {
        return false;
      }
    });
    assert.equal((await readFile(fork, "utf8")).includes("cipher-blob"), false);
    assert.equal((await readFile(fork, "utf8")).includes("plain-message"), true);
    assert.equal(stderr.includes("cipher-blob"), false);
  } finally {
    server.kill("SIGTERM");
    await once(server, "close").catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

async function waitFor(check) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for rollout migration");
}
