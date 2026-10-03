import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

function recordedProvider(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const modelProvider = typeof record.model_provider === "string" ? record.model_provider : "";
  const model = typeof record.model === "string" ? record.model : "";
  if (modelProvider === "grok_build_cli" || model.startsWith("grok-")) return "grok_build_cli";
  return modelProvider || null;
}

// session_meta sets the provider from model_provider. A later line that names
// grok_build_cli, or a model starting with grok-, switches to Grok. Anything
// else, including unknown, is not Grok.
function providerAfter(current, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return current;
  const payload =
    value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? value.payload
      : null;
  if (value.type === "session_meta") {
    const provider = payload && typeof payload.model_provider === "string" ? payload.model_provider : "";
    return provider || current;
  }
  return recordedProvider(payload) ?? recordedProvider(value) ?? current;
}

function isGrokProvider(provider) {
  return provider === "grok_build_cli" || (typeof provider === "string" && provider.startsWith("grok-"));
}

// Lines with no ciphertext stay the original string, including non-JSON lines.
// OpenAI and unknown items keep encrypted_content. The file is rewritten only
// when a Grok item actually loses a ciphertext field.
export function rewriteRolloutText(text) {
  if (!text.includes("encrypted_content") && !text.includes("encrypted_function_args"))
    return text;
  const lines = text.split("\n");
  let provider = null;
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
    provider = providerAfter(provider, value);
    if (!isGrokProvider(provider)) continue;
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
  let first;
  try {
    first = await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const next = rewriteRolloutText(first.toString("utf8"));
  if (next === first.toString("utf8")) return false;
  const mode = (await stat(file)).mode & 0o777;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, next, { mode });
  const again = await readFile(file);
  if (!again.equals(first)) {
    await rm(tmp, { force: true });
    return false;
  }
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
