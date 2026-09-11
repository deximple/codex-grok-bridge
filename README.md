# codex-grok-bridge

Run **Grok 4.6 as the model inside Codex**. Codex still owns tools, permissions,
history and MCP. Inference uses the installed `grok` CLI login session — not an
xAI API key.

```
Codex UI/CLI → app-server → scripts/codex-wrapper.mjs (adds grok-4.6 to the model list)
             → localhost /v1/responses (the bridge)
             → cli-chat-proxy.grok.com
             → Codex executes every tool call; results return as the next input
```

The published npm package installs on **macOS and Linux** (`"os": ["darwin",
"linux"]`). Windows installs are rejected by npm. The official ChatGPT/Codex
`.deb` stays untouched; `scripts/install-codex-grok-app.sh` writes a separate
wrapper.


---
## What this is

A local bridge that puts Grok 4.6 on Codex’s model list and sends Codex
`/v1/responses` traffic to `cli-chat-proxy.grok.com`. Grok does the inference.
Codex runs every tool call (shell, patch, MCP, …) and feeds the results back as
the next request’s `input`. That is the same agent loop as the GPT path.

The bridge does **not** execute Grok-native tools. It translates Codex tools into
function calling, streams the upstream Responses events, and rewrites names back
so Codex still recognizes them.

Fourteen files under `src/`. Zero runtime dependencies. Node.js ≥ 22.

This is not a second-opinion review product and not a Grok-native search
product. New Grok ids, including 4.7 when the CLI lists them, use the same
`grok-*` route. Set `GROK_BRIDGE_MODELS=grok-4.7` to show extras in the catalog
before they are the default. If Codex exposes a web-search tool, Grok can call
that tool the same way it calls any other Codex tool.

## Requirements

- macOS, or Linux with the official ChatGPT/Codex desktop package
- Node.js ≥ 22
- `/Applications/Codex.app` (macOS) or `/usr/lib/chatgpt/ChatGPT` (Linux)
- `grok` CLI at `~/.grok/bin/grok`
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
npm install -g codex-grok-bridge   # macOS or Linux, Node ≥ 22
codex-grok                         # launches Codex with Grok 4.6 available
codex-grok exec --skip-git-repo-check --sandbox workspace-write 'your task'
```

`codex-grok` registers the bridge as a model provider for the Codex process it
starts, and tears the provider down with that process.

### From a checkout

```sh
git clone https://github.com/deximple/codex-grok-bridge.git
cd codex-grok-bridge
npm test                        # 159 tests, no network, no inference
node scripts/codex-grok.mjs
```

### Desktop

Double-click **Open Codex with Grok.command** in this folder, or keep a
**separate** desktop wrapper in sync with
`scripts/install-codex-grok-app.sh` (see [Desktop install and update](#desktop-install-and-update)).
On Linux that wrapper is `~/.local/share/codex-grok-bridge/app` plus a user
`.desktop` entry; the stock `/usr/lib/chatgpt` tree is not patched.

In the new Codex window, **select Grok 4.6 / xAI before starting a new
thread**. Existing GPT models stay on the list. A Codex window that was already
open does not get this extension.

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
4. The bridge flattens Codex tools (plain functions, namespaced functions,
   freeform custom tools, `web_search`) into function tools, then pipes the
   `cli-chat-proxy.grok.com` Responses stream through.
5. Tool results return as the next Codex request `input`.

Authentication is the `grok login` session. `XAI_API_KEY` is not used.

Upstream sockets use `node:http(s)` with a keep-alive `Agent` (30 s, max 4
sockets) and a 5-minute DNS cache. A failed lookup still uses a valid cached
address when one exists, so a 5–20 s tool gap does not force a fresh name
lookup every time. `GROK_BRIDGE_TRANSPORT=fetch` restores the older `fetch`
path.

A request that dies **before** the first SSE block is written to Codex is
retried once. After the first block, the bridge never retries — Codex already
saw bytes, so a replay would duplicate them. Deterministic refusals (422) and
user aborts are not retried either.

If the Responses path misbehaves, `GROK_BRIDGE_INFERENCE=cli` falls back to the
older CLI envelope. That path pastes the whole JSON into a prompt each turn, so
it is slower and more expensive, has no token-by-token streaming, and is capped
at three minutes per request.

The default Responses path streams. Codex `prompt_cache_key` is forwarded as
`x-grok-conv-id`.

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

### Not guaranteed

Voice, cloud tasks, and video generation are not promised.

Upstream sometimes resets the connection mid-response (three measured cases:
25 s / 27 s / 253 s, 726 KB–22 MB). The bridge cannot retry after the first
SSE byte. The provider sets Codex `request_max_retries` / `stream_max_retries`
to 2 so **Codex** can resend the same request. Only the side that owns the
conversation can retry safely.

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
| `GROK_BRIDGE_MODELS` | Extra `grok-*` catalog ids (comma or space), e.g. `grok-4.7` |
| `NODE` | Absolute `node` binary for the `.command` launcher / desktop scripts |
| `CODEX_GROK_APP` | Alternate app path for `install-codex-grok-app.sh` (macOS: `/Applications/Codex Grok.app`; Linux: `~/.local/share/codex-grok-bridge/app`) |

## Verify

```sh
npm test                    # 159 tests, no remote inference
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
`/usr/lib/chatgpt` or `/usr/share/applications/chatgpt.desktop`.

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

