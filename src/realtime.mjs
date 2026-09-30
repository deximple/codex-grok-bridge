import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GrokAuthError, readGrokBearerToken } from "./auth.mjs";

export const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime";
export const DEFAULT_VOICE_MODEL = "grok-voice-latest";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 8 * 1024 * 1024;

export function upstreamRealtimeUrl(requestUrl = "/") {
  const incoming = new URL(requestUrl, "http://127.0.0.1");
  const requested = incoming.searchParams.get("model") ?? "";
  const model = /^grok-voice[A-Za-z0-9._-]*$/.test(requested)
    ? requested
    : DEFAULT_VOICE_MODEL;
  const url = new URL(XAI_REALTIME_URL);
  url.searchParams.set("model", model);
  return url.href;
}

export function voiceErrorMessage(error) {
  if (error instanceof GrokAuthError) return error.message;
  if (error?.status === 401 || error?.status === 403)
    return "Grok login expired. Run grok login.";
  return "Grok voice connection failed";
}

function authorized(header, token) {
  if (typeof header !== "string" || typeof token !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function failUpgrade(socket, status, message) {
  if (socket.destroyed || socket.writableEnded) return;
  const reason =
    status === 400 ? "Bad Request"
    : status === 401 ? "Unauthorized"
    : status === 404 ? "Not Found"
    : "Bad Gateway";
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
}

function encodeFrame(opcode, payload, mask) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const maskKey = mask ? randomBytes(4) : null;
  let lengthByte = data.length;
  let extra = 0;
  if (data.length >= 65536) {
    lengthByte = 127;
    extra = 8;
  } else if (data.length >= 126) {
    lengthByte = 126;
    extra = 2;
  }
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (mask ? 0x80 : 0) | lengthByte;
  let offset = 2;
  if (lengthByte === 126) {
    header.writeUInt16BE(data.length, 2);
    offset = 4;
  } else if (lengthByte === 127) {
    header.writeBigUInt64BE(BigInt(data.length), 2);
    offset = 10;
  }
  let body = data;
  if (mask) {
    maskKey.copy(header, offset);
    body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= maskKey[i & 3];
  }
  return Buffer.concat([header, body]);
}

function createFrameParser(onFrame, expectMask) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) throw new Error("frame too large");
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_FRAME) throw new Error("frame too large");
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + length) return;
      if (masked !== expectMask) throw new Error("frame mask mismatch");
      let payload = buffer.subarray(offset + maskLen, offset + maskLen + length);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      } else {
        payload = Buffer.from(payload);
      }
      const frame = {
        fin: (buffer[0] & 0x80) !== 0,
        opcode: buffer[0] & 0x0f,
        payload,
      };
      buffer = buffer.subarray(offset + maskLen + length);
      onFrame(frame);
    }
  };
}

function wrapRawSocket(socket, { mask, expectMask }) {
  const listeners = { message: [], close: [], error: [] };
  let pending = [];
  let pendingOpcode = null;
  let closed = false;
  const emit = (event, arg) => {
    for (const fn of listeners[event] ?? []) fn(arg);
  };
  const emitMessage = (opcode, payload) => {
    emit("message", opcode === 0x1 ? payload.toString("utf8") : payload);
  };
  const parser = createFrameParser((frame) => {
    if (frame.opcode === 0x9) {
      if (!socket.destroyed) socket.write(encodeFrame(0xa, frame.payload, mask));
      return;
    }
    if (frame.opcode === 0x8) {
      if (!closed) {
        closed = true;
        if (!socket.writableEnded)
          socket.end(encodeFrame(0x8, frame.payload.subarray(0, Math.min(frame.payload.length, 125)), mask));
        emit("close");
      }
      return;
    }
    if (frame.opcode === 0xa) return;
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (pendingOpcode !== null) throw new Error("frame interrupted");
      if (!frame.fin) {
        pendingOpcode = frame.opcode;
        pending = [frame.payload];
        return;
      }
      emitMessage(frame.opcode, frame.payload);
      return;
    }
    if (frame.opcode === 0x0) {
      if (pendingOpcode === null) throw new Error("unexpected continuation");
      pending.push(frame.payload);
      if (!frame.fin) return;
      const payload = Buffer.concat(pending);
      const opcode = pendingOpcode;
      pending = [];
      pendingOpcode = null;
      emitMessage(opcode, payload);
    }
  }, expectMask);
  socket.on("data", (chunk) => {
    try {
      parser(chunk);
    } catch (error) {
      emit("error", error);
      if (!socket.destroyed) socket.destroy();
    }
  });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    emit("close");
  });
  socket.on("error", (error) => emit("error", error));
  return {
    send(data) {
      if (socket.destroyed || socket.writableEnded) return;
      const binary = Buffer.isBuffer(data);
      socket.write(encodeFrame(binary ? 0x2 : 0x1, data, mask));
    },
    close() {
      if (closed || socket.destroyed) return;
      closed = true;
      if (!socket.writableEnded) socket.end(encodeFrame(0x8, Buffer.alloc(0), mask));
    },
    on(event, fn) {
      listeners[event].push(fn);
    },
  };
}

