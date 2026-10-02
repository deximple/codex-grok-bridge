import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  voiceAudioDelta,
  voiceSocketUrl,
  openVoiceSocket,
  MIC_HOLD_FRAMES,
  rememberLocalCall,
  remoteAudioTracks,
  startVoiceBridge,
  voiceCallCount,
  flushDelegationSpeech,
  mergeVoiceClientBurst,
  playoutGap,
  queueDelegationSpeech,
  voiceClientEvents,
  voiceSidebandEvent,
  sidebandFrames,
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

function rawUpgrade(port, requestPath, headers = {}, waitForTrail = requestPath.startsWith("/v1/live/")) {
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
      const sidebandByte = waitForTrail && head.includes("\r\n\r\nU");
      if (!settled && headersDone && (!waitForTrail || sidebandByte)) {
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
        assert.equal(sent[0].session.resumption.enabled, true);
        assert.equal(sent[0].session.tools[0].name, "codex");
        assert.equal(sent[0].session.audio.input.format.rate, 24000);
        assert.equal(sent[0].session.audio.input.transcription.model, "grok-transcribe");
        assert.equal(sent[0].session.audio.output.format.type, "audio/pcm");
      },
    );
  } finally {
    closeVoiceCalls();
    await offerer.close();
  }
});

test("a sideband frame bundled with the upgrade reaches xAI", async () => {
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
  await offerer.setLocalDescription(await offerer.createOffer());
  const sockets = [];
  try {
    await withServer(
      {
        realtimeFetch: async () =>
          new Response(Buffer.from('{"error":"Team is not authorized"}'), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        voiceWebSocket() {
          const sent = [];
          const socket = {
            readyState: 1,
            sent,
            send(data) {
              sent.push(String(data));
            },
            close() {},
          };
          sockets.push(socket);
          return socket;
        },
      },
      async (port) => {
        const answered = await postRaw(port, "/v1/realtime/calls", offerer.localDescription.sdp);
        assert.equal(answered.status, 201);
        const id = answered.headers.location.split("/").pop();
        const payload = Buffer.from(JSON.stringify({ type: "response.cancel" }));
        const mask = Buffer.from([9, 8, 7, 6]);
        const frame = Buffer.concat([
          Buffer.from([0x81, 0x80 | payload.length]),
          mask,
          Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])),
        ]);
        const socket = net.connect(port, "127.0.0.1");
        await once(socket, "connect");
        socket.write(
          Buffer.concat([
            Buffer.from(
              `GET /v1/live/${id} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${BRIDGE}\r\n\r\n`,
            ),
            frame,
          ]),
        );
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && !sockets[0].sent.some((line) => line.includes("response.cancel"))) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        socket.destroy();
        assert.equal(
          sockets[0].sent.some((line) => JSON.parse(line).type === "response.cancel"),
          true,
        );
      },
    );
  } finally {
    closeVoiceCalls();
    await offerer.close();
  }
});

test("a sideband request waits until the voice socket is open", () => {
  const sent = [];
  const socket = {
    readyState: 0,
    send(data) {
      sent.push(JSON.parse(String(data)));
    },
  };
  const bridge = startVoiceBridge({
    track: { onReceiveRtp: { subscribe() {} } },
    socket,
  });
  try {
    bridge.sendClient({ type: "response.create" });
    assert.equal(sent.length, 0);
    socket.readyState = 1;
    socket.onopen();
    assert.equal(sent[0].type, "session.update");
    assert.equal(sent.some((event) => event.type === "response.create"), true);
  } finally {
    bridge.close();
  }
});

test("a tool reply waits until playback finishes", async () => {
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
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.concat([Buffer.alloc(960), Buffer.alloc(960)]).toString("base64"),
      }),
    );
    bridge.onUpstream(JSON.stringify({ type: "response.done" }));
    bridge.sendClient({
      type: "conversation.item.create",
      item: { type: "force_message", role: "assistant", content: [{ type: "output_text", text: "Next." }] },
    });
    assert.equal(sent.some((event) => event.item?.type === "force_message"), false);
    const deadline = Date.now() + 500;
    while (!sent.some((event) => event.item?.type === "force_message") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(sent.some((event) => event.item?.type === "force_message"), true);
    assert.ok(track.rtp.length >= 2);
  } finally {
    bridge.close();
  }
});

test("user speech stops queued voice playback", async () => {
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: { readyState: 1, send() {} },
    codec: { kind: "opus", payloadType: 111 },
  });
  try {
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.alloc(960 * 4).toString("base64"),
      }),
    );
    assert.equal(track.rtp.length >= 1, true);
    const sent = track.rtp.length;
    bridge.onUpstream(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(track.rtp.length, sent);
    bridge.onUpstream(JSON.stringify({ type: "response.done" }));
    bridge.onUpstream(JSON.stringify({ type: "response.created" }));
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.alloc(960).toString("base64"),
      }),
    );
    assert.equal(track.rtp.length > sent, true);
  } finally {
    bridge.close();
  }
});

test("user speech truncates the assistant item to the audio already sent", () => {
  const sent = [];
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: {
      readyState: 1,
      send(data) {
        sent.push(JSON.parse(String(data)));
      },
    },
    codec: { kind: "opus", payloadType: 111 },
  });
  try {
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "item-1",
        content_index: 0,
        delta: Buffer.alloc(960 * 4).toString("base64"),
      }),
    );
    assert.equal(track.rtp.length, 1);
    bridge.onUpstream(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    const truncated = sent.filter((event) => event.type === "conversation.item.truncate");
    assert.equal(truncated.length, 1);
    assert.equal(truncated[0].item_id, "item-1");
    assert.equal(truncated[0].content_index, 0);
    assert.equal(truncated[0].audio_end_ms, 20);
    bridge.onUpstream(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    assert.equal(sent.filter((event) => event.type === "conversation.item.truncate").length, 1);
  } finally {
    bridge.close();
  }
});

