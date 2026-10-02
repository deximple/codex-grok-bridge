// cli-chat-proxy has no Responses `video_generation` tool. grok-build generates
// video by calling the videos API itself when the model invokes a function
// (`image_to_video` / `reference_to_video`): POST {xai_api_base}/videos/generations,
// then GET /videos/{request_id}. The bridge does the same with the grok login
// bearer it already sends to cli-chat-proxy — the `key` from that session, not
// an XAI_API_KEY.

export const GROK_VIDEO_TOOL_NAME = "grok_bridge_generate_video";

export const DEFAULT_VIDEO_API_BASE = "https://api.x.ai/v1";

const VIDEO_MODEL = "grok-imagine-video-1.5";
const POLL_LIMIT = 60;

export const GROK_VIDEO_TOOL = Object.freeze({
  type: "function",
  name: GROK_VIDEO_TOOL_NAME,
  description:
    "Generate a short video with Grok. The bridge runs this tool itself; Codex does not. " +
    "Provide a prompt. Provide image_url only when the clip should start from that still image.",
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

function videoPayload(args) {
  const payload = { model: VIDEO_MODEL, prompt: args.prompt };
  if (typeof args.image_url === "string" && args.image_url.trim())
    payload.image = { url: args.image_url.trim() };
  if (Number.isInteger(args.duration)) payload.duration = args.duration;
  else if (typeof args.duration === "string" && /^\d+$/.test(args.duration))
    payload.duration = Number(args.duration);
  if (typeof args.aspect_ratio === "string" && args.aspect_ratio.trim())
    payload.aspect_ratio = args.aspect_ratio.trim();
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

export async function videoToolOutput(call, options) {
  const token = options?.token;
  try {
    const args = parseArgs(call?.arguments);
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return "Video generation failed: a prompt is required.";
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
    });
    return scrub(`Video ready at ${url}`, token);
  } catch (error) {
    const status = Number(error?.status) || 0;
    if (status === 401 || status === 403)
      return `Video generation failed (${status}).`;
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
