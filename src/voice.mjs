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
// is not the local bridge. Trailing "generation" and "ufrag" tokens are not
// part of the candidate the helper parses, so they are removed.
// webrtc-rs opens SCTP only when it is the DTLS client, and only after the
// handshake. An actpass offer lets this answer be the server, so the desktop
// sends the INIT. A werift offerer still sends it: that stack initiates SCTP
// when it is ICE-controlling, which the offerer is.
function answerSdpForOffer(offer, answerSdp) {
  const text = String(answerSdp ?? "");
  if (!String(offer ?? "").includes("a=setup:actpass")) return text;
  return text.replaceAll("a=setup:active", "a=setup:passive");
}

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
    .map((line, index) => {
      if (!picked.has(index)) return line;
      const canonical = line.match(/^(a=candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ host)\b/);
      return canonical ? canonical[1] : line;
    })
    .filter((line, index) => !lines[index].startsWith("a=candidate:") || picked.has(index))
    .join("\r\n");
}

function callBodyText(body) {
  return Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
}

function partFromCallBody(body, contentType, name) {
  const text = callBodyText(body);
  const type = String(contentType ?? "");
  if (!type.toLowerCase().includes("multipart/form-data")) return null;
  const boundaryMatch = type.match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1];
  for (const part of text.split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd).toLowerCase();
    if (!headers.includes(`name="${name}"`) && !headers.includes(`name=${name}`)) continue;
    let value = part.slice(headerEnd + 4);
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    return value;
  }
  return null;
}

export function offerFromCallBody(body, contentType) {
  return partFromCallBody(body, contentType, "sdp") ?? callBodyText(body);
}

function sessionObject(body, contentType) {
  const raw = partFromCallBody(body, contentType, "session");
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    return session?.session && typeof session.session === "object" ? session.session : session;
  } catch {
    return null;
  }
}

export function instructionsFromCallBody(body, contentType) {
  const session = sessionObject(body, contentType);
  return typeof session?.instructions === "string" ? session.instructions.trim() : "";
}

export function initialItemsFromCallBody(body, contentType) {
  const items = sessionObject(body, contentType)?.initial_items;
  if (!Array.isArray(items)) return [];
  const seeded = [];
  for (const item of items) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    const text = item.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!text) continue;
    const assistant = item.role === "assistant";
    seeded.push({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: assistant ? "assistant" : "user",
        content: [{ type: assistant ? "output_text" : "input_text", text }],
      },
    });
  }
  return seeded;
}

export function remoteAudioTracks(pc) {
  const found = [];
  for (const transceiver of pc.getTransceivers?.() ?? []) {
    for (const track of transceiver.receiver?.tracks ?? []) {
      if (track?.remote && track.kind === "audio") found.push(track);
    }
  }
  return found;
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
  const marker = !state.talking;
  state.talking = true;
  state.sequence = (state.sequence + 1) & 0xffff;
  state.timestamp = (state.timestamp + clockStep) >>> 0;
  track.writeRtp(
    new RtpPacket(
      new RtpHeader({
        marker,
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

function flushPlayback(track, state) {
  if (state.kind !== "opus" || !state.opus || !state.pending?.length) return;
  const frameBytes = OPUS_FRAME * 2;
  const padded = Buffer.alloc(frameBytes);
  state.pending.copy(padded);
  state.pending = Buffer.alloc(0);
  const encoded = Buffer.from(state.opus.encode(monoToStereo(padded), OPUS_FRAME));
  writeAudio(track, state, encoded, OPUS_FRAME);
}

const CODEX_TOOL = {
  type: "function",
  name: "codex",
  description:
    "Ask the Codex coding agent to carry out work in the user's workspace. Use this when the user asks to read, edit, run, or inspect the project. Do not use it for ordinary conversation.",
  parameters: {
    type: "object",
    properties: {
      request: { type: "string", description: "What the user wants done, in their words." },
    },
    required: ["request"],
  },
};

function sessionUpdate(instructions) {
  const text = typeof instructions === "string" && instructions.trim() ? instructions.trim() : "Say ready.";
  return {
    type: "session.update",
    session: {
      voice: "eve",
      instructions: text,
      turn_detection: { type: "server_vad" },
      tools: [CODEX_TOOL],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: XAI_PCM_RATE },
          transcription: { model: "grok-transcribe" },
        },
        output: { format: { type: "audio/pcm", rate: XAI_PCM_RATE } },
      },
    },
  };
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "input_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// v3 puts instructions in the call's session part and later sends frameless
// appends. xAI accepts session.update, conversation.item.create, and force_message.
function codexRequest(argumentsText) {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) return "";
  try {
    const args = JSON.parse(argumentsText);
    if (typeof args?.request === "string" && args.request.trim()) return args.request.trim();
  } catch {
    // The model sometimes sends plain text instead of JSON.
  }
  return argumentsText.trim();
}

export function voiceClientEvents(event, state = {}) {
  const type = event?.type;
  if (type === "response.create" || type === "response.cancel" || type === "conversation.item.create") {
    return [event];
  }
  if (type === "session.update") {
    const instructions = typeof event.session?.instructions === "string" ? event.session.instructions.trim() : "";
    return instructions ? [sessionUpdate(instructions)] : [];
  }
  if (type === "session.context.append" || type === "delegation.context.append") {
    const text = textFromContent(event.content);
    if (!text) return [];
    if (event.channel === "commentary") {
      return [
        {
          type: "conversation.item.create",
          item: { type: "message", role: "assistant", content: [{ type: "input_text", text }] },
        },
      ];
    }
    const spoken = {
      type: "conversation.item.create",
      item: { type: "force_message", role: "assistant", content: [{ type: "output_text", text }] },
    };
    const callId = event.delegation_item_id;
    if (typeof callId === "string" && state.pendingCalls?.has(callId)) {
      state.pendingCalls.delete(callId);
      return [
        {
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: JSON.stringify(text) },
        },
        spoken,
      ];
    }
    return [spoken];
  }
  return [];
}

// Desktop v3 reads frameless sideband events. xAI voice uses different names.
// Cumulative user captions are reduced to the new suffix. A rewrite that no
// longer extends the previous caption is sent as the completed turn text.
export function voiceSidebandEvent(event, state) {
  const type = event?.type;
  if (type === "response.output_audio_transcript.delta" && typeof event.delta === "string" && event.delta) {
    return { type: "output_transcript.added", item: { text: event.delta } };
  }
  if (type === "response.output_audio_transcript.done" && typeof event.transcript === "string" && event.transcript) {
    return { type: "turn.done", turn: { role: "assistant", transcript: event.transcript } };
  }
  if (type === "conversation.item.input_audio_transcription.updated" && typeof event.transcript === "string") {
    const next = event.transcript;
    const prev = state.inputTranscript ?? "";
    state.inputTranscript = next;
    if (!next || next === prev) return null;
    if (next.startsWith(prev)) {
      const suffix = next.slice(prev.length);
      return suffix ? { type: "input_transcript.added", item: { text: suffix } } : null;
    }
    return { type: "turn.done", turn: { role: "user", transcript: next } };
  }
  if (
    type === "conversation.item.input_audio_transcription.completed" &&
    typeof event.transcript === "string" &&
    event.transcript
  ) {
    state.inputTranscript = "";
    return { type: "turn.done", turn: { role: "user", transcript: event.transcript } };
  }
  if ((type === "session.created" || type === "session.updated") && typeof event.session?.id === "string") {
    const session = { id: event.session.id };
    if (typeof event.session.instructions === "string") session.instructions = event.session.instructions;
    return { type: "session.updated", session };
  }
  if (type === "response.function_call_arguments.done" && event.name === "codex" && typeof event.call_id === "string") {
    const request = codexRequest(event.arguments);
    if (!request) return null;
    if (!state.pendingCalls) state.pendingCalls = new Set();
    state.pendingCalls.add(event.call_id);
    return {
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: event.call_id,
        content: [{ type: "input_text", text: request }],
      },
    };
  }
  if (type === "error") return event;
  return null;
}

