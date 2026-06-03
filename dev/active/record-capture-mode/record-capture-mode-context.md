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
- 2026-06-03: **production-hardening 세션 (ultracode 자율). 브랜치 feat/capture-hardening (master 분기).**
  - **환경 footgun(신규/치명)**: C: 디스크가 100% full이면 셸/하네스가 temp 작업디렉터리 mkdir에서 `ENOSPC`로
    **모든 Bash/PowerShell이 전면 차단**된다(파일 쓰기는 MFT 슬랙으로 가능하나 디렉터리 생성 불가). 복구법:
    **Write 툴로 큰 텍스트 파일을 truncate해 1클러스터 확보**(바이너리는 Read 거부로 불가) → 셸 복구 →
    `Temp\claude`의 **orphan `browser-use-user-data-dir-*` 프로파일 91개(~1.1GB)** + artifacts 정리. 그 후 24GB 여유.
    (디스크 대부분은 사용자 데이터라 추가 정리 불가; 캡처/run마다 artifacts 정리 권장.)
  - **P0.1 setup/auth.sh**: `wait --url` 글롭 버그(`--timeout` 무시, ~34s 후 os error 10060) **재확인** →
    **get url 폴링 루프 인라인 구현**(_url_match 인라인, lib/assert.sh와 동일 매칭). 글롭 SUCCESS_URL 라이브
    검증: 매칭 후 state 저장, exit 0 (구버전이면 34s 행). commit 2c5119e.
  - **P0.2 README**: capture 워크플로 추가, 깨진 batch `wait --url`→`wait_url`, get count 유일성 정정,
    auth 폴링 명시, Layout 보강. commit 06a467d.
  - **P1.3 seq health-check (probe-record.sh _flush_once)**: drain이 `__aqa_seq`를 buf와 함께 읽어
    `seq>recovered`면 **fail-loud(경고+exit 1)**, partial flow는 보존. 유닛(seeded mismatch/match) +
    실 capture() 와이어링(seq=7/buf=1→exit 1) 검증. tests/capture-healthcheck.test.sh. commit 656de1f.
  - **P1.4 new-tab (probe-record.sh)**: `tab list --json` 폴(>1 page tab)→`orig_tab` 스위치 후 drain→
    partial flow→exit 1. **eval은 활성탭 추적**(새탭=빈 storage이므로 스위치 없으면 원탭 유실) 실측 확인.
    timed/interactive(read -t 1) 양 경로에 watch loop. tests/capture-newtab.test.sh. 실 2탭 와이어링 검증. commit bf713df.
  - **Infra.9**: tests/build-flow-unit.test.sh(브라우저 불요 ~5s, 합성 records→flow.json/values.json 단정 +
    토큰화/마스킹/네비 wait/글롭/needs_review/@eN부재 + compile needs_review 거부). commit 9b44a40.
  - **P2.7/P3 한계 문서화(README "Capture scope & limitations")**: 단일탭, same-origin, 액션범위
    (scroll/hover/drag/upload 제외), 마스킹, needs_review 케이스(icon-only aria-label/dup-text grid/closed shadow),
    SPA pushState/hash vs pure-DOM, 데이터 무결성. commit (docs).
  - **suite 5/5 GREEN** (build-flow-unit, capture-healthcheck, capture-newtab, login, nav-roundtrip).
  - **P2.6 verify-repair**: **v2로 의도적 보류** — 근거: (a) 주 리스크(accname/role 발산)는 이미 capture.js
    WKIND가 role을 강등(testid/text/label 우선)해 완화됨, (b) compile→run.sh 라운드트립이 로케이터 실패의
    backstop, (c) 단계별 재생+복구는 run.sh를 복제하는 대형 신규 레이어 → KISS/YAGNI/기존구조우선 위배.
    design.md OPEN RISKS에 v2 TODO로 명시. 필요 시 다음 세션에서 별도 파일(bin/verify-flow.*)로 착수.
  - **남은 것**: #5(사람 녹화 round-trip)만 사람 필요 → 세션 종료 시 사용자에게 record.cmd 요청.
    probe-record.sh 313줄(목표~250 초과, 하드500 이내; 3모드 응집 dispatch라 분리 보류).
