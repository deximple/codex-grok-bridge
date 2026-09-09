# codex-grok-bridge

Run **Grok 4.6 as the model inside Codex**, with Codex still owning tools,
permissions, history and MCP. No xAI API key: inference goes through the login
session of the installed `grok` CLI.

```
Codex UI/CLI → app-server → codex-wrapper.mjs (adds grok-4.6 to the model list)
             → localhost /v1/responses (the bridge)
             → cli-chat-proxy.grok.com
             → Codex executes every tool call; results return as the next input
```

**Requirements** — macOS, Node.js ≥ 22, `/Applications/Codex.app`, the `grok`
CLI at `~/.grok/bin/grok` with a completed `grok login`. Zero runtime
dependencies; the whole bridge is thirteen files under `src/`.

**Quick start**

```sh
npm install -g codex-grok-bridge   # macOS, Node ≥ 22
codex-grok                         # Codex in the terminal, Grok 4.6 selected
```

From a checkout:

```sh
git clone https://github.com/deximple/codex-grok-bridge.git
cd codex-grok-bridge
npm test                        # 131 tests, no network, no inference
node scripts/codex-grok.mjs
```

That is the whole setup for terminal use — the bridge registers itself as a
model provider for the Codex process it launches and tears down with it.

`scripts/install-codex-grok-app.sh` keeps a **separate** `Codex Grok.app`
bundle in sync with a checkout, so the desktop app can use the bridge too. It
updates an existing bundle; it does not create one, and it will not touch the
normal `Codex.app`. It never deletes a live bundle and refuses to run while a
Codex Grok window is open. ESM is not hot-reloaded, so reopen the window after
an update.

**Docs** — `docs/HANDOFF.md` is the short version (state, pitfalls, open items).
`docs/solution-20260909.md` is the long one: how a fixed 15-second failure was
traced, what it turned out to be, and every measurement behind the fixes.
`docs/experiments/` reproduces those measurements.

**Diagnostics** — every turn is recorded to
`~/.local/share/codex-grok-bridge/logs/bridge.jsonl`: structural facts only,
never prompt text, tool output or tokens. Start there when something breaks.

---

아래는 한국어 상세 설명입니다.

## Codex + Grok Build CLI

Grok 4.6 / xAI를 Codex 모델 목록에 추가하고, Grok의 도구 요청을 Codex가 실행하도록 연결하는 로컬 확장입니다. xAI API 키를 사용하지 않습니다. 설치된 `grok` CLI의 로그인 세션으로 추론합니다.

## 실행

이 폴더의 **Open Codex with Grok.command**를 더블 클릭합니다. 별도로 열린 Codex 창에서 **새 작업을 시작하기 전에 Grok 4.6 / xAI를 선택**하세요. 기존 GPT 모델도 목록에 유지됩니다. 현재 실행 중인 일반 Codex 창에는 이 확장이 주입되지 않습니다.

터미널에서는 다음과 같이 실행할 수 있습니다.

```sh
npm install -g codex-grok-bridge
codex-grok
codex-grok exec --skip-git-repo-check --sandbox workspace-write '작업 내용'
```

체크아웃에서는 `node scripts/codex-grok.mjs`가 같은 진입점입니다. 필요한 설치: Node.js 22 이상, `/Applications/Codex.app`, `~/.grok/bin/grok`, 완료된 `grok login`. `.command` 런처는 자기 위치를 기준으로 경로를 잡으므로 폴더를 옮겨도 수정할 필요가 없습니다. `NODE=/path/to/node`로 Node를 지정할 수 있습니다.

## 연결 방식

기본 경로는 Codex-GPT와 같은 Responses 루프입니다. Grok 네이티브 도구는 실행하지 않습니다. 인증은 `grok login` 세션이며 `XAI_API_KEY`를 쓰지 않습니다.

1. `CODEX_CLI_PATH`로 지정한 래퍼가 Codex app-server를 실행합니다.
2. 래퍼가 모델 목록에 Grok를 추가하고 새 Grok 작업의 제공자를 `grok_build_cli`로 설정합니다.
3. Codex의 `/v1/responses` 요청은 localhost 변환기로 갑니다.
4. 변환기는 Codex 도구를 function calling으로 옮긴 뒤 `cli-chat-proxy.grok.com` Responses 스트림을 그대로 이어줍니다. MCP/셸/패치 실행은 Codex가 합니다.
5. 도구 결과는 다음 Codex 요청의 `input`으로 다시 들어갑니다. GPT 경로와 같은 에이전트 루프입니다.