export function startVoiceBridge({
  track,
  socket,
  codec = { kind: "pcmu", payloadType: 0 },
  onEvent,
  instructions,
  initialItems = [],
  voiceState,
  receiveTracks = [],
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
  const sidebandState = voiceState ?? { inputTranscript: "", pendingCalls: new Set() };
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
    if (event?.type === "response.output_audio.done" || event?.type === "response.done") {
      try {
        flushPlayback(track, state);
      } catch {
        // A short tail is dropped. The call stays up.
      }
      state.talking = false;
    }
    const sideband = voiceSidebandEvent(event, sidebandState);
    if (sideband) onEvent?.(JSON.stringify(sideband));
  };
  // The local track reports packets we send. The microphone is the remote track.
  for (const remote of receiveTracks) remote.onReceiveRtp?.subscribe?.(onRtp);
  socket.onopen = flush;
  socket.onmessage = (event) => onUpstream(event?.data ?? event);
  socket.onclose = () => {
    if (sidebandState.closing) return;
    onEvent?.(JSON.stringify({ type: "error", error: { message: "Voice connection closed." } }));
  };
  send(sessionUpdate(instructions));
  for (const item of initialItems) send(item);
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

export async function answerVoiceCall({ offer, token, webSocketFactory, instructions, initialItems }) {
  const pc = new RTCPeerConnection(peerConfig());
  const track = new MediaStreamTrack({ kind: "audio" });
  let socket;
  let bridge;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    voiceState.closing = true;
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
  const voiceState = { inputTranscript: "", pendingCalls: new Set() };
  let sidebandSocket = null;
  const session = {
    close,
    id: null,
    attachSideband(sock) {
      sidebandSocket = sock;
      attachClientFrames(sock, (text) => {
        let event;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        for (const outbound of voiceClientEvents(event, voiceState)) {
          try {
            socket?.send(JSON.stringify(outbound));
          } catch {
            // The xAI socket may already be closed.
          }
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
    const seenRemote = new Set();
    const receiveTracks = [];
    const watchRemote = (remote) => {
      if (!remote?.remote || remote.kind !== "audio" || seenRemote.has(remote)) return;
      seenRemote.add(remote);
      if (bridge?.onRtp) remote.onReceiveRtp?.subscribe?.(bridge.onRtp);
      else receiveTracks.push(remote);
    };
    pc.onTrack?.subscribe?.(watchRemote);
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    for (const remote of remoteAudioTracks(pc)) watchRemote(remote);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: "answer", sdp: answerSdpForOffer(offer, answer?.sdp) });
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
      instructions,
      initialItems,
      voiceState,
      receiveTracks,
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
