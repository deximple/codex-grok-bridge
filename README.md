# codex-grok-bridge

Run **Grok 4.7 as the model inside Codex**. Codex still owns tools, permissions,
history and MCP. `grok-4.6` stays on the model list so existing threads still
resolve. Inference uses the installed `grok` CLI login session — not an
xAI API key.

```
Codex UI/CLI → app-server → scripts/codex-wrapper.mjs (adds grok-4.7 and grok-4.6 to the model list)
             → localhost /v1/responses (the bridge)
             → cli-chat-proxy.grok.com
             → Codex executes every tool call; results return as the next input
```

The published npm package installs on **macOS, Linux, and Windows** (`"os":
["darwin", "linux", "win32"]`) starting at 1.5.0. Official ChatGPT/Codex
prefixes stay untouched; `scripts/install-codex-grok-app.sh` and
`scripts/install-codex-grok-app.ps1` write a separate wrapper.


---
## What this is

A local bridge that puts Grok 4.7 on Codex’s model list and sends Codex
`/v1/responses` traffic to `cli-chat-proxy.grok.com`. Grok does the inference.
Codex runs every tool call (shell, patch, MCP, …) and feeds the results back as
the next request’s `input`. That is the same agent loop as the GPT path.

The bridge does **not** execute Grok-native tools. It translates Codex tools into
function calling, streams the upstream Responses events, and rewrites names back
so Codex still recognizes them.

Eighteen files under `src/`. Zero runtime dependencies. Node.js ≥ 22.

This is not a second-opinion review product and not a Grok-native search
product. The picker shows `grok-4.7` (Grok 4.7 / xAI) and keeps `grok-4.6`.
Any other `grok-*` id uses the same route. `GROK_BRIDGE_MODELS` adds further
`grok-*` ids. Codex `web_search` is xAI's server-side tool, not a function
the bridge runs. See Release history.

## Release history

What each recent version added. Older cuts are in `CHANGELOG.md`.

### 1.7.2 — 2026-09-30

- Readable compaction summaries are passed through as user messages. A compaction item that only carries encrypted or internal fields is still dropped.
- `grok_bridge_generate_video`. The bridge declares this tool and, when the model calls it, posts to `https://api.x.ai/v1/videos/generations` with the grok login bearer, polls `GET /videos/{request_id}`, and returns the video URL as the tool result. A refusal from that API stays a tool error and does not fail the turn.
- Readable text from Codex input items that used to be dropped is forwarded as user `input_text`: shell, search, tool-search, a revised image prompt, and custom tool text. Encrypted blobs and image-byte results stay dropped.
- `POST /v1/images/generations` and `POST /v1/images/edits` are forwarded to the Imagine API with the grok login bearer. Codex's `gpt-image-2` body is rewritten to `grok-imagine-image-quality` and `b64_json`. OpenAI `file_id` edits are refused. No `XAI_API_KEY`.
- Codex `web_search` is kept as one server-side `{type:"web_search"}` tool. `web_search_call` results are passed through to Codex.
- Voice WebRTC (`POST /v1/realtime/calls`) and Codex cloud tasks are not in this package.

### 1.7.1 — 2026-09-30

- The bridge holds the upstream reply and sends it to Codex only after `response.completed`. A reset before that (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, or a close before the reply finishes) is retried up to two more times, and only if Codex has not been sent a byte. This provider's Codex `request_max_retries` and `stream_max_retries` are 0. A retry sends the prompt again, so that attempt's input tokens can be billed again.
- When `grok --version` fails or does not report a version, the client version is `unknown` instead of the stale `1.0.24`.

### 1.7.0 — 2026-09-29

- One `x-grok-conv-id` per Codex thread, and the forwarded transcript prefix stays byte-stable so the prompt cache can hit. The full transcript is still sent.
- Upstream `cached_prompt_tokens` and `cache_read_input_tokens` are copied onto `response.completed` usage and the diagnostics log when the proxy sends them, including `0`. Missing counters are not invented.

### 1.6.1 — 2026-09-28

- Darwin bundled CLI resolves `Codex.app/Contents/Resources/codex-cli/bin/codex` when that file exists (Codex 26.924). The legacy `Contents/Resources/codex` path remains the fallback. `CODEX_BINARY` still wins. Linux and Windows layouts are unchanged.

### 1.6.0 — 2026-09-27

- Default catalog model is `grok-4.7` (`Grok 4.7 / xAI`). `grok-4.6` stays listed so existing threads still resolve.
- `grok-*` still routes to `grok_build_cli`. No other model ids were added. `GROK_BRIDGE_MODELS` still appends extra `grok-*` ids.

## Requirements

- macOS, Linux, or Windows 11 with the official ChatGPT/Codex desktop package
- Node.js ≥ 22
- `/Applications/Codex.app` (macOS), `/usr/lib/chatgpt/ChatGPT` (Linux), or the official ChatGPT MSIX (Windows)
- `grok` CLI at `~/.grok/bin/grok` (Windows: `%USERPROFILE%\.grok\bin\grok.exe`)
- a completed `grok login`

The `.command` launcher resolves paths from its own location, so moving the
folder does not require edits. Set `NODE=/path/to/node` if `node` is not on
`PATH`.

Verified against: Codex 0.153.4 / app 26.901.51231, Grok CLI 1.0.25, Node 22.23.0.
An app update that changes `CODEX_CLI_PATH` or the app-server protocol needs
re-verification.

## Install and run

### Terminal (npm)

```sh
npm install -g codex-grok-bridge   # macOS, Linux, or Windows; Node ≥ 22
codex-grok                         # launches Codex with Grok 4.7 available
codex-grok exec --skip-git-repo-check --sandbox workspace-write 'your task'
```

`codex-grok` registers the bridge as a model provider for the Codex process it
starts, and tears the provider down with that process.