test("a later user turn does not truncate a finished voice reply", () => {
  const sent = [];
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: {
      readyState: 1,
      send(data) {
        sent.push(JSON.parse(String(data)));
      },
    },
    codec: { kind: "opus", payloadType: 111 },
  });
  try {
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "item-1",
        delta: Buffer.alloc(960).toString("base64"),
      }),
    );
    bridge.onUpstream(JSON.stringify({ type: "response.done" }));
    assert.equal(track.rtp.length, 1);
    bridge.onUpstream(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    assert.equal(sent.some((event) => event.type === "conversation.item.truncate"), false);
  } finally {
    bridge.close();
  }
});

test("a tool reply waits until the user stops speaking", () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(String(data)));
    },
  };
  const bridge = startVoiceBridge({
    track: { onReceiveRtp: { subscribe() {} }, writeRtp() {} },
    socket,
  });
  try {
    bridge.onUpstream(JSON.stringify({ type: "response.created" }));
    bridge.sendClient({
      type: "conversation.item.create",
      item: { type: "force_message", role: "assistant", content: [{ type: "output_text", text: "Later." }] },
    });
    bridge.onUpstream(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    bridge.onUpstream(JSON.stringify({ type: "response.done" }));
    assert.equal(sent.some((event) => event.item?.type === "force_message"), false);
    bridge.onUpstream(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    assert.equal(sent.some((event) => event.item?.type === "force_message"), true);
  } finally {
    bridge.close();
  }
});

test("a tool reply waits until the voice response is done", () => {
  const sent = [];
  const socket = {
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(String(data)));
    },
  };
  const bridge = startVoiceBridge({
    track: { onReceiveRtp: { subscribe() {} }, writeRtp() {} },
    socket,
  });
  try {
    bridge.onUpstream(JSON.stringify({ type: "response.created" }));
    bridge.sendClient({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1", output: JSON.stringify("done") },
    });
    bridge.sendClient({
      type: "conversation.item.create",
      item: { type: "force_message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    });
    bridge.sendClient({ type: "response.cancel" });
    assert.equal(sent.some((event) => event.item?.type === "force_message"), false);
    assert.equal(sent.some((event) => event.type === "response.cancel"), true);
    bridge.onUpstream(JSON.stringify({ type: "response.done" }));
    const items = sent.map((event) => event.item?.type).filter(Boolean);
    assert.deepEqual(items, ["function_call_output", "force_message"]);
  } finally {
    bridge.close();
  }
});

test("microphone audio held for the session ack keeps two seconds", () => {
  const sent = [];
  const bridge = startVoiceBridge({
    track: { onReceiveRtp: { subscribe() {} }, writeRtp() {} },
    socket: {
      readyState: 1,
      send(data) {
        sent.push(JSON.parse(String(data)));
      },
    },
  });
  try {
    const frames = MIC_HOLD_FRAMES - 10;
    for (let i = 0; i < frames; i += 1) bridge.onRtp({ payload: Buffer.from([i & 0xff]) });
    assert.equal(sent.some((event) => event.type === "input_audio_buffer.append"), false);
    bridge.onUpstream(JSON.stringify({ type: "session.updated", session: { id: "sess-1" } }));
    assert.equal(sent.filter((event) => event.type === "input_audio_buffer.append").length, frames);
  } finally {
    bridge.close();
  }
});

test("voice audio accepts the documented delta and audio fields", () => {
  const pcm = Buffer.alloc(6).toString("base64");
  assert.equal(voiceAudioDelta({ type: "response.output_audio.delta", delta: pcm }), pcm);
  assert.equal(voiceAudioDelta({ type: "response.audio.delta", audio: pcm }), pcm);
  assert.equal(voiceAudioDelta({ type: "response.output_audio.delta", audio: pcm }), pcm);
  assert.equal(voiceAudioDelta({ type: "response.done" }), "");
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
  assert.equal(sent.some((event) => event.type === "input_audio_buffer.append"), false);
  bridge.onUpstream(JSON.stringify({ type: "session.updated", session: { id: "sess-1" } }));
  assert.equal(sent.at(-1).type, "input_audio_buffer.append");
  assert.equal(Buffer.from(sent.at(-1).audio, "base64").length, mulawToPcm16(mulaw).length * 3);
  const pcm = Buffer.alloc(6);
  bridge.onUpstream(
    JSON.stringify({ type: "response.output_audio.delta", delta: pcm.toString("base64") }),
  );
  assert.equal(track.rtp.length, 1);
  assert.equal(track.rtp[0].payload.length, 1);
  bridge.onUpstream(JSON.stringify({ type: "ping" }));
  assert.equal(track.rtp.length, 1);
  const state = { sequence: 0, timestamp: 0, ssrc: 1 };
  playbackFromDelta(track, state, "");
  assert.equal(track.rtp.length, 1);
  appendFromRtp((event) => sent.push(event), Buffer.from([0x00]));
  assert.equal(sent.at(-1).type, "input_audio_buffer.append");
});

test("a short voice reply is played when the turn ends", () => {
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: { readyState: 1, send() {} },
    codec: { kind: "opus", payloadType: 111 },
  });
  bridge.onUpstream(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(200).toString("base64") }));
  assert.equal(track.rtp.length, 0);
  bridge.onUpstream(JSON.stringify({ type: "response.output_audio.done" }));
  assert.equal(track.rtp.length, 1);
  assert.equal(track.rtp[0].header.payloadType, 111);
  assert.equal(track.rtp[0].header.marker, true);
  bridge.onUpstream(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(200).toString("base64") }));
  bridge.onUpstream(JSON.stringify({ type: "response.done" }));
  assert.equal(track.rtp.length, 2);
  assert.equal(track.rtp[1].header.marker, true);
});

