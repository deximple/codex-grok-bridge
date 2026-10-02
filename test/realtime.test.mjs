import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeServer } from "../src/bridge.mjs";
import OpusScript from "opusscript";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, useOPUS } from "werift";
import { DEFAULT_REALTIME_API_BASE, forwardRealtime } from "../src/realtime.mjs";
import {
  appendFromRtp,
  closeVoiceCalls,
  mulawToPcm16,
  pcm16ToMulaw,
  playbackFromDelta,
  rememberLocalCall,
  startVoiceBridge,
} from "../src/voice.mjs";

const BRIDGE = "bridge-token";
const GROK = "grok-login-token";
const OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
const ANSWER = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n";

function server(options = {}) {
  return createBridgeServer({
    token: BRIDGE,
    grokSession: { token: GROK, userId: null },
    ...options,
  });
}

async function withServer(options, run) {
  const httpServer = server(options);
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  try {
    return await run(httpServer.address().port);
  } finally {
    httpServer.closeAllConnections();
    await Promise.race([
      new Promise((resolve) => httpServer.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
  }
}

function postRaw(port, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "POST",
        headers: {
          authorization: `Bearer ${BRIDGE}`,
          "content-type": "application/sdp",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("realtime calls and live forward raw SDP bytes to xAI", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const location = new URL(url).pathname.endsWith("/live")
      ? "/v1/live/rtc_live"
      : "/v1/realtime/calls/rtc_call";
    return new Response(ANSWER, {
      status: 201,
      headers: { location, "content-type": "application/sdp" },
    });
  };
  await withServer({ realtimeFetch: fetchImpl }, async (port) => {
    const search = "?intent=quicksilver&architecture=avas";
    const call = await postRaw(port, `/v1/realtime/calls${search}`, OFFER);
    assert.equal(call.status, 201);
    assert.equal(call.body.toString("utf8"), ANSWER);
    assert.equal(call.headers["content-type"], "application/sdp");
    assert.equal(call.headers.location, "/v1/realtime/calls/rtc_call");
    const live = await postRaw(port, `/v1/live${search}`, OFFER, {
      "content-type": "application/sdp",
    });
    assert.equal(live.status, 201);
    assert.equal(live.headers.location, "/v1/live/rtc_live");
    assert.equal(live.body.toString("utf8"), ANSWER);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${DEFAULT_REALTIME_API_BASE}/realtime/calls${"?intent=quicksilver&architecture=avas"}`);
  assert.equal(calls[1].url, `${DEFAULT_REALTIME_API_BASE}/live?intent=quicksilver&architecture=avas`);
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.headers.authorization, `Bearer ${GROK}`);
    assert.equal(call.init.headers["content-type"], "application/sdp");
    assert.equal(Buffer.from(call.init.body).toString("utf8"), OFFER);
    assert.equal(JSON.stringify(call.init.headers).includes("XAI_API_KEY"), false);
    assert.equal(JSON.stringify(call.init.headers).includes(BRIDGE), false);
    assert.equal(JSON.stringify(call.init.body).includes(BRIDGE), false);
  }
});

test("a non-2xx upstream body is returned unchanged", async () => {
  const upstreamBody = Buffer.from('{"error":"nope","sdp":"v=synthesized"}\n', "utf8");
  await withServer(
    {
      realtimeBaseUrl: "https://realtime.test/v1/",
      realtimeFetch: async (url, init) => {
        assert.equal(url, "https://realtime.test/v1/realtime/calls?model=grok");
        assert.equal(init.headers.authorization, `Bearer ${GROK}`);
        assert.equal(Buffer.from(init.body).equals(Buffer.from("not-json-sdp")), true);
        return new Response(upstreamBody, {
          status: 401,
          headers: {
            "content-type": "application/json",
            location: "/v1/realtime/calls/rtc_denied",
          },
        });
      },
    },
    async (port) => {
      const denied = await postRaw(port, "/v1/realtime/calls?model=grok", "not-json-sdp");
      assert.equal(denied.status, 401);
      assert.equal(denied.headers["content-type"], "application/json");
      assert.equal(denied.headers.location, "/v1/realtime/calls/rtc_denied");
      assert.equal(denied.body.equals(upstreamBody), true);
      assert.equal(denied.body.toString("utf8").includes("Grok login"), false);
    },
  );
  await withServer(
    {
      realtimeFetch: async () =>
        new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
    },
    async (port) => {
      const missing = await postRaw(port, "/v1/live", OFFER);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.toString("utf8"), "missing");
      assert.equal(missing.headers["content-type"], "text/plain");
      assert.equal(missing.headers.location, undefined);
    },
  );
});

test("missing login is a local 401 and a transport error is not an SDP answer", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-grok-realtime-"));
  let fetches = 0;
  await withServer(
    {
      grokSession: undefined,
      grokHome: home,
      realtimeFetch: async () => {
        fetches += 1;
        throw new Error("should not fetch");
      },
    },
    async (port) => {
      const response = await postRaw(port, "/v1/realtime/calls", OFFER);
      assert.equal(response.status, 401);
      assert.equal(response.headers["content-type"], "application/json");
      const body = JSON.parse(response.body.toString("utf8"));
      assert.match(body.error, /Grok login required/);
      assert.equal(response.body.toString("utf8").includes("v="), false);
    },
  );
  await withServer(
    {
      realtimeFetch: async () => {
        fetches += 1;
        throw new Error(`reset ${GROK}`);
      },
    },
    async (port) => {
      const response = await postRaw(port, "/v1/live", OFFER);
      assert.equal(response.status, 502);
      const body = JSON.parse(response.body.toString("utf8"));
      assert.equal(body.error, "Realtime call failed.");
      assert.equal(response.body.toString("utf8").includes(GROK), false);
      assert.equal(response.body.toString("utf8").includes("v="), false);
    },
  );
  assert.equal(fetches, 1);
});

test("realtime routes keep the bridge token gate", async () => {
  let fetches = 0;
  await withServer(
    {
      maxBodyBytes: 8,
      realtimeFetch: async () => {
        fetches += 1;
        throw new Error("should not fetch");
      },
    },
    async (port) => {
      const missing = await postRaw(port, "/v1/realtime/calls", OFFER, { authorization: "" });
      assert.equal(missing.status, 401);
      const browser = await postRaw(port, "/v1/live", OFFER, { origin: "https://evil.example" });
      assert.equal(browser.status, 403);
      const oversized = await postRaw(port, "/v1/realtime/calls", "0123456789");
      assert.equal(oversized.status, 413);
      const get = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "/v1/live", method: "GET" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(get, 404);
    },
  );
  assert.equal(fetches, 0);
});

test("forwardRealtime uses the default base and an injected fetch", async () => {
  const seen = await forwardRealtime({
    path: "/realtime/calls",
    search: "?a=b",
    body: Buffer.from(OFFER),
    contentType: "application/sdp",
    token: GROK,
    fetchImpl: async (url, init) => {
      assert.equal(url, `${DEFAULT_REALTIME_API_BASE}/realtime/calls?a=b`);
      assert.equal(init.headers["content-type"], "application/sdp");
      return new Response(new Uint8Array(Buffer.from(ANSWER)), {
        status: 200,
        headers: { location: "/v1/realtime/calls/rtc_unit" },
      });
    },
  });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.toString("utf8"), ANSWER);
  assert.equal(seen.location, "/v1/realtime/calls/rtc_unit");
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${DEFAULT_REALTIME_API_BASE}/live`);
    assert.equal(Object.hasOwn(init.headers, "content-type"), false);
    return new Response(null, { status: 204 });
  };
  try {
    const empty = await forwardRealtime({ path: "/live", body: Buffer.alloc(0), token: GROK });
    assert.equal(empty.status, 204);
    assert.equal(empty.body.length, 0);
    assert.equal(empty.contentType, null);
    assert.equal(empty.location, null);
  } finally {
    globalThis.fetch = previous;
  }
});

class ScriptedSocket extends Duplex {
  constructor(reply) {
    super();
    this.reply = reply;
    this.chunks = [];
    this.replied = false;
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk));
    if (!this.replied && this.text().includes("\r\n\r\n")) {
      this.replied = true;
      this.push(this.reply);
    }
    if (this.text().includes("\r\n\r\nC")) this.emit("client-byte");
    cb();
  }
  _read() {}
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function rawUpgrade(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
      const headerMap = {
        Host: `127.0.0.1:${port}`,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        Authorization: `Bearer ${BRIDGE}`,
        ...headers,
      };
      const lines = [
        `GET ${requestPath} HTTP/1.1`,
        ...Object.entries(headerMap).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("upgrade timed out"));
      }
    }, 2000);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const head = Buffer.concat(chunks);
      const headersDone = head.includes("\r\n\r\n");
      const sidebandByte = requestPath.startsWith("/v1/live/") && head.includes("\r\n\r\nU");
      if (!settled && headersDone && (!requestPath.startsWith("/v1/live/") || sidebandByte)) {
        settled = true;
        clearTimeout(timer);
        resolve({ socket, head });
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ socket, head: Buffer.concat(chunks), closed: true });
      }
    });
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

