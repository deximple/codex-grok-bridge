import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// cli-chat-proxy has no Responses `video_generation` tool. grok-build generates
// video by calling the videos API itself when the model invokes a function
// (`image_to_video` / `reference_to_video`): POST {xai_api_base}/videos/generations,
// then GET /videos/{request_id}. The bridge does the same with the grok login
// bearer it already sends to cli-chat-proxy — the `key` from that session, not
// an XAI_API_KEY. The finished clip is a temporary URL, so the bytes are saved
// locally before that URL expires.

export const GROK_VIDEO_TOOL_NAME = "grok_bridge_generate_video";

export const DEFAULT_VIDEO_API_BASE = "https://api.x.ai/v1";

export const DEFAULT_VIDEO_DIR = path.join(
  homedir(),
  ".local/share/codex-grok-bridge/generated-videos",
);

const VIDEO_MODEL = "grok-imagine-video-1.5";
const POLL_LIMIT = 60;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_VIDEO_REDIRECTS = 3;

export const GROK_VIDEO_TOOL = Object.freeze({
  type: "function",
  name: GROK_VIDEO_TOOL_NAME,
  description:
    "Generate a short video with Grok. The bridge runs this tool itself; Codex does not. " +
    "Provide a prompt. Provide image_url only when the clip should start from that still image. " +
    "The result names the temporary URL and the local file the bridge saved.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the video should show." },
      image_url: {
        type: "string",
        description: "Optional http(s) or data URL of a still image to animate.",
      },
      duration: {
        type: "integer",
        description: "Length in seconds, from 1 to 15.",
      },
      aspect_ratio: {
        type: "string",
        description: "One of 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3.",
      },
      resolution: {
        type: "string",
        description: "Optional 480p, 720p, or 1080p. Omit for the server default.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
});

function scrub(text, token) {
  let out = String(text ?? "");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  if (token) out = out.split(token).join("[redacted]");
  return out;
}

function parseArgs(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);

