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

test("the Grok provider leaves retries to the bridge", async () => {
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
    // Codex must not resend the prompt; the bridge retries before any SSE byte.
    assert.equal(config.stream_max_retries, "0");
    assert.equal(config.request_max_retries, "0");
    assert.equal(config.stream_idle_timeout_ms, "300000");
    const sideband = runtime.args.find((arg) =>
      arg.startsWith("experimental_realtime_ws_base_url="),
    );
    assert.equal(
      sideband,
      `experimental_realtime_ws_base_url=${config.base_url}`,
    );
  } finally {
    await runtime.close();
  }
});