test("a live-sized voice delta is played as opus", async () => {
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: { readyState: 1, send() {} },
    codec: { kind: "opus", payloadType: 111 },
  });
  bridge.onUpstream(
    JSON.stringify({
      type: "response.output_audio.delta",
      delta: Buffer.alloc(26424).toString("base64"),
    }),
  );
  const second = Date.now() + 500;
  while (track.rtp.length < 2 && Date.now() < second) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(track.rtp.length > 1);
  assert.equal(track.rtp[0].header.marker, true);
  assert.equal(track.rtp[0].header.payloadType, 111);
  assert.equal(track.rtp[1].header.marker, false);
  const played = track.rtp.length;
  bridge.onUpstream(JSON.stringify({ type: "response.output_audio.done" }));
  assert.ok(track.rtp.length >= played);
  bridge.close();
});

test("a later voice turn keeps its own talkspurt marker", async () => {
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: { readyState: 1, send() {} },
    codec: { kind: "opus", payloadType: 111 },
  });
  try {
    const frame = Buffer.alloc(960);
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.concat([frame, frame]).toString("base64"),
      }),
    );
    bridge.onUpstream(JSON.stringify({ type: "response.output_audio.done" }));
    bridge.onUpstream(JSON.stringify({ type: "response.output_audio.delta", delta: frame.toString("base64") }));
    const deadline = Date.now() + 500;
    while (track.rtp.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(track.rtp.length >= 3, true);
    assert.equal(track.rtp[0].header.marker, true);
    assert.equal(track.rtp[1].header.marker, false);
    assert.equal(track.rtp[2].header.marker, true);
  } finally {
    bridge.close();
  }
});

test("a streamed codex reply is spoken once", () => {
  const state = { pendingCalls: new Set(["call-1"]) };
  const frame = (text) => ({
    type: "delegation.context.append",
    delegation_item_id: "call-1",
    content: [{ type: "input_text", text }],
  });
  assert.equal(queueDelegationSpeech(state, frame("AAAA")), true);
  assert.equal(queueDelegationSpeech(state, frame("BBBB")), true);
  assert.equal(state.pendingCalls.has("call-1"), true);
  const spoken = flushDelegationSpeech(state);
  assert.equal(spoken[0].item.type, "function_call_output");
  assert.equal(spoken[0].item.output, JSON.stringify("AAAABBBB"));
  assert.equal(spoken[1].item.type, "force_message");
  assert.equal(spoken[1].item.content[0].text, "AAAABBBB");
  assert.equal(state.pendingCalls.has("call-1"), false);
  const quiet = { pendingCalls: new Set(["call-2"]) };
  assert.equal(
    queueDelegationSpeech(quiet, {
      type: "delegation.context.append",
      delegation_item_id: "call-2",
      channel: "commentary",
      content: [{ type: "input_text", text: "[STATUS] reading" }],
    }),
    false,
  );
  assert.equal(
    queueDelegationSpeech(quiet, {
      type: "delegation.context.append",
      delegation_item_id: "call-2",
      channel: "commentary",
      content: [{ type: "input_text", text: "Renamed the helper." }],
    }),
    true,
  );
  const aside = flushDelegationSpeech(quiet);
  assert.equal(aside[0].item.type, "function_call_output");
  assert.equal(aside[1].item.type, "message");
  assert.equal(aside[2].type, "response.create");
  assert.equal(aside.some((event) => event.item?.type === "force_message"), false);
});

test("a short playout delay does not split the talkspurt", () => {
  assert.equal(playoutGap({ lastSentAt: 1000 }, 1040), 0);
  assert.equal(playoutGap({ lastSentAt: 1000 }, 1070), 0);
  assert.ok(playoutGap({ lastSentAt: 1000 }, 1120) > 0);
});

test("a silent gap advances the voice playout clock", async () => {
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: { readyState: 1, send() {} },
    codec: { kind: "opus", payloadType: 111 },
  });
  try {
    const frame = Buffer.alloc(960).toString("base64");
    bridge.onUpstream(JSON.stringify({ type: "response.output_audio.delta", delta: frame }));
    bridge.onUpstream(JSON.stringify({ type: "response.output_audio.done" }));
    assert.equal(track.rtp.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    bridge.onUpstream(JSON.stringify({ type: "response.output_audio.delta", delta: frame }));
    assert.equal(track.rtp.length, 2);
    assert.equal(track.rtp[1].header.marker, true);
    assert.ok(track.rtp[1].header.timestamp > track.rtp[0].header.timestamp + 960);
  } finally {
    bridge.close();
  }
});

test("closing the voice bridge stops playback retries", async () => {
  let writes = 0;
  const track = {
    onReceiveRtp: { subscribe() {} },
    writeRtp() {
      writes += 1;
      throw new Error("not connected");
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: { readyState: 1, send() {} },
    codec: { kind: "opus", payloadType: 111 },
  });
  bridge.onUpstream(
    JSON.stringify({
      type: "response.output_audio.delta",
      delta: Buffer.alloc(960).toString("base64"),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const atClose = writes;
  assert.ok(atClose >= 1);
  bridge.close();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes, atClose);
});

test("a playback frame is retried when the peer is not ready", async () => {
  let fail = true;
  const track = {
    onReceiveRtp: { subscribe() {} },
    rtp: [],
    writeRtp(packet) {
      if (fail) throw new Error("not connected");
      this.rtp.push(packet);
    },
  };
  const bridge = startVoiceBridge({
    track,
    socket: { readyState: 1, send() {} },
    codec: { kind: "opus", payloadType: 111 },
  });
  try {
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.alloc(960).toString("base64"),
      }),
    );
    assert.equal(track.rtp.length, 0);
    fail = false;
    const deadline = Date.now() + 500;
    while (track.rtp.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(track.rtp.length >= 1, true);
    assert.equal(track.rtp[0].header.marker, true);
    assert.equal(track.rtp[0].header.sequenceNumber, 1);
  } finally {
    bridge.close();
  }
});