function videoDuration(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function videoArgumentError(args) {
  if (typeof args.image_url === "string" && args.image_url.trim()) {
    const image = args.image_url.trim();
    if (!/^https?:\/\//i.test(image) && !/^data:/i.test(image)) {
      return "Video generation failed: image_url must be an http(s) URL or a data URL.";
    }
  }
  if (args.duration != null && args.duration !== "") {
    const duration = videoDuration(args.duration);
    if (duration == null || duration < 1 || duration > 15) {
      return "Video generation failed: duration must be an integer from 1 to 15.";
    }
  }
  const ratio = typeof args.aspect_ratio === "string" ? args.aspect_ratio.trim() : "";
  if (ratio && !ASPECT_RATIOS.has(ratio)) {
    return "Video generation failed: aspect_ratio must be one of 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3.";
  }
  const resolution = typeof args.resolution === "string" ? args.resolution.trim() : "";
  if (resolution && !VIDEO_RESOLUTIONS.has(resolution)) {
    return "Video generation failed: resolution must be 480p, 720p, or 1080p.";
  }
  return "";
}

function videoPayload(args) {
  const payload = { model: VIDEO_MODEL, prompt: args.prompt };
  if (typeof args.image_url === "string" && args.image_url.trim())
    payload.image = { url: args.image_url.trim() };
  if (Number.isInteger(args.duration)) payload.duration = args.duration;
  else if (typeof args.duration === "string" && /^\d+$/.test(args.duration))
    payload.duration = Number(args.duration);
  if (typeof args.aspect_ratio === "string" && args.aspect_ratio.trim())
    payload.aspect_ratio = args.aspect_ratio.trim();
  if (typeof args.resolution === "string" && VIDEO_RESOLUTIONS.has(args.resolution.trim()))
    payload.resolution = args.resolution.trim();
  return payload;
}

async function videoHttp(fetchImpl, url, init) {
  const response = await fetchImpl(url, { ...init, redirect: "manual" });
  const text = await response.text().catch(() => "");
  if (response.status >= 300 && response.status < 400) {
    const error = new Error("Video generation failed (redirect).");
    error.status = response.status;
    throw error;
  }
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function httpFailure(status) {
  const error = new Error(`Video generation failed (${status}).`);
  error.status = status;
  return error;
}

export async function generateVideo(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_VIDEO_API_BASE).replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  };
  const started = await videoHttp(fetchImpl, `${base}/videos/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify(videoPayload(options)),
    signal: options.signal,
  });
  if (started.status < 200 || started.status >= 300)
    throw httpFailure(started.status);
  const requestId = started.body?.request_id;
  if (typeof requestId !== "string" || !requestId)
    throw httpFailure(started.status);
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    if (attempt > 0) await pause(5000);
    const poll = await videoHttp(
      fetchImpl,
      `${base}/videos/${encodeURIComponent(requestId)}`,
      { method: "GET", headers, signal: options.signal },
    );
    if (poll.status === 202) continue;
    if (poll.status < 200 || poll.status >= 300) throw httpFailure(poll.status);
    const status = poll.body?.status;
    if (status === "done") {
      const url = poll.body?.video?.url;
      if (typeof url === "string" && url) return url;
      const withheld =
        poll.body?.respect_moderation === false ||
        poll.body?.video?.respect_moderation === false;
      if (withheld) {
        const error = new Error("Video generation was withheld by moderation.");
        error.moderation = true;
        throw error;
      }
      throw new Error("Video generation finished without a URL.");
    }
    if (status === "failed" || status === "expired")
      throw new Error(`Video generation ${status}.`);
  }
  throw new Error("Video generation timed out.");
}

function looksLikeVideo(bytes, contentType) {
  if (bytes.length >= 8 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return "webm";
  const type = String(contentType ?? "").toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.startsWith("video/")) return "mp4";
  return "";
}

// The finished URL is a temporary file host (vidgen.x.ai), not the API host.
// The login bearer stays on the poll and is not sent with the download.
async function downloadGeneratedVideo(url, options, redirects = 0) {
  if (redirects > MAX_VIDEO_REDIRECTS) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: options.signal,
    });
  } catch {
    return null;
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers?.get?.("location");
    await response.arrayBuffer?.().catch(() => {});
    if (!location) return null;
    let next;
    try {
      next = new URL(location, url).href;
    } catch {
      return null;
    }
    return downloadGeneratedVideo(next, options, redirects + 1);
  }
  if (response.status < 200 || response.status >= 300) {
    await response.arrayBuffer?.().catch(() => {});
    return null;
  }
  const advertised = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_VIDEO_BYTES) {
    await response.arrayBuffer?.().catch(() => {});
    return null;
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) return null;
  const extension = looksLikeVideo(bytes, response.headers?.get?.("content-type"));
  if (!extension) return null;
  const dir = options.dir ?? DEFAULT_VIDEO_DIR;
  const stamp = (options.now ?? Date.now()).toString(36);
  const file = path.join(dir, `grok-${stamp}.${extension}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

export async function videoToolOutput(call, options) {
  const token = options?.token;
  try {
    const args = parseArgs(call?.arguments);
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return "Video generation failed: a prompt is required.";
    const invalid = videoArgumentError(args);
    if (invalid) return invalid;
    const url = await generateVideo({
      token: options.token,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
      pause: options.pause,
      signal: options.signal,
      prompt,
      image_url: args.image_url,
      duration: args.duration,
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
    });
    let file = null;
    try {
      file = await downloadGeneratedVideo(url, options);
    } catch {
      file = null;
    }
    const note = file
      ? `Video ready at ${url}. Saved to [${file}](${pathToFileURL(file).href}).`
      : `Video ready at ${url}`;
    return scrub(note, token);
  } catch (error) {
    const status = Number(error?.status) || 0;
    if (status >= 400 && status < 500) return `Video generation failed (${status}).`;
    if (error?.moderation)
      return "Video generation finished, but moderation withheld the URL.";
    return "Video generation failed.";
  }
}

export function videoCallsFromParts(parts) {
  const calls = [];
  const seen = new Set();
  for (const part of parts ?? []) {
    for (const line of String(part).split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let value;
      try {
        value = JSON.parse(payload);
      } catch {
        continue;
      }
      const item = value?.item;
      if (value?.type !== "response.output_item.done") continue;
      if (item?.type !== "function_call" || item.name !== GROK_VIDEO_TOOL_NAME)
        continue;
      if (typeof item.call_id !== "string" || seen.has(item.call_id)) continue;
      seen.add(item.call_id);
      calls.push({
        name: item.name,
        call_id: item.call_id,
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
      });
    }
  }
  return calls;
}
