import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const home = await mkdtemp(path.join(tmpdir(), "codex-provider-verifier-"));
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./codex-wrapper.mjs", import.meta.url)), "app-server"],
  { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CODEX_HOME: home } },
);
const exited = once(child, "close");
const pending = new Map();
let counter = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("RPC timeout: " + method));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(Error(msg.error.message)) : resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
try {
  await request("initialize", {
    clientInfo: { name: "grok-bridge-verifier", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const models = await request("model/list", { limit: 100 });
  assert.ok(models.data.some((m) => m.id === "grok-4.6"));
  const gpt = models.data.find((m) => m.id.startsWith("gpt"));
  assert.ok(gpt);
  const threadId = randomUUID();
  const timestamp = new Date().toISOString();
  const sessions = path.join(home, "sessions");
  await mkdir(sessions);
  const rollout = path.join(sessions, `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${threadId}.jsonl`);
  const fixture = [
    { type: "session_meta", payload: { id: threadId, timestamp, cwd: process.cwd(), originator: "provider-verifier", cli_version: "0.153.4", model_provider: "openai", source: "cli" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Keep this verification history." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "History fixture; no inference was executed." }] } },
  ].map((item) => JSON.stringify({ timestamp, ...item }) + "\n").join("");
  await writeFile(rollout, fixture, { mode: 0o600 });
  const original = await request("thread/resume", {
    threadId,
    path: rollout,
    model: gpt.model,
    modelProvider: "openai",
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
  const transitions = [];
  for (const [model, provider] of [["grok-4.6", "grok_build_cli"], [gpt.model, "openai"]]) {
    await request("thread/settings/update", { threadId, model });
    const resumed = await request("thread/resume", { threadId, excludeTurns: true });
    assert.equal(resumed.thread.id, threadId);
    assert.equal(resumed.modelProvider, provider);
    assert.equal(resumed.model, model);
    assert.equal(resumed.approvalPolicy, original.approvalPolicy);
    assert.deepEqual(resumed.sandbox, original.sandbox);
    transitions.push({ model: resumed.model, provider: resumed.modelProvider });
  }
  assert.ok((await readFile(rollout, "utf8")).startsWith(fixture));
  console.log(JSON.stringify({
    models: models.data.map((m) => m.id),
    transitions,
    sameThread: true,
    permissionsPreserved: true,
    inferenceExecuted: false,
  }));
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  const killer = new Promise((resolve) =>
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000),
  );
  await Promise.race([exited, killer]);
  lines.close();
  await rm(home, { recursive: true, force: true });
}
