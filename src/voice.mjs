import { createHash, randomUUID } from "node:crypto";
import OpusScript from "opusscript";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useOPUS,
  usePCMU,
} from "werift";

export const VOICE_SOCKET_URL = "wss://api.x.ai/v1/realtime?model=grok-voice-latest";

const localCalls = new Set();
const active = new Set();
const sessionsById = new Map();

const OPUS_FRAME = 960;

function peerConfig() {
  return {
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    iceUseTcp: false,
    iceAdditionalHostAddresses: ["127.0.0.1"],
    codecs: { audio: [useOPUS(), usePCMU()] },
  };
}

// Codex voice-host rejects an answer with more than 32 candidate lines and
// waits until the offered oai-events channel opens. A public srflx address
// is not the local bridge, so the desktop only sees host candidates.
function hostAnswerSdp(sdp) {
  const lines = String(sdp ?? "").split("\r\n");
  const hosts = [];
  lines.forEach((line, index) => {
    if (line.startsWith("a=candidate:") && line.includes(" typ host") && line.includes(" 1 udp ")) {
      hosts.push(index);
    }
  });
  const picked = new Set(
    hosts
      .sort((left, right) => {
        const loopback = Number(lines[right].includes(" 127.0.0.1 ")) - Number(lines[left].includes(" 127.0.0.1 "));
        return loopback || left - right;
      })
      .slice(0, 24),
  );
  return lines
    .filter((line, index) => !line.startsWith("a=candidate:") || picked.has(index))
    .join("\r\n");
}

export function offerFromCallBody(body, contentType) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  const type = String(contentType ?? "");
  if (!type.toLowerCase().includes("multipart/form-data")) return text;
  const boundaryMatch = type.match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) return text;
  const boundary = boundaryMatch[1];
  for (const part of text.split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd).toLowerCase();
    if (!headers.includes('name="sdp"') && !headers.includes("name=sdp")) continue;
    let value = part.slice(headerEnd + 4);
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    return value;
  }
  return text;
}

export function audioCodecFromSdp(sdp) {
  const opus = String(sdp ?? "").match(/a=rtpmap:(\d+) opus\/48000/i);
  if (opus) return { kind: "opus", payloadType: Number(opus[1]) };
  return { kind: "pcmu", payloadType: 0 };
}

function createOpus() {
  return new OpusScript(48000, 2, OpusScript.Application.AUDIO);
}

function opusPayloadToMono(decoder, payload) {
  const decoded = Buffer.from(decoder.decode(Buffer.from(payload)));
  const frames = Math.floor(decoded.length / 4);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const left = decoded.readInt16LE(i * 4);
    const right = decoded.readInt16LE(i * 4 + 2);
    mono.writeInt16LE((left + right) >> 1, i * 2);
  }
  return mono;
}

function monoToStereo(pcm) {
  const samples = Math.floor(pcm.length / 2);
  const stereo = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    stereo.writeInt16LE(sample, i * 4);
    stereo.writeInt16LE(sample, i * 4 + 2);
  }
  return stereo;
}

// Codex reads Location for rtc_* or a 36-character UUID and rejects anything else.
export function rememberLocalCall(id = randomUUID()) {
  localCalls.add(id);
  return id;
}

function callIdIn(url) {
  const text = String(url ?? "");
  for (const id of localCalls) {
    if (text.includes(id)) return id;
  }
  return null;
}

export function isLocalVoiceSideband(url) {
  return callIdIn(url) != null;
}

export function encodeServerFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else header = Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([header, data]);
}

function attachClientFrames(socket, onText) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let partOpcode = null;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let length = buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        socket.end(encodeServerFrame(0x8, Buffer.alloc(0)));
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + length) return;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + length);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buf = buf.subarray(offset + maskLen + length);
      if (opcode === 0x8) {
        socket.end(encodeServerFrame(0x8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeServerFrame(0xa, payload));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) {
          parts = [payload];
          partOpcode = opcode;
        } else if (partOpcode != null) parts.push(payload);
        if (fin && partOpcode === 0x1) onText(Buffer.concat(parts).toString("utf8"));
        if (fin) {
          parts = [];
          partOpcode = null;
        }
      }
    }
  });
}

export function acceptLocalSideband(socket, key, url) {
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const id = callIdIn(url);
  const session = sessionsById.get(id);
  const hangup = () => session?.close();
  socket.on("error", () => {});
  socket.on("close", hangup);
  socket.on("end", hangup);
  if (session?.attachSideband) session.attachSideband(socket);
  else socket.on("data", () => {});
  socket.resume();
}

