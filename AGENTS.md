# Grok bridge maintenance

- Codex owns history, tools, and permissions; Grok supplies inference. The user approved login-backed direct Responses transport on 2026-09-08; older CLI-only audit notes predate that approval.
- `turn/start`, `thread/settings/update`, and `turn/settings/update` cannot change `modelProvider`. Extra provider/config fields are silently ignored by Codex 0.153.4.
- A provider change requires an idle persisted root thread: unsubscribe the current connection, then resume the same ID with explicit model/provider. Verify the returned provider and permissions before forwarding the original request. Other subscribers can prevent the reload.
- New threads may lack a rollout until their first turn; use the confirmed `thread/start` result for that first request instead of attempting to resume them.
- `npm run verify:app-server` uses a temporary Codex home and synthetic saved history to test GPT/Grok switching in both directions without remote inference or user-state changes. Run it after routing changes, alongside `npm run test:coverage`.
- Real inference with the user's full skill/MCP context is expensive: the 2026-09-08 shell round-trip verification reported 272,767 input tokens. Prefer local protocol checks; report live-inference scope separately.
- The installed desktop wrapper is loaded at app-server startup. Existing Codex Grok windows need a restart to pick up source changes; preserve any active user work.

## 브리지 상태 확인 (도구 사용 금지)

"Grok이 붙었는지 / 제대로 도는지" 류의 질문에는 **도구를 호출하지 말고** 세션 컨텍스트만으로 답한다.

- 근거는 프롬프트 instructions 끝에 브리지가 직접 붙이는 `Transport:` 한 줄이다. 그 줄이 보이면 붙은 것이다.
  Codex는 provider·model 값을 프롬프트에 넣지 않으므로 세션 메타데이터를 근거로 삼으려 하면 안 된다 —
  2026-09-09 검증 턴에서 모델이 정확히 그 이유로 "확정할 수 없다"고 답했다.
- `~/.codex/config.toml`, ECC `SKILL.md`, `MEMORY.md`를 읽어 교차 확인하지 않는다. config.toml의 주석은 이 브리지의 상태를 설명하지 않으며, 2026-09-08 22:43 턴에서 바로 이 때문에 "model_provider가 openai-codex"라는 **틀린** 결론이 나왔다.
- 근거가 더 필요하면 `~/.local/share/codex-grok-bridge/logs/bridge.jsonl`의 마지막 몇 줄만 본다. `turn_ok`가 있으면 전송은 건강하다.
- 그보다 깊은 점검은 사용자에게 `npm run verify:app-server`를 제안하고, 직접 전수조사하지 않는다.
- `~/.grok/auth.json`과 `~/.codex/auth.json`은 읽지 않는다. 존재 확인이 필요하면 `test -f`로만 하고 내용을 출력하지 않는다. 2026-09-08 23:13 턴이 JWT를 도구 출력으로 끌어와 롤아웃에 영구 기록했다.

## 상태 (2026-09-09 기준)

`main`에 오류 분류 · 진단 로그 · 헤더 flush · node:http(s) 전송 + DNS 캐시 · 첫-이벤트-이전 재시도 ·
유한 동시성 · reasoning 요약 보존 · transport provenance · 입력 필드 화이트리스트가 모두 들어가 있다. 게이트 150/150.

`docs/solution-20260909.md` §13에 실증 기록이 있다 — 15.07초에 죽던 데스크톱 자가점검 질문이
**41.9초, 도구 0회, 정답**으로 끝난다. 설치된 앱 번들과 체크아웃의 동기화는
`sh scripts/install-codex-grok-app.sh`가 맞추고 끝에 내용 일치를 확인한다.

- `src/errors.mjs` — cause 체인 오류 분류. Node `fetch`는 코드를 `cause`에 숨기고 `node:http(s)`는 최상위에 두므로 양쪽을 모두 순회한다.
- `src/diagnostics.mjs` — 레닥션·회전 로컬 로그. `startRuntime()`에서만 켜진다. `createBridgeServer()`를 직접 만드는 테스트는 운영 로그를 건드리지 않는다.
- `src/transport.mjs` — keep-alive Agent + TTL 5분 DNS 캐시. `GROK_BRIDGE_TRANSPORT=fetch`로 되돌린다.
- `src/cli-inference.mjs` — `GROK_BRIDGE_INFERENCE=cli` 폴백. `bridge.mjs`에서 분리했다.
- `src/imagegen.mjs` — Grok 네이티브 이미지 생성. 브리지가 `image_generation` 도구를 직접 선언하고, 돌아온 바이트를 파일로 저장해 assistant 메시지로 넘긴다. Codex는 이 프로바이더에 이미지 생성 도구를 **주지 않는다**(263개 중 없음). 생성만 되고 투명 배경·진짜 편집은 안 된다 — 알파 없는 포맷이면 모델에게 그렇게 알린다.
- `src/slots.mjs` — 유한 동시성(4) + 큐(8). **1로 되돌리지 말 것**: Codex `spawn_agent` 자식 추론이 부모 턴과 겹쳐 429로 죽는다. 상류는 동시 6건을 문제없이 처리한다(실측).
- `src/tools.mjs`의 `TRANSPORT_PROVENANCE` — 브리지가 `instructions` 끝에 붙이는 출처 한 줄. Codex는 provider·model을 프롬프트에 넣지 않으므로, 이 줄이 "Grok이 붙었는가"의 유일한 프롬프트 내 근거다. `GROK_BRIDGE_IMAGE_GEN`이 꺼져 있지 않으면 그 뒤에 `IMAGE_GENERATION_PROVENANCE`를 붙여 Codex imagegen 스킬(OpenAI)을 읽지 말라고 한다.
- 배포는 `sh scripts/install-codex-grok-app.sh` 한 줄이다. 앱이 켜져 있으면 거부한다.
- Linux는 같은 스크립트가 `~/.local/share/codex-grok-bridge/app`과 사용자 `.desktop`을 만든다. `/usr/lib/chatgpt`와 정품 `chatgpt.desktop`은 건드리지 않는다. 번들 CLI는 `/usr/lib/chatgpt/resources/codex`다.
- 롤백은 git이 1차 수단이다. `~/.local/share/codex-grok-bridge/backups/`에는 git 도입 이전(2026-09-09 배포 직전) 스냅샷이 남아 있다.
