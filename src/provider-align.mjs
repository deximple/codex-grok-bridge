// Codex CLI 0.166+ rejects a turn when the thread provider differs from the
// app-server's configured provider (openai/codex#57840). The desktop wrapper
// keeps one app-server for both providers, so a switch has to make those two
// values match before resume or turn/start. The value lives in the user's
// config.toml for that process only; the baseline is restored on exit.

import { randomUUID } from "node:crypto";
import { constants, existsSync, openSync, closeSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { rewriteRolloutProviderText } from "./rollout.mjs";

const STATE_DBS = ["state_5.sqlite", "state_4.sqlite"];

export function providerMarkerPath(codexHome) {
  return path.join(codexHome, "grok-bridge-provider.json");
}

function processStartedAt(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] || null;
  } catch {
    return null;
  }
}

const PROCESS_OWNER = {
  pid: process.pid,
  token: randomUUID(),
  startedAt: processStartedAt(process.pid),
};
let ownerAliveForTests = null;

export function setOwnerAliveForTests(fn) {
  ownerAliveForTests = fn;
}

function ownerKey(owner) {
  return owner && Number.isInteger(owner.pid) ? `${owner.pid}:${owner.token ?? ""}` : "";
}

function ownerRecord(owner) {
  const startedAt = owner.startedAt || processStartedAt(owner.pid);
  return {
    pid: owner.pid,
    token: owner.token,
    ...(startedAt ? { startedAt } : {}),
  };
}

