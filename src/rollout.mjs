import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stripEncryptedReasoning } from "./tools.mjs";

export function codexHomeFromEnv(env = process.env, home = homedir()) {
  return env.CODEX_HOME || path.join(home, ".codex");
}

export function isSkippedHistoryPath(file) {
  const resolved = path.resolve(file);
  const parts = resolved.split(path.sep);
  return parts.includes(".grok") || path.basename(resolved) === "auth.json";
}

// Lines with no ciphertext stay the original string, including non-JSON lines.
// The file is rewritten only when stripEncryptedReasoning actually removes a field.
export function rewriteRolloutText(text) {
  if (!text.includes("encrypted_content") && !text.includes("encrypted_function_args"))
    return text;
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const copy = structuredClone(value);
    stripEncryptedReasoning(copy);
    if (isDeepStrictEqual(value, copy)) continue;
    lines[i] = JSON.stringify(copy);
    changed = true;
  }
  return changed ? lines.join("\n") : text;
}

export async function migrateRolloutFile(file) {
  if (typeof file !== "string" || !file || isSkippedHistoryPath(file)) return false;
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const next = rewriteRolloutText(text);
  if (next === text) return false;
  const mode = (await stat(file)).mode & 0o777;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, next, { mode });
  await rename(tmp, file);
  return true;
}

async function walkRollouts(dir, visit) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "auth.json" || entry.name === ".grok") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkRollouts(full, visit);
    else if (
      entry.isFile() &&
      entry.name.startsWith("rollout-") &&
      entry.name.endsWith(".jsonl")
    )
      await visit(full);
  }
}

export async function migrateSessionRollouts(codexHome) {
  if (isSkippedHistoryPath(codexHome)) return;
  const sessions = path.join(path.resolve(codexHome), "sessions");
  await walkRollouts(sessions, async (file) => {
    try {
      await migrateRolloutFile(file);
    } catch {
      process.stderr.write("Grok wrapper: could not rewrite a rollout\n");
    }
  });
}

export async function migrateResumePath(message) {
  const method = message?.method;
  const file = message?.params?.path;
  if (method !== "thread/resume" && method !== "thread/fork") return false;
  if (typeof file !== "string" || !file) return false;
  return migrateRolloutFile(file);
}