export function relayRealtime(client, upstream) {
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    client.close();
    upstream.close();
  };
  client.on("message", (data) => {
    if (!closed) upstream.send(data);
  });
  upstream.on("message", (data) => {
    if (!closed) client.send(data);
  });
  client.on("close", finish);
  upstream.on("close", finish);
  client.on("error", finish);
  upstream.on("error", (error) => {
    if (!closed)
      client.send(JSON.stringify({
        type: "error",
        message: voiceErrorMessage(error),
        error: { message: voiceErrorMessage(error) },
      }));
    finish();
  });
}

function acceptHandshake(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    failUpgrade(socket, 400, "Missing websocket key");
    return false;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  if (head?.length) socket.unshift(head);
  return true;
}

export function connectXaiRealtime({ url, token, requestImpl }) {
  const target = new URL(url);
  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const request = (requestImpl ?? (secure ? https.request : http.request))({
    protocol: secure ? "https:" : "http:",
    hostname: target.hostname,
    port: target.port ? Number(target.port) : (secure ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
      Authorization: `Bearer ${token}`,
    },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };
    request.on("upgrade", (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== 101) {
        socket.destroy();
        fail(Object.assign(new Error("Grok voice connection failed"), {
          status: response.statusCode === 401 || response.statusCode === 403 ? 401 : 502,
        }));
        return;
      }
      settled = true;
      if (head?.length) socket.unshift(head);
      resolve(wrapRawSocket(socket, { mask: true, expectMask: false }));
    });
    request.on("response", (response) => {
      response.resume();
      const status = response.statusCode;
      fail(Object.assign(new Error("Grok voice connection failed"), {
        status: status === 401 || status === 403 ? 401 : status || 502,
      }));
    });
    request.on("error", () => {
      fail(Object.assign(new Error("Grok voice connection failed"), { status: 502 }));
    });
    request.end();
  });
}

// Codex keeps thread/realtime. It dials this provider at /v1/realtime.
// The grok login bearer is used only on the upstream socket.
export function attachRealtime(server, options) {
  const readBearer = options.readBearer ?? (() => readGrokBearerToken(options.grokHome));
  const connect = options.connect ?? connectXaiRealtime;
  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head, { ...options, readBearer, connect }).catch((error) => {
      failUpgrade(socket, 502, voiceErrorMessage(error));
    });
  });
}

async function handleUpgrade(req, socket, head, options) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/v1/realtime") {
    failUpgrade(socket, 404, "Not found");
    return;
  }
  if (!authorized(req.headers.authorization, options.token)) {
    failUpgrade(socket, 401, "Unauthorized");
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    failUpgrade(socket, 400, "Missing websocket key");
    return;
  }
  let session;
  try {
    session = await options.readBearer();
  } catch (error) {
    failUpgrade(socket, 401, error instanceof GrokAuthError ? error.message : "Grok login required");
    return;
  }
  if (!session || typeof session.token !== "string" || session.token.length === 0) {
    failUpgrade(socket, 401, "Grok login required");
    return;
  }
  let upstream;
  try {
    upstream = await options.connect({
      url: upstreamRealtimeUrl(req.url),
      token: session.token,
    });
  } catch (error) {
    failUpgrade(
      socket,
      error?.status === 401 || error?.status === 403 ? 401 : 502,
      voiceErrorMessage(error),
    );
    try { upstream?.close(); } catch { /* connect failed before a socket existed */ }
    return;
  }
  if (socket.destroyed) {
    upstream.close();
    return;
  }
  if (!acceptHandshake(req, socket, head)) {
    upstream.close();
    return;
  }
  relayRealtime(wrapRawSocket(socket, { mask: false, expectMask: true }), upstream);
}
