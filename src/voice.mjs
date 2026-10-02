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

const OPUS_FRAME = 960;

function peerConfig() {
  return {
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    iceUseTcp: false,
    codecs: { audio: [useOPUS(), usePCMU()] },
  };
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

export function isLocalVoiceSideband(url) {
  const text = String(url ?? "");
  for (const id of localCalls) {
    if (text.includes(id)) return true;
  }
  return false;
}

export function acceptLocalSideband(socket, key) {
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.on("data", () => {});
  socket.on("error", () => {});
  socket.resume();
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

export function startVoiceBridge({ track, socket, codec = { kind: "pcmu", payloadType: 0 } }) {
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
    if (event?.type !== "response.output_audio.delta" || typeof event.delta !== "string") return;
    try {
      playbackFromDelta(track, state, event.delta);
    } catch {
      // The peer may not be connected yet. Keep the socket.
    }
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
  const close = () => {
    active.delete(session);
    try {
      bridge?.close();
      socket?.close();
    } catch {
      // Already closed.
    }
    pc.close().catch(() => {});
  };
  const session = { close };
  try {
    pc.addTrack(track);
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    const sdp = pc.localDescription?.sdp ?? "";
    if (!sdp.startsWith("v=0") || !sdp.includes("a=fingerprint:")) {
      throw new Error("incomplete answer");
    }
    const id = rememberLocalCall();
    socket = (webSocketFactory ?? openVoiceSocket)(VOICE_SOCKET_URL, token);
    socket.onerror = () => {};
    bridge = startVoiceBridge({ track, socket, codec: audioCodecFromSdp(sdp) });
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
