import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  DARWIN_CODEX_APP,
  DARWIN_CODEX_BINARY,
  LINUX_CHATGPT_BIN,
  LINUX_CODEX_BINARY,
  desktopLaunchArgs,
  desktopLaunchEnv,
  desktopUserDataDir,
  isForbiddenInstallDir,
  isGrokDesktopProcess,
  linuxAppDir,
  linuxDesktopEntry,
  linuxDesktopEntryPath,
  resolveCodexBinary,
  resolveDesktopApp,
  resolveGrokBinary,
  win32AppDir,
} from "../src/paths.mjs";
import { DEFAULT_LIMIT, DEFAULT_QUEUE_LIMIT } from "../src/slots.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("linux resolves the bundled ChatGPT CLI, not the Mac Codex.app path", () => {
  assert.equal(resolveCodexBinary({ platform: "linux", env: {} }), LINUX_CODEX_BINARY);
  assert.equal(resolveDesktopApp({ platform: "linux", env: {} }), LINUX_CHATGPT_BIN);
  assert.equal(LINUX_CODEX_BINARY, "/usr/lib/chatgpt/resources/codex");
  assert.equal(LINUX_CHATGPT_BIN, "/usr/lib/chatgpt/ChatGPT");
});

test("darwin keeps the Codex.app bundled CLI", () => {
  assert.equal(resolveCodexBinary({ platform: "darwin", env: {} }), DARWIN_CODEX_BINARY);
  assert.equal(resolveDesktopApp({ platform: "darwin", env: {} }), DARWIN_CODEX_APP);
});

test("explicit overrides win so tests can point at a fake binary", () => {
  assert.equal(
    resolveCodexBinary({ platform: "linux", env: { CODEX_BINARY: "/tmp/codex" } }),
    "/tmp/codex",
  );
  assert.equal(
    resolveDesktopApp({ platform: "linux", env: { CODEX_DESKTOP_APP: "/tmp/ChatGPT" } }),
    "/tmp/ChatGPT",
  );
});

test("the dedicated desktop profile stays under the bridge user-data dir", () => {
  assert.equal(
    desktopUserDataDir("/home/ubuntu", { platform: "linux", env: {} }),
    path.join("/home/ubuntu", ".local/share/codex-grok-bridge/desktop"),
  );
  assert.equal(
    linuxAppDir("/home/ubuntu"),
    path.join("/home/ubuntu", ".local/share/codex-grok-bridge/app"),
  );
  assert.equal(
    linuxDesktopEntryPath("/home/ubuntu"),
    path.join("/home/ubuntu", ".local/share/applications/codex-grok.desktop"),
  );
  assert.equal(
    linuxDesktopEntryPath("/home/ubuntu", "/tmp/xdg"),
    path.join("/tmp/xdg", "applications/codex-grok.desktop"),
  );
});

test("desktop launch env is the same hook Mac Codex Grok.app uses", () => {
  const userData = desktopUserDataDir("/home/ubuntu");
  assert.deepEqual(desktopLaunchArgs(userData), [`--user-data-dir=${userData}`]);
  assert.deepEqual(
    desktopLaunchEnv({
      wrapper: "/tmp/wrapper.mjs",
      userData,
      pathPrefix: "/usr/bin",
    }),
    {
      CODEX_CLI_PATH: "/tmp/wrapper.mjs",
      CODEX_APP_SERVER_FORCE_CLI: "1",
      CODEX_ELECTRON_USER_DATA_PATH: userData,
      PATH: "/usr/bin",
    },
  );
});

test("a Linux ChatGPT process with the dedicated profile is ours", () => {
  const userData = desktopUserDataDir("/home/ubuntu");
  assert.equal(
    isGrokDesktopProcess(
      `1234 ${LINUX_CHATGPT_BIN} --user-data-dir=${userData}`,
      userData,
      { platform: "linux", env: {} },
    ),
    true,
  );
  assert.equal(
    isGrokDesktopProcess(
      `1234 ${LINUX_CHATGPT_BIN} --user-data-dir=${userData} Helper`,
      userData,
      { platform: "linux", env: {} },
    ),
    false,
  );
  assert.equal(
    isGrokDesktopProcess(
      `99 /Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=${userData}`,
      userData,
      { platform: "darwin", env: {} },
    ),
    true,
  );
  const winUser = "C:/Users/agent/AppData/Local/codex-grok-bridge/desktop";
  assert.equal(
    isGrokDesktopProcess(
      `4321 C:/Users/agent/AppData/Local/codex-grok-bridge/app/ChatGPT.exe --user-data-dir=${winUser}`,
      winUser,
      {
        platform: "win32",
        env: { LOCALAPPDATA: "C:/Users/agent/AppData/Local" },
        home: "C:/Users/agent",
      },
    ),
    true,
  );
});

test("the installer must not write the stock ChatGPT or Codex.app prefix", () => {
  assert.equal(isForbiddenInstallDir("/usr/lib/chatgpt"), true);
  assert.equal(isForbiddenInstallDir("/usr/lib/chatgpt/resources"), true);
  assert.equal(isForbiddenInstallDir("/Applications/Codex.app"), true);
  assert.equal(isForbiddenInstallDir("/home/ubuntu/.local/share/codex-grok-bridge/app"), false);
});

test("the Linux desktop entry launches the wrapper, not stock chatgpt", () => {
  const text = linuxDesktopEntry({
    exec: '"/home/ubuntu/.local/share/codex-grok-bridge/app/bin/codex-grok-desktop" %U',
  });
  assert.match(text, /^Name=Codex Grok$/m);
  assert.match(text, /codex-grok-desktop/);
  assert.doesNotMatch(text, /^Exec=chatgpt /m);
});

test("slot concurrency stays at 4 with a queue of 8", () => {
  assert.equal(DEFAULT_LIMIT, 4);
  assert.equal(DEFAULT_QUEUE_LIMIT, 8);
});

test("win32 uses LocalAppData for the isolated profile and grok.exe", () => {
  const home = "C:/Users/agent";
  const env = { LOCALAPPDATA: "C:/Users/agent/AppData/Local" };
  assert.equal(
    win32AppDir(home, { env }),
    path.join(env.LOCALAPPDATA, "codex-grok-bridge", "app"),
  );
  assert.equal(
    desktopUserDataDir(home, { platform: "win32", env }),
    path.join(env.LOCALAPPDATA, "codex-grok-bridge", "desktop"),
  );
  assert.equal(
    resolveCodexBinary({ platform: "win32", home, env }),
    path.join(env.LOCALAPPDATA, "codex-grok-bridge", "app", "codex.exe"),
  );
  assert.equal(
    resolveDesktopApp({ platform: "win32", home, env }),
    path.join(env.LOCALAPPDATA, "codex-grok-bridge", "app", "ChatGPT.exe"),
  );
  assert.equal(
    resolveGrokBinary(home, { platform: "win32", env: {} }),
    path.join(home, ".grok", "bin", "grok.exe"),
  );
  assert.equal(
    isForbiddenInstallDir("C:/Program Files/WindowsApps/OpenAI.Codex_1.0/app"),
    true,
  );
  assert.equal(isForbiddenInstallDir("C:/Users/agent/AppData/Local/codex-grok-bridge/app"), false);
});

test("the published package allows npm install on linux", () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  assert.deepEqual(pkg.os, ["darwin", "linux"]);
});
