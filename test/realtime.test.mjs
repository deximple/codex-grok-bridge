import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import { GrokAuthError } from "../src/auth.mjs";
import { createBridgeServer } from "../src/bridge.mjs";
import {
  connectXaiRealtime,
  relayRealtime,
  upstreamRealtimeUrl,
} from "../src/realtime.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function fakePeer() {
  const listeners = { message: [], close: [], error: [] };
  const sent = [];
  const waiters = [];
  let taken = 0;
  return {
    sent,
    closed: false,
    send(data) {
      sent.push(data);
      const waiter = waiters.shift();
      if (waiter) {
        taken += 1;
        waiter(data);
      }
    },
    next() {
      if (sent.length > taken) return Promise.resolve(sent[taken++]);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      for (const fn of listeners.close) fn();
    },
    on(event, fn) {
      listeners[event].push(fn);
    },
    emit(event, arg) {
      for (const fn of listeners[event] ?? []) fn(arg);
    },
  };
}

function encodeClientFrame(opcode, payload, { fin = true, mask = true } = {}) {
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
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  header[1] = (mask ? 0x80 : 0x00) | lengthByte;
  if (lengthByte === 126) header.writeUInt16BE(data.length, 2);
  else if (lengthByte === 127) header.writeBigUInt64BE(BigInt(data.length), 2);
  let body = data;
  if (mask) {
    maskKey.copy(header, 2 + extra);
    body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= maskKey[i & 3];
  }
  return Buffer.concat([header, body]);
}

function decodeServerFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const lengthByte = buffer[offset + 1] & 0x7f;
    if (buffer[offset + 1] & 0x80) throw new Error("server frame was masked");
    let length = lengthByte;
    let start = offset + 2;
    if (lengthByte === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      start = offset + 4;
    } else if (lengthByte === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      length = Number(big);
      start = offset + 10;
    }
    if (buffer.length - start < length) break;
    frames.push({
      opcode: buffer[offset] & 0x0f,
      payload: Buffer.from(buffer.subarray(start, start + length)),
    });
    offset = start + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function openUpgrade(port, { path = "/v1/realtime?model=gpt-realtime&intent=conversation", token, key = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const wsKey = randomBytes(16).toString("base64");
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
      ];
      if (key) lines.push(`Sec-WebSocket-Key: ${wsKey}`);
      if (token) lines.push(`Authorization: Bearer ${token}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        const header = buf.subarray(0, end).toString("utf8");
        resolve({
          socket,
          header,
          rest: buf.subarray(end + 4),
          wsKey,
          status: Number(/^HTTP\/1.1 (\d+)/.exec(header)?.[1]),
        });
      };
      socket.on("data", onData);
    });
    socket.on("error", reject);
  });
}

async function readHttp(port, options) {
  const result = await openUpgrade(port, options);
  if (result.status === 101) return result;
  const length = Number(/Content-Length: (\d+)/i.exec(result.header)?.[1] ?? 0);
  let body = result.rest;
  while (body.length < length) {
    const [chunk] = await once(result.socket, "data");
    body = Buffer.concat([body, chunk]);
  }
  result.body = body.toString("utf8");
  result.socket.end();
  return result;
}

function frameReader(socket, initial = Buffer.alloc(0)) {
  let buffer = initial;
  const pending = [];
  const waiters = [];
  const pump = () => {
    const decoded = decodeServerFrames(buffer);
    buffer = Buffer.from(decoded.rest);
    pending.push(...decoded.frames);
    while (pending.length && waiters.length) waiters.shift()(pending.shift());
  };
  pump();
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  return {
    next() {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function withServer(options, fn) {
  const server = createBridgeServer({
    token: "bridge-token",
    readRealtimeBearer: () => ({ token: "grok-bearer" }),
    connectRealtime: async () => {
      throw new Error("unexpected connect");
    },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await fn(server.address().port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

test("voice url keeps a grok voice model and replaces anything else", () => {
  assert.equal(
    upstreamRealtimeUrl("/v1/realtime?model=gpt-realtime&intent=conversation"),
    "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
  );
  assert.equal(
    upstreamRealtimeUrl("/v1/realtime?model=grok-voice-think-fast-2.0"),
    "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0",
  );
  assert.equal(
    upstreamRealtimeUrl("/v1/realtime"),
    "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
  );
});

test("relay forwards realtime events and turns a rejected bearer into an error", () => {
  const client = fakePeer();
  const upstream = fakePeer();
  relayRealtime(client, upstream);
  client.emit("message", '{"type":"input_audio_buffer.append","audio":"AQID"}');
  assert.deepEqual(upstream.sent, ['{"type":"input_audio_buffer.append","audio":"AQID"}']);
  upstream.emit("message", '{"type":"response.output_audio.delta","delta":"AQID"}');
  assert.deepEqual(client.sent, ['{"type":"response.output_audio.delta","delta":"AQID"}']);
  const error = new Error("Bearer grok-bearer rejected");
  error.status = 401;
  upstream.emit("error", error);
  assert.equal(client.sent.length, 2);
  const parsed = JSON.parse(client.sent[1]);
  assert.equal(parsed.type, "error");
  assert.equal(parsed.message, "Grok login expired. Run grok login.");
  assert.equal(client.sent[1].includes("output_audio"), false);
  assert.equal(client.sent[1].includes("grok-bearer"), false);
  assert.equal(client.closed, true);
  assert.equal(upstream.closed, true);
  client.emit("message", '{"type":"input_audio_buffer.append","audio":"MORE"}');
  assert.equal(upstream.sent.length, 1);
});

test("a missing bearer fails the upgrade and does not open a voice socket", async () => {
  let connected = false;
  let lookedUp = false;
  await withServer(
    {
      readRealtimeBearer: () => {
        lookedUp = true;
        throw new GrokAuthError("Grok login required");
      },
      connectRealtime: async () => {
        connected = true;
        return fakePeer();
      },
    },
    async (port) => {
      const response = await readHttp(port, { token: "bridge-token" });
      assert.equal(response.status, 401);
      assert.match(response.body, /Grok login required/);
      assert.doesNotMatch(response.body, /output_audio|delta/);
      assert.equal(connected, false);
      assert.equal(lookedUp, true);
    },
  );
});

test("an empty bearer and a non-auth failure stay a login error without audio", async () => {
  await withServer(
    {
      readRealtimeBearer: () => ({ token: "" }),
      connectRealtime: async () => fakePeer(),
    },
    async (port) => {
      const response = await readHttp(port, { token: "bridge-token" });
      assert.equal(response.status, 401);
      assert.match(response.body, /Grok login required/);
      assert.doesNotMatch(response.body, /output_audio/);
    },
  );
  await withServer(
    {
      readRealtimeBearer: () => {
        throw new Error("disk failed at /tmp/secret-token");
      },
    },
    async (port) => {
      const response = await readHttp(port, { token: "bridge-token" });
      assert.equal(response.status, 401);
      assert.match(response.body, /Grok login required/);
      assert.equal(response.body.includes("secret-token"), false);
    },
  );
});

test("a rejected upstream bearer is an error response, not an audio frame", async () => {
  let connected = false;
  await withServer(
    {
      connectRealtime: async ({ url, token }) => {
        connected = true;
        assert.equal(url, "wss://api.x.ai/v1/realtime?model=grok-voice-latest");
        assert.equal(token, "grok-bearer");
        const error = new Error("upstream said Bearer grok-bearer");
        error.status = 403;
        throw error;
      },
    },
    async (port) => {
      const response = await readHttp(port, { token: "bridge-token" });
      assert.equal(response.status, 401);
      assert.match(response.body, /Grok login expired/);
      assert.doesNotMatch(response.body, /output_audio|AQID|grok-bearer/);
      assert.equal(connected, true);
    },
  );
});

test("the bridge token is required before any bearer lookup", async () => {
  let lookedUp = false;
  await withServer(
    {
      readRealtimeBearer: () => {
        lookedUp = true;
        return { token: "grok-bearer" };
      },
    },
    async (port) => {
      const missing = await readHttp(port, {});
      assert.equal(missing.status, 401);
      assert.match(missing.body, /Unauthorized/);
      const wrong = await readHttp(port, { token: "other-token" });
      assert.equal(wrong.status, 401);
      const other = await readHttp(port, { path: "/v1/responses", token: "bridge-token" });
      assert.equal(other.status, 404);
      const nokey = await readHttp(port, { token: "bridge-token", key: false });
      assert.equal(nokey.status, 400);
      assert.equal(lookedUp, false);
    },
  );
});

test("audio appends and deltas cross a fake upstream socket", async () => {
  const upstream = fakePeer();
  let seen;
  await withServer(
    {
      connectRealtime: async (attempt) => {
        seen = attempt;
        return upstream;
      },
    },
    async (port) => {
      const opened = await openUpgrade(port, {
        path: "/v1/realtime?model=grok-voice-think-fast-2.0",
        token: "bridge-token",
      });
      assert.equal(opened.status, 101);
      const accept = createHash("sha1").update(opened.wsKey + WS_GUID).digest("base64");
      assert.ok(opened.header.includes(`Sec-WebSocket-Accept: ${accept}`));
      assert.equal(seen.token, "grok-bearer");
      assert.equal(seen.url, "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0");
      const frames = frameReader(opened.socket, opened.rest);
      const append = '{"type":"input_audio_buffer.append","audio":"AQID"}';
      opened.socket.write(encodeClientFrame(0x1, append));
      assert.equal(await upstream.next(), append);
      opened.socket.write(encodeClientFrame(0x1, "hel", { fin: false }));
      opened.socket.write(encodeClientFrame(0x0, "lo"));
      assert.equal(await upstream.next(), "hello");
      const speech = '{"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}';
      opened.socket.write(encodeClientFrame(0x1, speech));
      assert.equal(await upstream.next(), speech);
      const wide = "w".repeat(200);
      opened.socket.write(encodeClientFrame(0x1, wide));
      assert.equal(await upstream.next(), wide);
      opened.socket.write(encodeClientFrame(0x2, Buffer.from([1, 2, 3])));
      assert.deepEqual(await upstream.next(), Buffer.from([1, 2, 3]));
      const bulky = "b".repeat(65536);
      opened.socket.write(encodeClientFrame(0x1, bulky));
      assert.equal(await upstream.next(), bulky);
      opened.socket.write(encodeClientFrame(0x9, "ping"));
      const pong = await frames.next();
      assert.equal(pong.opcode, 0xa);
      assert.equal(pong.payload.toString(), "ping");
      const delta = '{"type":"response.output_audio.delta","delta":"AQID"}';
      upstream.emit("message", delta);
      const audio = await frames.next();
      assert.equal(audio.opcode, 0x1);
      assert.equal(audio.payload.toString(), delta);
      upstream.emit("message", wide);
      const echoed = await frames.next();
      assert.equal(echoed.payload.toString(), wide);
      upstream.emit("message", bulky);
      const echoedBulky = await frames.next();
      assert.equal(echoedBulky.payload.toString(), bulky);
      upstream.emit("error", Object.assign(new Error("later"), { status: 401 }));
      const failure = await frames.next();
      assert.equal(JSON.parse(failure.payload.toString()).type, "error");
      assert.equal(failure.payload.toString().includes("output_audio"), false);
      opened.socket.write(encodeClientFrame(0x8, Buffer.alloc(0)));
      const started = Date.now();
      while (!upstream.closed && Date.now() - started < 2000)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(upstream.closed, true);
    },
  );
});

test("a protocol error does not become an audio delta", async () => {
  const frames = [
    Buffer.from([0x81, 0x02, 0x41, 0x42]),
    (() => {
      const huge = Buffer.alloc(10);
      huge[0] = 0x81;
      huge[1] = 0xff;
      huge.writeBigUInt64BE(BigInt(8 * 1024 * 1024 + 1), 2);
      return huge;
    })(),
    encodeClientFrame(0x0, "nope"),
    Buffer.concat([
      encodeClientFrame(0x1, "hel", { fin: false }),
      encodeClientFrame(0x1, "nope"),
    ]),
  ];
  for (const frame of frames) {
    const upstream = fakePeer();
    await withServer({ connectRealtime: async () => upstream }, async (port) => {
      const opened = await openUpgrade(port, { token: "bridge-token" });
      assert.equal(opened.status, 101);
      const closed = once(opened.socket, "close");
      opened.socket.write(frame);
      await closed;
      assert.equal(upstream.sent.length, 0);
    });
  }
});

test("an upstream transport failure is a bad gateway, not audio", async () => {
  await withServer(
    {
      connectRealtime: async () => {
        throw Object.assign(new Error("reset"), { status: 502 });
      },
    },
    async (port) => {
      const response = await readHttp(port, { token: "bridge-token" });
      assert.equal(response.status, 502);
      assert.match(response.body, /Grok voice connection failed/);
      assert.doesNotMatch(response.body, /output_audio/);
    },
  );
});

test("connectXaiRealtime sends the grok bearer and fails a rejected handshake", async () => {
  await assert.rejects(
    connectXaiRealtime({
      url: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
      token: "grok-bearer",
      requestImpl(options) {
        assert.equal(options.headers.Authorization, "Bearer grok-bearer");
        assert.equal(options.hostname, "api.x.ai");
        assert.equal(options.path, "/v1/realtime?model=grok-voice-latest");
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => {
          const response = new EventEmitter();
          response.statusCode = 401;
          response.resume = () => {};
          req.emit("response", response);
        };
        return req;
      },
    }),
    (error) => error.status === 401 && !String(error.message).includes("grok-bearer"),
  );

  const upstream = new PassThrough();
  const socket = await connectXaiRealtime({
    url: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    token: "grok-bearer",
    requestImpl(options) {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        req.emit("upgrade", { statusCode: 101, headers: {} }, upstream, Buffer.alloc(0));
      };
      assert.equal(options.port, 443);
      return req;
    },
  });
  const incoming = new Promise((resolve) => socket.on("message", resolve));
  const payload = Buffer.from('{"type":"response.output_audio.delta","delta":"AQID"}');
  upstream.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  const message = await incoming;
  assert.equal(message, payload.toString());
  socket.close();
});

test("a transport failure and a non-101 upgrade reject without audio", async () => {
  await assert.rejects(
    connectXaiRealtime({
      url: "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
      token: "grok-bearer",
      requestImpl() {
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => req.emit("error", new Error("reset"));
        return req;
      },
    }),
    (error) => error.status === 502,
  );
  await assert.rejects(
    connectXaiRealtime({
      url: "ws://127.0.0.1:9/v1/realtime?model=grok-voice-latest",
      token: "grok-bearer",
      requestImpl(options) {
        assert.equal(options.protocol, "http:");
        assert.equal(options.port, 9);
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => {
          const socket = new PassThrough();
          req.emit("upgrade", { statusCode: 404, headers: {} }, socket, Buffer.alloc(0));
        };
        return req;
      },
    }),
    (error) => error.status === 502,
  );
});
