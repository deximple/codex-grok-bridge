import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { desktopUserDataDir } from "../src/paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const installScript = path.join(root, "scripts/install-codex-grok-app.sh");
const installPs1 = path.join(root, "scripts/install-codex-grok-app.ps1");
const launchDesktop = path.join(root, "scripts/launch-desktop.mjs");

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

test("the win32 installer finds node when Get-Command node fails", async () => {
  const text = await readFile(installPs1, "utf8");
  assert.match(text, /Get-Command node/);
  assert.match(text, /\$env:NODE/);
  assert.match(text, /ProgramFiles.*nodejs\\node\.exe|nodejs\\node\.exe/);
  assert.match(text, /ProgramFiles\(x86\)/);
  assert.match(text, /LOCALAPPDATA.*Programs\\nodejs|Programs\\nodejs\\node\.exe/);
  assert.match(text, /USERPROFILE/);
  assert.doesNotMatch(text, /Get-Command node -ErrorAction Stop/);
  assert.match(text, /refusing to install into the stock ChatGPT\/Codex prefix/);
  assert.match(text, /\$App -match "\(\?i\)WindowsApps"/);
  assert.match(text, /\$pointerDir -match "\(\?i\)WindowsApps"/);
});

test("win32 first launch starts ChatGPT when only the CIM probe matches", async () => {
  const launcher = await readFile(launchDesktop, "utf8");
  assert.match(launcher, /\$PID/);
  assert.match(launcher, /selectGrokDesktopPid/);

  const home = await mkdtemp(path.join(tmpdir(), "codex-grok-win32-launch-"));
  const local = path.join(home, "AppData", "Local");
  const userData = desktopUserDataDir(home, {
    platform: "win32",
    env: { LOCALAPPDATA: local },
  });
  const fakeDir = path.join(home, "fake");
  await mkdir(fakeDir, { recursive: true });
  const fakeApp = path.join(fakeDir, "ChatGPT.mjs");
  const record = path.join(home, "launch.out");
  const cim = JSON.stringify([
    {
      ProcessId: 4242,
      CommandLine: `powershell.exe -NoProfile -Command Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--user-data-dir=${userData}*' }`,
    },
  ]);
  try {
    await writeFile(
      fakeApp,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, "started\\n");
`,
    );
    const child = spawn(process.execPath, [launchDesktop], {
      env: {
        ...process.env,
        HOME: home,
        LOCALAPPDATA: local,
        CODEX_GROK_PLATFORM: "win32",
        CODEX_GROK_CIM_JSON: cim,
        CODEX_DESKTOP_APP: fakeApp,
      },
      stdio: "ignore",
    });
    const [code] = await Promise.race([
      once(child, "close"),
      new Promise((_, reject) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("win32 launch-desktop timed out"));
        }, 5000),
      ),
    ]);
    assert.equal(code, 0);
    assert.match(await readFile(record, "utf8"), /started/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
