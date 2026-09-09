// Prototype of src/diagnostics.mjs — a local, redacted, size-capped record of
// every bridge turn, so a failure is diagnosable after the fact instead of
// vanishing into an Electron process's inherited stderr.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_LOG_DIR = path.join(homedir(), ".local/share/codex-grok-bridge/logs");
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

// Values that must never reach disk, matched structurally rather than by name,
// because the field a token arrives in is not stable.
const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[jwt]"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "[key]"],
  [/xai-[A-Za-z0-9_-]{16,}/g, "[key]"],
];

export function redact(value, home = homedir()) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  // Home paths identify the operator and can carry project names; keep the shape.
  return text.split(home).join("~").slice(0, 400);
}

function rotate(file) {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // Nothing to rotate.
  }
}

export function createDiagnostics(options = {}) {
  // Opt-in: only the runtime enables this. A directly constructed server
  // (every test does that) must never touch the operator's real log.
  if (!options.enabled) return { record: () => {}, file: null };
  const dir = options.dir ?? DEFAULT_LOG_DIR;
  const file = path.join(dir, "bridge.jsonl");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return { record: () => {}, file: null };
  }
  return {
    file,
    // Only structural facts: sizes, counts, durations, codes. Never prompt text,
    // never tool output, never a token, never a raw upstream body.
    record(entry) {
      try {
        rotate(file);
        appendFileSync(
          file,
          JSON.stringify({
            at: new Date().toISOString(),
            ...entry,
            ...(entry.detail === undefined ? {} : { detail: redact(entry.detail) }),
          }) + "\n",
          { mode: 0o600 },
        );
      } catch {
        // Diagnostics must never break a turn.
      }
    },
  };
}
