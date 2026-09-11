import path from "node:path";
import { homedir } from "node:os";

export const LINUX_CODEX_BINARY = "/usr/lib/chatgpt/resources/codex";
export const LINUX_CHATGPT_BIN = "/usr/lib/chatgpt/ChatGPT";
export const DARWIN_CODEX_BINARY = "/Applications/Codex.app/Contents/Resources/codex";
export const DARWIN_CODEX_APP = "/Applications/Codex.app";
export const LINUX_STOCK_PREFIX = "/usr/lib/chatgpt";

export function resolvePlatform(options = {}) {
  const env = options.env ?? process.env;
  return options.platform ?? env.CODEX_GROK_PLATFORM ?? process.platform;
}

export function resolveCodexBinary(options = {}) {
  const env = options.env ?? process.env;
  if (env.CODEX_BINARY) return env.CODEX_BINARY;
  return resolvePlatform({ ...options, env }) === "linux"
    ? LINUX_CODEX_BINARY
    : DARWIN_CODEX_BINARY;
}

export function resolveDesktopApp(options = {}) {
  const env = options.env ?? process.env;
  if (env.CODEX_DESKTOP_APP) return env.CODEX_DESKTOP_APP;
  return resolvePlatform({ ...options, env }) === "linux"
    ? LINUX_CHATGPT_BIN
    : DARWIN_CODEX_APP;
}

export function desktopUserDataDir(home = homedir()) {
  return path.join(home, ".local/share/codex-grok-bridge/desktop");
}

export function linuxAppDir(home = homedir()) {
  return path.join(home, ".local/share/codex-grok-bridge/app");
}

export function linuxDesktopEntryPath(home = homedir(), xdgDataHome) {
  const dataHome = xdgDataHome || path.join(home, ".local/share");
  return path.join(dataHome, "applications", "codex-grok.desktop");
}

export function desktopLaunchEnv({ wrapper, userData, pathPrefix }) {
  const env = {
    CODEX_CLI_PATH: wrapper,
    CODEX_APP_SERVER_FORCE_CLI: "1",
    CODEX_ELECTRON_USER_DATA_PATH: userData,
  };
  if (pathPrefix) env.PATH = pathPrefix;
  return env;
}

export function desktopLaunchArgs(userData) {
  return [`--user-data-dir=${userData}`];
}

export function isGrokDesktopProcess(line, userData, options = {}) {
  if (!line.includes(`--user-data-dir=${userData}`)) return false;
  if (line.includes("Helper") || line.includes("crashpad")) return false;
  const app = resolveDesktopApp(options);
  if (line.includes(app)) return true;
  return resolvePlatform(options) === "linux"
    ? line.includes(LINUX_CHATGPT_BIN)
    : /MacOS\/(ChatGPT|Codex)(\s|$)/.test(line);
}

export function isForbiddenInstallDir(app) {
  const resolved = path.resolve(app);
  const forbidden = [
    LINUX_STOCK_PREFIX,
    "/usr/bin/chatgpt",
    "/usr/share/applications/chatgpt.desktop",
    DARWIN_CODEX_APP,
  ];
  return forbidden.some(
    (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`),
  );
}

export function linuxDesktopEntry({ exec, icon = "chatgpt" }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Codex Grok",
    "Comment=Codex desktop with Grok via the local bridge",
    `Exec=${exec}`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=ChatGPT",
    "",
  ].join("\n");
}