function waitForHostCandidate(pc) {
  const sdp = () => hostAnswerSdp(pc.localDescription?.sdp ?? "");
  const hasHost = () => (pc.localDescription?.sdp ?? "").includes(" typ host");
  const hasLoopback = () => (pc.localDescription?.sdp ?? "").includes(" 127.0.0.1 ");
  if (hasHost() && hasLoopback()) return Promise.resolve(sdp());
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      clearTimeout(loopbackGrace);
      resolve(sdp());
    };
    const limit = setTimeout(finish, 500);
    const loopbackGrace = setTimeout(() => {
      if (hasHost()) finish();
    }, 100);
    const check = () => {
      if (hasHost() && hasLoopback()) finish();
    };
    if (typeof pc.iceGatheringStateChange?.subscribe === "function") {
      pc.iceGatheringStateChange.subscribe(check);
    }
    if (typeof pc.onIceCandidate?.subscribe === "function") pc.onIceCandidate.subscribe(check);
    check();
  });
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function mulawToPcm16(mulaw) {
  const input = Buffer.from(mulaw);
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i += 1) {
    const sample = ~input[i] & 0xff;
    const sign = sample & 0x80;
    const exponent = (sample >> 4) & 0x07;
    const mantissa = sample & 0x0f;
    let pcm = ((mantissa << 3) + MULAW_BIAS) << exponent;
    pcm -= MULAW_BIAS;
    out.writeInt16LE(sign ? -pcm : pcm, i * 2);
  }
  return out;
}

export function pcm16ToMulaw(pcm) {
  const input = Buffer.from(pcm);
  const samples = Math.floor(input.length / 2);
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i += 1) {
    let sample = input.readInt16LE(i * 2);
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > MULAW_CLIP) sample = MULAW_CLIP;
    sample += MULAW_BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

const XAI_PCM_RATE = 24000;

function resampleInt16(pcm, factor, direction) {
  const samples = Math.floor(Buffer.from(pcm).length / 2);
  const input = Buffer.from(pcm);
  if (direction === "down") {
    const outSamples = Math.floor(samples / factor);
    const out = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i += 1) out.writeInt16LE(input.readInt16LE(i * factor * 2), i * 2);
    return out;
  }
  const out = Buffer.alloc(samples * factor * 2);
  for (let i = 0; i < samples; i += 1) {
    const sample = input.readInt16LE(i * 2);
    for (let step = 0; step < factor; step += 1) out.writeInt16LE(sample, (i * factor + step) * 2);
  }
  return out;
}

function pcmForXai(payload, codec, decoder) {
  if (codec.kind === "opus" && decoder) return resampleInt16(opusPayloadToMono(decoder, payload), 2, "down");
  return resampleInt16(mulawToPcm16(payload), 3, "up");
}

export function appendFromRtp(send, payload, codec = { kind: "pcmu", payloadType: 0 }, decoder) {
  const pcm = pcmForXai(payload, codec, decoder);
  if (pcm.length === 0) return;
  send({
    type: "input_audio_buffer.append",
    audio: pcm.toString("base64"),
  });
}

function writeAudio(track, state, payload, clockStep) {
  if (payload.length === 0) return;
  state.sequence = (state.sequence + 1) & 0xffff;
  state.timestamp = (state.timestamp + clockStep) >>> 0;
  track.writeRtp(
    new RtpPacket(
      new RtpHeader({
        payloadType: state.payloadType,
        sequenceNumber: state.sequence,
        timestamp: state.timestamp,
        ssrc: state.ssrc,
      }),
      payload,
    ),
  );
}

export function playbackFromDelta(track, state, delta) {
  const pcm = Buffer.from(String(delta ?? ""), "base64");
  if (state.kind === "opus" && state.opus) {
    const wide = resampleInt16(pcm, 2, "up");
    state.pending = Buffer.concat([state.pending ?? Buffer.alloc(0), wide]);
    const frameBytes = OPUS_FRAME * 2;
    while (state.pending.length >= frameBytes) {
      const frame = state.pending.subarray(0, frameBytes);
      state.pending = state.pending.subarray(frameBytes);
      const encoded = Buffer.from(state.opus.encode(monoToStereo(frame), OPUS_FRAME));
      writeAudio(track, state, encoded, OPUS_FRAME);
    }
    return;
  }
  const mulaw = pcm16ToMulaw(resampleInt16(pcm, 3, "down"));
  writeAudio(track, state, mulaw, mulaw.length);
}

