import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { startRuntime } from "../src/runtime.mjs";
test("runtime binds loopback and removes its temporary catalog", async () => {
  const runtime = await startRuntime();
  assert.equal(runtime.server.address().address, "127.0.0.1");
  assert.equal(runtime.token.length, 64);
  await access(runtime.catalogPath);
  await runtime.close();
  await assert.rejects(access(runtime.catalogPath));
});

test("the provider lets Codex retry, because the bridge cannot", async () => {
  const runtime = await startRuntime();
  try {
    const config = Object.fromEntries(
      runtime.args
        .filter((arg) => arg.startsWith("model_providers.grok_build_cli."))
        .map((arg) => {
          const [key, ...rest] = arg.slice("model_providers.grok_build_cli.".length).split("=");
          return [key, rest.join("=")];
        }),
    );
    // A mid-stream reset is only recoverable by whoever owns the conversation.
    assert.equal(config.stream_max_retries, "2");
    assert.equal(config.request_max_retries, "2");
    assert.equal(config.stream_idle_timeout_ms, "300000");
  } finally {
    await runtime.close();
  }
});
