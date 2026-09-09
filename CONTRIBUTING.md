# Contributing

## Ground rules

This bridge exists to let **Codex stay the harness** while Grok supplies
inference. Changes that move tool execution, permissions, history or MCP out of
Codex are out of scope, as is anything that makes `XAI_API_KEY` the primary
credential — authentication is the `grok login` session.

## Before you open a PR

```sh
npm test                    # no network, no inference
npm run test:coverage       # 80% line / branch / function gate
npm run verify:app-server    # real Codex app-server routing, still no inference
```

A change to transport behaviour needs a test that fails before it and passes
after. `docs/experiments/` holds the scripts that produced the measurements in
`docs/solution-20260909.md`, plus live probes (`replay-*`, `verify-vision.mjs`).
Those consume real Grok quota; the rest are free. They are not part of the
published package — `package.json` `files` is an explicit whitelist.

## House style

- Immutable data: return new objects rather than mutating arguments.
- Small, focused modules — 200–400 lines is typical, 800 is the ceiling.
- Handle errors explicitly and classify them; never widen the generic bucket.
- No runtime dependencies. The package ships with an empty dependency tree on
  purpose, so the bundle can be copied into an app without `node_modules`.
- Do not put `*.test.mjs` files or a `test/` directory anywhere under `docs/` —
  `node --test` picks them up and they end up in `npm test`.

## Reporting a problem

Include the relevant lines from `~/.local/share/codex-grok-bridge/logs/bridge.jsonl`.
They carry structural facts only — no prompt text, no tool output, no tokens —
so they are safe to paste. `kind` and `signature` are usually enough to identify
the failure.