상류 연결은 `node:http(s)`와 keep-alive `Agent`(소켓 30초 유지, 최대 4개)로 직접 엽니다. DNS는 5분 TTL로 캐시하며, 조회가 실패해도 유효한 캐시가 있으면 그것으로 버팁니다. 도구 실행으로 5–20초가 비는 사이에 소켓이 닫혀 매번 새로 이름을 찾는 상황을 피하기 위한 것입니다. `GROK_BRIDGE_TRANSPORT=fetch`로 이전 `fetch` 경로로 되돌릴 수 있습니다.

Codex에 첫 SSE 블록을 쓰기 **전**에 죽은 요청은 한 번 다시 보냅니다. 아직 아무것도 전달하지 않았으므로 재전송이 대화를 오염시키지 않기 때문입니다. 첫 블록을 쓴 뒤에는 절대 재시도하지 않고, 422 같은 결정적 거절과 사용자 중단도 재시도하지 않습니다.

문제가 있으면 `GROK_BRIDGE_INFERENCE=cli`로 이전 CLI 봉투 경로를 쓸 수 있습니다. CLI 경로는 매 턴 전체 JSON을 프롬프트로 넣기 때문에 토큰과 지연이 큽니다.

설치된 Codex 앱 번들, 코드 서명, `~/.codex/config.toml`, Grok 인증 파일은 수정하지 않습니다. 전용 창은 `~/.local/share/codex-grok-bridge/desktop`에 UI 데이터를 저장하고 기존 Codex 홈의 계정·작업·설정을 공유합니다. 따라서 실제 사용자 작업 내용과 설정 변경은 다른 Codex 창에서도 보일 수 있습니다.

## 확인된 동작과 제한