function sessionUpdate() {
  return {
    type: "session.update",
    session: {
      voice: "eve",
      instructions: "Say ready.",
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: XAI_PCM_RATE } },
        output: { format: { type: "audio/pcm", rate: XAI_PCM_RATE } },
      },
    },
  };
}

export function startVoiceBridge({
  track,
  socket,
  codec = { kind: "pcmu", payloadType: 0 },
  onEvent,
}) {
  const opus = codec.kind === "opus" ? createOpus() : null;
  const state = {
    sequence: 0,
    timestamp: 0,
    ssrc: 1,
    kind: codec.kind,
    payloadType: codec.payloadType,
    opus,
    pending: Buffer.alloc(0),
  };
  const queued = [];
  let opened = socket.readyState === 1;
  const send = (event) => {
    const text = JSON.stringify(event);
    if (!opened) {
      queued.push(text);
      return;
    }
    socket.send(text);
  };
  const flush = () => {
    opened = true;
    for (const text of queued.splice(0)) socket.send(text);
  };
  const onRtp = (rtp) => {
    const payload = rtp?.payload ?? rtp;
    const payloadType = rtp?.header?.payloadType;
    const incoming =
      payloadType === 0
        ? { kind: "pcmu", payloadType: 0 }
        : payloadType == null
          ? codec
          : { kind: "opus", payloadType };
    try {
      appendFromRtp(send, payload, incoming, opus);
    } catch {
      // A bad frame is dropped. The call stays up.
    }
  };
  const onUpstream = (raw) => {
    let event;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw?.data ?? raw).toString("utf8"));
    } catch {
      return;
    }
    if (event?.type === "response.output_audio.delta" && typeof event.delta === "string") {
      try {
        playbackFromDelta(track, state, event.delta);
      } catch {
        // The peer may not be connected yet. Keep the socket.
      }
      return;
    }
    onEvent?.(typeof raw === "string" ? raw : JSON.stringify(event));
  };
  if (typeof track.onReceiveRtp?.subscribe === "function") track.onReceiveRtp.subscribe(onRtp);
  socket.onopen = flush;
  socket.onmessage = (event) => onUpstream(event?.data ?? event);
  send(sessionUpdate());
  if (opened) flush();
  return {
    onRtp,
    onUpstream,
    close() {
      try {
        opus?.delete?.();
      } catch {
        // The decoder is already gone.
      }
    },
  };
}

function openVoiceSocket(_url, token) {
  return new WebSocket(VOICE_SOCKET_URL, {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function answerVoiceCall({ offer, token, webSocketFactory }) {
  const pc = new RTCPeerConnection(peerConfig());
  const track = new MediaStreamTrack({ kind: "audio" });
  let socket;
  let bridge;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    active.delete(session);
    if (session.id) sessionsById.delete(session.id);
    try {
      bridge?.close();
      socket?.close();
    } catch {
      // Already closed.
    }
    pc.close().catch(() => {});
  };
  const pendingEvents = [];
  let sidebandSocket = null;
  const session = {
    close,
    id: null,
    attachSideband(sock) {
      sidebandSocket = sock;
      attachClientFrames(sock, (text) => {
        try {
          socket?.send(text);
        } catch {
          // The xAI socket may already be closed.
        }
      });
      for (const text of pendingEvents.splice(0)) sock.write(encodeServerFrame(0x1, text));
    },
  };
  const noteEvent = (text) => {
    if (sidebandSocket && !sidebandSocket.destroyed) sidebandSocket.write(encodeServerFrame(0x1, text));
    else pendingEvents.push(text);
  };
  try {
    pc.addTrack(track);
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    let sdp = pc.localDescription?.sdp ?? "";
    if (!sdp.startsWith("v=0") || !sdp.includes("a=fingerprint:")) {
      throw new Error("incomplete answer");
    }
    sdp = await waitForHostCandidate(pc);
    const id = rememberLocalCall();
    session.id = id;
    sessionsById.set(id, session);
    socket = (webSocketFactory ?? openVoiceSocket)(VOICE_SOCKET_URL, token);
    socket.onerror = () => {};
    bridge = startVoiceBridge({
      track,
      socket,
      codec: audioCodecFromSdp(sdp),
      onEvent: noteEvent,
    });
    active.add(session);
    return { sdp, location: `/v1/realtime/calls/${id}`, close };
  } catch (error) {
    close();
    throw error;
  }
}

export function closeVoiceCalls() {
  for (const session of [...active]) session.close();
}

export function voiceCallCount() {
  return active.size;
}