function ownerAlive(owner) {
  if (!ownerKey(owner)) return false;
  if (ownerAliveForTests) return ownerAliveForTests(owner);
  if (owner.pid === PROCESS_OWNER.pid && owner.token === PROCESS_OWNER.token) return true;
  const startedAt = processStartedAt(owner.pid);
  if (owner.startedAt) return startedAt === owner.startedAt;
  if (!startedAt) {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
  return true;
}

function liveOwners(marker, except) {
  const skip = ownerKey(except);
  const seen = new Set();
  const live = [];
  for (const owner of marker?.owners ?? []) {
    const key = ownerKey(owner);
    if (!key || key === skip || seen.has(key) || !ownerAlive(owner)) continue;
    seen.add(key);
    live.push(ownerRecord(owner));
  }
  return live;
}

function readMarker(codexHome) {
  const markerPath = providerMarkerPath(codexHome);
  if (!existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    return marker && typeof marker === "object" ? marker : null;
  } catch {
    return null;
  }
}

function writeMarker(codexHome, marker) {
  const markerPath = providerMarkerPath(codexHome);
  const tmp = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  try {
    rmSync(markerPath, { force: true });
    const fd = openSync(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(marker)}\n`);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

function withProviderLock(codexHome, fn) {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const lockPath = path.join(codexHome, "grok-bridge-provider.lock");
  const started = Date.now();
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 2_000) unlinkSync(lockPath);
      } catch {
        // The holder removed it between the stat and the unlink.
      }
      if (Date.now() - started > 5_000) throw new Error("provider baseline lock timed out");
      const until = Date.now() + 15;
      while (Date.now() < until) {
        // The critical section is synchronous, so the wait has to be too.
      }
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

export function readModelProvider(text) {
  let inTable = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inTable = true;
    if (inTable) continue;
    const match = line.match(/^\s*model_provider\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    return unquoteToml(match[1].trim());
  }
  return null;
}

function unquoteToml(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }
  return value;
}

export function renderModelProvider(text, provider) {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let inTable = false;
  let replaced = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTable = true;
    if (!inTable && /^\s*model_provider\s*=/.test(line)) {
      replaced = true;
      if (provider != null) out.push(`model_provider = ${JSON.stringify(provider)}`);
      continue;
    }
    out.push(line);
  }
  if (!replaced && provider != null) {
    let insertAt = 0;
    while (
      insertAt < out.length &&
      (/^\s*$/.test(out[insertAt]) || /^\s*#/.test(out[insertAt]))
    ) {
      insertAt += 1;
    }
    out.splice(insertAt, 0, `model_provider = ${JSON.stringify(provider)}`);
  }
  if (out.length === 0) return "";
  return `${out.join("\n")}\n`;
}

function configPath(codexHome) {
  return path.join(codexHome, "config.toml");
}

export function alignConfiguredProvider(codexHome, provider) {
  if (!codexHome || !provider) return false;
  const file = configPath(codexHome);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (readModelProvider(text) === provider) return false;
  const next = renderModelProvider(text, provider);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(file, next, { mode: 0o600 });
  return true;
}

export function applyModelProvider(codexHome, provider) {
  const file = configPath(codexHome);
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  const next = renderModelProvider(text, provider);
  if (next === text) return false;
  if (!next && !exists) return false;
  if (!next) {
    rmSync(file, { force: true });
    return true;
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(file, next, exists ? undefined : { mode: 0o600 });
  return true;
}

export function captureProviderBaseline(codexHome, owner = PROCESS_OWNER) {
  return withProviderLock(codexHome, () => {
    const marker = readMarker(codexHome);
    const trusted = marker?.codexHome === codexHome ? marker : null;
    const others = liveOwners(trusted, owner);
    if (others.length) {
      writeMarker(codexHome, {
        codexHome,
        original: trusted.original ?? null,
        owners: [...others, ownerRecord(owner)],
      });
      return trusted.original ?? null;
    }
    if (trusted) applyModelProvider(codexHome, trusted.original ?? null);
    const file = configPath(codexHome);
    const original = existsSync(file) ? readModelProvider(readFileSync(file, "utf8")) : null;
    writeMarker(codexHome, {
      codexHome,
      original,
      owners: [ownerRecord(owner)],
    });
    return original;
  });
}

export function restoreProviderBaseline(codexHome, owner = PROCESS_OWNER) {
  return withProviderLock(codexHome, () => {
    const markerPath = providerMarkerPath(codexHome);
    if (!existsSync(markerPath)) return false;
    const marker = readMarker(codexHome);
    if (!marker || marker.codexHome !== codexHome) {
      rmSync(markerPath, { force: true });
      return true;
    }
    const others = liveOwners(marker, owner);
    if (others.length) {
      writeMarker(codexHome, { ...marker, owners: others });
      return true;
    }
    applyModelProvider(codexHome, marker.original ?? null);
    rmSync(markerPath, { force: true });
    return true;
  });
}

async function updateStateDb(file, threadId, provider, model) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(file, { timeout: 3000 });
    let row;
    try {
      row = db.prepare("SELECT model_provider, rollout_path FROM threads WHERE id = ?").get(threadId);
    } catch {
      row = db.prepare("SELECT model_provider FROM threads WHERE id = ?").get(threadId);
    }
    if (!row) return null;
    if (model != null) {
      try {
        db.prepare("UPDATE threads SET model_provider = ?, model = ? WHERE id = ?").run(
          provider,
          model,
          threadId,
        );
      } catch {
        db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?").run(provider, threadId);
      }
    } else if (row.model_provider !== provider) {
      db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?").run(provider, threadId);
    }
    return row;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // The resume path still has the rollout fallback.
    }
  }
}

export async function rewriteSavedModelProvider({
  codexHome,
  threadId,
  rolloutPath,
  provider,
  model,
}) {
  if (!provider || !threadId) return false;
  let savedPath = rolloutPath;
  let updated = false;
  if (codexHome) {
    for (const name of STATE_DBS) {
      const file = path.join(codexHome, name);
      if (!existsSync(file)) continue;
      const row = await updateStateDb(file, threadId, provider, model);
      if (row) {
        updated = true;
        savedPath = savedPath || row.rollout_path;
      }
    }
  }
  if (savedPath && (await rewriteRolloutModelProvider(savedPath, provider, model))) updated = true;
  return updated;
}

export async function rewriteRolloutModelProvider(file, provider, model) {
  if (typeof file !== "string" || !file || !provider) return false;
  let info;
  try {
    info = await lstat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const first = await readFile(file);
  const next = rewriteRolloutProviderText(first.toString("utf8"), provider, model);
  if (next === first.toString("utf8")) return true;
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, next, { mode: info.mode & 0o777 });
  const again = await readFile(file);
  if (!again.equals(first)) {
    await rm(tmp, { force: true });
    return false;
  }
  await rename(tmp, file);
  return true;
}
