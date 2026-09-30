import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolveGrokBinary } from "./paths.mjs";
import { createSseRewriter } from "./tools.mjs";
import { requestStream } from "./transport.mjs";
import { BRIDGE_ERROR, classifyBridgeError } from "./errors.mjs";

export const DEFAULT_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
export const DEFAULT_CLIENT_IDENTIFIER = "grok-shell";

const UNKNOWN_CLIENT_VERSION = "unknown";
let cachedClientVersion;

export function clearClientVersionCache() {
  cachedClientVersion = undefined;
}

export function detectGrokClientVersion(home = homedir()) {
  if (cachedClientVersion) return cachedClientVersion;
  try {
    // Synchronous, and on the first request's critical path: a grok binary that
    // hangs would freeze the whole bridge event loop without a timeout.
    const output = execFileSync(resolveGrokBinary(home), ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const match = output.match(/grok\s+(\S+(?:\s+\([^)]+\))?)/i);
    cachedClientVersion = match ? match[1].trim() : UNKNOWN_CLIENT_VERSION;
  } catch {
    cachedClientVersion = UNKNOWN_CLIENT_VERSION;
  }
  return cachedClientVersion;
}

function redactedError(status, text) {
  const trimmed = String(text || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
  if (status === 401 || status === 403)
    return "Grok login expired. Run grok login.";
  return `Grok Responses proxy failed (${status})${trimmed ? `: ${trimmed}` : ""}`;
}

// node:http(s) by default so the bridge owns DNS caching and connection reuse.
// GROK_BRIDGE_TRANSPORT=fetch restores the global fetch path unchanged.
function defaultTransport() {
  return process.env.GROK_BRIDGE_TRANSPORT === "fetch" ? fetch : requestStream;
}

export async function openProxyStream(options) {
  const fetchImpl = options.fetchImpl ?? defaultTransport();
  const base = (options.baseUrl ?? DEFAULT_PROXY_BASE).replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent":
      options.userAgent ??
      `grok-shell/${options.clientVersion ?? detectGrokClientVersion()}`,
    "x-grok-client-version":
      options.clientVersion ?? detectGrokClientVersion(),
    "x-grok-client-identifier":
      options.clientIdentifier ?? DEFAULT_CLIENT_IDENTIFIER,
  };
  if (options.convId) headers["x-grok-conv-id"] = options.convId;
  if (options.sessionId) headers["x-grok-session-id"] = options.sessionId;
  if (options.userId) headers["x-grok-user-id"] = options.userId;
  const response = await fetchImpl(`${base}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(redactedError(response.status, text));
  }
  if (!response.body) throw new Error("Grok Responses proxy returned no body");
  return response;
}

// The upstream reply is already buffered until it finishes. This wait applies
// only while that buffer is flushed: a slow Codex exerts backpressure, and a
// client that vanishes is noticed instead of being written forever.
function drained(output) {
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      output.off("drain", onDrain);
      output.off("close", onClose);
      output.off("error", onError);
      fn(value);
    };
    const onDrain = () => settle(resolve);
    const onClose = () =>
      settle(
        reject,
        Object.assign(new Error("The client closed the stream"), {
          code: "ERR_STREAM_PREMATURE_CLOSE",
        }),
      );
    const onError = (error) => settle(reject, error);
    output.once("drain", onDrain);
    output.once("close", onClose);
    output.once("error", onError);
  });
}

// First try, then two more. That is the budget Codex used to spend on
// request_max_retries / stream_max_retries. A retry sends the prompt again, so
// the input tokens for that attempt can be billed again.
export const PROXY_ATTEMPTS = 3;

// DNS and connect failures are included. A socket reset (ECONNRESET, EPIPE,
// UND_ERR_SOCKET) or a body that ends before response.completed is included
// only while Codex has not been sent a byte. User aborts and deterministic
// 422s are not in this set.
const RETRYABLE = new Set([
  BRIDGE_ERROR.DNS,
  BRIDGE_ERROR.CONNECT,
  BRIDGE_ERROR.UPSTREAM_CLOSED,
]);

// response.incomplete is the other usage event this code already treats as the
// end of a response. response.failed here is a finished upstream event, not a
// dropped socket, so it is forwarded instead of retried.
const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

export function isTerminalSseBlock(part) {
  for (const line of part.split("\n")) {
    if (line.startsWith("event:") && TERMINAL_EVENTS.has(line.slice(6).trim()))
      return true;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const value = JSON.parse(payload);
      if (TERMINAL_EVENTS.has(value?.type)) return true;
    } catch {
      // A non-JSON data line cannot be the terminal event.
    }
  }
  return false;
}

function prematureUpstreamClose() {
  return Object.assign(new Error("Grok closed the connection before finishing"), {
    code: "ERR_UPSTREAM_PREMATURE_CLOSE",
  });
}

function clientClosed() {
  return Object.assign(new Error("The client closed the stream"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}

// Returns the retry kind, or null when this failure must surface as-is.
function retryKind(error, options, attempt, rounds, clientBytes) {
  if (clientBytes > 0 || options.signal?.aborted || attempt === rounds)
    return null;
  const kind = classifyBridgeError(error);
  return RETRYABLE.has(kind) ? kind : null;
}

export async function openProxyStreamWithRetry(options, attempts = PROXY_ATTEMPTS) {
  const rounds = Math.max(1, attempts);
  let lastError;
  for (let attempt = 1; attempt <= rounds; attempt += 1) {
    try {
      return await openProxyStream(options);
    } catch (error) {
      lastError = error;
      const kind = retryKind(error, options, attempt, rounds, 0);
      if (!kind) break;
      options.onRetry?.({ attempt, kind });
    }
  }
  throw lastError;
}

function completeBlocks(buffer) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { parts: parts.filter((part) => part.trim()), rest };
}

// Read the upstream body to memory. Write to Codex only after a terminal
// event, so a reset before that has not shown Codex a partial reply.
export async function pipeProxySse(stream, output, map, usageBox, onClientByte) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const rewrite = createSseRewriter(map);
  const pending = [];
  let clientBytes = 0;
  let finished = false;
  let failed = false;

  const flush = async (parts) => {
    for (const part of parts) {
      const rewritten = rewrite(part);
      if (rewritten === null) continue;
      const block = `${rewritten}\n\n`;
      if (output.destroyed || output.writableEnded) throw clientClosed();
      // Count the byte as soon as the client stream accepts it. A later drain
      // error must not look like "Codex saw nothing" and resubmit the prompt.
      const accepted = output.write(block);
      clientBytes += Buffer.byteLength(block);
      onClientByte?.();
      if (!accepted) await drained(output);
    }
  };

  const accept = async (parts) => {
    if (!parts.length) return;
    if (finished) {
      await flush(parts);
      return;
    }
    const terminalAt = parts.findIndex((part) => isTerminalSseBlock(part));
    if (terminalAt === -1) {
      pending.push(...parts);
      return;
    }
    pending.push(...parts.slice(0, terminalAt + 1));
    await flush(pending);
    pending.length = 0;
    finished = true;
    await flush(parts.slice(terminalAt + 1));
  };

  try {
    while (true) {
      if (output.destroyed || output.writableEnded) throw clientClosed();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = completeBlocks(buffer);
      buffer = split.rest;
      await accept(split.parts);
    }
    buffer += decoder.decode();
    if (buffer.trim()) await accept([buffer]);
    if (!finished) throw prematureUpstreamClose();
  } catch (error) {
    failed = true;
    // Stop pulling from Grok the moment this attempt is over; leaving the body
    // unread holds the upstream socket open for the rest of the response.
    await reader.cancel(error).catch(() => {});
    if (error && typeof error === "object") error.clientBytes = clientBytes;
    throw error;
  } finally {
    if (!failed) reader.releaseLock();
    if (usageBox) usageBox.cacheUsage = rewrite.cacheUsage ?? null;
  }
}

// Open and read one attempt. If the socket dies before Codex has a byte, send
// the same request again. Once a byte has been written, never resubmit.
async function relayAttempts(options, consume, attempts = PROXY_ATTEMPTS) {
  const rounds = Math.max(1, attempts);
  let lastError;
  for (let attempt = 1; attempt <= rounds; attempt += 1) {
    try {
      const response = await openProxyStream(options);
      await consume(response);
      return response;
    } catch (error) {
      lastError = error;
      const kind = retryKind(
        error,
        options,
        attempt,
        rounds,
        error?.clientBytes ?? 0,
      );
      if (!kind) break;
      options.onRetry?.({ attempt, kind });
    }
  }
  throw lastError;
}

export async function relayProxySse(options, output, map, usageBox, attempts = PROXY_ATTEMPTS) {
  return relayAttempts(
    options,
    (response) =>
      pipeProxySse(response.body, output, map, usageBox, options.onClientByte),
    attempts,
  );
}

// Read until response.completed (or the other terminal events). Do not write
// those bytes yet: a video tool call has to be answered before Codex sees the
// turn, and a reset before that write is still safe to retry.
export async function readUntilTerminal(stream, output) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const collected = [];
  let released = false;
  const finish = async (error) => {
    if (released) return;
    released = true;
    await reader.cancel(error).catch(() => {});
  };
  try {
    while (true) {
      if (output?.destroyed || output?.writableEnded) throw clientClosed();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = completeBlocks(buffer);
      buffer = split.rest;
      collected.push(...split.parts);
      if (collected.some((part) => isTerminalSseBlock(part))) {
        await finish();
        return collected;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) collected.push(buffer);
    if (!collected.some((part) => isTerminalSseBlock(part)))
      throw prematureUpstreamClose();
    await finish();
    return collected;
  } catch (error) {
    await finish(error);
    if (error && typeof error === "object" && error.clientBytes == null)
      error.clientBytes = 0;
    throw error;
  }
}

export async function readRelayProxySse(options, output, attempts = PROXY_ATTEMPTS) {
  let parts;
  await relayAttempts(
    options,
    async (response) => {
      parts = await readUntilTerminal(response.body, output);
    },
    attempts,
  );
  return parts;
}

export async function emitProxySse(parts, output, map, usageBox, onClientByte) {
  const rewrite = createSseRewriter(map);
  let clientBytes = 0;
  try {
    for (const part of parts) {
      const rewritten = rewrite(part);
      if (rewritten === null) continue;
      const block = `${rewritten}\n\n`;
      if (output.destroyed || output.writableEnded) throw clientClosed();
      const accepted = output.write(block);
      clientBytes += Buffer.byteLength(block);
      onClientByte?.();
      if (!accepted) await drained(output);
    }
  } catch (error) {
    if (error && typeof error === "object") error.clientBytes = clientBytes;
    throw error;
  } finally {
    if (usageBox) usageBox.cacheUsage = rewrite.cacheUsage ?? null;
  }
}
