# 핸드오프 — Codex–Grok 브리지

작성 2026-09-09 · 이 문서 하나로 차가운 상태에서 이어받을 수 있게 쓴다.
깊은 배경과 전체 조사 기록은 `docs/solution-20260909.md`.

---

## 1. 이게 뭔가

Codex를 하네스로 두고 **Grok 4.6만 추론에 쓰는** 로컬 브리지.
Codex가 도구·권한·히스토리·MCP를 전부 소유하고, 브리지는 `/v1/responses`를 localhost에서 받아
`cli-chat-proxy.grok.com`으로 옮긴다. 인증은 `grok login` 세션이고 `XAI_API_KEY`는 쓰지 않는다.

```
Codex UI/CLI → app-server → scripts/codex-wrapper.mjs (모델 목록에 grok-4.6 주입)
             → localhost /v1/responses (src/bridge.mjs)
             → cli-chat-proxy.grok.com (src/transport.mjs, node:http(s))
             → 도구 호출은 Codex가 실행하고 결과가 다음 요청의 input으로 돌아온다
```

## 2. 지금 상태

```
저장소 src/ = /Applications/Codex Grok.app/…/bridge/src/     (해시 일치)
게이트        132/132, 97.44 lines / 87.30 branches / 89.93 functions
```

| 모듈 | 역할 |
|---|---|
| `bridge.mjs` | HTTP 서버, SSE, 진단 기록. 225줄 |
| `transport.mjs` | node:http(s) Agent + TTL 5분 DNS 캐시. `GROK_BRIDGE_TRANSPORT=fetch`로 되돌림 |
| `proxy.mjs` | Grok Responses 프로토콜, 재시도 경계, SSE 파이프 |
| `tools.mjs` | Codex↔Grok 아이템/도구 변환. `TRANSPORT_PROVENANCE` + 이미지 켜짐 시 `IMAGE_GENERATION_PROVENANCE` |
| `errors.mjs` | cause 체인 오류 분류 |
| `diagnostics.mjs` | 레닥션·회전 로컬 로그 |
| `slots.mjs` | 유한 동시성(기본 4) + 큐(기본 8) |
| `imagegen.mjs` | Grok 네이티브 이미지 생성. 파일 저장 후 assistant 메시지로 전달 |
| `cli-inference.mjs` | `GROK_BRIDGE_INFERENCE=cli` 폴백 |
| `router.mjs` / `runtime.mjs` / `auth.mjs` / `images.mjs` | 라우팅 / 프로바이더 등록 / 로그인 토큰 / 이미지 |

진단 로그: `~/.local/share/codex-grok-bridge/logs/bridge.jsonl` (0600, 4 MiB 회전, `GROK_BRIDGE_DIAGNOSTICS=off`)

## 3. 무엇이 고장나 있었고 무엇이 고쳤나

원래 증상: 데스크톱에서 "Grok이 잘 붙었는지 체크해줘"를 물으면 **항상 15.07초에** 죽고
`stream disconnected before completion: Grok response failed validation or execution`이 떴다.

| 실제 원인 | 수정 |
|---|---|
| `isAbortLike`가 `error.code`만 봤다. Node `fetch`는 실제 코드를 `error.cause`에 숨긴다 → **네트워크 실패 8종이 전부 제네릭 한 줄로 붕괴** | `errors.mjs` cause 체인 순회 |
| 실패가 어디에도 기록되지 않았다 (wrapper stderr → Electron → 소실) | `diagnostics.mjs` |
| `res.writeHead()`만 하고 `flushHeaders()`를 안 해서 상류 첫 바이트(또는 10초 keepalive)까지 헤더조차 안 나갔다 | `res.flushHeaders()` |
| 동시성 가드가 `await` 앞에 있어 **동시 3요청이 전부 통과**했다 | `slots.mjs` (아래 4.4 주의) |
| `reasoning` 평문 요약까지 통째로 버렸다 | 요약 보존, 암호화분만 제거 |
| 프롬프트에 provider·model이 없어 모델이 "붙었는지" 확인할 방법이 없었다 | `TRANSPORT_PROVENANCE` 한 줄 |
| 에이전트가 config·스킬·메모리를 35–85회 전수조사해 턴당 1.4–1.9M 토큰을 썼다 | `AGENTS.md` 상태 확인 규칙 |

결과: 죽던 그 질문이 **41.9초, 도구 0회, 정답**으로 끝난다.

## 4. 시간 잡아먹는 함정 (여기부터가 진짜 핸드오프)

### 4.1 15000ms는 사라졌고, 남은 실패는 상류의 중간 리셋이다 — 해결됨