- 실제 app-server에서 GPT 6개 모델과 `grok-4.6`의 혼합 목록 및 Grok 제공자 라우팅 확인.
- 실제 Grok CLI → Codex `exec_command` → 실행 결과 → Grok 최종 응답을 확인. 결과: `BRIDGE_TOOL_OK`.
- 별도로 연 Codex 창에 `Grok 4.6 / xAI Extra High` 표시 확인.
- 브리지는 상류로 보내는 `instructions` 끝에 출처 한 줄(`Transport: …`)을 붙입니다. Codex는 provider·model을 프롬프트에 넣지 않기 때문에, 이 줄이 없으면 "Grok이 붙었는지"를 모델이 확인할 방법이 없어 설정 파일을 뒤지거나 답을 얼버무립니다. 대화 내용을 판단하는 것이 아니라 전송이 자기 출처를 밝히는 것이며, `user-agent` 헤더와 같은 범주입니다.
- Codex `reasoning` 항목의 평문 요약은 상류로 전달합니다. 암호화된 `encrypted_content`와 Codex 자체 아이템 id는 제거합니다. 여러 번 호출이 이어지는 턴에서 모델이 자기 추론을 이어받게 하기 위한 것으로, 실제 상류가 이 형태를 수락하는지 확인했습니다.
- 추론은 변환기당 **동시 4건**까지 실행하고, 그 이상은 큐(기본 8)에서 대기합니다. 큐까지 가득 찼을 때만 `429`를 냅니다. 대기가 거절보다 나은 이유는 브리지가 이미 응답 헤더를 보냈고 keepalive로 스트림을 살려 두기 때문입니다. 동시 1로 조이면 Codex `spawn_agent` 자식 추론이 부모 턴과 겹쳐 죽습니다.
- 일반 함수 도구, namespace 함수 도구, freeform 커스텀 도구를 변환합니다. 파일 변경·MCP 등은 Codex가 노출한 도구 및 권한 범위에서 사용할 수 있지만, 개별 기능을 모두 실검증한 것은 아닙니다.
- 이미지 첨부·인식을 지원합니다. PNG/JPEG/WebP, **이미지당 10 MiB, 요청 전체 20 MiB**, 서로 다른 이미지 4장까지, PNG는 32메가픽셀까지입니다. 한도는 추측이 아니라 실측입니다 — 상류가 12.5 MiB PNG를 받아 답하는 것을 확인하고 그 아래로 잡았습니다.
- **쓸 수 없는 첨부 하나가 대화를 죽이지 않습니다.** 브리지는 대화 전체를 훑기 때문에, 예전에는 한도를 넘는 이미지가 히스토리에 한 번 들어가면 이후 모든 턴이 영구히 400으로 실패했습니다. 지금은 그런 첨부만 이유를 밝힌 텍스트로 바꾸고 나머지는 그대로 보냅니다. 쓸 수 있는 이미지는 `input_image` 그대로 넘어가며(Grok가 직접 읽습니다), 원격 URL은 가져오지 않습니다.
- 음성, 클라우드 작업, 영상 생성은 아직 보장하지 않습니다.
- 기본 Responses 경로는 스트림을 전달합니다. 프롬프트 캐시 키는 Codex `prompt_cache_key`를 `x-grok-conv-id`로 넘깁니다.
- cli-chat-proxy는 function tool 339개 요청을 수락했습니다. 공개 API 문서의 200개 한도는 이 로그인 경로에 적용되지 않습니다.
- 저장된 루트 작업이 대기 중이면 GPT ↔ Grok 전환을 지원합니다. `turn/start`와 설정 변경 API는 제공자를 바꾸지 못하므로, 래퍼가 구독 해제 → 같은 ID로 제공자를 지정해 재개 → 제공자·권한 확인 후 원래 요청을 전달합니다. 실행 중인 작업, 임시 작업, 하위 에이전트는 제공자 전환을 거부하며, 다른 구독자가 전환을 막으면 추론을 보내지 않습니다. 첫 턴이 저장되기 전에는 새 작업을 시작할 때 원하는 모델을 선택하세요.
- **이미지 생성도 Grok이 합니다.** 브리지가 상류 요청에 `{ type: "image_generation" }`을 직접 선언하므로, Codex가 이미지 도구를 노출하지 않아도 Grok이 서버 쪽에서 생성합니다. 도구가 켜져 있으면 `instructions` 끝에 `Images:` 출처 한 줄을 붙여 Codex `imagegen` 스킬을 읽지 말라고 합니다. 돌아온 바이트는 `~/.local/share/codex-grok-bridge/generated-images/`에 0600으로 저장하고, Codex에는 파일 경로를 알려주는 assistant 메시지로 전달합니다. Codex가 모르는 `response.image_generation_call.*` 이벤트는 걸러냅니다. `GROK_BRIDGE_IMAGE_GEN=off`로 끄면 도구와 그 줄이 같이 빠집니다.
  - **한계도 실측했습니다.** Grok의 `image_generation`은 텍스트→이미지 생성만 제대로 됩니다.

    | 기능 | 결과 |
    |---|---|
    | 텍스트→이미지 생성 | 됨 |
    | 투명 배경 | **안 됨.** 항상 JPEG로 오고 알파 채널이 없습니다. 모델은 "투명 배경"이라고 말하면서 **체커보드를 그림에 칠해서** 보냅니다 |
    | 도구 파라미터(`background`, `output_format`) | 거부되지 않고 **조용히 무시**됩니다 |
    | 이미지 편집(image-to-image) | **진짜 편집이 아닙니다.** 입력 이미지를 텍스트로 묘사해 재생성하므로 구도·크기·해상도가 달라집니다 |

    그래서 브리지는 저장한 파일의 실제 포맷을 확인해, 알파가 없으면 "이 포맷은 알파 채널이 없으니 투명하다고 설명하지 말라"고 모델에게 명시합니다. 투명 배경이나 정확한 인페인팅이 꼭 필요하면 Codex의 OpenAI 경로를 쓰는 편이 맞습니다.
  - 이게 없으면 Codex의 `imagegen` 시스템 스킬이 OpenAI 경로(내장 `image_gen` 또는 `OPENAI_API_KEY` + `gpt-image-*`)로 갑니다. 실제로 Codex가 이 프로바이더에 보내는 263개 도구 중 이미지 생성 도구는 하나도 없습니다 — `view_image`뿐입니다. 즉 추론은 Grok인데 그림만 다른 벤더에서 나오는 상태가 됩니다.
