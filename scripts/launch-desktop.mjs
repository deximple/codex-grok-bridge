import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const userData = path.join(homedir(), ".local/share/codex-grok-bridge/desktop");
const logFile = path.join(homedir(), ".local/share/codex-grok-bridge/launch.log");
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
    if (
      line.includes(`--user-data-dir=${userData}`) &&
      /MacOS\/(ChatGPT|Codex)(\s|$)/.test(line) &&
      !line.includes("Helper") &&
      !line.includes("crashpad")
    )
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
  try {
    execFileSync("/usr/bin/osascript", [
      "-e",
      `display notification ${JSON.stringify(text)} with title "Codex Grok"`,
    ]);
  } catch {}
}

const wrapper = fileURLToPath(new URL("./codex-wrapper.mjs", import.meta.url));
try {
  const running = grokPid();
  if (running) {
    log(`activate pid=${running}`);
    try {
      activate(running);
      notify("Codex Grok 창을 앞으로 가져왔습니다.");
      process.exit(0);
    } catch (error) {
      log(`activate failed: ${error.message}`);
    }
  }
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
} catch (error) {
  log(`fatal: ${error.message}`);
  notify(error.message);
  process.exit(1);
}
