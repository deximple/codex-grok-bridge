# Changelog

## 1.8.3 — 2026-10-06

- Tracked Grok CLI is 1.0.46 (https://x.ai/build/changelog). No bridge change.

## 1.8.2 — 2026-10-06

- Tracked Codex CLI is 0.160.1 (https://github.com/openai/codex/releases/tag/rust-v0.160.1). No protocol change.

## 1.8.1 — 2026-10-03

- Grok reasoning ciphertext is removed from the stream back to Codex, so a later switch to an OpenAI model does not try to decrypt a Grok reasoning blob. This was already on main after 1.8.0 and was not in the 1.8.0 npm tarball.
- The Linux and Windows installers install `opusscript@0.1.1` and `werift@0.24.4` into the bridge directory.
- App-server startup survives a missing voice package. `opusscript` and `werift` load with dynamic import, so a missing module does not exit before Codex reads organization settings.
- Local JSON Schema `$ref` values (`#/$defs` and `#/definitions`) are inlined before tool parameters are sent to Grok.

## 1.8.0 — 2026-10-02

- When xAI rejects a Codex voice offer on `POST /v1/realtime/calls` or `POST /v1/live`, the bridge reads the SDP part of the multipart body, whether the parts use CRLF or LF, and answers locally with werift. Opus is used when that is the offered codec. Audio is bridged to the xAI voice socket. The sideband for that answered call stays on the bridge. An offer the local peer cannot answer stays the upstream response. An offer xAI accepts is still forwarded. Codex cloud tasks are not in this package.
- Runtime dependencies are `werift` 0.24.4 and `opusscript` 0.1.1. There is still no `XAI_API_KEY`.
- Codex image `size` is sent to Imagine as `aspect_ratio` (`1024x1024` → `1:1`, `1536x1024` → `3:2`, `1024x1536` → `2:3`) for new pictures and edits. `quality: high` is `2k`, `low` is `1k`, and `auto` omits resolution. `n` is capped at 10. A local file path on an image edit is refused.
- A generated image is saved once. The completed response carries that file note instead of the raw image bytes.
- `grok_bridge_generate_video` accepts `480p`, `720p`, or `1080p`. A bad duration, aspect ratio, resolution, or local image path is rejected without calling the API. The finished clip is downloaded, without the login bearer, into `~/.local/share/codex-grok-bridge/generated-videos/`. The tool result names the temporary URL and the saved file. A moderation withhold is a tool message, not a failed turn. If the download fails, the result is still the URL.
- A custom tool call that comes back under its Codex name is restored when that name belongs to one tool, including streamed argument events and the completed response output. A custom tool result is restored even when it only has a call id.
- A function result that arrives as a list of content parts is forwarded as text. A remote image URL in that list is included. An inline PNG, JPEG, or WebP is attached after the tool result so the model can see it.
- A previous web search keeps its query and the pages it found.
- Command stdout, stderr, or an aggregated log stays in the forwarded history, with a non-zero exit code.
- A chat audio attachment is replaced with an explanation so its bytes do not reject the turn.
- When a reasoning summary is empty, plain text in the reasoning content is forwarded. Encrypted reasoning stays dropped.

## 1.7.2 — 2026-09-30

- Readable compaction summaries are passed through as user messages. A compaction item that only carries encrypted or internal fields is still dropped.
- A Grok thread can generate a video without an API key. The bridge declares `grok_bridge_generate_video` on the upstream request and, when the model calls it, posts to `https://api.x.ai/v1/videos/generations` with the grok login bearer, polls `GET /videos/{request_id}`, and returns the video URL to the model as the tool result. A refusal from that API stays a tool error and does not fail the turn.
- Codex input items Grok does not accept (`local_shell_call`, `web_search_call`, `tool_search_call`, `tool_search_output`, `additional_tools`, `image_generation_call`, and unmapped custom tool items) keep their readable text as user `input_text` messages, the same shape as a compaction summary. That text includes shell commands, search queries, tool-search text, an image `revised_prompt`, and custom tool text. `encrypted_content`, `encrypted_function_args`, `internal_*` fields, and image-byte `result` values stay dropped.
- `POST /v1/images/generations` and `POST /v1/images/edits` are forwarded to the Imagine API with the grok login bearer. Codex's `gpt-image-2` body is rewritten to `grok-imagine-image-quality` and `b64_json`. OpenAI `file_id` edits are refused. No `XAI_API_KEY`.
- Codex `web_search` is kept as one server-side `{type:"web_search"}` tool. `web_search_call` results are passed through to Codex.
- Voice WebRTC (`POST /v1/realtime/calls`) and Codex cloud tasks are not in this package.

## 1.7.1 — 2026-09-30

- The bridge holds the upstream reply and sends it to Codex only after `response.completed`. A reset before that (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, or a close before the reply finishes) is retried up to two more times, and only if Codex has not been sent a byte. This provider's Codex `request_max_retries` and `stream_max_retries` are 0. A retry sends the prompt again, so that attempt's input tokens can be billed again.
- When `grok --version` fails or does not report a version, the client version is `unknown` instead of the stale `1.0.24`.

## 1.7.0 — 2026-09-29

- One `x-grok-conv-id` per Codex thread, and the forwarded transcript prefix stays byte-stable so prompt cache can hit. The full transcript is still sent.
- Upstream `cached_prompt_tokens` and `cache_read_input_tokens` are copied onto `response.completed` usage and the diagnostics log when the proxy sends them, including `0`. Missing counters are not invented.

## 1.6.1 — 2026-09-28

- Darwin bundled CLI resolves `Codex.app/Contents/Resources/codex-cli/bin/codex` when that file exists (Codex 26.924). The legacy `Contents/Resources/codex` path remains the fallback. `CODEX_BINARY` still wins. Linux and Windows layouts are unchanged.

## 1.6.0 — 2026-09-27

- Default catalog model is `grok-4.7` (`Grok 4.7 / xAI`). `grok-4.6` stays listed so existing threads still resolve.
- `grok-*` still routes to `grok_build_cli`. No other model ids were added. `GROK_BRIDGE_MODELS` still appends extra `grok-*` ids.

## 1.5.0 — 2026-09-12

First cut that accepts **Windows** (`"os": ["darwin", "linux", "win32"]`).

- Isolated win32 wrapper under `%LOCALAPPDATA%\codex-grok-bridge`. Never writes WindowsApps.
- Launch reads a Store ChatGPT / `resources/codex.exe` pointer when the isolated copies are missing.
- Grok 4.7 drop prep: any `grok-*` id uses the Grok provider. Extra catalog slugs via `GROK_BRIDGE_MODELS`.
- UTM Windows 11 ARM64 guest: Node 22.23.2, `node --test` 157/0/3 on 1.5.0, official ChatGPT ARM64 MSIX `OpenAI.Codex_26.903.8094.0`, bundled CLI `codex-cli 0.153.4`, grok 1.0.25, loopback `/v1/models` 200. See `docs/windows-arm64-guest.md`.

Install: `npm install -g codex-grok-bridge@1.5.0`

## 1.0.5 — 2026-09-12

First npm cut that accepts **Linux** (`"os": ["darwin", "linux"]`). Windows stays rejected.

- Input field allowlist for Grok Responses (`#10`) — drops `internal_*` and other fields Grok rejects.
- Collapse `anyOf` / `oneOf` tool-parameter roots to a plain object (`#12`) — unblocks Linux GUI `invalid_client_tool_schema` 400s.
- Linux desktop wrapper (`#11`) — `~/.local/share/codex-grok-bridge/app` plus a user `.desktop` file. Does not patch `/usr/lib/chatgpt`.
- Docs: test gate **150/150**, coverage 97.30 / 87.70 / 90.57, Grok CLI verified **1.0.25**.

Install: `npm install -g codex-grok-bridge@1.0.5`

## 1.0.4 — 2026-09-09

English and Korean README aligned. macOS-only npm package.

## 1.0.3 — 2026-09-09

See GitHub release `v1.0.3`.

## 1.0.2 — 2026-09-09

See GitHub release `v1.0.2`.

## 1.0.1 — 2026-09-09

See GitHub release `v1.0.1`.

## 1.0.0 — 2026-09-09

Initial publish. macOS only.
