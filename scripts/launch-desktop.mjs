import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopLaunchArgs,
  desktopLaunchEnv,
  desktopUserDataDir,
  isGrokDesktopProcess,
  resolveDesktopApp,
  resolvePlatform,
} from "../src/paths.mjs";

const platform = resolvePlatform();
const userData = desktopUserDataDir();
const logFile = path.join(userData, "..", "launch.log");
mkdirSync(userData, { recursive: true, mode: 0o700 });
mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });

function log(message) {
  appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}

function grokPid() {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  for (const line of out.split("\n")) {
    if (isGrokDesktopProcess(line, userData))
      return Number(line.trim().split(/\s+/)[0]);
  }
  return null;
}

function activate(pid) {
  execFileSync("/usr/bin/osascript", [
    "-e",
    `tell application "System Events"
       set p to first process whose unix id is ${pid}
       set visible of p to true
       set frontmost of p to true
     end tell`,
  ]);
}

function notify(text) {
  if (platform !== "darwin") return;
  try {
    execFileSync("/usr/bin/osascript", [
      "-e",
      `display notification ${JSON.stringify(text)} with title "Codex Grok"`,
    ]);
  } catch {}
}

function startLinux(wrapper) {
  const app = resolveDesktopApp();
  const pathPrefix = `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  log(`start linux app=${app} wrapper=${wrapper}`);
  const child = spawn(app, desktopLaunchArgs(userData), {
    stdio: "inherit",
    env: {
      ...process.env,
      ...desktopLaunchEnv({ wrapper, userData, pathPrefix }),
    },
  });
  child.on("error", (error) => {
    log(`spawn failed: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    log(`chatgpt exit=${code}`);
    process.exit(code ?? 1);
  });
}

function startDarwin(wrapper) {
  log(`start wrapper=${wrapper}`);
  const child = spawn(
    "/usr/bin/open",
    [
      "-n",
      "--env",
      `CODEX_CLI_PATH=${wrapper}`,
      "--env",
      "CODEX_APP_SERVER_FORCE_CLI=1",
      "--env",
      `PATH=${path.dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      "--env",
      `CODEX_ELECTRON_USER_DATA_PATH=${userData}`,
      "/Applications/Codex.app",
      "--args",
      `--user-data-dir=${userData}`,
    ],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    log(`open exit=${code}`);
    const pid = grokPid();
    if (pid) {
      try {
        activate(pid);
      } catch (error) {
        log(`post-open activate failed: ${error.message}`);
      }
    } else {
      notify("Codex Grok을 열지 못했습니다. launch.log를 확인하세요.");
    }
    process.exit(code ?? 1);
  });
}

const wrapper = fileURLToPath(new URL("./codex-wrapper.mjs", import.meta.url));
try {
  const running = grokPid();
  if (running) {
    log(`activate pid=${running}`);
    if (platform !== "darwin") {
      process.exit(0);
    }
    try {
      activate(running);
      notify("Codex Grok 창을 앞으로 가져왔습니다.");
      process.exit(0);
    } catch (error) {
      log(`activate failed: ${error.message}`);
    }
  }
  if (platform === "linux") startLinux(wrapper);
  else startDarwin(wrapper);
} catch (error) {
  log(`fatal: ${error.message}`);
  notify(error.message);
  process.exit(1);
}
