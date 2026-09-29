import { createHash } from "node:crypto";

// xAI prompt cache hits only when later requests repeat the same prefix
// unchanged, on the same x-grok-conv-id. Codex resends the whole transcript,
// but a fresh rewrite (new ids, encrypted reasoning, tool index names) makes
// that prefix differ. This module pins the conv id and reuses the exact
// items already forwarded.

const CACHE_USAGE_FIELDS = [
  "cached_prompt_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];

const VOLATILE_KEYS = new Set([
  "id",
  "status",
  "encrypted_content",
  "encrypted_function_args",
]);

export function stableConvId(threadId, promptCacheKey) {
  const thread = typeof threadId === "string" ? threadId.trim() : "";
  if (thread) return thread;
  const cache = typeof promptCacheKey === "string" ? promptCacheKey.trim() : "";
  return cache || null;
}

export function stableProxyName(spec, sanitizedName) {
  const basis = `${spec.kind}\0${spec.namespace ?? ""}\0${spec.name ?? ""}`;
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 8);
  return `codex_${hash}_${sanitizedName}`;
}

function normalizeForFingerprint(value) {
  if (Array.isArray(value)) return value.map(normalizeForFingerprint);
  if (!value || typeof value !== "object") return value;
  if (
    value.type === "input_text" ||
    value.type === "output_text" ||
    value.type === "summary_text"
  ) {
    return {
      type: value.type,
      text: typeof value.text === "string" ? value.text : "",
    };
  }
  if (value.type === "input_image") {
    const url =
      value.image_url && typeof value.image_url === "object"
        ? value.image_url.url
        : value.image_url;
    const image = { type: "input_image" };
    if (url !== undefined) image.image_url = url;
    if (value.detail !== undefined) image.detail = value.detail;
    return image;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.has(key) || key.startsWith("internal_")) continue;
    const child = value[key];
    if (child === undefined || child === null) continue;
    out[key] = normalizeForFingerprint(child);
  }
  if (
    out.role &&
    out.content !== undefined &&
    (out.type == null || out.type === "message")
  ) {
    out.type = "message";
    if (typeof out.content === "string")
      out.content = [{ type: "input_text", text: out.content }];
  }
  return out;
}

export function logicalFingerprint(item) {
  return JSON.stringify(normalizeForFingerprint(item));
}

// Object key order is part of the cached prefix. Codex does not promise it.
export function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort())
    out[key] = stableJsonValue(value[key]);
  return out;
}

const MAX_THREADS = 64;

export function createPrefixMemory() {
  const threads = new Map();
  return {
    reuse(convId, pairs) {
      const fresh = pairs.map((pair) => pair.item);
      if (!convId || pairs.length === 0) return fresh;
      const previous = threads.get(convId);
      let reused = 0;
      if (previous) {
        const limit = Math.min(previous.length, pairs.length);
        while (
          reused < limit &&
          previous[reused].fingerprint === pairs[reused].fingerprint
        )
          reused += 1;
      }
      const stored =
        reused > 0
          ? [...previous.slice(0, reused), ...pairs.slice(reused)]
          : pairs.slice();
      if (threads.has(convId)) threads.delete(convId);
      threads.set(
        convId,
        stored.map((pair) => ({
          fingerprint: pair.fingerprint,
          item: structuredClone(pair.item),
        })),
      );
      while (threads.size > MAX_THREADS) {
        const oldest = threads.keys().next().value;
        threads.delete(oldest);
      }
      if (!previous || reused === 0) return fresh;
      return [
        ...previous.slice(0, reused).map((pair) => structuredClone(pair.item)),
        ...pairs.slice(reused).map((pair) => pair.item),
      ];
    },
  };
}

// Copy only cache counters the upstream actually sent. Zero is a real miss.
// Absence is not a miss, so it must not become 0.
export function readCacheUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = {};
  for (const key of CACHE_USAGE_FIELDS) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function applyCacheUsage(usage) {
  const cache = readCacheUsage(usage);
  if (!cache) return usage;
  const cached =
    typeof cache.cached_prompt_tokens === "number"
      ? cache.cached_prompt_tokens
      : cache.cache_read_input_tokens;
  if (typeof cached !== "number") return usage;
  const details =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? usage.input_tokens_details
      : {};
  if (typeof details.cached_tokens !== "number") {
    details.cached_tokens = cached;
    usage.input_tokens_details = details;
  }
  return usage;
}
