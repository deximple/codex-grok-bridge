import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const installScript = path.join(root, "scripts/install-codex-grok-app.sh");
const installPs1 = path.join(root, "scripts/install-codex-grok-app.ps1");

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

test("the win32 installer writes LocalAppData and refuses WindowsApps", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-grok-win32-home-"));
  const local = path.join(home, "AppData", "Local");
  const roaming = path.join(home, "AppData", "Roaming");
  try {
    const result = process.platform === "win32"
      ? await run("powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          installPs1,
        ], {
          env: {
            ...process.env,
            HOME: home,
            LOCALAPPDATA: local,
            APPDATA: roaming,
            NODE: process.execPath,
          },
        })
      : await run("sh", [installScript], {
          env: {
            ...process.env,
            HOME: home,
            LOCALAPPDATA: local,
            APPDATA: roaming,
            CODEX_GROK_PLATFORM: "win32",
            NODE: process.execPath,
          },
        });
    assert.equal(result.code, 0, result.stderr);
    const app = path.join(local, "codex-grok-bridge", "app");
    const launcher = path.join(app, "codex-grok-desktop.cmd");
    const startMenu = path.join(
      roaming,
      "Microsoft/Windows/Start Menu/Programs/Codex Grok.cmd",
    );
    await stat(path.join(app, "scripts/codex-wrapper.mjs"));
    await stat(path.join(app, "src/models.mjs"));
    await stat(path.join(app, "src/paths.mjs"));
    const launcherText = await readFile(launcher, "utf8");
    assert.match(launcherText, /launch-desktop\.mjs/);
    assert.match(launcherText, /@echo off/);
    assert.equal(await readFile(startMenu, "utf8"), launcherText);
    assert.match(result.stdout, /win32 wrapper/);

    const forbiddenEnv = {
      ...process.env,
      HOME: home,
      LOCALAPPDATA: local,
      APPDATA: roaming,
      CODEX_GROK_PLATFORM: "win32",
      CODEX_GROK_APP: path.join(local, "WindowsApps", "ChatGPT"),
      NODE: process.execPath,
    };
    const forbidden = process.platform === "win32"
      ? await run("powershell.exe", [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          installPs1,
        ], { env: forbiddenEnv })
      : await run("sh", [installScript], { env: forbiddenEnv });
    assert.notEqual(forbidden.code, 0);
    assert.match(forbidden.stderr, /stock|refusing|WindowsApps/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
