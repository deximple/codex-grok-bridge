#!/usr/bin/env node
import { spawn } from "node:child_process";
import { startRuntime } from "../src/runtime.mjs";
const runtime = await startRuntime();
const userArgs = process.argv.slice(2);
const overrides = [
  ...runtime.args,
  "-c",
  'model_provider="grok_build_cli"',
  "-c",
  `model_catalog_json=${JSON.stringify(runtime.catalogPath)}`,
  "-m",
  "grok-4.6",
];
const args =
  userArgs[0] === "exec"
    ? [userArgs[0], ...overrides, ...userArgs.slice(1)]
    : [...overrides, ...userArgs];
const child = spawn("/Applications/Codex.app/Contents/Resources/codex", args, {
  stdio: "inherit",
  env: { ...process.env, CODEX_GROK_BRIDGE_TOKEN: runtime.token },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => process.stderr.write("Could not start Codex\n"));
child.on("close", async (code) => {
  await runtime.close();
  process.exit(code ?? 1);
});
