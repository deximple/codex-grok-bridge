import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export const LINUX_CODEX_BINARY = "/usr/lib/chatgpt/resources/codex";
export const LINUX_CHATGPT_BIN = "/usr/lib/chatgpt/ChatGPT";
export const DARWIN_CODEX_BINARY = "/Applications/Codex.app/Contents/Resources/codex";
export const DARWIN_CODEX_APP = "/Applications/Codex.app";
export const LINUX_STOCK_PREFIX = "/usr/lib/chatgpt";
export const WIN32_WINDOWSAPPS = "WindowsApps";
export const WIN32_BRIDGE_APP = "codex-grok-bridge";

export function resolvePlatform(options = {}) {
  const env = options.env ?? process.env;
  return options.platform ?? env.CODEX_GROK_PLATFORM ?? process.platform;
}

export function localAppData(home = homedir(), options = {}) {
  const env = options.env ?? process.env;
  if (env.LOCALAPPDATA) return env.LOCALAPPDATA;
  return path.join(home, "AppData", "Local");
}

export function win32AppDir(home = homedir(), options = {}) {
  return path.join(localAppData(home, options), WIN32_BRIDGE_APP, "app");
}

export function win32StorePointer(home = homedir(), options = {}, name = "store-app.txt") {
  return path.join(localAppData(home, options), WIN32_BRIDGE_APP, name);
}

function readPointer(file, options = {}) {
  const exists = options.existsSync ?? existsSync;
  const read = options.readFileSync ?? ((p) => readFileSync(p, "utf8"));
  if (!exists(file)) return "";
  return String(read(file)).trim();
}

function resolveWin32Binary(fileName, pointerName, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.existsSync ?? existsSync;
  const isolated = path.join(win32AppDir(home, { env }), fileName);
  if (exists(isolated)) return isolated;
  const pointed = readPointer(win32StorePointer(home, { env }, pointerName), options);
  return pointed || isolated;
}

export function resolveCodexBinary(options = {}) {
  const env = options.env ?? process.env;
  if (env.CODEX_BINARY) return env.CODEX_BINARY;
  const platform = resolvePlatform({ ...options, env });
  if (platform === "linux") return LINUX_CODEX_BINARY;
  if (platform === "win32") {
    return resolveWin32Binary("codex.exe", "store-codex.txt", { ...options, env });
  }
  return DARWIN_CODEX_BINARY;
}

export function resolveDesktopApp(options = {}) {
  const env = options.env ?? process.env;
  if (env.CODEX_DESKTOP_APP) return env.CODEX_DESKTOP_APP;
  const platform = resolvePlatform({ ...options, env });
  if (platform === "linux") return LINUX_CHATGPT_BIN;
  if (platform === "win32") {
    return resolveWin32Binary("ChatGPT.exe", "store-app.txt", { ...options, env });
  }
  return DARWIN_CODEX_APP;
}

export function resolveGrokBinary(home = homedir(), options = {}) {
  const env = options.env ?? process.env;
  if (env.GROK_BINARY) return env.GROK_BINARY;
  const platform = resolvePlatform({ ...options, env });
  const name = platform === "win32" ? "grok.exe" : "grok";
  return path.join(home, ".grok", "bin", name);
}

export function desktopUserDataDir(home = homedir(), options = {}) {
  const env = options.env ?? process.env;
  if (resolvePlatform({ ...options, env }) === "win32") {
    return path.join(localAppData(home, { env }), WIN32_BRIDGE_APP, "desktop");
  }
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
  const platform = resolvePlatform(options);
  if (platform === "linux") return line.includes(LINUX_CHATGPT_BIN);
  if (platform === "win32") {
    return /ChatGPT\.exe|Codex\.exe/i.test(line);
  }
  return /MacOS\/(ChatGPT|Codex)(\s|$)/.test(line);
}

export function isForbiddenInstallDir(app) {
  const resolved = path.resolve(app);
  const norm = resolved.replace(/\\/g, "/").toLowerCase();
  const asPosix = String(app).replace(/\\/g, "/");
  const forbidden = [
    LINUX_STOCK_PREFIX,
    "/usr/bin/chatgpt",
    "/usr/share/applications/chatgpt.desktop",
    DARWIN_CODEX_APP,
  ];
  if (
    forbidden.some((prefix) => {
      const p = prefix.toLowerCase();
      return (
        asPosix === prefix ||
        asPosix.startsWith(`${prefix}/`) ||
        norm === p ||
        norm.endsWith(p) ||
        norm.includes(`${p}/`)
      );
    })
  ) {
    return true;
  }
  return norm.includes("/windowsapps/") || norm.endsWith("/windowsapps");
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