test("a dropped voice socket resumes the same conversation once", () => {
  const first = { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(String(data))); }, close() {} };
  let second;
  const events = [];
  const bridge = startVoiceBridge({
    track: { onReceiveRtp: { subscribe() {} } },
    socket: first,
    onEvent(text) {
      events.push(JSON.parse(text));
    },
    openSocket(conversationId) {
      assert.equal(conversationId, "conv-1");
      second = { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(String(data))); }, close() {} };
      return second;
    },
  });
  try {
    assert.equal(voiceSocketUrl("conv-1").includes("conversation_id=conv-1"), true);
    first.onmessage(JSON.stringify({ type: "conversation.created", conversation: { id: "conv-1" } }));
    first.onclose();
    assert.equal(events.length, 0);
    assert.equal(second.sent[0].type, "session.update");
    assert.equal(second.sent[0].session.resumption.enabled, true);
    second.onclose();
    assert.equal(events.at(-1).error.message, "Voice connection closed.");
  } finally {
    bridge.close();
  }
});

test("a resumed voice socket dials the same conversation", () => {
  const urls = [];
  const Original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor(url) {
      urls.push(String(url));
      this.readyState = 0;
    }
    close() {}
  };
  try {
    const socket = openVoiceSocket(voiceSocketUrl("conv-1"), "token");
    assert.match(urls[0], /conversation_id=conv-1/);
    assert.equal(urls[0].includes("model=grok-voice-latest"), true);
    socket.close();
  } finally {
    globalThis.WebSocket = Original;
  }
});

test("a dropped voice socket sends a held tool reply after the new session is ready", () => {
  const first = {
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(JSON.parse(String(data)));
    },
    close() {},
  };
  let second;
  const bridge = startVoiceBridge({
    track: { onReceiveRtp: { subscribe() {} }, writeRtp() {} },
    socket: first,
    openSocket() {
      second = {
        readyState: 1,
        sent: [],
        send(data) {
          this.sent.push(JSON.parse(String(data)));
        },
        close() {},
      };
      return second;
    },
  });
  try {
    first.onmessage(JSON.stringify({ type: "conversation.created", conversation: { id: "conv-1" } }));
    first.onmessage(JSON.stringify({ type: "session.updated", session: { id: "sess-1" } }));
    bridge.onUpstream(JSON.stringify({ type: "response.created" }));
    bridge.sendClient({
      type: "conversation.item.create",
      item: { type: "force_message", role: "assistant", content: [{ type: "output_text", text: "Later." }] },
    });
    assert.equal(first.sent.some((event) => event.item?.type === "force_message"), false);
    first.onclose();
    assert.equal(second.sent[0].type, "session.update");
    assert.equal(second.sent.some((event) => event.item?.type === "force_message"), false);
    second.onmessage(JSON.stringify({ type: "session.updated", session: { id: "sess-2" } }));
    assert.equal(second.sent.at(-1).item.type, "force_message");
  } finally {
    bridge.close();
  }
});

test("a dropped voice socket tells the desktop", () => {
  const seen = [];
  const socket = { readyState: 1, send() {} };
  const state = { closing: false };
  const bridge = startVoiceBridge({
    track: { onReceiveRtp: { subscribe() {} } },
    socket,
    onEvent(text) {
      seen.push(JSON.parse(text));
    },
    voiceState: state,
  });
  socket.onclose();
  assert.equal(seen.at(-1).error.message, "Voice connection closed.");
  state.closing = true;
  socket.onclose();
  assert.equal(seen.length, 1);
  bridge.close();
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

test("a Codex multipart call body is answered from its sdp part", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [useOPUS()] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  await offerer.setLocalDescription(await offerer.createOffer());
  const boundary = "codex-realtime-call-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="sdp"',
    "Content-Type: application/sdp",
    "",
    offerer.localDescription.sdp,
    `--${boundary}`,
    'Content-Disposition: form-data; name="session"',
    "Content-Type: application/json",
    "",
    '{"instructions":"Use the repo instructions.","initial_items":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Earlier turn."}]}]}',
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const sockets = [];
  try {
    await withServer(
      {
        realtimeFetch: async () =>
          new Response("no", { status: 403, headers: { "content-type": "text/plain" } }),
        voiceWebSocket() {
          const sent = [];
          const socket = {
            readyState: 1,
            send(data) {
              sent.push(String(data));
            },
            close() {},
            sent,
          };
          sockets.push(socket);
          return socket;
        },
      },
      async (port) => {
        const answered = await postRaw(port, "/v1/live", body, {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        });
        assert.equal(answered.status, 201);
        const sdp = answered.body.toString("utf8");
        assert.equal(sdp.startsWith("v=0"), true);
        assert.equal(sdp.includes("a=fingerprint:"), true);
        assert.match(sdp, /a=rtpmap:\d+ OPUS\/48000/i);
        assert.equal(sdp.includes("codex-realtime-call-boundary"), false);
        const sent = sockets[0].sent.map((line) => JSON.parse(line));
        assert.equal(sent[0].session.instructions, "Use the repo instructions.");
        assert.equal(sent[0].session.voice, "eve");
        assert.equal(sent[1].item.role, "user");
        assert.equal(sent[1].item.content[0].text, "Earlier turn.");
      },
    );
  } finally {
    closeVoiceCalls();
    await offerer.close();
  }
});

test("a streamed codex reply is sent after the desktop pauses", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [useOPUS()] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  await offerer.setLocalDescription(await offerer.createOffer());
  const sockets = [];
  let live;
  try {
    await withServer(
      {
        realtimeFetch: async () =>
          new Response("no", { status: 403, headers: { "content-type": "text/plain" } }),
        voiceWebSocket() {
          const socket = { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(String(data))); }, close() {} };
          sockets.push(socket);
          return socket;
        },
      },
      async (port) => {
        const answered = await postRaw(port, "/v1/realtime/calls", offerer.localDescription.sdp);
        const id = answered.headers.location.split("/").pop();
        live = await rawUpgrade(port, `/v1/live/${id}`, {}, false);
        sockets[0].onmessage(
          JSON.stringify({
            type: "response.function_call_arguments.done",
            name: "codex",
            call_id: "call-1",
            arguments: JSON.stringify({ request: "hi" }),
          }),
        );
        const frame = (text) =>
          maskedClientText(
            JSON.stringify({
              type: "delegation.context.append",
              delegation_item_id: "call-1",
              content: [{ type: "input_text", text }],
            }),
          );
        live.socket.write(frame("AAAA"));
        live.socket.write(frame("BBBB"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(
          sockets[0].sent.some((event) => event.item?.type === "function_call_output"),
          false,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const output = sockets[0].sent.find((event) => event.item?.type === "function_call_output");
        const spoken = sockets[0].sent.find((event) => event.item?.type === "force_message");
        assert.equal(output.item.output, JSON.stringify("AAAABBBB"));
        assert.equal(spoken.item.content[0].text, "AAAABBBB");
      },
    );
  } finally {
    live?.socket.destroy();
    closeVoiceCalls();
    await offerer.close();
  }
});

test("a session.close frame hangs up the voice call", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [useOPUS()] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  await offerer.setLocalDescription(await offerer.createOffer());
  let live;
  let closed = 0;
  try {
    await withServer(
      {
        realtimeFetch: async () =>
          new Response("no", { status: 403, headers: { "content-type": "text/plain" } }),
        voiceWebSocket() {
          return {
            readyState: 1,
            send() {},
            close() {
              closed += 1;
            },
          };
        },
      },
      async (port) => {
        const answered = await postRaw(port, "/v1/realtime/calls", offerer.localDescription.sdp);
        assert.equal(answered.status, 201);
        const id = answered.headers.location.split("/").pop();
        live = await rawUpgrade(port, `/v1/live/${id}`, {}, false);
        live.socket.write(maskedClientText(JSON.stringify({ type: "session.close" })));
        const deadline = Date.now() + 500;
        while (voiceCallCount() !== 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(voiceCallCount(), 0);
        assert.equal(closed, 1);
      },
    );
  } finally {
    live?.socket.destroy();
    closeVoiceCalls();
    await offerer.close();
  }
});

test("closing the v3 sideband hangs up the voice peer", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [useOPUS()] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  await offerer.setLocalDescription(await offerer.createOffer());
  let live;
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
        assert.equal(answered.body.toString("utf8").includes("a=candidate:"), true);
        assert.equal(voiceCallCount(), 1);
        const id = answered.headers.location.split("/").pop();
        live = await rawUpgrade(port, `/v1/live/${id}`, {}, false);
        live.socket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(voiceCallCount(), 0);
      },
    );
  } finally {
    live?.socket.destroy();
    closeVoiceCalls();
    await offerer.close();
  }
});

