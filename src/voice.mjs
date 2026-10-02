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

export function voiceSocketUrl(conversationId) {
  if (!conversationId) return VOICE_SOCKET_URL;
  const url = new URL(VOICE_SOCKET_URL);
  url.searchParams.set("conversation_id", conversationId);
  return url.toString();
}

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

export function ackFillerFromCallBody(body, contentType) {
  return sessionObject(body, contentType)?.delegation?.ack_filler === true;
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
  return new OpusScript(48000, 2, OpusScript.Application.VOIP);
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

export function acceptLocalSideband(socket, key, url, head = Buffer.alloc(0)) {
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
  if (head?.length) socket.unshift(head);
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

// A late 20 ms timer is still one talkspurt. Only a real pause moves the clock,
// or the helper treats the next packet as a new, late frame and can drop it.
export function playoutGap(state, now) {
  if (state.lastSentAt == null) return 0;
  const frames = Math.floor((now - state.lastSentAt) / 20);
  if (frames < 4) return 0;
  return frames - 1;
}

function writeAudio(track, state, payload, clockStep, forceMarker = false) {
  if (payload.length === 0) return;
  const now = Date.now();
  const extra = playoutGap(state, now);
  const sequence = (state.sequence + 1) & 0xffff;
  const timestamp = (state.timestamp + (extra + 1) * clockStep) >>> 0;
  track.writeRtp(
    new RtpPacket(
      new RtpHeader({
        marker: forceMarker || extra > 0 || !state.talking,
        payloadType: state.payloadType,
        sequenceNumber: sequence,
        timestamp,
        ssrc: state.ssrc,
      }),
      payload,
    ),
  );
  state.talking = true;
  state.sequence = sequence;
  state.timestamp = timestamp;
  state.lastSentAt = now;
  const rate = state.kind === "opus" ? 48000 : 8000;
  state.playedMs = (state.playedMs ?? 0) + Math.round((clockStep / rate) * 1000);
}

export function voiceAudioDelta(event) {
  if (event?.type !== "response.output_audio.delta" && event?.type !== "response.audio.delta") return "";
  if (typeof event.delta === "string" && event.delta) return event.delta;
  if (typeof event.audio === "string" && event.audio) return event.audio;
  return "";
}

export function playbackFromDelta(track, state, delta) {
  const pcm = Buffer.from(String(delta ?? ""), "base64");
  if (state.kind === "opus" && state.opus) {
    if (state.endTalk) state.armMarker = true;
    state.endTalk = false;
    const wide = resampleInt16(pcm, 2, "up");
    state.pending = Buffer.concat([state.pending ?? Buffer.alloc(0), wide]);
    const frameBytes = OPUS_FRAME * 2;
    while (state.pending.length >= frameBytes) {
      const frame = state.pending.subarray(0, frameBytes);
      state.pending = state.pending.subarray(frameBytes);
      const encoded = Buffer.from(state.opus.encode(monoToStereo(frame), OPUS_FRAME));
      enqueueAudio(state, encoded, OPUS_FRAME);
    }
    kickAudio(track, state);
    return;
  }
  const mulaw = pcm16ToMulaw(resampleInt16(pcm, 3, "down"));
  writeAudio(track, state, mulaw, mulaw.length);
}

function enqueueAudio(state, payload, clockStep) {
  if (!state.playout) state.playout = [];
  const marker = state.armMarker === true;
  if (marker) state.armMarker = false;
  state.playout.push({ payload, clockStep, marker });
}

function scheduleAudio(track, state) {
  if (state.stopped) return;
  state.pumping = true;
  const timer = setTimeout(() => {
    state.pumping = false;
    state.playoutTimer = null;
    kickAudio(track, state);
  }, 20);
  timer.unref?.();
  state.playoutTimer = timer;
}

function kickAudio(track, state) {
  if (state.stopped || state.pumping) return;
  const frame = state.playout?.[0];
  if (!frame) {
    if (state.endTalk) state.talking = false;
    state.onDrained?.();
    return;
  }
  try {
    writeAudio(track, state, frame.payload, frame.clockStep, frame.marker);
  } catch {
    scheduleAudio(track, state);
    return;
  }
  state.playout.shift();
  if (!state.playout.length) {
    if (state.endTalk) state.talking = false;
    state.onDrained?.();
    return;
  }
  scheduleAudio(track, state);
}

export function stopPlayback(state, options = {}) {
  state.playout = [];
  state.pending = Buffer.alloc(0);
  state.pumping = false;
  state.dropping = true;
  state.userSpeaking = options.userSpeaking !== false;
  state.endTalk = true;
  state.talking = false;
  if (state.playoutTimer) {
    clearTimeout(state.playoutTimer);
    state.playoutTimer = null;
  }
}

function flushPlayback(track, state) {
  if (state.dropping) return;
  if (state.kind !== "opus" || !state.opus || !state.pending?.length) return;
  const frameBytes = OPUS_FRAME * 2;
  const padded = Buffer.alloc(frameBytes);
  state.pending.copy(padded);
  state.pending = Buffer.alloc(0);
  const encoded = Buffer.from(state.opus.encode(monoToStereo(padded), OPUS_FRAME));
  enqueueAudio(state, encoded, OPUS_FRAME);
  kickAudio(track, state);
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

const ACK_FILLER =
  "When you call the codex tool, say one short sentence first so the user hears that work has started.";

function sessionUpdate(instructions, ackFiller = false) {
  const base = typeof instructions === "string" && instructions.trim() ? instructions.trim() : "Say ready.";
  const text = ackFiller && !base.includes(ACK_FILLER) ? `${base}\n\n${ACK_FILLER}` : base;
  return {
    type: "session.update",
    session: {
      voice: "eve",
      instructions: text,
      turn_detection: { type: "server_vad" },
      resumption: { enabled: true },
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

function contextChannel(event) {
  return event?.channel ?? null;
}

// Desktop splits one append into 500-byte frames. Join a back-to-back burst
// before the tool result and the spoken line are built.
export function mergeVoiceClientBurst(events) {
  const merged = [];
  for (const event of events) {
    const prev = merged.at(-1);
    const type = event?.type;
    const sameDelegation =
      prev?.type === "delegation.context.append" &&
      type === "delegation.context.append" &&
      prev.delegation_item_id === event.delegation_item_id &&
      contextChannel(prev) === contextChannel(event);
    const sameSession =
      prev?.type === "session.context.append" &&
      type === "session.context.append" &&
      contextChannel(prev) === contextChannel(event);
    if (sameDelegation || sameSession) {
      merged[merged.length - 1] = {
        ...prev,
        content: [{ type: "input_text", text: textFromContent(prev.content) + textFromContent(event.content) }],
      };
      continue;
    }
    merged.push(structuredClone(event));
  }
  return merged;
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
  if (type === "input_audio.append" && typeof event.audio === "string" && event.audio) {
    return [{ type: "input_audio_buffer.append", audio: event.audio }];
  }
  if (type === "session.update") {
    const instructions = typeof event.session?.instructions === "string" ? event.session.instructions.trim() : "";
    return instructions ? [sessionUpdate(instructions, state.ackFiller === true)] : [];
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

// Desktop streams a codex reply in pieces about 200 ms apart. Hold them until
// the stream pauses, then close the tool and speak the whole reply once.
export const DELEGATION_SPEECH_WAIT_MS = 350;
export const MIC_HOLD_MS = 2000;
export const MIC_HOLD_FRAMES = MIC_HOLD_MS / 20;

export function queueDelegationSpeech(state, event) {
  if (event?.type !== "delegation.context.append") return false;
  const id = event.delegation_item_id;
  if (typeof id !== "string") return false;
  const text = textFromContent(event.content);
  if (event.channel === "commentary" && text.startsWith("[STATUS]")) return false;
  if (!state.pendingCalls?.has(id) && !state.speechParts?.has(id)) return false;
  if (!state.speechParts) state.speechParts = new Map();
  const prior = state.speechParts.get(id) ?? { text: "", commentary: event.channel === "commentary" };
  if (event.channel !== "commentary") prior.commentary = false;
  if (text) prior.text += text;
  state.speechParts.set(id, prior);
  return true;
}

export function flushDelegationSpeech(state) {
  const parts = state.speechParts;
  if (!parts?.size) return [];
  const events = [];
  for (const [id, record] of parts) {
    const text = record.text ?? "";
    if (record.commentary) {
      if (state.pendingCalls?.has(id)) {
        state.pendingCalls.delete(id);
        events.push({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: id, output: JSON.stringify(text) },
        });
      }
      if (text) {
        events.push({
          type: "conversation.item.create",
          item: { type: "message", role: "assistant", content: [{ type: "input_text", text }] },
        });
      }
      events.push({ type: "response.create" });
      continue;
    }
    events.push(
      ...voiceClientEvents(
        {
          type: "delegation.context.append",
          delegation_item_id: id,
          content: [{ type: "input_text", text }],
        },
        state,
      ),
    );
  }
  parts.clear();
  return events;
}

// Desktop v3 reads frameless sideband events. xAI voice uses different names.
// Cumulative user captions are reduced to the new suffix. A rewrite that no
// longer extends the previous caption is sent as the completed turn text.
function assistantTextDelta(event) {
  if (event?.type !== "response.output_text.delta" && event?.type !== "response.text.delta") return "";
  return typeof event.delta === "string" ? event.delta : "";
}

export function voiceSidebandEvent(event, state) {
  const type = event?.type;
  if (type === "response.created") {
    state.outputText = "";
    state.audioText = "";
    state.audioTranscript = false;
    state.assistantTurnClosed = false;
    return null;
  }
  const text = assistantTextDelta(event);
  if (text) {
    if (state.audioTranscript) return null;
    state.outputText = `${state.outputText ?? ""}${text}`;
    return { type: "output_transcript.added", item: { text } };
  }
  if (type === "response.output_text.done" || type === "response.text.done") {
    const full =
      typeof event.text === "string" && event.text
        ? event.text
        : typeof event.transcript === "string" && event.transcript
          ? event.transcript
          : (state.outputText ?? "");
    state.outputText = "";
    state.assistantTurnClosed = true;
    return full ? { type: "turn.done", turn: { role: "assistant", transcript: full } } : null;
  }
  if (type === "response.output_audio_transcript.delta" && typeof event.delta === "string" && event.delta) {
    state.audioTranscript = true;
    state.outputText = "";
    state.audioText = `${state.audioText ?? ""}${event.delta}`;
    return { type: "output_transcript.added", item: { text: event.delta } };
  }
  if (type === "response.output_audio_transcript.done" && typeof event.transcript === "string" && event.transcript) {
    state.outputText = "";
    state.audioText = "";
    state.assistantTurnClosed = true;
    return { type: "turn.done", turn: { role: "assistant", transcript: event.transcript } };
  }
  if (type === "response.done" && !state.assistantTurnClosed) {
    const full = state.audioTranscript ? (state.audioText ?? "") : (state.outputText ?? "");
    state.outputText = "";
    state.audioText = "";
    if (!full) return null;
    state.assistantTurnClosed = true;
    return { type: "turn.done", turn: { role: "assistant", transcript: full } };
  }
  if (type === "input_audio_buffer.speech_started" && state.inputTranscript) {
    const transcript = state.inputTranscript;
    state.inputTranscript = "";
    state.userClosed = transcript;
    return { type: "turn.done", turn: { role: "user", transcript } };
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
    const closed = state.userClosed ?? "";
    state.inputTranscript = "";
    state.userClosed = "";
    if (closed && (event.transcript === closed || event.transcript.startsWith(closed))) return null;
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
  // Codex treats every sideband error as fatal and ends the call. xAI errors
  // are usually recoverable, so they stay here. A dead socket reports its own error.
  return null;
}

// The desktop waits for session.updated before it will read any other sideband event.
export function announceSession(state, pending) {
  if (state.sessionAnnounced || !state.sessionId) return pending;
  state.sessionAnnounced = true;
  return [JSON.stringify({ type: "session.updated", session: { id: state.sessionId } }), ...pending];
}

// The desktop rejects a frameless call whose first event is not session.updated.
export function sidebandFrames(state, text) {
  const frames = [];
  let event = null;
  try {
    event = JSON.parse(text);
  } catch {
    event = null;
  }
  const announced = event?.type === "session.updated" && typeof event.session?.id === "string";
  if (!state.sessionAnnounced && !announced && state.sessionId) {
    frames.push(JSON.stringify({ type: "session.updated", session: { id: state.sessionId } }));
  }
  if (announced || frames.length) state.sessionAnnounced = true;
  frames.push(text);
  return frames;
}

export function startVoiceBridge({
  track,
  socket,
  codec = { kind: "pcmu", payloadType: 0 },
  onEvent,
  instructions,
  ackFiller = false,
  initialItems = [],
  voiceState,
  receiveTracks = [],
  openSocket,
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
  const held = [];
  const sidebandState = voiceState ?? { inputTranscript: "", pendingCalls: new Set() };
  let current = socket;
  let opened = socket.readyState === 1;
  let responseActive = false;
  let pendingCreate = false;
  let resumed = false;
  let sessionReady = false;
  const pendingAudio = [];
  const send = (event) => {
    if (!sessionReady && event?.type === "input_audio_buffer.append") {
      pendingAudio.push(event);
      if (pendingAudio.length > MIC_HOLD_FRAMES) pendingAudio.shift();
      return;
    }
    const text = JSON.stringify(event);
    if (!opened) {
      queued.push(text);
      return;
    }
    current.send(text);
  };
  let readyTimer = null;
  const armReadyTimer = () => {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = setTimeout(() => markSessionReady(), MIC_HOLD_MS);
    readyTimer.unref();
  };
  const markSessionReady = () => {
    if (sessionReady) return;
    sessionReady = true;
    if (readyTimer) clearTimeout(readyTimer);
    for (const event of pendingAudio.splice(0)) send(event);
    releaseHeld();
  };
  armReadyTimer();
  const holdsForIdleResponse = (event) => {
    const item = event?.item;
    return (
      event?.type === "response.create" ||
      (event?.type === "conversation.item.create" &&
        (item?.type === "force_message" || item?.type === "function_call_output"))
    );
  };
  const playbackBusy = () => Boolean(state.playout?.length || state.pumping);
  const releaseHeld = () => {
    if (responseActive || playbackBusy() || state.userSpeaking) return;
    for (const event of held.splice(0)) send(event);
  };
  const interruptAssistant = (userSpeaking) => {
    const unsent = Boolean(state.playout?.length || state.pending?.length);
    stopPlayback(state, { userSpeaking });
    if (unsent && state.audioItemId && !state.truncated) {
      state.truncated = true;
      send({
        type: "conversation.item.truncate",
        item_id: state.audioItemId,
        content_index: state.audioContentIndex ?? 0,
        audio_end_ms: state.playedMs ?? 0,
      });
    }
  };
  state.onDrained = releaseHeld;
  const flush = () => {
    opened = true;
    for (const text of queued.splice(0)) current.send(text);
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
    const errorMessage = event?.error?.message ?? event?.message;
    if (
      event?.type === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.startsWith("Conversation already has an active response in progress")
    ) {
      responseActive = true;
      pendingCreate = true;
    }
    if (event?.type === "conversation.created" && typeof event.conversation?.id === "string") {
      sidebandState.conversationId = event.conversation.id;
    }
    if (event?.type === "session.updated") markSessionReady();
    if (event?.type === "input_audio_buffer.speech_started") interruptAssistant(true);
    if (event?.type === "input_audio_buffer.speech_stopped") {
      state.userSpeaking = false;
      releaseHeld();
    }
    const spoken = voiceAudioDelta(event);
    if (spoken) {
      if (!state.dropping) {
        if (typeof event.item_id === "string" && event.item_id !== state.audioItemId) {
          state.audioItemId = event.item_id;
          state.audioContentIndex = Number.isInteger(event.content_index) ? event.content_index : 0;
          state.playedMs = 0;
          state.truncated = false;
        }
        try {
          playbackFromDelta(track, state, spoken);
        } catch {
          // The peer may not be connected yet. Keep the socket.
        }
      }
      return;
    }
    if (event?.type === "response.created") {
      responseActive = true;
      state.dropping = false;
    }
    if (event?.type === "response.output_audio.done" || event?.type === "response.done") {
      try {
        flushPlayback(track, state);
      } catch {
        // A short tail is dropped. The call stays up.
      }
      state.endTalk = true;
      if (!state.playout?.length) state.talking = false;
      if (event.type === "response.done") {
        responseActive = false;
        state.dropping = false;
        releaseHeld();
        if (pendingCreate) {
          pendingCreate = false;
          send({ type: "response.create" });
        }
      }
    }
    const sideband = voiceSidebandEvent(event, sidebandState);
    if (sideband) onEvent?.(JSON.stringify(sideband));
  };
  // The local track reports packets we send. The microphone is the remote track.
  for (const remote of receiveTracks) remote.onReceiveRtp?.subscribe?.(onRtp);
  const onSocketClose = () => {
    if (sidebandState.closing || state.stopped) return;
    if (!resumed && sidebandState.conversationId && openSocket) {
      resumed = true;
      try {
        const pendingHeld = held.splice(0);
        responseActive = false;
        pendingCreate = false;
        state.dropping = false;
        state.userSpeaking = false;
        state.truncated = false;
        state.playedMs = 0;
        state.audioItemId = undefined;
        queued.length = 0;
        current = openSocket(sidebandState.conversationId);
        opened = current.readyState === 1;
        sessionReady = false;
        armReadyTimer();
        bindSocket(current);
        send(sessionUpdate(instructions, ackFiller));
        held.push(...pendingHeld);
        return;
      } catch {
        // The resume dial failed. Tell the desktop below.
      }
    }
    onEvent?.(JSON.stringify({ type: "error", error: { message: "Voice connection closed." } }));
  };
  const bindSocket = (next) => {
    next.onopen = flush;
    next.onmessage = (event) => onUpstream(event?.data ?? event);
    next.onclose = onSocketClose;
    next.onerror = () => {};
  };
  bindSocket(socket);
  send(sessionUpdate(instructions, ackFiller));
  for (const item of initialItems) send(item);
  if (opened) flush();
  return {
    onRtp,
    onUpstream,
    sendClient(event) {
      try {
        if (event?.type === "response.cancel") {
          pendingCreate = false;
          interruptAssistant(state.userSpeaking === true);
          send(event);
          return;
        }
        if ((responseActive || playbackBusy() || state.userSpeaking) && holdsForIdleResponse(event)) {
          held.push(event);
          return;
        }
        send(event);
      } catch {
        // The xAI socket may already be closed.
      }
    },
    close() {
      state.stopped = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (state.playoutTimer) clearTimeout(state.playoutTimer);
      try {
        opus?.delete?.();
      } catch {
        // The decoder is already gone.
      }
    },
  };
}

export function openVoiceSocket(url, token) {
  return new WebSocket(url || VOICE_SOCKET_URL, {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function answerVoiceCall({ offer, token, webSocketFactory, instructions, ackFiller = false, initialItems }) {
  const pc = new RTCPeerConnection(peerConfig());
  const track = new MediaStreamTrack({ kind: "audio" });
  let socket;
  let bridge;
  let closed = false;
  let appendTimer = null;
  let speechTimer = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (appendTimer) clearTimeout(appendTimer);
    if (speechTimer) clearTimeout(speechTimer);
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
  const voiceState = { inputTranscript: "", pendingCalls: new Set(), ackFiller };
  const appendBurst = [];
  const flushAppends = () => {
    appendTimer = null;
    const burst = appendBurst.splice(0);
    for (const event of mergeVoiceClientBurst(burst)) {
      for (const outbound of voiceClientEvents(event, voiceState)) bridge?.sendClient?.(outbound);
    }
  };
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
        const type = event?.type;
        if (type === "session.close") {
          queueMicrotask(() => close());
          return;
        }
        if (queueDelegationSpeech(voiceState, event)) {
          if (speechTimer) clearTimeout(speechTimer);
          speechTimer = setTimeout(() => {
            speechTimer = null;
            for (const outbound of flushDelegationSpeech(voiceState)) bridge?.sendClient?.(outbound);
          }, DELEGATION_SPEECH_WAIT_MS);
          speechTimer.unref();
          return;
        }
        if (type === "session.context.append" || type === "delegation.context.append") {
          appendBurst.push(event);
          if (!appendTimer) {
            appendTimer = setTimeout(flushAppends, 30);
            appendTimer.unref();
          }
          return;
        }
        if (appendTimer) {
          clearTimeout(appendTimer);
          flushAppends();
        }
        for (const outbound of voiceClientEvents(event, voiceState)) bridge?.sendClient?.(outbound);
      });
      for (const text of announceSession(noteState, pendingEvents.splice(0))) {
        sock.write(encodeServerFrame(0x1, text));
      }
    },
  };
  const noteState = { sessionAnnounced: false, sessionId: null };
  const writeSideband = (text) => {
    for (const frame of sidebandFrames(noteState, text)) {
      if (sidebandSocket && !sidebandSocket.destroyed) sidebandSocket.write(encodeServerFrame(0x1, frame));
      else pendingEvents.push(frame);
    }
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
    noteState.sessionId = id;
    sessionsById.set(id, session);
    const dial = webSocketFactory ?? openVoiceSocket;
    socket = dial(VOICE_SOCKET_URL, token);
    socket.onerror = () => {};
    bridge = startVoiceBridge({
      track,
      socket,
      codec: audioCodecFromSdp(sdp),
      onEvent: writeSideband,
      instructions,
      ackFiller,
      initialItems,
      voiceState,
      receiveTracks,
      openSocket(conversationId) {
        socket = dial(voiceSocketUrl(conversationId), token);
        return socket;
      },
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