test("a rejected xAI offer is answered by werift and bridged to the voice socket", async () => {
  const pcmu = new RTCRtpCodecParameters({
    mimeType: "audio/PCMU",
    clockRate: 8000,
    channels: 1,
    payloadType: 0,
  });
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [pcmu] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  const sockets = [];
  const fetchImpl = async () =>
    new Response(Buffer.from('{"error":"Team is not authorized"}'), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  try {
    await withServer(
      {
        realtimeFetch: fetchImpl,
        voiceWebSocket(_url, token) {
          assert.equal(token, GROK);
          const sent = [];
          const socket = {
            readyState: 1,
            sent,
            send(data) {
              sent.push(String(data));
            },
            close() {
              this.readyState = 3;
            },
          };
          sockets.push(socket);
          return socket;
        },
      },
      async (port) => {
        const answered = await postRaw(port, "/v1/realtime/calls", offerer.localDescription.sdp);
        assert.equal(answered.status, 201);
        assert.equal(answered.headers["content-type"], "application/sdp");
        const sdp = answered.body.toString("utf8");
        assert.equal(sdp.startsWith("v=0"), true);
        assert.equal(sdp.includes("a=fingerprint:"), true);
        assert.equal(sdp.includes("Team is not authorized"), false);
        assert.match(
          answered.headers.location,
          /^\/v1\/realtime\/calls\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        const sent = sockets[0].sent.map((line) => JSON.parse(line));
        assert.equal(sent[0].type, "session.update");
        assert.equal(sent[0].session.voice, "eve");
      },
    );
  } finally {
    closeVoiceCalls();
    await offerer.close();
  }
});

test("voice audio uses append and output_audio.delta", () => {
  const sent = [];
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const socket = {
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(String(data)));
    },
  };
  const bridge = startVoiceBridge({ track, socket });
  const mulaw = Buffer.from([0xff, 0x7f]);
  bridge.onRtp({ payload: mulaw });
  assert.equal(sent.at(-1).type, "input_audio_buffer.append");
  assert.equal(Buffer.from(sent.at(-1).audio, "base64").equals(mulawToPcm16(mulaw)), true);
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(16000, 2);
  bridge.onUpstream(
    JSON.stringify({ type: "response.output_audio.delta", delta: pcm.toString("base64") }),
  );
  assert.equal(track.rtp.length, 1);
  assert.equal(Buffer.from(track.rtp[0].payload).equals(pcm16ToMulaw(pcm)), true);
  bridge.onUpstream(JSON.stringify({ type: "ping" }));
  assert.equal(track.rtp.length, 1);
  const state = { sequence: 0, timestamp: 0, ssrc: 1 };
  playbackFromDelta(track, state, "");
  assert.equal(track.rtp.length, 1);
  appendFromRtp((event) => sent.push(event), Buffer.from([0x00]));
  assert.equal(sent.at(-1).type, "input_audio_buffer.append");
});

