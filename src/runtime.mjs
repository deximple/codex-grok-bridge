import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createBridgeServer, MODEL_INFO } from "./bridge.mjs";

export async function startRuntime(options = {}) {
  const token = randomBytes(32).toString("hex");
  const dir = await mkdtemp(path.join(tmpdir(), "codex-grok-runtime-"));
  const catalogPath = path.join(dir, "models.json");
  await writeFile(catalogPath, JSON.stringify({ models: [MODEL_INFO] }), {
    mode: 0o600,
  });
  const server = createBridgeServer({
    token,
    ...options,
    diagnosticsOptions: {
      enabled: process.env.GROK_BRIDGE_DIAGNOSTICS !== "off",
      ...(options.diagnosticsOptions ?? {}),
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const provider = {
    name: "Grok Build CLI",
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    env_key: "CODEX_GROK_BRIDGE_TOKEN",
    wire_api: "responses",
    requires_openai_auth: false,
    // The upstream resets a response mid-stream now and then — measured three
    // times as ECONNRESET at 25s, 27s and 253s, on requests from 726 KB to
    // 22 MB. The bridge cannot retry that: Codex has already received part of
    // the answer, so re-sending would duplicate it. Codex can, because it owns
    // the conversation and re-sends the same request. These were both 0, which
    // turned every such reset into a dead turn.
    request_max_retries: 2,
    stream_max_retries: 2,
    // Do not inherit whatever Codex's default happens to be across upgrades.
    stream_idle_timeout_ms: 300000,
  };
  const tomlValue = (value) =>
    typeof value === "string" ? JSON.stringify(value) : String(value);
  const args = Object.entries(provider).flatMap(([key, value]) => [
    "-c",
    `model_providers.grok_build_cli.${key}=${tomlValue(value)}`,
  ]);
  return {
    server,
    token,
    catalogPath,
    args,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