- 2026-06-03 (이어서): **적대적 코드리뷰(read-only WF, 19 에이전트) → 실버그 10건 확정 → 병렬 수정 → 검증.**
  - 리뷰(16제기/10확정/6기각): F1/F2 **직전에 넣은 P1.4 watch 루프가 Ctrl-C 정지를 깨뜨림**(INT trap이 루프를
    못 빠져나와 닫힌 브라우저에 스핀), F3 open실패시 오해성 "could not drain" 메시지, F4 trailing flag가 shift로 abort,
    F5 **크로스오리진 top-level nav가 이벤트 유실 + seq체크 우회(false-negative)**, F6 재사용세션 stale버퍼 replay,
    F7 미완성 flow.json이 나중 compile에 clean으로 수용, F8 빈캡처→vacuous always-green test, F9 auth폴링이
    로그인페이지에서 조기매칭(로그아웃 state 저장), F10 newtab테스트가 실 _flush_once 미검증. (6건 기각: seq/buf
    "freeze together" 주장 등 — nextSeq가 SEQ를 먼저/작게 쓰고 save가 BUF를 나중/크게 써서 비대칭 → seq>buf로 정상 감지.)
  - **병렬 구현 WF**: 3 에이전트가 독립 파일(probe-record.sh/auth.sh/test)을 동시 수정 + 적대적 verify(3 approved/0 must_fix).
    probe-record.sh: F1 `_stopped` 플래그(트랩이 set, 양 watch loop 첫 줄이 break), F3 트랩을 open 성공 후로 이동,
    F4 `[ $# -ge 2 ] || usage` 가드, F5 `_watch`(단일 tab list 호출로 newtab+crossorigin 동시 판정; about:/data:/chrome:
    스킴은 http(s) case로 걸러 false-trigger 방지), F6 시작시 buf/seq/prevurl 리셋, F7 fatal마다 `.incomplete`로 mv,
    F8 n==0 fail-loud. auth.sh: F9 `got!=LOGIN_URL` 가드 + usage 예시 비충돌로 교체. test: F10 구조적 가드(switch가 drain 전 존재).
  - **검증**: suite 5/5 GREEN(회귀). 라이브: F8(빈→exit1, flow미작성)✓ F5(크로스오리진 감지)✓ F9(조기매칭 차단·state미저장)✓
    F1(트랩+_stopped+break: SIGINT 전달시 ~1s 정지)✓. F7은 정적리뷰+F8(fail-loud-exit)+newtab스위트(감지·원탭drain)로 검증
    (n>0 격리 E2E는 F6 clear가 pre-seed를 지우고 실이벤트 구동이 racy/wedge라 비실용; mv는 자명).
  - **신규 footgun(2개)**: ① **헤디드 캡처를 연속/빠르게 돌리면 데몬 wedge** — `tab list`/`get url`이 건당 ~30s 행
    (os error 10060류). 라이브테스트의 F1=64s·F9=90s 지연 원인. 복구: ExecutablePath에 `\.agent-browser\browsers\`
    포함 chrome.exe(=Chrome-for-Testing)만 Stop-Process(Program Files chrome 절대 보존) + 데몬 kill →
    run.sh preflight 재워밍. ② **MSYS2: `kill -INT <bg_pid>`는 백그라운드 프로세스 트랩에 SIGINT 미전달**
    (실 Ctrl-C는 foreground group이라 정상 전달). SIGINT 자동테스트는 foreground 자식→부모 `kill -INT $$`로.
- 2026-06-03 (이어서): **P2.6 verify-repair 구현 (사용자 요청, 보류 해제). branch feat/verify-repair.**
  - **bin/verify-flow.sh** (신규): `probe-record.sh verify <flow>`로 호출. 캡처된 flow를 헤드리스 재생하며
    각 find step의 로케이터를 `find … hover`(비파괴)로 검증 → 실패 시 후보 사다리(candidates 사이드카)에서
    복구, 없으면 needs_review 승격 후 flow.json 재작성. lib/env.sh+assert.sh 재사용(bin→lib). 재생은 파괴적
    (동일빌드 replay, 부작용)·첫 미해결 step에서 정지(이후 미검증) — 의도된 동작. fill/select는 values.json 치환.
  - **build-flow.js**: `flows/<name>.candidates.json`(per-step 사다리) 사이드카 추가 — verify의 복구 소스. gitignore.
  - **probe-record.sh**: `verify` dispatch(→verify-flow.sh exec). **.gitignore**: `*.candidates.json`, `*.flow.json.incomplete`.
  - **버그 1건 자체발견·수정**: 빈 연관배열 `${#REPAIR[@]}`가 `set -u`에서 unbound → 카운터 가드(`repaired+promoted`)로 교체.
  - **검증**: 3 경로 라이브(repair rc0 / verified rc0 / promote rc1) ✓. tests/verify-flow.test.sh(repair+promote, 헤드리스)
    추가, **suite 6/6 GREEN**. 적대적 리뷰 진행(verify-flow.sh 집중).
  - **잔여 한계**: cardinality≠identity — hover로 해결돼도 wrong-element 가능(0.27.0 시맨틱 count 프리미티브 부재);
    round-trip이 backstop. design.md OPEN RISKS 갱신.

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