test("an opus-only offer is answered instead of returned as the xAI rejection", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [useOPUS()] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  await offerer.setLocalDescription(await offerer.createOffer());
  try {
    await withServer(
      {
        realtimeFetch: async () =>
          new Response("no", { status: 403, headers: { "content-type": "text/plain" } }),
        voiceWebSocket() {
          return { readyState: 1, send() {}, close() {} };
        },
      },
      async (port) => {
        const answered = await postRaw(port, "/v1/realtime/calls", offerer.localDescription.sdp);
        assert.equal(answered.status, 201);
        const sdp = answered.body.toString("utf8");
        assert.equal(sdp.startsWith("v=0"), true);
        assert.match(sdp, /a=rtpmap:\d+ opus\/48000/i);
        assert.equal(sdp.includes("a=fingerprint:"), true);
        assert.equal(sdp.includes("no"), false);
      },
    );
  } finally {
    closeVoiceCalls();
    await offerer.close();
  }
});

test("opus rtp is appended as pcm and playback is opus", () => {
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const encoded = encoder.encode(Buffer.alloc(960 * 4), 960);
  const sent = [];
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const socket = {
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(String(data)));
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket,
    codec: { kind: "opus", payloadType: 111 },
  });
  try {
    bridge.onRtp({ header: { payloadType: 111 }, payload: encoded });
    const appended = sent.find((event) => event.type === "input_audio_buffer.append");
    assert.ok(appended);
    assert.ok(Buffer.from(appended.audio, "base64").length > 0);
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.alloc(960 * 2).toString("base64"),
      }),
    );
    assert.equal(track.rtp.length, 1);
    assert.equal(track.rtp[0].header.payloadType, 111);
    assert.ok(track.rtp[0].payload.length > 0);
  } finally {
    bridge.close();
    encoder.delete?.();
  }
});

