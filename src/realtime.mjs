import { timingSafeEqual } from "node:crypto";
import tls from "node:tls";
import { GrokAuthError, readGrokBearerToken } from "./auth.mjs";
import { acceptLocalSideband, isLocalVoiceSideband } from "./voice.mjs";

// Codex posts the WebRTC SDP offer to the provider base
// (`POST /v1/realtime/calls`, and v3 `POST /v1/live`). The body is raw bytes
// (Content-Type application/sdp, or whatever Codex sent). xAI answers with
// the SDP body, its status, and a Location header. This is a byte pipe:
// nothing here parses JSON or writes an SDP answer.

export const DEFAULT_REALTIME_API_BASE = "https://api.x.ai/v1";

export async function forwardRealtime(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_REALTIME_API_BASE).replace(/\/$/, "");
  const headers = { authorization: `Bearer ${options.token}` };
  if (typeof options.contentType === "string") headers["content-type"] = options.contentType;
  const response = await fetchImpl(`${base}${options.path}${options.search ?? ""}`, {
    method: "POST",
    headers,
    body: options.body,
    redirect: "manual",
    signal: options.signal,
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    body,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
  };
}

export function connectSideband() {
  return tls.connect({ host: "api.x.ai", port: 443, servername: "api.x.ai" });
}

export function isSidebandUpgradePath(url) {
  let pathname = "/";
  try {
    pathname = new URL(url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return false;
  }
  return (
    pathname === "/v1/realtime" ||
    pathname.startsWith("/v1/realtime/") ||
    pathname === "/v1/live" ||
    pathname.startsWith("/v1/live/")
  );
}

function headerText(value) {
  const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (!text || /[\r\n]/.test(text)) return null;
  return text;
}

function bearerMatches(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function upgradeRequest(url, headers, token) {
  const lines = [
    `GET ${url} HTTP/1.1`,
    "Host: api.x.ai",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${headers.key}`,
    `Sec-WebSocket-Version: ${headers.version}`,
    `Authorization: Bearer ${token}`,
  ];
  if (headers.protocol) lines.push(`Sec-WebSocket-Protocol: ${headers.protocol}`);
  if (headers.extensions) lines.push(`Sec-WebSocket-Extensions: ${headers.extensions}`);
  lines.push("", "");
  return lines.join("\r\n");
}

function readHead(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    let reading = false;
    const onReadable = () => {
      if (reading) return;
      reading = true;
      let chunk = socket.read();
      while (chunk) {
        buf = Buffer.concat([buf, chunk]);
        chunk = socket.read();
      }
      reading = false;
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > 65536) {
          cleanup();
          reject(new Error("header too large"));
        }
        return;
      }
      cleanup();
      resolve({ head: buf.subarray(0, end + 4), rest: buf.subarray(end + 4) });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("closed"));
    };
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("close", onClose);
    onReadable();
  });
}

function switching(head) {
  const line = head.toString("latin1").split("\r\n", 1)[0] ?? "";
  return /^HTTP\/1\.[01] 101\b/.test(line);
}

function fail(socket, upstream) {
  socket.destroy();
  upstream?.destroy();
}

export function attachSidebandUpgrade(server, options = {}) {
  server.on("upgrade", (req, socket, head) => {
    pipeSidebandUpgrade(req, socket, head, options).catch(() => fail(socket));
  });
}

async function pipeSidebandUpgrade(req, socket, head, options) {
  const url = String(req.url ?? "/");
  if (!isSidebandUpgradePath(url) || req.headers.origin) return fail(socket);
  if (!bearerMatches(req.headers.authorization, options.token)) return fail(socket);
  const key = headerText(req.headers["sec-websocket-key"]);
  if (isLocalVoiceSideband(url)) {
    if (!key) return fail(socket);
    acceptLocalSideband(socket, key, url);
    return;
  }
  const version =
    req.headers["sec-websocket-version"] == null
      ? "13"
      : headerText(req.headers["sec-websocket-version"]);
  if (!key || !version) return fail(socket);
  const protocol = headerText(req.headers["sec-websocket-protocol"]);
  const extensions = headerText(req.headers["sec-websocket-extensions"]);
  if (
    (req.headers["sec-websocket-protocol"] && !protocol) ||
    (req.headers["sec-websocket-extensions"] && !extensions)
  ) {
    return fail(socket);
  }
  let token;
  try {
    token = (options.grokSession ?? readGrokBearerToken(options.grokHome)).token;
  } catch (error) {
    if (error instanceof GrokAuthError) return fail(socket);
    throw error;
  }
  const connect = options.sidebandConnect ?? connectSideband;
  const upstream = connect();
  if (!upstream) return fail(socket);
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    fail(socket, upstream);
  }, options.sidebandHandshakeMs ?? 10_000);
  const finishHandshake = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    return true;
  };
  try {
    socket.pause();
    upstream.write(
      upgradeRequest(url, { key, version, protocol, extensions }, token),
    );
    if (head?.length) upstream.write(head);
    const response = await readHead(upstream);
    if (!finishHandshake()) return;
    if (!switching(response.head)) return fail(socket, upstream);
    socket.write(response.head);
    if (response.rest.length) socket.write(response.rest);
    socket.resume();
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  } catch {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
    }
    fail(socket, upstream);
  }
}
