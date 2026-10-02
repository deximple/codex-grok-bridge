// Codex posts the WebRTC SDP offer to the provider base
// (`POST /v1/realtime/calls`, and v3 `POST /v1/live`). The body is raw bytes
// (Content-Type application/sdp, or whatever Codex sent). xAI answers with
// the SDP body, its status, and a Location header. This is a byte pipe:
// nothing here parses JSON or writes an SDP answer.

export const DEFAULT_REALTIME_API_BASE = "https://api.x.ai/v1";

export async function forwardRealtime(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_REALTIME_API_BASE).replace(/\/$/, "");
  const headers = { authorization: `Bearer ${options.token}` };
  if (typeof options.contentType === "string") headers["content-type"] = options.contentType;
  const response = await fetchImpl(`${base}${options.path}${options.search ?? ""}`, {
    method: "POST",
    headers,
    body: options.body,
    redirect: "manual",
    signal: options.signal,
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    body,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
  };
}
