# Changelog

## Unreleased

Windows wrapper paths (`%LOCALAPPDATA%\codex-grok-bridge`), `grok.exe`, and `install-codex-grok-app.ps1`. `"os"` stays `darwin`+`linux` until ARM64 VM proof.

Grok 4.7 drop prep: any `grok-*` id routes through the same provider. Extra catalog slugs come from `GROK_BRIDGE_MODELS` (for example `grok-4.7`) without a rewrite. Default catalog remains `grok-4.6`.

Windows ARM64 test portability: skip Linux-only installer tests, accept native path separators and ACL modes, and keep stock-prefix refusal working when `path.resolve` is win32.

UTM Windows 11 ARM64 guest proof (`docs/windows-arm64-guest.md`): Node 22.23.2, `node --test` 156/0/3, isolated installer, loopback `/v1/models` 200.

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
