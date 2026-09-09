// Prototype of src/errors.mjs — the error taxonomy the bridge is missing today.
// Node's fetch reports every network fault as `TypeError: fetch failed` or
// `TypeError: terminated` with the real code hidden on `.cause`, so classification
// MUST walk the cause chain instead of matching a fixed set of top-level codes.

export const BRIDGE_ERROR = Object.freeze({
  ABORTED: "aborted",
  AUTH: "auth",
  DNS: "dns",
  CONNECT: "connect",
  UPSTREAM_TIMEOUT: "upstream_timeout",
  UPSTREAM_CLOSED: "upstream_closed",
  UPSTREAM_STATUS: "upstream_status",
  UPSTREAM_PROTOCOL: "upstream_protocol",
  PAYLOAD: "payload",
  INTERNAL: "internal",
});

const MESSAGES = Object.freeze({
  [BRIDGE_ERROR.ABORTED]: "Grok request was aborted",
  [BRIDGE_ERROR.AUTH]: "Grok login expired. Run grok login.",
  [BRIDGE_ERROR.DNS]:
    "Grok is unreachable: DNS lookup for the Grok proxy failed. Check network or DNS, then retry.",
  [BRIDGE_ERROR.CONNECT]:
    "Grok is unreachable: could not connect to the Grok proxy. Check network, then retry.",
  [BRIDGE_ERROR.UPSTREAM_TIMEOUT]:
    "Grok did not respond in time. Retry, or shorten the turn.",
  [BRIDGE_ERROR.UPSTREAM_CLOSED]:
    "Grok closed the connection before finishing. Retry.",
  [BRIDGE_ERROR.UPSTREAM_PROTOCOL]:
    "Grok sent a malformed response. Retry.",
  [BRIDGE_ERROR.PAYLOAD]: "Grok rejected the request payload",
  [BRIDGE_ERROR.INTERNAL]: "Grok bridge failed to process the turn",
});

const DNS_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "EAI_NODATA", "EAI_NONAME", "ETIMEOUT"]);
const CONNECT_CODES = new Set([
  "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EACCES",
  "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]);
const CLOSED_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);
const ABORT_CODES = new Set([
  "ABORT_ERR", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_PREMATURE_CLOSE",
]);

// Walk the whole cause chain once, newest first, and yield every (name, code, message).
function* chain(error, depth = 0) {
  if (!error || typeof error !== "object" || depth > 8) return;
  yield error;
  yield* chain(error.cause, depth + 1);
}

export function classifyBridgeError(error, context = {}) {
  for (const link of chain(error)) {
    const code = typeof link.code === "string" ? link.code : "";
    if (link.name === "AbortError" || ABORT_CODES.has(code)) {
      // The bridge aborts the upstream only when the client hangs up, so an
      // abort-shaped error means the client left. If the bridge ever aborts for
      // its own reason it must pass that reason to controller.abort() and set
      // context.reason here, instead of having classification guess from
      // socket state (which races with the failing write).
      return context.reason ?? BRIDGE_ERROR.ABORTED;
    }
    if (DNS_CODES.has(code)) return BRIDGE_ERROR.DNS;
    if (CONNECT_CODES.has(code)) return BRIDGE_ERROR.CONNECT;
    if (TIMEOUT_CODES.has(code)) return BRIDGE_ERROR.UPSTREAM_TIMEOUT;
    if (CLOSED_CODES.has(code)) return BRIDGE_ERROR.UPSTREAM_CLOSED;
    if (code.startsWith("HPE_") || link.name === "HTTPParserError")
      return BRIDGE_ERROR.UPSTREAM_PROTOCOL;
  }
  if (/this operation was aborted/i.test(String(error?.message ?? "")))
    return BRIDGE_ERROR.ABORTED;
  return BRIDGE_ERROR.INTERNAL;
}

// A short, stable, secret-free trace of the cause chain: names and codes only,
// never messages (a message can carry a host, a path, or a token fragment).
export function errorSignature(error) {
  const parts = [];
  for (const link of chain(error)) {
    const name = typeof link.name === "string" ? link.name : "Error";
    const code = typeof link.code === "string" ? link.code : "";
    parts.push(code ? `${name}[${code}]` : name);
  }
  return parts.join(" <- ").slice(0, 200);
}

export function bridgeErrorMessage(kind, detail) {
  const base = MESSAGES[kind] ?? MESSAGES[BRIDGE_ERROR.INTERNAL];
  return detail ? `${base} (${detail})` : base;
}