Grok 4.6을 Codex 모델 목록에 넣고, Codex의 `/v1/responses`를
`cli-chat-proxy.grok.com`으로 넘기는 로컬 브리지입니다. 추론은 Grok이 합니다.
도구 호출(셸, 패치, MCP, …)은 Codex가 실행하고, 결과는 다음 요청의 `input`으로
돌아갑니다. GPT 경로와 같은 에이전트 루프입니다.

브리지는 Grok 네이티브 도구를 실행하지 않습니다. Codex 도구를 function
calling으로 옮기고, 상류 Responses 스트림을 전달한 뒤, Codex가 알아보는
이름으로 되돌립니다.

`src/` 아래 파일 14개. 런타임 의존성 없음. Node.js 22 이상.

코드 리뷰 전용 제품이 아니고 Grok 네이티브 검색 제품도 아닙니다. CLI가 새
id(4.7 포함)를 내놓으면 같은 `grok-*` 경로로 붙습니다. 기본 카탈로그에 먼저
보이게 하려면 `GROK_BRIDGE_MODELS=grok-4.7`을 씁니다. Codex가 웹 검색 도구를
노출하면 Grok은 다른 Codex 도구와 같이 그 도구를 호출할 수 있습니다.

## 필요한 것

- macOS, 또는 공식 ChatGPT/Codex 데스크톱 패키지가 있는 Linux
- Node.js 22 이상
- `/Applications/Codex.app` (macOS) 또는 `/usr/lib/chatgpt/ChatGPT` (Linux)
- `~/.grok/bin/grok`
- 완료된 `grok login`

`.command` 런처는 자기 위치를 기준으로 경로를 잡으므로 폴더를 옮겨도 수정할
필요가 없습니다. `PATH`에 `node`가 없으면 `NODE=/path/to/node`로 지정합니다.

검증 버전: Codex 0.153.4 / 앱 26.901.51231, Grok CLI 1.0.25, Node 22.23.0.
앱 업데이트가 `CODEX_CLI_PATH`나 app-server 프로토콜을 바꾸면 재검증이
필요합니다.

## 설치와 실행

### 터미널 (npm)

```sh
npm install -g codex-grok-bridge   # macOS or Linux, Node ≥ 22
codex-grok                         # Grok 4.6이 있는 Codex를 띄움
codex-grok exec --skip-git-repo-check --sandbox workspace-write '작업 내용'
```

`codex-grok`는 자기가 띄운 Codex 프로세스에만 브리지를 모델 제공자로 등록하고,
그 프로세스와 함께 내립니다.

### 체크아웃에서

```sh
git clone https://github.com/deximple/codex-grok-bridge.git
cd codex-grok-bridge
npm test                        # 159건, 네트워크·추론 없음
node scripts/codex-grok.mjs
```

### 데스크톱