**옛 실패**(수정 전, `fetch` 경로): 5건이 15077/15094/15107/15069/15113 ms — 편차 44ms의 고정 타이머.
제네릭 문자열 때문에 정체를 알 수 없었다. Codex도(침묵 400초 견딤) 상류도(138.8초 응답 정상 완료) 아니었다.
유력 가설은 macOS `getaddrinfo` 타임아웃(resolver `timeout:5` × 3 = 15초)이었다.

**새 실패**(진단 로그 도입 후): 38턴 중 3건. 15.0초 상수는 **한 번도 재현되지 않았다.**

```
kind=upstream_closed  signature=Error[ECONNRESET]  detail="aborted"
25,256ms / 726 KB / 7 items
26,780ms /  22 MB / 60 items
252,819ms / 909 KB / 121 items
```

즉 **DNS가 아니었거나, `transport.mjs`의 DNS 캐시가 이미 그 원인을 없앴다.** 어느 쪽이든 15.0초 패턴은 끝났다.
남은 것은 **상류가 응답 중간에 연결을 리셋하는 것**이고, 시각·크기에 상수가 없는 간헐적 현상이다.

**브리지는 이걸 재시도할 수 없다** — Codex가 이미 응답 일부를 받았으므로 재전송하면 중복된다.
**Codex는 할 수 있다** — 대화를 소유하므로 같은 요청을 다시 보내면 된다. 그런데 provider 설정이
`stream_max_retries: 0`이라 모든 리셋이 죽은 턴이 되고 있었다. 지금은 `2`다.
(`request_max_retries`도 2. 브리지 자체 재시도는 첫 이벤트 이전만 담당하므로 서로 겹치지 않는다.)

### 4.2 프롬프트에 provider·model이 없다

Codex는 `provider`/`model`을 프롬프트에 넣지 않는다. `session_meta.model_provider`는 **롤아웃 메타데이터**이고,
`MODEL_INFO.model_messages.instructions_template`은 **모델에 도달하지 않는다**(실측 확인).
"Grok이 붙었나"에 답할 수 있는 유일한 프롬프트 내 근거는 브리지가 `instructions` 끝에 붙이는 `Transport:` 한 줄이다.
이걸 모르고 AGENTS.md에 "provider 값을 보라"고 썼다가, 모델이 순환을 알아채고 "확정할 수 없다"고 답했다.

### 4.3 AGENTS.md는 이 저장소에서만 적용된다

실제 실패는 다른 작업 디렉터리에서 났다. 하네스 전역에 걸쳐야 하는 규칙은 **브리지에 넣어야** 한다.

### 4.4 동시성을 1로 조이면 서브에이전트가 죽는다

원래 가드는 고장나 있었고(전부 통과), 그래서 Codex `spawn_agent` 자식 추론이 우연히 동작했다.
가드를 제대로 고치자 **자식이 429로 죽었다.** 상류는 동시 6건을 문제없이 처리한다(실측).
그래서 지금은 **유한 동시성(4) + 큐(8)** 이고, 넘치면 거절이 아니라 대기한다.
Codex는 400초 침묵도 견디므로 대기가 429보다 항상 낫다. **이 값을 1로 되돌리지 말 것.**

### 4.5 ESM은 핫리로드되지 않는다

파일을 바꿔도 떠 있는 창은 로드된 코드를 계속 쓴다. **창을 다시 열어야** 반영된다.
`sh scripts/install-codex-grok-app.sh`는 앱이 켜져 있으면 거부한다(`--force`로 무시 — 실행 중 창은 영향 없음).

### 4.6 `docs/` 안에 `*.test.mjs`나 `test/` 디렉터리를 만들지 말 것

`node --test`의 기본 글롭이 `**/*.test.mjs`와 `**/test/**`를 훑는다. `docs/` 밑에 두면 `npm test`에 섞인다.
참조용 테스트는 `*.tests.mjs`(복수형)로 둔다.

### 4.7 진단 로그는 `startRuntime()`에서만 켜진다

`createBridgeServer()`를 직접 만드는 테스트가 운영 로그를 오염시켰던 적이 있다. opt-in으로 바꿨다.

### 4.8 `new URL(...).pathname`은 퍼센트 인코딩을 돌려준다

`/Applications/Codex Grok.app/…`의 공백 때문에 `verify-app-server.mjs`가 설치된 번들에서만 조용히 죽었다.
파일 경로에는 `fileURLToPath()`를 쓴다.

### 4.9 Codex는 이미지 생성 도구를 주지 않는다