function maskedClientText(text, opcode = 0x1, fin = true) {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]), mask, masked]);
}

test("voice sideband relays control events and answers pings", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [useOPUS()] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  await offerer.setLocalDescription(await offerer.createOffer());
  const sockets = [];
  let live;
  try {
    await withServer(
      {
        realtimeFetch: async () =>
          new Response("no", { status: 403, headers: { "content-type": "text/plain" } }),
        voiceWebSocket() {
          const sent = [];
          const socket = {
            readyState: 1,
            sent,
            send(data) {
              sent.push(String(data));
            },
            close() {},
          };
          sockets.push(socket);
          return socket;
        },
      },
      async (port) => {
        const answered = await postRaw(port, "/v1/realtime/calls", offerer.localDescription.sdp);
        const id = answered.headers.location.split("/").pop();
        const frames = [];
        live = await rawUpgrade(port, `/v1/live/${id}`, {}, false);
        live.socket.on("data", (chunk) => frames.push(chunk));
        sockets[0].onmessage({
          data: JSON.stringify({ type: "session.created", session: { id: "sess-1", instructions: "Say ready." } }),
        });
        live.socket.write(maskedClientText(JSON.stringify({ type: "response.create" })));
        const cancel = JSON.stringify({ type: "response.cancel" });
        live.socket.write(maskedClientText(cancel.slice(0, 8), 0x1, false));
        live.socket.write(maskedClientText(cancel.slice(8), 0x0, true));
        live.socket.write(Buffer.from([0x89, 0x80, 9, 9, 9, 9]));
        const inbound = await new Promise((resolve) => {
          const started = Date.now();
          const check = () => {
            const buf = Buffer.concat(frames);
            if (buf.includes(Buffer.from([0x8a])) || Date.now() - started > 500) resolve(buf);
            else setTimeout(check, 10);
          };
          check();
        });
        assert.equal(inbound.toString("utf8").includes('"type":"session.updated"'), true);
        assert.equal(inbound.toString("utf8").includes("sess-1"), true);
        assert.equal(sockets[0].sent.some((line) => line.includes("response.create")), true);
        assert.equal(sockets[0].sent.filter((line) => line.includes("response.cancel")).length, 1);
        assert.equal(inbound.includes(Buffer.from([0x8a])), true);
      },
    );
  } finally {
    live?.socket.destroy();
    closeVoiceCalls();
    await offerer.close();
  }
});

test("an offer with a data channel keeps that channel in the answer", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: { audio: [useOPUS()] },
  });
  offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
  offerer.createDataChannel("oai-events");
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
        const answered = await postRaw(port, "/v1/live", offerer.localDescription.sdp);
        const sdp = answered.body.toString("utf8");
        assert.equal(answered.status, 201);
        assert.equal(sdp.includes("m=audio"), true);
        assert.equal(sdp.includes("m=application"), true);
        assert.equal(sdp.includes("a=sctp-port:"), true);
        assert.equal(sdp.includes("a=setup:passive"), true);
        assert.equal(sdp.includes("a=setup:active"), false);
        assert.equal(sdp.includes(" 127.0.0.1 "), true);
        assert.equal(sdp.includes(" typ srflx"), false);
        assert.equal(sdp.includes(" generation "), false);
        assert.equal(sdp.includes(" ufrag "), false);
        assert.equal((sdp.match(/^a=candidate:/gm) ?? []).length <= 24, true);
      },
    );
  } finally {
    closeVoiceCalls();
    await offerer.close();
  }
});

