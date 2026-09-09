// Control: is the bridge's ": keepalive" comment load-bearing for Codex's tolerance?
// Same stub, but the SSE stream sends NOTHING at all (keepalive suppressed by
// standing up a bare server rather than the bridge).
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL_INFO } from "../../src/bridge.mjs";

const token = randomBytes(16).toString("hex");
const dir = await mkdtemp(path.join(tmpdir(), "probe-"));
const catalogPath = path.join(dir, "models.json");
await writeFile(catalogPath, JSON.stringify({ models: [MODEL_INFO] }));
let requestAt = null;
const server = http.createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({models:[MODEL_INFO]})); }
  req.resume();
  req.on("end", () => {
    requestAt = Date.now();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // total silence — no events, no keepalive comments
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const started = Date.now();
const child = spawn("/Applications/Codex.app/Contents/Resources/codex", [
  "exec",
  "-c", `model_providers.grok_build_cli.name="stub"`,
  "-c", `model_providers.grok_build_cli.base_url="http://127.0.0.1:${port}/v1"`,
  "-c", `model_providers.grok_build_cli.env_key="CODEX_GROK_BRIDGE_TOKEN"`,
  "-c", `model_providers.grok_build_cli.wire_api="responses"`,
  "-c", `model_providers.grok_build_cli.requires_openai_auth=false`,
  "-c", `model_providers.grok_build_cli.request_max_retries=0`,
  "-c", `model_providers.grok_build_cli.stream_max_retries=0`,
  "-c", 'model_provider="grok_build_cli"',
  "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`,
  "-m", "grok-4.6", "--skip-git-repo-check", "Reply with exactly PONG.",
], { stdio: ["ignore","pipe","pipe"], env: { ...process.env, CODEX_GROK_BRIDGE_TOKEN: token, CODEX_HOME: "/tmp/grok-bridge-diag/codexhome" } });
let out=""; child.stdout.on("data",c=>out+=c); child.stderr.on("data",c=>out+=c);
child.on("close", (code) => {
  const since = requestAt ? ((Date.now()-requestAt)/1000).toFixed(2) : "n/a";
  console.log(`### NO-KEEPALIVE: codex exited code=${code} after ${((Date.now()-started)/1000).toFixed(2)}s (${since}s after request)`);
  console.log(out.split("\n").filter(l=>/error|disconnect|timeout|stream/i.test(l)).slice(-6).join("\n"));
  server.close(); process.exit(0);
});
setTimeout(() => { console.log("### NO-KEEPALIVE: still alive at 400s"); child.kill(); }, 400000);
