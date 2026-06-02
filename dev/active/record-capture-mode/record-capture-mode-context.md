# record-capture-mode — Context

Last Updated: 2026-06-02

## SESSION PROGRESS

- 2026-06-02: ouroboros Path B(소크라테스 인터뷰, MCP 미연결) 설계 완료. 7 트랙(T1~T7) 모두 닫음.
  키 결정: 산출물=기존 flow.json 자동생성, 캡처=addinitscript JS 주입, 로그인=캐시 state 후 녹화,
  로케이터 불가시=needs_review, 행위=클릭/입력/셀렉트/Enter/이동, assert=종료 URL 자동+나머지 후처리,
  대상=범용. seed 생성+QA 0.92 → `record-capture-mode-seed.yaml`. plan/context/tasks 작성.
- 2026-06-02: **Phase 0 PoC PASS** (brg25r4fo). --init-script 리스너가 실클릭 캡처 + ?nav=1 같은-오리진
  네비게이션 넘어 sessionStorage 보존 + 네비후 재캡처 모두 확인. CDP 폴백 불요. poc-capture.js/poc-run.sh.
  **footgun 발견: cold-spawn agent-browser를 파이프/`$()`로 받으면 daemon이 stdout fd 물어 hang →
  파일 redirect 또는 daemon 워밍 선행. 구현 시 capture 모드도 이 규칙 준수.**
- 2026-06-02: **ultracode WF-1 완료**(23 에이전트, 2.16M tok). 적대비평이 seed의 BLOCKER 3개 적발:
  B1 get count는 CSS-only(시맨틱 유일성 불가→in-page 카운트), B2 addinitscript 0.27.0에 없음(→--init-script),
  B3 headless 기본(→AGENT_BROWSER_HEADED=1). 보안: 마스킹 확대(OTP/카드/SSN), flow.json git커밋 PII,
  URL 쿼리 토큰. 굳힌 설계 = **record-capture-mode-design.md** (단일 구현 레퍼런스, seed 블로커 supersede).
  주의: WF 에이전트는 샌드박스서 브라우저 못 띄워 PoC 미실행이라 했으나, 내 인라인 PoC(brg25r4fo)가 R1 retire 완료.
- 2026-06-02: **bin/capture.js 전면 재작성**(314줄, node --check OK) — composedPath+interactive ancestor+라벨
  중복제거+IME/입력합치기+확대마스킹+후보사다리(P1~P6)+엔트로피거부+in-page 유일성카운트+네비 A~D레이어.
- 2026-06-02: **값 처리 결정 = 파라미터화 + gitignore 사이드카**(사용자). flow.json엔 {{input_N}} 토큰,
  실값은 gitignored flows/<name>.values.json. compile/run이 런타임 치환(키 없으면 fail-loud). 민감필드는 캡처시 마스킹.
- 2026-06-02: **Phase 1+2+3 구현·검증 완료. end-to-end round-trip 그린.** bin/build-flow.js(변환기),
  probe-record.sh capture()/compile()(needs_review 가드+토큰 런타임 치환), .gitignore *.values.json.
  단위테스트(build-flow), needs_review 가드, 토큰 치환(+fail-loud), 그리고 실제 캡처→compile→run.sh PASS 실증.
- 2026-06-02: **실측 버그 발견·수정** — agent-browser 0.27.0 `find role --name`이 요소 매칭 실패(heading+link,
  정확한 accessible name에도; --json success:false). `find text|label|placeholder|testid`는 동작. capture.js
  WKIND 가중치를 엔진-지원 로케이터 우선(text 40>role 24)으로 재조정 → round-trip 그린. **`find ... hover --json`
  = 비파괴 검증 프리미티브**(v2 verify-repair replay의 토대; design.md open-risk "accname/role 발산" 실현·완화).