- CLI 폴백은 응답이 끝난 뒤 Codex에 결과를 전달하므로 토큰 단위 실시간 출력이 없습니다. 요청당 3분 제한입니다.
- 상류가 응답 중간에 연결을 리셋하는 경우가 간헐적으로 있습니다(실측 3건: 25s/27s/253s, 726 KB–22 MB). 브리지는 이걸 재시도할 수 없습니다 — Codex가 이미 응답 일부를 받았으므로 재전송하면 중복됩니다. 대신 provider에 `stream_max_retries: 2`를 설정해 **Codex가 같은 요청을 다시 보내도록** 했습니다. 대화를 소유한 쪽만 안전하게 재시도할 수 있습니다.
- 앱 업데이트가 `CODEX_CLI_PATH`나 app-server 프로토콜을 바꾸면 재검증이 필요합니다. 검증 버전: Codex 0.153.4 / 앱 26.901.51231, Grok CLI 1.0.24, Node 22.23.0.

## 진단 로그

브리지는 매 턴을 `~/.local/share/codex-grok-bridge/logs/bridge.jsonl`에 한 줄씩 기록합니다(디렉터리 0700, 파일 0600, 4 MiB 초과 시 `.1`로 1회 회전). 끄려면 `GROK_BRIDGE_DIAGNOSTICS=off`.

```jsonl
{"at":"…","event":"turn_ok","mode":"proxy","elapsedMs":14118,"requestBytes":469749,"items":4,"tools":29}
{"at":"…","event":"turn_failed","kind":"dns","signature":"TypeError <- Error[EAI_AGAIN]","elapsedMs":15071,…}
```

구조적 사실만 남깁니다 — 시각, 성공/실패, 오류 분류, 오류 체인의 이름·코드, 경과 시간, 요청 바이트, 아이템·도구 개수. **프롬프트 본문, 도구 출력, 상류 응답 본문, 토큰은 기록하지 않습니다.** `detail`에 들어가는 오류 메시지는 Bearer 토큰·JWT·API 키·홈 경로를 치환한 뒤 400자로 자릅니다.

성공 턴도 남기는 이유는, 실패 시 로그가 비어 있다는 사실 자체가 "브리지가 호출되지도 않았다"는 진단이 되기 때문입니다.

`event: "turn_failed"`의 `kind`는 다음 중 하나입니다 — `aborted`(사용자가 중단), `auth`(로그인 만료), `dns`, `connect`, `upstream_timeout`, `upstream_closed`, `upstream_protocol`, `payload`, `internal`. Codex UI에는 같은 분류가 `bridge_<kind>` 코드와 함께 표시됩니다.

## 검증

```sh
npm test                    # 131건, 외부 추론 없음
npm run test:coverage       # line/branch/function 80% 게이트
npm run verify:app-server   # 실제 app-server 라우팅. 설치된 앱 번들에서도 실행됩니다
npm audit --omit=dev
```

## 설치와 갱신

```sh
sh scripts/install-codex-grok-app.sh          # 브리지 JS만 동기화 (기본)
sh scripts/install-codex-grok-app.sh --full   # 런처 applet 재빌드 + 서명까지
```

기본 동작은 번들의 `src/`·`scripts/`를 이 저장소와 일치시키는 것입니다. 디렉터리를 지우지 않고, 저장소에 없는 파일만 골라서 제거하며, 끝에 내용이 일치하는지 확인합니다. Codex Grok 창이 열려 있으면 거부합니다(`--force`로 무시). ESM은 핫리로드되지 않으므로 **동기화 후 창을 다시 열어야** 새 코드가 적용됩니다.

테스트는 외부 추론을 호출하지 않습니다. `verify:app-server`는 실제 app-server에 모델 목록과 임시 작업 생성을 요청하며, 모델 추론은 하지 않습니다. 실제 CLI 검증은 사용자 계정 사용량을 소비합니다.

변환기는 loopback에만 바인딩하며, 추론 요청에 매 실행마다 생성한 임시 토큰을 요구합니다. 브라우저 Origin 요청, 지원하지 않는 모델, 과대 요청, 알 수 없는 도구 호출은 거부합니다. Grok 프롬프트 임시 파일은 0600 권한으로 생성하고 종료 후 제거합니다. CLI 오류 원문과 인증 정보는 응답에 포함하지 않습니다. Codex와 Grok 자체의 대화 저장 정책은 그대로 적용됩니다.

중지하려면 확장으로 연 Codex 창을 종료하세요. 일반 Codex는 기존 아이콘으로 실행하면 됩니다. 자동 시작 서비스나 전역 환경변수는 등록하지 않았습니다.

참고: [Grok Build headless scripting](https://docs.x.ai/build/cli/headless-scripting), [Grok Build source](https://github.com/xai-org/grok-build), [Codex source](https://github.com/openai/codex).
