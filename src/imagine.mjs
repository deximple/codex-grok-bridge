// Codex posts OpenAI Images requests on the provider base
// (`POST /v1/images/generations`, `POST /v1/images/edits`). grok-build sends
// the same two paths to the Imagine API with the login bearer, not an
// XAI_API_KEY. The bodies are not the same: Codex hardcodes `gpt-image-2`
// plus `size` / `quality` / `background`, and edits use `{image_url}` or
// `{file_id}`. Imagine wants `grok-imagine-image-quality`, `response_format:
// b64_json`, and `{url}` references. Codex `size` maps to `aspect_ratio`.
// Codex `quality: high` maps to resolution `2k`, and `low` to `1k`.
// `auto` omits resolution so Imagine keeps its own default. `quality` itself
// is not sent: that field belongs to a different Imagine model.

export const DEFAULT_IMAGINE_API_BASE = "https://api.x.ai/v1";
export const IMAGINE_MODEL = "grok-imagine-image-quality";

const IMAGINE_TIMEOUT_MS = 300_000;

function promptOf(input) {
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    const error = new Error("Image generation requires a prompt.");
    error.status = 400;
    throw error;
  }
  return prompt;
}

function basePayload(prompt) {
  return {
    model: IMAGINE_MODEL,
    prompt,
    n: 1,
    response_format: "b64_json",
  };
}

const SIZE_ASPECT = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
};

function aspectFromSize(size) {
  if (typeof size !== "string") return "";
  return SIZE_ASPECT[size.trim()] ?? "";
}

function imageCount(value) {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, 10);
}

function applyImageOptions(payload, input) {
  const aspect = aspectFromSize(input?.size);
  if (aspect) payload.aspect_ratio = aspect;
  if (input?.quality === "high") payload.resolution = "2k";
  else if (input?.quality === "low") payload.resolution = "1k";
  else delete payload.resolution;
  payload.n = imageCount(input?.n);
  return payload;
}

export function imagineGenerationBody(input) {
  return applyImageOptions(basePayload(promptOf(input)), input);
}

export function imagineEditBody(input) {
  const prompt = promptOf(input);
  const images = Array.isArray(input?.images) ? input.images : [];
  const urls = [];
  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    if (typeof image.image_url === "string" && image.image_url.trim()) {
      const url = image.image_url.trim();
      if (!/^https?:\/\//i.test(url) && !/^data:/i.test(url)) {
        const error = new Error("Image edit requires an http(s) URL or a data URL.");
        error.status = 400;
        throw error;
      }
      urls.push(url);
      continue;
    }
    if (typeof image.file_id === "string" && image.file_id.trim()) {
      const error = new Error("OpenAI file ids cannot be edited with Grok.");
      error.status = 400;
      throw error;
    }
  }
  if (!urls.length) {
    const error = new Error("Image edit requires a reference image.");
    error.status = 400;
    throw error;
  }
  const payload = basePayload(prompt);
  if (urls.length === 1) payload.image = { url: urls[0] };
  else payload.images = urls.map((url) => ({ url }));
  applyImageOptions(payload, input);
  if (!payload.aspect_ratio && urls.length > 1) payload.aspect_ratio = "auto";
  return payload;
}

export function codexImageResponse(payload) {
  const data = [];
  if (Array.isArray(payload?.data)) {
    for (const item of payload.data) {
      if (item && typeof item.b64_json === "string" && item.b64_json.length)
        data.push({ b64_json: item.b64_json });
    }
  }
  if (!data.length) {
    const error = new Error("Image generation returned no image.");
    error.status = 502;
    throw error;
  }
  const created = Number.isInteger(payload?.created)
    ? payload.created
    : Math.floor(Date.now() / 1000);
  return { created, data };
}

function scrub(text, token) {
  let out = String(text ?? "");
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  if (token) out = out.split(token).join("[redacted]");
  return out;
}

async function imagineHttp(fetchImpl, url, init) {
  const response = await fetchImpl(url, { ...init, redirect: "manual" });
  const text = await response.text().catch(() => "");
  if (response.status >= 300 && response.status < 400) {
    const error = new Error("Image generation failed (redirect).");
    error.status = 502;
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

export async function forwardImagine(options) {
  const token = options.token;
  const kind = options.kind === "edits" ? "edits" : "generations";
  const payload =
    kind === "edits" ? imagineEditBody(options.body) : imagineGenerationBody(options.body);
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_IMAGINE_API_BASE).replace(/\/$/, "");
  const timeout = AbortSignal.timeout(IMAGINE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let result;
  try {
    result = await imagineHttp(fetchImpl, `${base}/images/${kind}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (error?.status) throw error;
    const wrapped = new Error(scrub(error?.message || "Image generation failed.", token));
    wrapped.status = 502;
    throw wrapped;
  }
  if (result.status === 401 || result.status === 403) {
    const error = new Error("Grok login expired. Run grok login.");
    error.status = 401;
    throw error;
  }
  if (result.status < 200 || result.status >= 300) {
    const error = new Error(`Image generation failed (${result.status}).`);
    error.status = result.status >= 400 && result.status < 500 ? result.status : 502;
    throw error;
  }
  return codexImageResponse(result.body);
}