- 2026-06-02: **`wait --url` 글롭 버그 root-cause + 수정. 멀티스텝-네비 재생 GREEN.** 실측: agent-browser
  0.27.0 `wait --url`은 **글롭 패턴(`*`/`**`)에서 일관되게 깨짐** — `**/secure`는 ~34s 후 `os error 10060`
  ("Failed to read")로 실패(standalone·batch 둘 다). **평문 substring은 동작**(`wait --url "secure"|"iana.org"` OK).
  그래서 login.test.sh(substring)는 통과했고 build-flow의 `**/glob` 방출은 실패했던 것. `get url`은 100% 신뢰.
  → **수정**: ① lib/assert.sh에 `wait_url <glob> [timeout=15s]` 추가 — `get url`을 폴링하며 assert_url과
  **동일한 `_url_match`**(공유 헬퍼)로 매칭, 네비 중 일시적 get-url 실패는 데드라인까지 재시도. ② compile()이
  `wait until:url`을 더 이상 batch 명령으로 내지 않고 **url-wait 경계마다 batch를 분할** — jq가 연속 batch 명령을
  세그먼트로 합쳐 base64화하고 `_run_batch '<b64>'` / `wait_url '<glob>'`를 교차 방출. 단일 `_run_batch` 헬퍼가
  b64 디코드→{{input_N}} 사이드카 치환(walk)→fail-loud→`BATCH --bail`. text/load wait는 동작하므로 batch 안에 유지.
- 2026-06-02: **검증**: `flows/nav-roundtrip`(example.com→"Learn more"→iana `**/help/example-domains`,
  글롭 wait + 네비 후 세그먼트 hover) 컴파일→**run.sh GREEN**. 전체 suite 2/2(login+nav-roundtrip) GREEN.
  build-flow가 네비 경계에서 `{kind:wait,until:url,value:"**/..."}` + 종료 url assert 정상 방출(합성 records 단위확인) →
  capture.js→build-flow→compile→replay **전 체인 검증**. needs_review compile 거부(exit 1)·assert_url substring(login) 무회귀 확인.