test("a host-only answer opens the offered event channel", async () => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { MediaStreamTrack, RTCPeerConnection, useOPUS } from "werift";
        import { answerVoiceCall } from "./src/voice.mjs";
        const offerer = new RTCPeerConnection({
          iceServers: [],
          iceUseIpv4: true,
          iceUseIpv6: false,
          iceUseTcp: false,
          codecs: { audio: [useOPUS()] },
        });
        offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
        const channel = offerer.createDataChannel("oai-events");
        await offerer.setLocalDescription(await offerer.createOffer());
        const answered = await answerVoiceCall({
          offer: offerer.localDescription.sdp,
          token: "t",
          webSocketFactory: () => ({ readyState: 1, send() {}, close() {} }),
        });
        await offerer.setRemoteDescription({ type: "answer", sdp: answered.sdp });
        const opened = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 4000);
          const done = (state) => {
            if (state !== "open") return;
            clearTimeout(timer);
            resolve(true);
          };
          channel.stateChanged.subscribe(done);
          done(channel.readyState);
        });
        console.log(opened ? "OPEN" : "CLOSED");
        process.exit(opened ? 0 : 1);
      `,
    ],
    { cwd: process.cwd() },
  );
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 8000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(out.includes("OPEN"), true);
  assert.equal(code, 0);
});

test("a connected offerer microphone reaches xAI", async () => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import OpusScript from "opusscript";
        import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, useOPUS } from "werift";
        import { answerVoiceCall } from "./src/voice.mjs";
        const offerer = new RTCPeerConnection({
          iceServers: [],
          iceUseIpv4: true,
          iceUseIpv6: false,
          iceUseTcp: false,
          codecs: { audio: [useOPUS({ payloadType: 111 })] },
        });
        const mic = new MediaStreamTrack({ kind: "audio" });
        offerer.addTrack(mic);
        const channel = offerer.createDataChannel("oai-events");
        await offerer.setLocalDescription(await offerer.createOffer());
        const sent = [];
        const upstream = { readyState: 1, send(data) { sent.push(String(data)); }, close() {} };
        const answered = await answerVoiceCall({
          offer: offerer.localDescription.sdp,
          token: "t",
          webSocketFactory: () => upstream,
        });
        upstream.onmessage(JSON.stringify({ type: "session.updated", session: { id: "sess-1" } }));
        await offerer.setRemoteDescription({ type: "answer", sdp: answered.sdp });
        const opened = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          const done = (state) => {
            if (state !== "open") return;
            clearTimeout(timer);
            resolve(true);
          };
          channel.stateChanged.subscribe(done);
          done(channel.readyState);
        });
        if (!opened) {
          console.log("CLOSED");
          process.exit(1);
        }
        const encoder = new OpusScript(48000, 1, OpusScript.Application.VOIP);
        const encoded = Buffer.from(encoder.encode(Buffer.alloc(960 * 2), 960));
        mic.writeRtp(new RtpPacket(new RtpHeader({
          marker: true,
          payloadType: 111,
          sequenceNumber: 1,
          timestamp: 960,
          ssrc: 1,
        }), encoded));
        const appended = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 2000);
          const check = () => {
            if (sent.some((line) => line.includes("input_audio_buffer.append"))) {
              clearTimeout(timer);
              resolve(true);
              return;
            }
            setTimeout(check, 20);
          };
          check();
        });
        encoder.delete?.();
        console.log(appended ? "APPEND" : "NO");
        process.exit(appended ? 0 : 1);
      `,
    ],
    { cwd: process.cwd() },
  );
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 12000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(out.includes("APPEND"), true, err.slice(0, 500));
  assert.equal(code, 0);
});