이 폴더의 **Open Codex with Grok.command**를 더블 클릭하거나,
`scripts/install-codex-grok-app.sh`로 **별도의** 데스크톱 래퍼를 체크아웃과
맞춥니다([데스크톱 설치와 갱신](#데스크톱-설치와-갱신)).
Linux에서는 `~/.local/share/codex-grok-bridge/app`과 사용자 `.desktop`이고,
정품 `/usr/lib/chatgpt`는 패치하지 않습니다.

새로 열린 Codex 창에서 **새 작업을 시작하기 전에 Grok 4.6 / xAI를 선택**하세요.
기존 GPT 모델도 목록에 남습니다. 이미 열려 있던 일반 Codex 창에는 이 확장이
주입되지 않습니다.

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
4. 브리지는 Codex 도구(일반 함수, namespace 함수, freeform 커스텀, `web_search`)를
   function tool로 펼친 뒤 `cli-chat-proxy.grok.com` Responses 스트림을 이어줍니다.
5. 도구 결과는 다음 Codex 요청의 `input`으로 돌아갑니다.

인증은 `grok login` 세션입니다. `XAI_API_KEY`는 쓰지 않습니다.

상류 소켓은 `node:http(s)` keep-alive `Agent`(30초, 최대 4개)와 TTL 5분 DNS
캐시를 씁니다. 조회가 실패해도 유효한 캐시가 있으면 그것으로 버팁니다. 도구
실행으로 5–20초가 비어도 매번 이름을 다시 찾지 않기 위해서입니다.
`GROK_BRIDGE_TRANSPORT=fetch`로 이전 `fetch` 경로로 되돌릴 수 있습니다.

Codex에 첫 SSE 블록을 쓰기 **전**에 죽은 요청은 한 번 다시 보냅니다. 아직
아무것도 전달하지 않았으므로 재전송이 대화를 오염시키지 않습니다. 첫 블록을
쓴 뒤에는 절대 재시도하지 않습니다. 422 같은 결정적 거절과 사용자 중단도
재시도하지 않습니다.

Responses 경로가 이상하면 `GROK_BRIDGE_INFERENCE=cli`로 이전 CLI 봉투 경로를
씁니다. 매 턴 전체 JSON을 프롬프트로 넣으므로 더 느리고 비싸며, 토큰 단위
실시간 출력이 없고, 요청당 3분 제한입니다.

기본 Responses 경로는 스트림을 전달합니다. Codex `prompt_cache_key`는
`x-grok-conv-id`로 넘깁니다.

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

### 아직 보장하지 않는 것

음성, 클라우드 작업, 영상 생성은 약속하지 않습니다.

상류가 응답 중간에 연결을 리셋하는 경우가 있습니다(실측 3건: 25초 / 27초 /
253초, 726 KB–22 MB). 첫 SSE 바이트 이후에는 브리지가 재시도할 수 없습니다.
provider에 Codex `request_max_retries` / `stream_max_retries`를 2로 두어
**Codex**가 같은 요청을 다시 보내게 했습니다. 대화를 소유한 쪽만 안전하게
재시도할 수 있습니다.

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
| `GROK_BRIDGE_MODELS` | 카탈로그에 더할 `grok-*` id (쉼표/공백). 예: `grok-4.7` |
| `NODE` | `.command` / 데스크톱 스크립트가 쓸 `node` 절대 경로 |
| `CODEX_GROK_APP` | `install-codex-grok-app.sh`가 쓸 앱 경로 (macOS: `/Applications/Codex Grok.app`; Linux: `~/.local/share/codex-grok-bridge/app`) |

## 검증

```sh
npm test                    # 159건, 외부 추론 없음
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
```

기본 동작은 이 체크아웃의 `src/`와 `scripts/*.mjs`를 번들에 복사하고, 저장소에
없는 파일만 고른 뒤, 끝에서 모든 파일을 `cmp`합니다. 살아있는 번들을
`rm -rf`하지 않습니다. Codex Grok 창이 열려 있으면 거부합니다(`--force`로
무시). ESM은 핫리로드되지 않으므로 **동기화 후 창을 다시 열어야** 합니다.

macOS에서는 이미 있는 `Codex Grok.app`을 갱신하며 `/Applications/Codex.app`은
건드리지 않습니다. Linux에서는 `~/.local/share/codex-grok-bridge/app`과
`~/.local/share/applications/codex-grok.desktop`을 만들고 `/usr/lib/chatgpt`와
정품 `chatgpt.desktop`은 쓰지 않습니다.

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