- 2026-06-02: **footgun 추가**: the-internet.herokuapp.com이 반복 접속 시 간헐 "Application Error"(heroku 무료 dyno)
  → 신뢰성 검증은 안정 사이트(example.com→iana)로. 데몬이 누적 orphan으로 degrade되면 **ExecutablePath가
  `\.agent-browser\`인 Chrome-for-Testing만** Stop-Process(데몬·Program Files Chrome은 보존) 후 preflight 재워밍.
- **정리**: 스크래치(flows/tests의 herodemo*, mytest*, navdemo 중간본) 삭제. `nav-roundtrip`은 **영구 회귀 테스트로
  유지**(컴파일된 멀티스텝-네비 + wait_url 경로의 유일 커버리지; 완료기준 round-trip GREEN의 backstop, PII 없음).
- 2026-06-02: **적대적 코드리뷰(ultracode WF, 17 에이전트) → 실 버그 2건 적발·수정**:
  ① **`_url_match` 글롭 메타문자 미이스케이프**(assert_url/wait_url 공유) — `case`의 unquoted `$glob`이
  URL의 `[..]`/`?`를 문자클래스/와일드카드로 해석 → **false-green 가능**(이 프레임워크 존재이유에 정면 위배).
  수정: `[`→`[[]`, `?`→`[?]` 단일문자 브래킷식으로 리터럴화(역슬래시 이스케이프는 `${//}`에서 불안정), `*`만 와일드카드 유지.
  (리팩터 중 `local got=.. want=.. glob="$want"` 동일선언 내 `$want` 미설정 버그도 발견→ glob 별도 라인 할당으로 수정.)
  ② **compile select text/val 우선순위** — `if .text then .. elif .val`이 select에서 표시텍스트를 옵션값보다
  우선 → 잘못된 옵션 선택. 수정: action=="select"면 `.val` 우선, 그 외 `.text` 우선(build-flow는 둘을 동시 방출 안 하므로
  손수작성 flow 방어). 둘 다 단위테스트(10/10 URL 매칭, select=value/fill=text) + 전체 suite로 검증. 기각 3건(base64/jq
  fail-loud은 set -euo pipefail로 이미 보호, JSON 누출은 _ab_data가 성공시에만 stdout 출력이라 불가).
- **다음(v2/선택)**: ① 사람 헤디드 실사용 경로 통합검증(현재 메커니즘만) ② verify-repair replay
  (캡처 후 flow를 단계별 재생하며 각 로케이터를 hover --json으로 검증·복구) ③ icon-only(aria-label) 보강
  ④ SPA pushState-only 네비(URL 신호 無) wait gate 부재 — 다음 find의 암묵 wait에 의존.

## Current Execution Contract

- 언어: 순수 bash, Git Bash. agent-browser가 엔진(그것이 하는 일은 래핑 안 함).
- 의존 단방향: tests→lib(leaf), run.sh 오케스트레이션, bin/* standalone(아무도 import 안 함).
  단 bin/probe-record.sh가 lib/env.sh를 source하는 것은 허용(bin→lib, 정방향).
- 파일 500라인 이내(probe-record.sh 목표 ~250, 초과 시 캡처 JS 분리). 새 추상화 전 기존 확장 우선.
- 임시방편/하드코딩/문제은폐 금지: 유일 로케이터 미달은 needs_review로 fail-loud(조용한 css 폴백 금지).
- 검증은 항상 `--json .success`/필드 파싱, exit code 신뢰 금지(기존 footgun).
- **이 작업은 agent-qa 전용. workflow-use는 건드리지 않는다**(다른 세션이 거기 녹화 버그 수정 중).

## 현재 Active Task

**Phase 0 — PoC.** addinitscript로 click 리스너 주입 → agent-browser가 클릭 구동 → `eval --json`으로
캡처 확인 → 네비게이션 후 sessionStorage 보존 확인. self-run 가능(사용자 수동 클릭 불요: DOM
addEventListener는 합성/실제 클릭 모두 발화). 통과해야 Phase 1 착수.

## 다음 세션 읽기 순서

1. `record-capture-mode-plan.md` (phase 지도, acceptance, 검증 게이트, 리스크)
2. `record-capture-mode-tasks.md` (체크박스 + 참조 블록)
3. 이 파일(context) — execution contract, 의사결정
4. `record-capture-mode-seed.yaml` (전체 명세 — 단일 진실원천)
5. 코드: `bin/probe-record.sh`, `flows/SCHEMA.md`, `lib/env.sh`(AB_AUTH), `setup/auth.sh`

## 핵심 파일과 역할

- `bin/probe-record.sh` — 여기에 `capture` 3번째 모드 추가. 기존 scaffold/compile과 동일 dispatch 패턴.
- `flows/SCHEMA.md` — flow.json 스키마. `needs_review:true`+`candidates[]` 필드 확장 추가(나머지 불변).
- `lib/env.sh` — `AB_AUTH <app>`로 캐시 state 주입(캡처 시작에 재사용).
- `setup/auth.sh` — 1회 로그인→state 캐싱(변경 없이 재사용).
- (신규 가능) `bin/capture.js` — 250라인 초과 시 주입 JS를 분리하는 후보 위치.

## 중요한 의사결정 (design.md가 최종 — seed 블로커 supersede)

> ⚠️ seed의 일부 가정은 WF-1에서 실측으로 틀린 것으로 판명. **design.md를 단일 구현 레퍼런스로 사용.**

- **주입=`--init-script <abs-path>` (첫 open에)**. `addinitscript`는 0.27.0 바이너리에 없음(B2). 네비/페이지 바뀌어도 재실행.
- **이벤트 보존=sessionStorage 동기 write-through**(PoC 검증). 호스트가 url 변경마다 drain(크로스오리진은 per-origin이라 사전 drain 필요; same-origin이 proven).
- **종료=CLI 신호**: `trap flush_once INT EXIT`(Enter·Ctrl-C 같은 경로), close 전 버퍼 스냅샷, drain은 `jq .success`로 판정(브라우저 죽었으면 fail-loud, 빈 flow.json 금지).
- **로케이터=stability-score + in-page 유일성카운트**. `get count`는 CSS-only라 시맨틱 유일성 불가(B1) → in-page에서 `find`와 동일 매칭으로 카운트. 엔트로피/동적id 거부 필터가 최고 레버리지 graft. 미달 시 needs_review+후보≥2, compile 거부(fail-loud).
- **headed 강제**: `AGENT_BROWSER_HEADED=1` + `--headed`(B3, 안 하면 빈 녹화).
- **값 처리=파라미터화**: flow.json {{input_N}} 토큰, 실값 gitignored flows/<name>.values.json, 런타임 치환. 민감필드(password/OTP/카드/SSN: type·autocomplete·inputmode 휴리스틱)는 캡처시 마스킹.
- **네비 wait**: url 실제 변경시에만 emit, `**/<stable-path>`로 정규화(쿼리/프래그먼트 strip).
- **범위 제외**: scroll/hover/파일업로드, 새탭(감지시 원탭 drain→partial flow 저장→경고종료), 크로스오리진 iframe.
- **완료기준**: record→compile→replay 그린(round-trip).

## 빠른 재개

`cd C:/project/agent-qa`. Phase 0부터: agent-browser로 addinitscript 주입 PoC. 구현 중이면
plan→tasks 순으로 active phase 확인 후 이어서. seed가 전체 명세의 단일 진실원천.