### From a checkout

```sh
git clone https://github.com/deximple/codex-grok-bridge.git
cd codex-grok-bridge
npm test                        # 191 tests, no network, no inference
node scripts/codex-grok.mjs
```

### Desktop

Double-click **Open Codex with Grok.command** in this folder, or keep a
**separate** desktop wrapper in sync with
`scripts/install-codex-grok-app.sh` (see [Desktop install and update](#desktop-install-and-update)).
On Linux that wrapper is `~/.local/share/codex-grok-bridge/app` plus a user
`.desktop` entry; the stock `/usr/lib/chatgpt` tree is not patched. On Windows
it is `%LOCALAPPDATA%\codex-grok-bridge`; `WindowsApps` is never written.

In the new Codex window, **select Grok 4.7 / xAI before starting a new
thread**. Existing GPT models stay on the list, and so does `grok-4.6`. A Codex
window that was already open does not get this extension.

The dedicated window stores UI data under
`~/.local/share/codex-grok-bridge/desktop` and **shares** the normal Codex home
for account, threads and settings. Work and setting changes can show up in other
Codex windows.

The installer never writes the stock Codex.app bundle, `/usr/lib/chatgpt`,
their signatures, `~/.codex/config.toml`, or Grok auth files. It does not
register a launch agent or a global environment variable.

Stop by closing the Codex window this extension opened. Ordinary Codex still
launches from its usual icon.

## How it connects

1. A wrapper set as `CODEX_CLI_PATH` starts the Codex app-server.
2. The wrapper adds Grok to the model catalog and sets the provider of a new
   Grok thread to `grok_build_cli`.
3. Codex `/v1/responses` requests go to the localhost bridge.
4. The bridge flattens Codex function and custom tools into function tools,
   forwards `web_search` as xAI's server-side tool, then pipes the
   `cli-chat-proxy.grok.com` Responses stream through.
5. Tool results return as the next Codex request `input`.

Authentication is the `grok login` session. `XAI_API_KEY` is not used.

Upstream sockets use `node:http(s)` with a keep-alive `Agent` (30 s, max 4
sockets) and a 5-minute DNS cache. A failed lookup still uses a valid cached
address when one exists, so a 5–20 s tool gap does not force a fresh name
lookup every time. `GROK_BRIDGE_TRANSPORT=fetch` restores the older `fetch`
path.

The bridge holds Grok’s reply until it finishes (`response.completed`). No
byte of that reply is sent to Codex before then. If the connection drops
first — a reset (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`) or a close before
the reply finishes — the bridge sends the same request again, up to two more
times. DNS and connection failures use that same budget. This provider sets
Codex `request_max_retries` and `stream_max_retries` to 0, so Codex does not
send the prompt again as well. If any byte of the reply was already sent to
Codex, the bridge does not resubmit. A retry sends the prompt to Grok again,
so that attempt’s input tokens can be billed again. This replaces Codex
resending the prompt up to two extra times. User aborts and deterministic 422
responses are not retried. Codex still gives the stream five minutes of
silence (`stream_idle_timeout_ms`); a reply that takes longer can be cut off
before any of it is sent.

### In short

Codex keeps the conversation and sends the whole turn each time. Grok can
treat the unchanged beginning as a cache. If the connection drops before
Codex has been sent any bytes, the bridge tries again. Codex does not send
that same request again. Voice call setup (`POST /v1/realtime/calls` and
`POST /v1/live`) is forwarded raw when xAI accepts it. When xAI rejects that
offer, the bridge reads the SDP part of Codex's multipart body, answers with
its own WebRTC peer, including Opus when that is the offered codec, and
bridges the audio to the xAI voice socket. A reply shorter than one audio frame is still played when the turn ends. The answer lists only this machine's host addresses, including 127.0.0.1, as plain host candidates, so the desktop voice helper can open its event channel. The sideband for that answered call stays on the bridge. If that voice socket closes on its own, the desktop is told. xAI transcript events are rewritten into the desktop v3 sideband names. The call's session instructions and earlier messages are kept, and v3 context appends become xAI voice items. A `codex` tool call becomes the desktop handoff, and the agent's spoken reply closes that call.
Codex cloud tasks are not in this package.

If the Responses path misbehaves, `GROK_BRIDGE_INFERENCE=cli` falls back to the
older CLI envelope. That path pastes the whole JSON into a prompt each turn, so
it is slower and more expensive, has no token-by-token streaming, and is capped
at three minutes per request.

The default Responses path streams. One Codex thread keeps a single
`x-grok-conv-id`: the `thread-id` header when Codex sends it, otherwise
`prompt_cache_key`. That same id is written into `prompt_cache_key`. An
unchanged transcript prefix is resent byte-for-byte; the new items are
appended, not substituted for the history.

## What works and what does not

Measured, not guessed:

- Mixed catalog of the six GPT models plus `grok-4.6`, with Grok provider
  routing, on a real app-server.
- Live Grok CLI → Codex `exec_command` → result → Grok final reply
  (`BRIDGE_TOOL_OK`).
- A separate Codex window showing `Grok 4.6 / xAI Extra High`.
- cli-chat-proxy accepted a 339-function-tool request. The public API’s 200-tool
  cap does not apply on this login path.

### Provenance lines

Codex does not put provider or model into the prompt. The bridge appends a
`Transport:` line to `instructions` so the model can answer “is Grok attached?”
without opening config files. That line is transport provenance, in the same
category as a `User-Agent` header.

When image generation is on, an `Images:` line is appended as well: pictures on
this transport use Grok’s `image_generation` tool already on the request; do
not read Codex’s `imagegen` skill and do not send the picture to OpenAI.
`GROK_BRIDGE_IMAGE_GEN=off` drops both the tool and that line.

### Reasoning

Plain-text summaries on Codex `reasoning` items are forwarded. Encrypted
`encrypted_content` and Codex’s own item ids are stripped. This is so a
multi-call turn can continue its own reasoning. The upstream has been observed
to accept this shape. The same pass keeps only the fields Grok’s Responses
input accepts on each item and content part — `status`, unknown Codex keys,
and every `internal_*` field are dropped so a new client field cannot 422 the
upstream.

### Concurrency

Up to **4** inferences run at once per bridge; the rest wait in a queue of 8.
Only a full queue returns `429`. Waiting is better than refusing because the
bridge has already sent response headers and is holding the stream with
keepalive. Setting concurrency to 1 kills Codex `spawn_agent` child inferences
that overlap the parent turn.

### Tools

Ordinary function tools, namespaced function tools, and freeform custom tools
are translated. File edits, MCP, and similar work inside whatever Codex
exposed, at whatever approval policy the user set. Not every tool has been
live-tested individually.

### Image attachments (vision)

PNG / JPEG / WebP. **10 MiB per image, 20 MiB per request**, up to four distinct
images, PNG up to 32 megapixels. The cap is measured: the upstream answered a
12.5 MiB PNG, and the limit sits below that.

One unusable attachment no longer kills the conversation. The bridge walks the
whole history; a single over-limit image used to make every later turn fail
with 400. Now that attachment is replaced with an explanation and the rest
goes through. Usable images stay `input_image` (Grok reads them). Remote URLs
are not fetched.

### Image generation

The bridge declares `{ type: "image_generation" }` on the upstream request.
Codex does not offer an image-generation tool to this provider (263 tools, none
of them generate — `view_image` only), so without the declaration Codex’s
`imagegen` skill falls back to OpenAI (`image_gen` or `OPENAI_API_KEY` +
`gpt-image-*`): thinking on Grok, pixels on another vendor.

Returned bytes are written to
`~/.local/share/codex-grok-bridge/generated-images/` as mode `0600`. Codex
cannot host those bytes, so the bridge turns the result into an assistant
message whose path is a markdown `file://` link:

`[ /path/to/grok-….jpg ](file:///path/to/grok-….jpg)`

Whether that link is clickable depends on Codex’s markdown renderer. Codex
events it does not know (`response.image_generation_call.*`) are dropped.

Grok’s `image_generation` is text-to-image only:

| Capability | Result |
|---|---|
| Text → image | Works |
| Transparent background | **No.** Always JPEG, no alpha. The model will say “transparent” and paint a checkerboard into the picture |
| Tool parameters (`background`, `output_format`) | Accepted and **silently ignored** |
| Image edit (image-to-image) | **Not a real edit.** The input is described in text and regenerated; composition and resolution change |

The bridge inspects the saved file. If there is no alpha channel it tells the
model not to describe the picture as transparent. If you need a real alpha
channel or accurate inpainting, use Codex’s OpenAI path.

### GPT ↔ Grok switching

Supported on an idle persisted root thread. `turn/start`,
`thread/settings/update` and `turn/settings/update` cannot change
`modelProvider`; extra provider fields are ignored. The wrapper unsubscribes,
resumes the same id with an explicit model/provider, checks the returned
provider and permissions, then forwards the original request. Active threads,
ephemeral threads and child agents refuse a switch. Other subscribers can block
the reload; if they do, no inference is sent. Pick the model you want when
starting a new thread, before the first turn is saved.

### Not in this release

A voice session still depends on the xAI voice socket accepting the login, and on the desktop completing ICE with the bridge. Codex cloud tasks are not in this package.

Upstream sometimes resets the connection mid-response (three measured cases:
25 s / 27 s / 253 s, 726 KB–22 MB). The bridge holds the reply and, if that
drop happens before Codex has been sent any of it, tries the same request up
to two more times. Codex does not also resend it. A retry can bill the input
tokens for that attempt again.

## Diagnostics

Every turn is one JSONL line at
`~/.local/share/codex-grok-bridge/logs/bridge.jsonl` (directory `0700`, file
`0600`, rotated once to `.1` above 4 MiB). `GROK_BRIDGE_DIAGNOSTICS=off` disables
it.

```jsonl
{"at":"…","event":"turn_ok","mode":"proxy","elapsedMs":14118,"requestBytes":469749,"items":4,"tools":29}
{"at":"…","event":"turn_failed","kind":"dns","signature":"TypeError <- Error[EAI_AGAIN]","elapsedMs":15071,…}
```

Structural facts only: time, success/failure, error class, error-chain names
and codes, elapsed ms, request bytes, item and tool counts. **No prompt text,
tool output, upstream body, or tokens.** `detail` is redacted (bearer tokens,
JWTs, API keys, home paths) and truncated to 400 characters.

Completed turns are logged too: an empty log on failure means the bridge was
never called.

`turn_failed.kind` is one of: `aborted`, `auth`, `dns`, `connect`,
`upstream_timeout`, `upstream_closed`, `upstream_protocol`, `payload`,
`internal`. Codex UI shows the same class as `bridge_<kind>`.

Start here when something breaks. Do not open `~/.grok/auth.json` or
`~/.codex/auth.json` to “check” the bridge.

## Environment variables

| Variable | Effect |
|---|---|
| `GROK_BRIDGE_IMAGE_GEN=off` | Do not declare Grok `image_generation`; do not append the `Images:` line |
| `GROK_BRIDGE_TRANSPORT=fetch` | Use Node `fetch` instead of `node:http(s)` |
| `GROK_BRIDGE_INFERENCE=cli` | Fall back to the CLI envelope path |
| `GROK_BRIDGE_DIAGNOSTICS=off` | Do not write the JSONL log |
| `GROK_BRIDGE_MODELS` | Extra `grok-*` catalog ids (comma or space) beyond `grok-4.7` and `grok-4.6` |
| `NODE` | Absolute `node` binary for the `.command` launcher / desktop scripts |
| `CODEX_GROK_APP` | Alternate app path for the desktop installer (macOS: `/Applications/Codex Grok.app`; Linux: `~/.local/share/codex-grok-bridge/app`; Windows: `%LOCALAPPDATA%\codex-grok-bridge\app`) |

## Verify

```sh
npm test                    # 191 tests, no remote inference
npm run test:coverage       # 80% line / branch / function gate
npm run verify:app-server   # real app-server routing; also runs against an installed bundle
npm audit --omit=dev
```

`npm test` does not call remote inference. `verify:app-server` talks to a real
app-server for the model list and a temporary thread; it does not run model
inference. A live CLI check spends the user’s quota.

## Desktop install and update

```sh
sh scripts/install-codex-grok-app.sh          # sync bridge JS only (default)
sh scripts/install-codex-grok-app.sh --full   # macOS: rebuild and sign the launcher applet
powershell -File scripts/install-codex-grok-app.ps1
```

The default copies this checkout’s `src/` and `scripts/*.mjs` into the bundle,
prunes files the checkout no longer has, and `cmp`s every file at the end. It
never `rm -rf`s the live bundle. It refuses while a Codex Grok window is open
(`--force` to override). ESM is not hot-reloaded: **reopen the window** after a
sync.

On macOS the script updates an existing `Codex Grok.app`. It does not create
one, and it does not touch `/Applications/Codex.app`. On Linux it creates
`~/.local/share/codex-grok-bridge/app` and
`~/.local/share/applications/codex-grok.desktop`, and it does not write
`/usr/lib/chatgpt` or `/usr/share/applications/chatgpt.desktop`. On Windows
`scripts/install-codex-grok-app.ps1` writes
`%LOCALAPPDATA%\codex-grok-bridge` and may point at a Store `ChatGPT.exe` /
`resources\codex.exe`; it never writes `WindowsApps`.

## Security notes

The bridge binds loopback only. Each inference request needs a per-run
temporary token. Browser `Origin` requests, unsupported models, oversized
bodies, and unknown tool calls are rejected. Grok prompt temp files are `0600`
and deleted on exit. CLI error text and credentials are not returned in
responses. Codex’s and Grok’s own retention policies still apply.

## Further docs

- `docs/HANDOFF.md` — current state, pitfalls, open items
- `docs/solution-20260909.md` — how a fixed 15-second failure was traced, and
  every measurement behind the fixes
- `docs/experiments/` — scripts that reproduce those measurements

## References

- [Grok Build headless scripting](https://docs.x.ai/build/cli/headless-scripting)
- [Grok Build source](https://github.com/xai-org/grok-build)
- [Codex source](https://github.com/openai/codex)

---

# 한국어

## 이게 뭔가

Grok 4.7을 Codex 모델 목록에 넣고, Codex의 `/v1/responses`를
`cli-chat-proxy.grok.com`으로 넘기는 로컬 브리지입니다. 추론은 Grok이 합니다.
도구 호출(셸, 패치, MCP, …)은 Codex가 실행하고, 결과는 다음 요청의 `input`으로
돌아갑니다. GPT 경로와 같은 에이전트 루프입니다.

브리지는 Grok 네이티브 도구를 실행하지 않습니다. Codex 도구를 function
calling으로 옮기고, 상류 Responses 스트림을 전달한 뒤, Codex가 알아보는
이름으로 되돌립니다.

`src/` 아래 파일 18개. 런타임 의존성 없음. Node.js 22 이상. 1.5.0부터 npm
`"os"`는 `darwin` / `linux` / `win32`입니다.

코드 리뷰 전용 제품이 아니고 Grok 네이티브 검색 제품도 아닙니다. 피커에는
`grok-4.7`(Grok 4.7 / xAI)이 기본으로 보이고 `grok-4.6`도 남습니다. 그 외
`grok-*` id도 같은 경로로 붙고, `GROK_BRIDGE_MODELS`로 카탈로그에 더합니다.
Codex `web_search`는 브리지가 실행하는 함수가 아니라 xAI 서버 도구입니다.
릴리스 기록을 보세요.

## 릴리스 기록

최근 버전이 더한 것입니다. 그 이전은 `CHANGELOG.md`에 있습니다.

### 1.7.2 — 2026-09-30

- 읽을 수 있는 compaction 요약을 사용자 메시지로 넘깁니다. 암호화된 내용이나 내부 필드만 있는 compaction 항목은 그대로 버립니다.
- `grok_bridge_generate_video`. 브리지가 이 도구를 선언하고, 모델이 호출하면 grok 로그인 bearer로 `https://api.x.ai/v1/videos/generations`에 보낸 뒤 `GET /videos/{request_id}`를 폴링하고, 영상 URL을 도구 결과로 돌려줍니다. 그 API의 거절은 도구 오류로 남고 턴을 실패시키지 않습니다.
- 예전에는 버리던 Codex 입력 항목의 읽을 수 있는 글을 사용자 `input_text`로 넘깁니다. 셸, 검색, tool-search, 수정된 이미지 프롬프트, 커스텀 도구 텍스트입니다. 암호화된 blob과 이미지 바이트 결과는 그대로 버립니다.
- `POST /v1/images/generations`와 `POST /v1/images/edits`를 grok 로그인 bearer로 Imagine API에 넘깁니다. Codex의 `gpt-image-2` 본문은 `grok-imagine-image-quality`와 `b64_json`으로 바꿉니다. OpenAI `file_id` 편집은 거절합니다. `XAI_API_KEY`는 쓰지 않습니다.
- Codex `web_search`는 서버 측 `{type:"web_search"}` 도구 하나로 유지합니다. `web_search_call` 결과는 Codex로 통과합니다.
- 음성 WebRTC(`POST /v1/realtime/calls`)와 Codex 클라우드 작업은 이 패키지에 없습니다.

### 1.7.1 — 2026-09-30

- 브리지는 상류 응답을 `response.completed` 이후에만 Codex로 보냅니다. 그 전의 리셋(`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, 또는 응답이 끝나기 전의 닫힘)은 최대 두 번 더 재시도하며, Codex에 바이트를 아직 보내지 않았을 때만 합니다. 이 provider의 Codex `request_max_retries`와 `stream_max_retries`는 0입니다. 재시도는 프롬프트를 다시 보내므로 그 시도의 입력 토큰이 다시 과금될 수 있습니다.
- `grok --version`이 실패하거나 버전을 보고하지 않으면 클라이언트 버전은 오래된 `1.0.24` 대신 `unknown`입니다.

### 1.7.0 — 2026-09-29

- Codex 스레드마다 `x-grok-conv-id`는 하나이고, 전달하는 트랜스크립트 접두는 바이트 그대로라 프롬프트 캐시가 맞을 수 있습니다. 전체 트랜스크립트는 그대로 보냅니다.
- 상류가 보내면 `cached_prompt_tokens`와 `cache_read_input_tokens`를 `response.completed` usage와 진단 로그에 복사합니다. `0`도 포함합니다. 없는 카운터는 만들지 않습니다.

### 1.6.1 — 2026-09-28

- Darwin 번들 CLI는 파일이 있으면 `Codex.app/Contents/Resources/codex-cli/bin/codex`를 씁니다(Codex 26.924). 예전 `Contents/Resources/codex`는 폴백으로 남습니다. `CODEX_BINARY`가 우선합니다. Linux와 Windows 배치는 그대로입니다.

### 1.6.0 — 2026-09-27

- 기본 카탈로그 모델은 `grok-4.7`(Grok 4.7 / xAI)입니다. `grok-4.6`은 기존 스레드가 계속 맞게 목록에 남습니다.
- `grok-*`는 여전히 `grok_build_cli`로 갑니다. 다른 모델 id는 추가하지 않았습니다. `GROK_BRIDGE_MODELS`는 그 외 `grok-*` id를 카탈로그에 더합니다.

## 필요한 것

- macOS, Linux, 또는 공식 ChatGPT/Codex 데스크톱이 있는 Windows 11
- Node.js 22 이상
- `/Applications/Codex.app` (macOS), `/usr/lib/chatgpt/ChatGPT` (Linux), 또는 공식 ChatGPT MSIX (Windows)
- `~/.grok/bin/grok` (Windows: `%USERPROFILE%\.grok\bin\grok.exe`)
- 완료된 `grok login`

`.command` 런처는 자기 위치를 기준으로 경로를 잡으므로 폴더를 옮겨도 수정할
필요가 없습니다. `PATH`에 `node`가 없으면 `NODE=/path/to/node`로 지정합니다.

검증 버전: Codex 0.153.4 / 앱 26.901.51231, Grok CLI 1.0.25, Node 22.23.0.
앱 업데이트가 `CODEX_CLI_PATH`나 app-server 프로토콜을 바꾸면 재검증이
필요합니다.

## 설치와 실행

### 터미널 (npm)

```sh
npm install -g codex-grok-bridge   # macOS, Linux, Windows; Node ≥ 22
codex-grok                         # Grok 4.7이 있는 Codex를 띄움
codex-grok exec --skip-git-repo-check --sandbox workspace-write '작업 내용'
```

`codex-grok`는 자기가 띄운 Codex 프로세스에만 브리지를 모델 제공자로 등록하고,
그 프로세스와 함께 내립니다.

### 체크아웃에서

```sh
git clone https://github.com/deximple/codex-grok-bridge.git
cd codex-grok-bridge
npm test                        # 191건, 네트워크·추론 없음
node scripts/codex-grok.mjs
```

### 데스크톱

이 폴더의 **Open Codex with Grok.command**를 더블 클릭하거나,
`scripts/install-codex-grok-app.sh`로 **별도의** 데스크톱 래퍼를 체크아웃과
맞춥니다([데스크톱 설치와 갱신](#데스크톱-설치와-갱신)).
Linux에서는 `~/.local/share/codex-grok-bridge/app`과 사용자 `.desktop`이고,
정품 `/usr/lib/chatgpt`는 패치하지 않습니다. Windows에서는
`%LOCALAPPDATA%\codex-grok-bridge`이고 `WindowsApps`는 쓰지 않습니다.

새로 열린 Codex 창에서 **새 작업을 시작하기 전에 Grok 4.7 / xAI를 선택**하세요.
기존 GPT 모델과 `grok-4.6`도 목록에 남습니다. 이미 열려 있던 일반 Codex 창에는
이 확장이 주입되지 않습니다.

전용 창은 UI 데이터를 `~/.local/share/codex-grok-bridge/desktop`에 두고,
계정·작업·설정은 기존 Codex 홈을 **공유**합니다. 작업 내용과 설정 변경은 다른
Codex 창에도 보일 수 있습니다.

설치 스크립트는 정품 Codex.app 번들, `/usr/lib/chatgpt`, 코드 서명,
`~/.codex/config.toml`, Grok 인증 파일을 수정하지 않습니다. 자동 시작
서비스나 전역 환경변수도 등록하지 않습니다.

중지하려면 이 확장으로 연 Codex 창을 닫으면 됩니다. 일반 Codex는 기존 아이콘으로
실행합니다.

## 연결 방식

1. `CODEX_CLI_PATH`로 지정한 래퍼가 Codex app-server를 실행합니다.
2. 래퍼가 모델 목록에 Grok를 추가하고, 새 Grok 작업의 제공자를
   `grok_build_cli`로 설정합니다.
3. Codex의 `/v1/responses` 요청은 localhost 브리지로 갑니다.
4. 브리지는 Codex 함수·커스텀 도구를 function tool로 펼치고, `web_search`는
   xAI 서버 도구로 넘긴 뒤 `cli-chat-proxy.grok.com` Responses 스트림을 이어줍니다.
5. 도구 결과는 다음 Codex 요청의 `input`으로 돌아갑니다.

인증은 `grok login` 세션입니다. `XAI_API_KEY`는 쓰지 않습니다.

상류 소켓은 `node:http(s)` keep-alive `Agent`(30초, 최대 4개)와 TTL 5분 DNS
캐시를 씁니다. 조회가 실패해도 유효한 캐시가 있으면 그것으로 버팁니다. 도구
실행으로 5–20초가 비어도 매번 이름을 다시 찾지 않기 위해서입니다.
`GROK_BRIDGE_TRANSPORT=fetch`로 이전 `fetch` 경로로 되돌릴 수 있습니다.

브리지는 Grok의 응답이 끝날 때까지(`response.completed`) 들고 있습니다.
그 전에 Codex로 응답 바이트를 보내지 않습니다. 그 전에 연결이 끊기면 —
리셋(`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`)이거나, 응답이 끝나기 전에
닫힌 경우 — 브리지가 같은 요청을 최대 두 번 더 보냅니다. DNS·연결 실패도
같은 횟수를 씁니다. 이 provider는 Codex `request_max_retries`와
`stream_max_retries`를 0으로 두어, Codex가 그 프롬프트를 또 보내지 않게
합니다. 응답 바이트를 Codex에 이미 보냈다면 브리지는 다시 보내지 않습니다.
재시도는 프롬프트를 Grok에 다시 보내므로, 그 시도의 입력 토큰이 다시 과금될
수 있습니다. Codex가 프롬프트를 최대 두 번 더 보내던 것을 이것으로 대신합니다.
사용자 중단과 422 같은 결정적 거절은 재시도하지 않습니다. Codex는 응답
바이트 없이 5분(`stream_idle_timeout_ms`)을 기다립니다. 그보다 오래 걸리면
보내기 전에 끊길 수 있습니다.

### 쉽게 말하면

Codex가 대화를 갖고 있고, 턴마다 그 턴 전체를 보냅니다. 앞부분이 그대로면
Grok는 그 부분을 캐시로 볼 수 있습니다. Codex에 바이트를 보내기 전에 연결이
끊기면 브리지가 다시 시도합니다. Codex는 그 요청을 또 보내지 않습니다. 음성
통화 설정(`POST /v1/realtime/calls`, `POST /v1/live`)은 xAI가 수락하면 원문
그대로 넘깁니다. xAI가 그 offer를 거절하면 브리지가 Codex multipart 본문에서 SDP를 읽고
자체 WebRTC 피어로 답합니다. offer가 Opus이면 Opus로 답하고, 오디오를 xAI
음성 소켓으로 잇습니다. 한 프레임보다 짧은 답도 턴이 끝나면 재생합니다. 답변에는 이 기기의 호스트 주소만 넣고 127.0.0.1도
일반 호스트 후보로 포함해서, 데스크톱 음성 헬퍼가 이벤트 채널을 열 수 있게 합니다. 그렇게 답한 통화의 sideband는 브리지에
남습니다. 그 음성 소켓이 스스로 닫히면 데스크톱에 알립니다. xAI 전사 이벤트는 데스크톱 v3 sideband가 읽는 이름으로 바꿉니다. 통화의 세션 지시문과 이전 메시지는 유지하고, v3 문맥 추가는 xAI 음성 항목이 됩니다. `codex` 도구 호출은 데스크톱 handoff가 되고, 에이전트의 말은 그 호출을 닫습니다. Codex 클라우드 작업은 이 패키지에 없습니다.

Responses 경로가 이상하면 `GROK_BRIDGE_INFERENCE=cli`로 이전 CLI 봉투 경로를
씁니다. 매 턴 전체 JSON을 프롬프트로 넣으므로 더 느리고 비싸며, 토큰 단위
실시간 출력이 없고, 요청당 3분 제한입니다.

기본 Responses 경로는 스트림을 전달합니다. Codex 스레드마다 `x-grok-conv-id`는
하나입니다. `thread-id` 헤더가 있으면 그 값이고, 없으면 `prompt_cache_key`입니다.
같은 id를 `prompt_cache_key`에도 넣습니다. 바뀌지 않은 트랜스크립트 접두는
바이트 그대로 다시 보내고, 새 항목은 그 뒤에 붙입니다.

## 확인된 동작과 제한

추측이 아니라 실측입니다.

- 실제 app-server에서 GPT 6개 모델과 `grok-4.6`의 혼합 목록, Grok 제공자 라우팅.
- 실제 Grok CLI → Codex `exec_command` → 결과 → Grok 최종 응답
  (`BRIDGE_TOOL_OK`).
- 별도 Codex 창에 `Grok 4.6 / xAI Extra High` 표시.
- cli-chat-proxy가 function tool 339개 요청을 수락. 공개 API 문서의 200개 한도는
  이 로그인 경로에 적용되지 않음.

### 출처 한 줄

Codex는 provider·model을 프롬프트에 넣지 않습니다. 브리지는 `instructions` 끝에
`Transport:` 줄을 붙여, 모델이 설정 파일을 열지 않고도 “Grok이 붙었는가”에
답하게 합니다. 대화 내용을 판단하는 것이 아니라 전송이 자기 출처를 밝히는
것이며, `User-Agent` 헤더와 같은 범주입니다.

이미지 생성이 켜져 있으면 `Images:` 줄도 붙습니다. 이 전송의 그림은 요청에 이미
있는 Grok `image_generation` 도구로 만들고, Codex `imagegen` 스킬을 읽거나
OpenAI로 보내지 말라는 뜻입니다. `GROK_BRIDGE_IMAGE_GEN=off`면 도구와 그 줄이
같이 빠집니다.

### reasoning

Codex `reasoning` 항목의 평문 요약은 상류로 전달합니다. 암호화된
`encrypted_content`와 Codex 자체 아이템 id는 제거합니다. 여러 번 호출이 이어지는
턴에서 모델이 자기 추론을 이어받게 하기 위한 것이며, 상류가 이 형태를 수락하는
것을 확인했습니다. 같은 과정에서 아이템과 content part는 Grok Responses가
받는 필드만 남깁니다. `status`, 알 수 없는 Codex 키, `internal_*` 필드는
버려서 새 클라이언트 필드가 상류 422를 내지 않게 합니다.

### 동시성

변환기당 추론은 **동시 4건**, 나머지는 큐(기본 8)에서 대기합니다. 큐까지 가득
찼을 때만 `429`입니다. 브리지가 이미 응답 헤더를 보냈고 keepalive로 스트림을
살려 두기 때문에 대기가 거절보다 낫습니다. 동시 1로 조이면 Codex `spawn_agent`
자식 추론이 부모 턴과 겹쳐 죽습니다.

### 도구

일반 함수 도구, namespace 함수 도구, freeform 커스텀 도구를 변환합니다. 파일
변경·MCP 등은 Codex가 노출한 도구와 사용자가 정한 승인 정책 안에서 동작합니다.
개별 기능을 모두 실검증한 것은 아닙니다.

### 이미지 첨부 (인식)

PNG / JPEG / WebP. **이미지당 10 MiB, 요청 전체 20 MiB**, 서로 다른 이미지
4장까지, PNG는 32메가픽셀까지. 한도는 실측입니다 — 상류가 12.5 MiB PNG를 받아
답하는 것을 확인하고 그 아래로 잡았습니다.

쓸 수 없는 첨부 하나가 대화를 죽이지 않습니다. 브리지는 대화 전체를 훑기
때문에, 예전에는 한도를 넘는 이미지가 히스토리에 한 번 들어가면 이후 모든 턴이
영구히 400이었습니다. 지금은 그 첨부만 이유를 밝힌 텍스트로 바꾸고 나머지는
그대로 보냅니다. 쓸 수 있는 이미지는 `input_image` 그대로 넘어가며 Grok가 직접
읽습니다. 원격 URL은 가져오지 않습니다.

### 이미지 생성

브리지가 상류 요청에 `{ type: "image_generation" }`을 직접 선언합니다. Codex는
이 프로바이더에 이미지 생성 도구를 주지 않습니다(263개 중 없음, `view_image`
뿐). 선언이 없으면 Codex `imagegen` 스킬이 OpenAI 경로(`image_gen` 또는
`OPENAI_API_KEY` + `gpt-image-*`)로 가서, 추론은 Grok인데 그림만 다른 벤더가
그립니다.

돌아온 바이트는 `~/.local/share/codex-grok-bridge/generated-images/`에 `0600`으로
저장합니다. Codex는 그 바이트를 둘 곳이 없어서, 브리지는 경로를 마크다운
`file://` 링크로 넣은 assistant 메시지로 바꿉니다.

`[ /path/to/grok-….jpg ](file:///path/to/grok-….jpg)`

클릭 여부는 Codex 마크다운 렌더러에 달립니다. Codex가 모르는
`response.image_generation_call.*` 이벤트는 걸러냅니다.

Grok의 `image_generation`은 텍스트→이미지만 제대로 됩니다.

| 기능 | 결과 |
|---|---|
| 텍스트→이미지 | 됨 |
| 투명 배경 | **안 됨.** 항상 JPEG, 알파 없음. 모델은 “투명”이라고 말하면서 체커보드를 그림에 칠함 |
| 도구 파라미터(`background`, `output_format`) | 받아 주고 **조용히 무시** |
| 이미지 편집(image-to-image) | **진짜 편집이 아님.** 입력을 텍스트로 묘사해 재생성하므로 구도·해상도가 바뀜 |

브리지는 저장한 파일의 포맷을 확인합니다. 알파가 없으면 모델에게 투명하다고
설명하지 말라고 적습니다. 진짜 알파나 정확한 인페인팅이 필요하면 Codex의
OpenAI 경로가 맞습니다.

### GPT ↔ Grok 전환

대기 중인 저장된 루트 작업에서만 됩니다. `turn/start`,
`thread/settings/update`, `turn/settings/update`는 `modelProvider`를 바꾸지
못하고, 추가 provider 필드는 무시됩니다. 래퍼가 구독 해제 → 같은 ID로
모델/제공자를 지정해 재개 → 돌아온 제공자·권한을 확인한 뒤 원래 요청을
전달합니다. 실행 중인 작업, 임시 작업, 하위 에이전트는 전환을 거부합니다. 다른
구독자가 재로드를 막으면 추론을 보내지 않습니다. 첫 턴이 저장되기 전에 새
작업을 시작할 때 원하는 모델을 고르세요.

### 이번 릴리스에 없는 것

음성 세션은 xAI 음성 소켓이 로그인을 수락하는지, 그리고 데스크톱이 브리지와 ICE를 끝내는지를 따릅니다. Codex 클라우드 작업은 이 패키지에 없습니다.

상류가 응답 중간에 연결을 리셋하는 경우가 있습니다(실측 3건: 25초 / 27초 /
253초, 726 KB–22 MB). 브리지는 응답을 들고 있다가, Codex에 그 응답을 보내기
전에 끊기면 같은 요청을 최대 두 번 더 시도합니다. Codex가 또 보내지는
않습니다. 재시도하면 그 시도의 입력 토큰이 다시 과금될 수 있습니다.

## 진단 로그

매 턴을 `~/.local/share/codex-grok-bridge/logs/bridge.jsonl`에 한 줄씩 기록합니다
(디렉터리 `0700`, 파일 `0600`, 4 MiB 초과 시 `.1`로 1회 회전).
`GROK_BRIDGE_DIAGNOSTICS=off`로 끕니다.

```jsonl
{"at":"…","event":"turn_ok","mode":"proxy","elapsedMs":14118,"requestBytes":469749,"items":4,"tools":29}
{"at":"…","event":"turn_failed","kind":"dns","signature":"TypeError <- Error[EAI_AGAIN]","elapsedMs":15071,…}
```

구조적 사실만 남깁니다 — 시각, 성공/실패, 오류 분류, 오류 체인의 이름·코드,
경과 시간, 요청 바이트, 아이템·도구 개수. **프롬프트 본문, 도구 출력, 상류 응답
본문, 토큰은 기록하지 않습니다.** `detail`은 Bearer 토큰·JWT·API 키·홈 경로를
지운 뒤 400자로 자릅니다.

성공 턴도 남깁니다. 실패했는데 로그가 비어 있으면 브리지가 호출되지 않은
것입니다.

`turn_failed.kind`는 다음 중 하나입니다 — `aborted`, `auth`, `dns`, `connect`,
`upstream_timeout`, `upstream_closed`, `upstream_protocol`, `payload`,
`internal`. Codex UI에는 같은 분류가 `bridge_<kind>`로 보입니다.

문제가 있으면 여기부터 봅니다. 브리지를 “확인”하려고 `~/.grok/auth.json`이나
`~/.codex/auth.json`을 열지 마세요.

## 환경 변수

| 변수 | 효과 |
|---|---|
| `GROK_BRIDGE_IMAGE_GEN=off` | Grok `image_generation`을 선언하지 않고 `Images:` 줄도 붙이지 않음 |
| `GROK_BRIDGE_TRANSPORT=fetch` | `node:http(s)` 대신 Node `fetch` |
| `GROK_BRIDGE_INFERENCE=cli` | CLI 봉투 경로로 폴백 |
| `GROK_BRIDGE_DIAGNOSTICS=off` | JSONL 로그를 쓰지 않음 |
| `GROK_BRIDGE_MODELS` | `grok-4.7`과 `grok-4.6` 외에 카탈로그에 더할 `grok-*` id (쉼표/공백) |
| `NODE` | `.command` / 데스크톱 스크립트가 쓸 `node` 절대 경로 |
| `CODEX_GROK_APP` | 데스크톱 설치기가 쓸 앱 경로 (macOS: `/Applications/Codex Grok.app`; Linux: `~/.local/share/codex-grok-bridge/app`; Windows: `%LOCALAPPDATA%\codex-grok-bridge\app`) |

## 검증

```sh
npm test                    # 191건, 외부 추론 없음
npm run test:coverage       # line/branch/function 80% 게이트
npm run verify:app-server   # 실제 app-server 라우팅. 설치된 앱 번들에서도 실행
npm audit --omit=dev
```

`npm test`는 외부 추론을 호출하지 않습니다. `verify:app-server`는 실제
app-server에 모델 목록과 임시 작업을 요청하며, 모델 추론은 하지 않습니다. 실제
CLI 검증은 사용자 계정 사용량을 씁니다.

## 데스크톱 설치와 갱신

```sh
sh scripts/install-codex-grok-app.sh          # 브리지 JS만 동기화 (기본)
sh scripts/install-codex-grok-app.sh --full   # macOS: 런처 applet 재빌드 + 서명
powershell -File scripts/install-codex-grok-app.ps1
```

기본 동작은 이 체크아웃의 `src/`와 `scripts/*.mjs`를 번들에 복사하고, 저장소에
없는 파일만 고른 뒤, 끝에서 모든 파일을 `cmp`합니다. 살아있는 번들을
`rm -rf`하지 않습니다. Codex Grok 창이 열려 있으면 거부합니다(`--force`로
무시). ESM은 핫리로드되지 않으므로 **동기화 후 창을 다시 열어야** 합니다.

macOS에서는 이미 있는 `Codex Grok.app`을 갱신하며 `/Applications/Codex.app`은
건드리지 않습니다. Linux에서는 `~/.local/share/codex-grok-bridge/app`과
`~/.local/share/applications/codex-grok.desktop`을 만들고 `/usr/lib/chatgpt`와
정품 `chatgpt.desktop`은 쓰지 않습니다. Windows에서는
`scripts/install-codex-grok-app.ps1`이 `%LOCALAPPDATA%\codex-grok-bridge`를
쓰고 Store `ChatGPT.exe` / `resources\codex.exe`를 가리킬 수 있으며,
`WindowsApps`는 쓰지 않습니다.

## 보안

브리지는 loopback에만 붙습니다. 추론 요청마다 실행 단위 임시 토큰이 필요합니다.
브라우저 `Origin` 요청, 지원하지 않는 모델, 과대 본문, 알 수 없는 도구 호출은
거절합니다. Grok 프롬프트 임시 파일은 `0600`으로 만들고 종료 후 지웁니다. CLI
오류 원문과 인증 정보는 응답에 넣지 않습니다. Codex와 Grok 자체의 보관 정책은
그대로입니다.

## 더 깊은 문서

- `docs/HANDOFF.md` — 현재 상태, 함정, 남은 항목
- `docs/solution-20260909.md` — 15초 고정 실패를 추적한 기록과 측정
- `docs/experiments/` — 그 측정을 재현하는 스크립트

## 참고

- [Grok Build headless scripting](https://docs.x.ai/build/cli/headless-scripting)
- [Grok Build source](https://github.com/xai-org/grok-build)
- [Codex source](https://github.com/openai/codex)
