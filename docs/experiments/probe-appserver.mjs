// Drive the REAL desktop path: codex-wrapper -> codex app-server -> bridge -> stalling stub.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const stall = process.argv[2] ?? "40000";
const home = await mkdtemp(path.join(tmpdir(), "probe-appserver-"));
const child = spawn(process.execPath, ["/tmp/grok-bridge-diag/stub-wrapper.mjs", "app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, CODEX_HOME: home, STUB_STALL_MS: stall },
});
const pending = new Map(); let counter = 0;
const t0 = Date.now(); const mark = () => ((Date.now() - t0) / 1000).toFixed(2) + "s";
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method && /turn|item|error|thread/.test(m.method)) {
    const s = JSON.stringify(m.params ?? {});
    if (/error|failed|complete|aborted/i.test(m.method) || /error/i.test(s))
      console.log(`[${mark()}] ${m.method} ${s.slice(0, 400)}`);
  }
});
const req = (method, params) => new Promise((res, rej) => {
  const id = ++counter;
  const t = setTimeout(() => rej(new Error("rpc timeout " + method)), 120000);
  pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
await req("initialize", { clientInfo: { name: "probe", version: "1" }, capabilities: { experimentalApi: true } });
child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const thread = await req("thread/start", { model: "grok-4.6", cwd: process.cwd(), sandbox: "read-only", approvalPolicy: "never" });
const threadId = thread.thread.id;
console.log(`[${mark()}] thread started provider=${thread.modelProvider} model=${thread.model}`);
const turnStart = Date.now();
try {
  await req("turn/start", { threadId, input: [{ type: "text", text: "Reply with exactly PONG." }] });
} catch (e) { console.log(`[${mark()}] turn/start rejected: ${e.message}`); }
await new Promise((r) => setTimeout(r, Number(stall) + 20000));
console.log(`### probe done; turn window was ${((Date.now() - turnStart) / 1000).toFixed(1)}s with stall=${stall}ms`);
child.kill("SIGTERM");
await rm(home, { recursive: true, force: true });
process.exit(0);