test("a locally answered sideband stays on the bridge", async () => {
  const id = rememberLocalCall("local-sideband-test");
  let dials = 0;
  await withServer(
    {
      sidebandConnect() {
        dials += 1;
        return new ScriptedSocket(Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"));
      },
    },
    async (port) => {
      const local = await rawUpgrade(port, `/v1/realtime?call_id=${id}`);
      assert.equal(local.closed, undefined);
      assert.match(local.head.toString("latin1"), /^HTTP\/1\.1 101 /);
      assert.match(local.head.toString("latin1"), /Sec-WebSocket-Accept:/);
      local.socket.destroy();
    },
  );
  assert.equal(dials, 0);
});

test("sideband upgrade is piped to api.x.ai with the grok bearer", async () => {
  const upstreams = [];
  const reply = Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nU",
  );
  await withServer(
    {
      sidebandConnect() {
        const upstream = new ScriptedSocket(reply);
        upstreams.push(upstream);
        return upstream;
      },
    },
    async (port) => {
      const live = await rawUpgrade(port, "/v1/live/call-1?x=1");
      assert.equal(live.closed, undefined);
      const text = live.head.toString("latin1");
      assert.match(text, /^HTTP\/1\.1 101 /);
      assert.equal(text.endsWith("\r\n\r\nU"), true);
      const sent = upstreams[0].text();
      assert.match(sent, /^GET \/v1\/live\/call-1\?x=1 HTTP\/1\.1/);
      assert.match(sent, new RegExp(`Authorization: Bearer ${GROK}`));
      assert.equal(sent.includes(BRIDGE), false);
      assert.match(sent, /Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==/);
      const clientByte = once(upstreams[0], "client-byte");
      live.socket.write(Buffer.from("C"));
      await clientByte;
      assert.equal(upstreams[0].text().endsWith("\r\n\r\nC"), true);
      live.socket.destroy();
      upstreams[0].destroy();
    },
  );
  assert.equal(upstreams.length, 1);
});

test("sideband upgrade does not dial on auth, origin, or other paths", async () => {
  let dials = 0;
  const connect = () => {
    dials += 1;
    return new ScriptedSocket(Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"));
  };
  await withServer({ sidebandConnect: connect }, async (port) => {
    const denied = await rawUpgrade(port, "/v1/realtime?call_id=nope", {
      Authorization: "Bearer wrong",
    });
    assert.equal(denied.closed, true);
    const browser = await rawUpgrade(port, "/v1/realtime?call_id=browser", {
      Origin: "https://evil.example",
    });
    assert.equal(browser.closed, true);
    const other = await rawUpgrade(port, "/v1/responses");
    assert.equal(other.closed, true);
  });
  const home = await mkdtemp(path.join(tmpdir(), "codex-grok-sideband-"));
  await withServer(
    { sidebandConnect: connect, grokSession: undefined, grokHome: home },
    async (port) => {
      const missing = await rawUpgrade(port, "/v1/realtime?call_id=login");
      assert.equal(missing.closed, true);
    },
  );
  assert.equal(dials, 0);
});

class SilentSocket extends Duplex {
  constructor() {
    super();
  }
  _write(_chunk, _enc, cb) {
    cb();
  }
  _read() {}
}

test("a sideband handshake that never answers closes the client", async () => {
  let dials = 0;
  await withServer(
    {
      sidebandHandshakeMs: 30,
      sidebandConnect() {
        dials += 1;
        return new SilentSocket();
      },
    },
    async (port) => {
      const hung = await rawUpgrade(port, "/v1/realtime?call_id=slow");
      assert.equal(hung.closed, true);
      assert.equal(hung.head.includes("101"), false);
    },
  );
  assert.equal(dials, 1);
});
