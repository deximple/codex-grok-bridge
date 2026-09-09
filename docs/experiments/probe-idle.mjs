// Decisive experiment: who owns the 15.1s clock — Codex, or the upstream Grok proxy?
// We stand up the REAL bridge with a STUB upstream that returns 200 + SSE headers
// and then stays silent forever. No Grok quota is consumed.
// If Codex gives up at ~15s, the clock is Codex's (stream_idle_timeout_ms).
import { spawn } from "node:child_process";
import { startRuntime } from "../../src/runtime.mjs";

const stallSeconds = Number(process.argv[2] ?? 60);
let requestAt = null;

const proxyFetch = async () => {
  requestAt = Date.now();
  const stream = new ReadableStream({
    start(controller) {
      // emit nothing at all: simulates Grok "thinking" on a 160k-token prompt
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stub","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'));
        controller.close();
      }, stallSeconds * 1000);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const runtime = await startRuntime({ proxyFetch, grokHome: "/tmp/grok-bridge-diag/fakehome" });
const started = Date.now();
const child = spawn("/Applications/Codex.app/Contents/Resources/codex", [
  "exec", ...runtime.args,
  "-c", 'model_provider="grok_build_cli"',
  "-c", `model_catalog_json=${JSON.stringify(runtime.catalogPath)}`,
  "-c", 'model_providers.grok_build_cli.request_max_retries=0',
  "-c", 'model_providers.grok_build_cli.stream_max_retries=0',
  "-m", "grok-4.6",
  "--skip-git-repo-check",
  "Reply with exactly PONG.",
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CODEX_GROK_BRIDGE_TOKEN: runtime.token, CODEX_HOME: "/tmp/grok-bridge-diag/codexhome" },
});
let out = "";
child.stdout.on("data", (c) => { out += c; });
child.stderr.on("data", (c) => { out += c; });
child.on("close", async (code) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  const sinceReq = requestAt ? ((Date.now() - requestAt) / 1000).toFixed(2) : "n/a";
  console.log(`\n### codex exited code=${code} after ${elapsed}s (${sinceReq}s after the upstream request began)`);
  console.log(out.split("\n").filter((l) => /error|disconnect|timeout|stream|PONG/i.test(l)).slice(-12).join("\n"));
  await runtime.close();
  process.exit(0);
});