test("played voice audio reaches the offering peer", async () => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { MediaStreamTrack, RTCPeerConnection, useOPUS } from "werift";
        import { answerVoiceCall } from "./src/voice.mjs";
        const offerer = new RTCPeerConnection({
          iceServers: [],
          iceUseIpv4: true,
          iceUseIpv6: false,
          iceUseTcp: false,
          codecs: { audio: [useOPUS({ payloadType: 111 })] },
        });
        offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
        const channel = offerer.createDataChannel("oai-events");
        await offerer.setLocalDescription(await offerer.createOffer());
        const upstream = { readyState: 1, send() {}, close() {} };
        const answered = await answerVoiceCall({
          offer: offerer.localDescription.sdp,
          token: "t",
          webSocketFactory: () => upstream,
        });
        await offerer.setRemoteDescription({ type: "answer", sdp: answered.sdp });
        const opened = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          const done = (state) => {
            if (state !== "open") return;
            clearTimeout(timer);
            resolve(true);
          };
          channel.stateChanged.subscribe(done);
          done(channel.readyState);
        });
        if (!opened) {
          console.log("CLOSED");
          process.exit(1);
        }
        let playback = false;
        for (const transceiver of offerer.getTransceivers()) {
          const track = transceiver.receiver?.track;
          track?.onReceiveRtp?.subscribe?.((rtp) => {
            if (rtp?.header?.payloadType === 111 && rtp.payload?.length) playback = true;
          });
        }
        const pcm = Buffer.alloc(4800);
        upstream.onmessage?.({
          data: JSON.stringify({ type: "response.output_audio.delta", delta: pcm.toString("base64") }),
        });
        upstream.onmessage?.({ data: JSON.stringify({ type: "response.output_audio.done" }) });
        const heard = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 2000);
          const check = () => {
            if (playback) {
              clearTimeout(timer);
              resolve(true);
              return;
            }
            setTimeout(check, 20);
          };
          check();
        });
        console.log(heard ? "HEARD" : "SILENT");
        process.exit(heard ? 0 : 1);
      `,
    ],
    { cwd: process.cwd() },
  );
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, 12000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(out.includes("HEARD"), true, err.slice(0, 500));
  assert.equal(code, 0);
});

test("desktop v3 sideband context becomes an xAI voice item", () => {
  assert.deepEqual(voiceClientEvents({ type: "response.cancel" }), [{ type: "response.cancel" }]);
  assert.deepEqual(voiceClientEvents({ type: "input_audio.append", audio: "AQID" }), [
    { type: "input_audio_buffer.append", audio: "AQID" },
  ]);
  assert.deepEqual(voiceClientEvents({ type: "session.close" }), []);
  assert.deepEqual(
    voiceClientEvents({
      type: "session.context.append",
      content: [{ type: "input_text", text: "Say this." }],
    }),
    [
      {
        type: "conversation.item.create",
        item: { type: "force_message", role: "assistant", content: [{ type: "output_text", text: "Say this." }] },
      },
    ],
  );
  assert.equal(
    voiceClientEvents({
      type: "delegation.context.append",
      delegation_item_id: "del-1",
      channel: "commentary",
      content: [{ type: "input_text", text: "thinking" }],
    })[0].item.role,
    "assistant",
  );
  assert.equal(voiceClientEvents({
    type: "delegation.context.append",
    channel: "commentary",
    content: [{ type: "input_text", text: "thinking" }],
  })[0].item.type, "message");
  const updated = voiceClientEvents({
    type: "session.update",
    session: { instructions: "From the desktop.", voice: "alloy", audio: { output: { voice: "alloy" } } },
  });
  assert.equal(updated[0].session.instructions, "From the desktop.");
  assert.equal(updated[0].session.voice, "eve");
  assert.equal(updated[0].session.audio.input.format.rate, 24000);
  const state = { pendingCalls: new Set(["call-1"]) };
  assert.deepEqual(voiceSidebandEvent({
    type: "response.function_call_arguments.done",
    name: "codex",
    call_id: "call-1",
    arguments: JSON.stringify({ request: "Rename the helper." }),
  }, state), {
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id: "call-1",
      content: [{ type: "input_text", text: "Rename the helper." }],
    },
  });
  assert.equal(voiceSidebandEvent({
    type: "response.function_call_arguments.done",
    name: "web_search",
    call_id: "other",
    arguments: "{}",
  }, state), null);
  const spoken = voiceClientEvents({
    type: "delegation.context.append",
    delegation_item_id: "call-1",
    content: [{ type: "input_text", text: "Renamed it." }],
  }, state);
  assert.equal(spoken[0].item.type, "function_call_output");
  assert.equal(spoken[0].item.call_id, "call-1");
  assert.equal(spoken[1].item.type, "force_message");
  assert.equal(state.pendingCalls.has("call-1"), false);
});

test("split context appends are joined before the tool result is spoken", () => {
  const frames = [
    {
      type: "delegation.context.append",
      delegation_item_id: "call-1",
      content: [{ type: "input_text", text: "AAAA" }],
    },
    {
      type: "delegation.context.append",
      delegation_item_id: "call-1",
      content: [{ type: "input_text", text: "BBBB" }],
    },
  ];
  const merged = mergeVoiceClientBurst(frames);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].content[0].text, "AAAABBBB");
  assert.equal(frames[0].content[0].text, "AAAA");
  const state = { pendingCalls: new Set(["call-1"]) };
  const spoken = voiceClientEvents(merged[0], state);
  assert.equal(spoken[0].item.type, "function_call_output");
  assert.equal(spoken[0].item.output, JSON.stringify("AAAABBBB"));
  assert.equal(spoken[1].item.type, "force_message");
  assert.equal(spoken[1].item.content[0].text, "AAAABBBB");
  const commentary = mergeVoiceClientBurst([
    {
      type: "delegation.context.append",
      delegation_item_id: "call-2",
      channel: "commentary",
      content: [{ type: "input_text", text: "think" }],
    },
    {
      type: "delegation.context.append",
      delegation_item_id: "call-2",
      channel: "commentary",
      content: [{ type: "input_text", text: "ing" }],
    },
  ]);
  const quiet = voiceClientEvents(commentary[0], { pendingCalls: new Set() });
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].item.type, "message");
  assert.equal(quiet[0].item.content[0].text, "thinking");
  const split = mergeVoiceClientBurst([
    frames[0],
    { type: "response.create" },
    frames[1],
  ]);
  assert.equal(split.length, 3);
  assert.equal(split[0].content[0].text, "AAAA");
  assert.equal(split[1].type, "response.create");
  assert.equal(split[2].content[0].text, "BBBB");
});

test("xAI voice events become the desktop v3 sideband events", () => {
  const state = { inputTranscript: "" };
  assert.deepEqual(voiceSidebandEvent({ type: "response.output_audio_transcript.delta", delta: "Hi" }, state), {
    type: "output_transcript.added",
    item: { text: "Hi" },
  });
  assert.deepEqual(
    voiceSidebandEvent({ type: "response.output_audio_transcript.done", transcript: "Hi there" }, state),
    { type: "turn.done", turn: { role: "assistant", transcript: "Hi there" } },
  );
  const unfinished = {};
  voiceSidebandEvent({ type: "response.output_audio_transcript.delta", delta: "Hi" }, unfinished);
  voiceSidebandEvent({ type: "response.output_audio_transcript.delta", delta: " there" }, unfinished);
  assert.deepEqual(voiceSidebandEvent({ type: "response.done" }, unfinished), {
    type: "turn.done",
    turn: { role: "assistant", transcript: "Hi there" },
  });
  assert.equal(voiceSidebandEvent({ type: "response.done" }, unfinished), null);
  assert.deepEqual(
    voiceSidebandEvent({ type: "conversation.item.input_audio_transcription.updated", transcript: "hel" }, state),
    { type: "input_transcript.added", item: { text: "hel" } },
  );
  assert.deepEqual(
    voiceSidebandEvent({ type: "conversation.item.input_audio_transcription.updated", transcript: "hello" }, state),
    { type: "input_transcript.added", item: { text: "lo" } },
  );
  assert.deepEqual(
    voiceSidebandEvent({ type: "conversation.item.input_audio_transcription.updated", transcript: "hallo" }, state),
    { type: "turn.done", turn: { role: "user", transcript: "hallo" } },
  );
  assert.deepEqual(
    voiceSidebandEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "hallo" }, state),
    { type: "turn.done", turn: { role: "user", transcript: "hallo" } },
  );
  assert.equal(state.inputTranscript, "");
  const user = {};
  voiceSidebandEvent({ type: "conversation.item.input_audio_transcription.updated", transcript: "hello" }, user);
  assert.deepEqual(voiceSidebandEvent({ type: "input_audio_buffer.speech_started" }, user), {
    type: "turn.done",
    turn: { role: "user", transcript: "hello" },
  });
  assert.equal(
    voiceSidebandEvent(
      { type: "conversation.item.input_audio_transcription.completed", transcript: "hello!" },
      user,
    ),
    null,
  );
  assert.equal(voiceSidebandEvent({ type: "input_audio_buffer.speech_started" }, user), null);
  assert.equal(voiceSidebandEvent({ type: "conversation.created" }, state), null);
  const textState = {};
  assert.equal(voiceSidebandEvent({ type: "response.created" }, textState), null);
  assert.deepEqual(voiceSidebandEvent({ type: "response.output_text.delta", delta: "Hel" }, textState), {
    type: "output_transcript.added",
    item: { text: "Hel" },
  });
  assert.deepEqual(voiceSidebandEvent({ type: "response.text.delta", delta: "lo" }, textState), {
    type: "output_transcript.added",
    item: { text: "lo" },
  });
  assert.deepEqual(voiceSidebandEvent({ type: "response.done" }, textState), {
    type: "turn.done",
    turn: { role: "assistant", transcript: "Hello" },
  });
  assert.equal(voiceSidebandEvent({ type: "response.done" }, textState), null);
  const audioState = {};
  voiceSidebandEvent({ type: "response.output_audio_transcript.delta", delta: "Hi" }, audioState);
  assert.equal(voiceSidebandEvent({ type: "response.text.delta", delta: "Hi" }, audioState), null);
  assert.equal(voiceSidebandEvent({ type: "error", error: { message: "nope" } }, state), null);
  const sideband = { sessionAnnounced: false, sessionId: "call-1" };
  const first = sidebandFrames(sideband, JSON.stringify({ type: "output_transcript.added", item: { text: "Hi" } }));
  assert.equal(JSON.parse(first[0]).type, "session.updated");
  assert.equal(JSON.parse(first[0]).session.id, "call-1");
  assert.equal(JSON.parse(first[1]).type, "output_transcript.added");
  const next = sidebandFrames(sideband, JSON.stringify({ type: "turn.done", turn: { role: "assistant", transcript: "Hi" } }));
  assert.equal(next.length, 1);
});

test("microphone packets come from the remote track", () => {
  const sent = [];
  const remoteHandlers = [];
  const localHandlers = [];
  const bridge = startVoiceBridge({
    track: {
      onReceiveRtp: {
        subscribe(handler) {
          localHandlers.push(handler);
        },
      },
    },
    receiveTracks: [
      {
        onReceiveRtp: {
          subscribe(handler) {
            remoteHandlers.push(handler);
          },
        },
      },
    ],
    socket: {
      readyState: 1,
      send(data) {
        sent.push(JSON.parse(String(data)));
      },
    },
    codec: { kind: "pcmu", payloadType: 0 },
  });
  try {
    assert.equal(remoteHandlers.length, 1);
    assert.equal(localHandlers.length, 0);
    remoteHandlers[0]({ header: { payloadType: 0 }, payload: Buffer.from([0xff]) });
    assert.equal(sent.some((event) => event.type === "input_audio_buffer.append"), false);
    bridge.onUpstream(JSON.stringify({ type: "session.updated", session: { id: "sess-1" } }));
    assert.equal(sent.some((event) => event.type === "input_audio_buffer.append"), true);
  } finally {
    bridge.close();
  }
});

test("an offer registers a remote microphone track", async () => {
  const offerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    iceUseTcp: false,
  });
  const answerer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    iceUseTcp: false,
  });
  try {
    offerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
    await offerer.setLocalDescription(await offerer.createOffer());
    answerer.addTrack(new MediaStreamTrack({ kind: "audio" }));
    await answerer.setRemoteDescription({ type: "offer", sdp: offerer.localDescription.sdp });
    const tracks = remoteAudioTracks(answerer);
    assert.ok(tracks.length > 0);
    assert.equal(tracks.every((track) => track.remote && track.kind === "audio"), true);
  } finally {
    await offerer.close();
    await answerer.close();
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
    bridge.onUpstream(JSON.stringify({ type: "session.updated", session: { id: "sess-1" } }));
    bridge.onRtp({ header: { payloadType: 111 }, payload: encoded });
    const appended = sent.find((event) => event.type === "input_audio_buffer.append");
    assert.ok(appended);
    assert.ok(Buffer.from(appended.audio, "base64").length > 0);
    bridge.onUpstream(
      JSON.stringify({
        type: "response.output_audio.delta",
        delta: Buffer.alloc(480 * 2).toString("base64"),
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
      let local;
      let live;
      try {
        local = await rawUpgrade(port, `/v1/realtime?call_id=${id}`);
        assert.equal(local.closed, undefined);
        assert.match(local.head.toString("latin1"), /^HTTP\/1\.1 101 /);
        assert.match(local.head.toString("latin1"), /Sec-WebSocket-Accept:/);
        live = await rawUpgrade(port, `/v1/live/${id}`, {}, false);
        assert.equal(live.closed, undefined);
        assert.match(live.head.toString("latin1"), /^HTTP\/1\.1 101 /);
        const closed = new Promise((resolve) => live.socket.once("close", () => resolve(true)));
        live.socket.write(Buffer.from("client-frame"));
        assert.equal(
          await Promise.race([
            closed,
            new Promise((resolve) => setTimeout(() => resolve(false), 50)),
          ]),
          false,
        );
      } finally {
        local?.socket.destroy();
        live?.socket.destroy();
      }
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
