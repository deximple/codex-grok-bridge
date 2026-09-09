import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSseRewriter } from "./tools.mjs";
import { requestStream } from "./transport.mjs";
import { BRIDGE_ERROR, classifyBridgeError } from "./errors.mjs";

export const DEFAULT_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
export const DEFAULT_CLIENT_IDENTIFIER = "grok-shell";

let cachedClientVersion;

export function detectGrokClientVersion(home = homedir()) {
  if (cachedClientVersion) return cachedClientVersion;
  try {
    // Synchronous, and on the first request's critical path: a grok binary that
    // hangs would freeze the whole bridge event loop without a timeout.
    const output = execFileSync(join(home, ".grok/bin/grok"), ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const match = output.match(/grok\s+(\S+(?:\s+\([^)]+\))?)/i);
    cachedClientVersion = match ? match[1].trim() : "1.0.24";
  } catch {
    cachedClientVersion = "1.0.24";
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

// Resolve when the consumer has drained, reject if it goes away first. Without
// this, a slow client makes the bridge buffer the whole Grok response in memory,
// and a client that vanishes mid-stream is never noticed.
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

async function writeBlock(output, block) {
  if (output.destroyed || output.writableEnded)
    throw Object.assign(new Error("The client closed the stream"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
  if (!output.write(block)) await drained(output);
}

// Nothing has reached Codex until the first SSE block is written, so a stream
// that dies before it opens is safe to send again. After that it never is:
// re-sending would duplicate items Codex has already recorded.
const RETRYABLE = new Set([
  BRIDGE_ERROR.DNS,
  BRIDGE_ERROR.CONNECT,
  BRIDGE_ERROR.UPSTREAM_CLOSED,
]);

export async function openProxyStreamWithRetry(options, attempts = 2) {
  const rounds = Math.max(1, attempts);
  let lastError;
  for (let attempt = 1; attempt <= rounds; attempt += 1) {
    try {
      return await openProxyStream(options);
    } catch (error) {
      lastError = error;
      const kind = classifyBridgeError(error);
      if (
        !RETRYABLE.has(kind) ||
        options.signal?.aborted ||
        attempt === rounds
      )
        break;
      options.onRetry?.({ attempt, kind });
    }
  }
  throw lastError;
}

export async function pipeProxySse(stream, output, map) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const rewrite = createSseRewriter(map);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        if (part.trim()) await writeBlock(output, rewrite(part) + "\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await writeBlock(output, rewrite(buffer) + "\n\n");
  } catch (error) {
    // Stop pulling from Grok the moment the client is gone; leaving the body
    // unread holds the upstream socket open for the rest of the response.
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}