이 프로바이더에 오는 263개 도구 중 이미지 생성은 하나도 없다(`view_image`만 있다).
그래서 Codex의 `imagegen` 시스템 스킬은 OpenAI 경로로 폴백한다 — 추론은 Grok인데 그림은 다른 벤더가 그린다.
브리지가 `{type:"image_generation"}`을 직접 선언해서 해결했다. Codex를 거치지 않고 Grok이 서버 쪽에서 생성한다.
도구가 켜져 있으면 `IMAGE_GENERATION_PROVENANCE`를 instructions에 붙여 그 스킬을 읽지 말라고 한다. `GROK_BRIDGE_IMAGE_GEN=off`면 도구와 그 줄이 같이 빠진다.

**단, 생성만 된다.** 실측: 투명 배경은 지원하지 않는다 — 항상 JPEG로 오고, 모델은 "투명 배경"이라 말하면서
체커보드를 그림에 칠해서 보낸다. 도구 파라미터(`background`, `output_format`)는 조용히 무시된다.
편집도 진짜 image-to-image가 아니라 텍스트 묘사 재생성이라 구도·해상도가 바뀐다.
그래서 저장 시 포맷을 확인해 알파가 없으면 "투명하다고 설명하지 말라"를 모델에게 붙인다.
투명 배경이나 정확한 인페인팅이 필요하면 Codex의 OpenAI 경로가 맞다.

### 4.10 세션 트랜스크립트에는 실제 자격증명이 들어간다

`cat ~/.codex/config.toml` 한 번으로 MCP 토큰이 트랜스크립트에 남는다.
저장소에 넣을 때는 `docs/experiments/render-transcript.mjs`를 쓴다 — 형태 기반 레닥션 후
**출력에 자격증명 형태가 남아 있으면 쓰기를 거부**한다.

## 5. 검증

```sh
npm test                                   # 132건, 외부 추론 없음
npm run test:coverage                      # 80% 게이트
npm run verify:app-server                  # 실제 app-server 라우팅. 설치 번들에서도 실행됨
node scripts/codex-grok.mjs exec --skip-git-repo-check "Reply with exactly PONG." </dev/null
```

라이브 게이트는 사용자 계정 사용량을 쓴다. 실제 데스크톱 경로까지 보려면 app-server를 직접 구동한다
(드라이버 예시는 `docs/experiments/probe-appserver.mjs`). 측정 재현은 `docs/experiments/` 참고 —
`replay-*.mjs`만 Grok 호출을 소비한다.

## 6. 하드 제약 (사용자가 고정한 것)

- Codex가 하네스다. Grok은 추론만. 두 번째 Grok 에이전트 런타임을 켜지 않는다.
- 인증은 `grok login` 세션. `XAI_API_KEY`를 주 경로로 쓰지 않는다.
- Codex.app을 다시 쓰지 않는다. `~/.codex/config.toml`과 `~/.grok/*`를 브리지 수정의 일부로 건드리지 않는다.
- 실행 중인 앱을 `rm -rf`하거나 kill해서 배포하지 않는다.
- 불변성, 작고 집중된 파일(≤400줄 권장/800 상한), 명시적 오류 처리, `node --test` 80% 커버리지.

## 7. 남은 일

| 항목 | 다음 행동 | 비용 |
|---|---|---|
| 상류 중간 리셋 재발 여부 | `stream_max_retries: 2` 적용 후에도 `turn_failed`가 남는지 로그로 확인 | 무료 |
| ~~`apply_patch` 왕복~~ | **해당 없음.** Codex는 이 프로바이더에 `apply_patch`를 주지 않는다 — read-only/workspace-write/danger-full-access 세 샌드박스 모두에서 확인(258–268개 도구 중 없음). 파일 변경은 `exec_command`로만 한다 | — |
| MCP 네임스페이스 왕복 | 실제 MCP 도구 1건 왕복 | 중간 |
| `context_window` 258,400 출처 | 카탈로그 값을 131072로 낮추고 `token_count.model_context_window`가 따라 변하는지 관찰. 안 변하면 Codex 내부값 | 라이브 1콜 |
| 프리픽스 156k 축소 | 전용 `CODEX_HOME`으로 world_state(119,669자)를 슬림화. 재로그인 비용이 있어 사용자 결정 사항 | — |
| `~/.grok/auth.json` JWT 노출 | 2026-09-08 23:13 턴이 롤아웃에 기록했다. **토큰 회전(`grok login`)이 실질적 대응** | — |
| 필드 화이트리스트 | 타입만 거르고 여분 필드는 상류로 그대로 간다. 새 Codex 필드가 422를 부를 수 있다 | 낮음 |

## 8. 롤백

```sh
ls ~/.local/share/codex-grok-bridge/backups/          # 적용 전 src/, test/, 번들 사본
```

`git revert` / `git checkout`이 1차 수단이고, 위 백업은 git 이전 상태(2026-09-09 배포 직전)를 담고 있다.
`staging/alt-proposal-unverified/`는 병렬 분석이 낸 **검증 실패한** 독립 구현이다 — 적용하지 말 것.
