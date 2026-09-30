# Changelog

## Unreleased

- A Grok thread can generate a video without an API key. The bridge declares `grok_bridge_generate_video` on the upstream request and, when the model calls it, posts to `https://api.x.ai/v1/videos/generations` with the grok login bearer, polls `GET /videos/{request_id}`, and returns the video URL to the model as the tool result. A refusal from that API stays a tool error and does not fail the turn.
- Codex voice uses that same grok login bearer. The app-server still owns `thread/realtime` and dials this provider at `/v1/realtime`. The bridge relays that websocket to `wss://api.x.ai/v1/realtime`. A missing or rejected login fails the socket and does not invent audio.

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
