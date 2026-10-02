import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("bridge and realtime import when opusscript and werift cannot be resolved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-grok-voice-missing-"));
  await cp(path.join(root, "src"), path.join(dir, "src"), { recursive: true });
  const runtime = path.join(dir, "src/runtime.mjs");
  const realtime = path.join(dir, "src/realtime.mjs");
  const voice = path.join(dir, "src/voice.mjs");
  const script = `
    import { startRuntime } from ${JSON.stringify(runtime)};
    import { forwardRealtime } from ${JSON.stringify(realtime)};
    import { offerFromCallBody, startVoiceBridge } from ${JSON.stringify(voice)};
    if (typeof startRuntime !== "function") throw new Error("runtime did not load");
    if (typeof forwardRealtime !== "function") throw new Error("realtime did not load");
    if (offerFromCallBody("v=0\\r\\n", "application/sdp") !== "v=0\\r\\n") throw new Error("offer parser changed");
    let thrown = null;
    try {
      startVoiceBridge({
        track: { onReceiveRtp: { subscribe() {} } },
        socket: { readyState: 0, send() {} },
        codec: { kind: "opus", payloadType: 111 },
      });
    } catch (error) {
      thrown = error;
    }
    if (!thrown) throw new Error("voice start did not fail");
    if (!/opusscript|werift/i.test(String(thrown.message))) {
      throw new Error("unclear voice error: " + thrown.message);
    }
  `;
  try {
    const result = await run(process.execPath, ["--input-type=module", "-e", script]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
