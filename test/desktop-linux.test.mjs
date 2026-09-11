import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { desktopUserDataDir } from "../src/paths.mjs";

const linuxOnly = process.platform === "win32" ? test.skip : test;
const root = fileURLToPath(new URL("..", import.meta.url));
const installScript = path.join(root, "scripts/install-codex-grok-app.sh");
const wrapper = path.join(root, "scripts/codex-wrapper.mjs");
const grokCli = path.join(root, "scripts/codex-grok.mjs");
const launchDesktop = path.join(root, "scripts/launch-desktop.mjs");
const verifyAppServer = path.join(root, "scripts/verify-app-server.mjs");

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

linuxOnly("the Linux installer creates a separate app and never writes /usr/lib/chatgpt", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-grok-linux-home-"));
  const stock = path.join(home, "stock-chatgpt");
  await mkdir(stock, { recursive: true });
  await writeFile(path.join(stock, "marker"), "stock\n");
  try {
    const result = await run("sh", [installScript], {
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(home, ".local/share"),
        CODEX_GROK_PLATFORM: "linux",
        NODE: process.execPath,
      },
    });
    assert.equal(result.code, 0, result.stderr);
    const app = path.join(home, ".local/share/codex-grok-bridge/app");
    const launcher = path.join(app, "bin/codex-grok-desktop");
    const desktop = path.join(home, ".local/share/applications/codex-grok.desktop");
    await stat(path.join(app, "scripts/codex-wrapper.mjs"));
    await stat(path.join(app, "src/paths.mjs"));
    await stat(launcher);
    const desktopText = await readFile(desktop, "utf8");
    const launcherText = await readFile(launcher, "utf8");
    assert.match(desktopText, /Name=Codex Grok/);
    assert.match(desktopText, /codex-grok-desktop/);
    assert.match(launcherText, /launch-desktop\.mjs/);
    assert.doesNotMatch(desktopText, /\/usr\/lib\/chatgpt/);
    assert.equal(await readFile(path.join(stock, "marker"), "utf8"), "stock\n");
    const forbidden = await run("sh", [installScript], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_GROK_PLATFORM: "linux",
        CODEX_GROK_APP: "/usr/lib/chatgpt",
        NODE: process.execPath,
      },
    });
    assert.notEqual(forbidden.code, 0);
    assert.match(forbidden.stderr, /stock|refusing|chatgpt/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

linuxOnly("codex-wrapper and codex-grok spawn the Linux bundled CLI", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-grok-binary-"));
  const record = path.join(dir, "record.txt");
  const fake = path.join(dir, "codex");
  await writeFile(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(record)}
`,
  );
  await chmod(fake, 0o755);
  try {
    const wrapped = await run(process.execPath, [wrapper, "--version"], {
      env: { ...process.env, CODEX_BINARY: fake, CODEX_GROK_PLATFORM: "linux" },
    });
    assert.equal(wrapped.code, 0, wrapped.stderr);
    assert.equal((await readFile(record, "utf8")).trim(), "--version");

    const grok = await run(process.execPath, [grokCli, "exec", "--help"], {
      env: {
        ...process.env,
        CODEX_BINARY: fake,
        CODEX_GROK_PLATFORM: "linux",
        GROK_BRIDGE_DIAGNOSTICS: "off",
      },
    });
    assert.equal(grok.code, 0, grok.stderr);
    const grokArgs = await readFile(record, "utf8");
    assert.match(grokArgs, /model_provider="grok_build_cli"/);
    assert.match(grokArgs, /^exec\n/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify:app-server fails fast when the bundled Codex CLI is missing", async () => {
  const result = await run(process.execPath, [verifyAppServer], {
    env: { ...process.env, CODEX_BINARY: "/no/such/codex" },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /skipped: bundled Codex CLI not found/);
});

linuxOnly("launch-desktop starts Linux ChatGPT with the wrapper and a separate profile", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-grok-launch-"));
  const fakeDir = path.join(home, "usr/lib/chatgpt");
  await mkdir(fakeDir, { recursive: true });
  const fakeApp = path.join(fakeDir, "ChatGPT");
  const record = path.join(home, "launch.out");
  await writeFile(
    fakeApp,
    `#!/bin/sh
{
  printf 'CODEX_CLI_PATH=%s\\n' "$CODEX_CLI_PATH"
  printf 'CODEX_APP_SERVER_FORCE_CLI=%s\\n' "$CODEX_APP_SERVER_FORCE_CLI"
  printf 'CODEX_ELECTRON_USER_DATA_PATH=%s\\n' "$CODEX_ELECTRON_USER_DATA_PATH"
  printf 'ARGS=%s\\n' "$*"
} > ${JSON.stringify(record)}
`,
  );
  await chmod(fakeApp, 0o755);
  try {
    const child = spawn(process.execPath, [launchDesktop], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_GROK_PLATFORM: "linux",
        CODEX_DESKTOP_APP: fakeApp,
      },
      stdio: "ignore",
    });
    const [code] = await Promise.race([
      once(child, "close"),
      new Promise((_, reject) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("launch-desktop timed out"));
        }, 5000),
      ),
    ]);
    assert.equal(code, 0);
    const text = await readFile(record, "utf8");
    const userData = desktopUserDataDir(home);
    assert.match(text, new RegExp(`CODEX_CLI_PATH=${wrapper}`));
    assert.match(text, /CODEX_APP_SERVER_FORCE_CLI=1/);
    assert.match(text, new RegExp(`CODEX_ELECTRON_USER_DATA_PATH=${userData}`));
    assert.match(text, new RegExp(`ARGS=--user-data-dir=${userData}`));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
