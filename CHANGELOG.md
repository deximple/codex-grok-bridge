# Changelog

## Unreleased

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
