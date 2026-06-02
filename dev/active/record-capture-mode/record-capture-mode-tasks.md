# record-capture-mode — Tasks

Last Updated: 2026-06-02

## Phase 상태

- Phase 0 — PoC(게이팅 리스크 제거): **DONE (2026-06-02, PASS)**
- Phase 1 — 캡처 레코더(bin/capture.js): **DONE (2026-06-02)**
- Phase 2 — 호스트 capture() + compile 변경: **DONE (2026-06-02)** — needs_review 가드/토큰 치환/build-flow.js
- Phase 3 — round-trip 검증: **DONE (2026-06-02, run.sh PASS exit 0)**
- Phase 3.1 — **네비 wait 신뢰성 수정 + 멀티스텝-네비 재생: DONE (2026-06-02, run.sh PASS)**

> ✅ **`wait --url` 글롭 버그 수정**: agent-browser 0.27.0 `wait --url`은 글롭(`*`/`**`)에서 `os error 10060`로
> 깨짐(평문 substring만 동작). → `wait_url` get-url 폴링 헬퍼(lib/assert.sh, assert_url과 `_url_match` 공유) +
> compile()이 url-wait 경계마다 batch 분할(`_run_batch`/`wait_url` 교차 방출). **멀티스텝-네비 round-trip GREEN**
> (flows/nav-roundtrip: example→iana 글롭 wait + 네비후 세그먼트). 전체 suite 2/2 GREEN. 스크래치 삭제, nav-roundtrip 영구 유지.
> 상세는 context.md SESSION PROGRESS 2026-06-02 마지막 3개 엔트리.

> ✅ **end-to-end round-trip 그린**(b7riprx5w): 실제 CDP 클릭 → capture.js 기록 → build-flow → compile
> → run.sh **PASS**. 검증 중 **실측 버그 발견·수정**: agent-browser 0.27.0 `find role --name`이 요소를
> 못 찾음(heading+link, 정확한 이름에도; `--json`으로 success:false 확인). `find text|label|placeholder|testid`는
> 동작. → capture.js 가중치를 엔진-지원 로케이터 우선으로 재조정(role 강등). `find ... hover --json`이
> 비파괴 검증 프리미티브로 확인됨(v2 verify-repair replay의 토대).
>
> **남은 v1 한계(미검증/문서화)**: ① 사람이 직접 헤디드로 끌고 Enter로 멈추는 실사용 경로는 메커니즘
> 조각만 검증(합성클릭 자동화는 타이밍상 racy). ② 멀티스텝/네비 저널은 build-flow 단위테스트만(통합 미검증).
> ③ icon-only 버튼(텍스트 없음, aria-label만)은 role 강등으로 needs_review 가능. ④ 크로스오리진/새탭 OUT.
> ⑤ **v2 robust 수정**: 캡처 후 flow를 단계별 재생하며 각 로케이터를 `find hover --json`으로 검증·복구.

> ⚠️ WF-1 이후 설계가 갱신됨 — **record-capture-mode-design.md가 구현 단일 레퍼런스**.
> 로케이터 경화/유일성/마스킹/네비마커는 in-page(capture.js, 완료)로 이동했고,
> 호스트는 open+inject+poll+drain+trap+flow.json빌드(토큰화+사이드카)+compile가드를 담당.

---

## phase-0 — PoC: addinitscript 리스너 캡처+네비 보존 증명

- [x] P0-1 `--init-script`로 click 리스너 주입 → `window` + `sessionStorage` 누적 JS 작성 (poc-capture.js)
- [x] P0-2 agent-browser로 example.com open + init-script 주입 → `click h1`로 실클릭 구동
- [x] P0-3 `eval --json`으로 캡처 배열 회수 → 클릭 이벤트 1건 확인 (tag:H1, text:"Example Domain")
- [x] P0-4 ?nav=1로 같은-오리진 네비게이션 → 리스너 재주입 확인 + sessionStorage 이전 이벤트 보존 확인 + 재캡처(2건)
- [x] P0-5 판정: **PASS** — 캡처+보존+재캡처 모두 OK. CDP 폴백 불요. Phase 1 진행.

> 실측(brg25r4fo): step4 클릭1건, step7 네비후 보존, step9 네비후 클릭2건째 누적. **핵심 footgun 발견:
> cold-spawn agent-browser를 `| tail`/`$()`로 받으면 daemon이 stdout fd를 물어 hang.
> → 파일 redirect(`>"$T/o" 2>&1 </dev/null`) 또는 daemon 워밍 후 cmdsubst 사용. (poc-run.sh 참조)**

### 작업 전 필독
- plan: Phase 0 검증 게이트, R1
- context: 캡처=addinitscript / 보존=sessionStorage 의사결정
- seed: exit_conditions.poc_validated

### 원본 코드 참조
- agent-browser 명령: `agent-browser --help`, 기존 실측(eval/addinitscript/--state)은 build-agent-qa-framework-context.md "환경 절대경로"
- 기존 주입 예시 없음(신규). lib/env.sh의 AB()/AB_JSON() 호출 패턴 참고

### 구현 대상
- 임시 PoC 스크립트(검증용, 통과 후 Phase 1에 흡수). 캡처 JS 초안.

### 검증 참조
- `eval --json`이 click 이벤트 + 네비 후 보존 이벤트를 모두 반환 → 통과

### 문서 반영
- 결과(통과/폴백)를 context SESSION PROGRESS + 이 파일 Phase 상태에 기록

---

## phase-1 — 캡처 코어 (capture 모드 dispatch)

- [ ] P1-1 bin/probe-record.sh에 `capture <name> <startUrl> [--app <app>]` dispatch + usage 추가
- [ ] P1-2 `--app` 있으면 lib/env.sh source 후 AB_AUTH로 캐시 state open, 없으면 일반 open
- [ ] P1-3 addinitscript로 캡처 JS 영구 주입(Phase 0 JS 채택), startUrl open
- [ ] P1-4 CLI-신호 stop(Enter 입력/trap INT): 사용자 조작 동안 대기 → 신호 시 종료 절차
- [ ] P1-5 종료 시 `eval`로 sessionStorage 캡처 buffer flush → 원시 이벤트 JSON으로 덤프, 그 다음 브라우저 close
- [ ] P1-6 `bash -n` 통과 + 수동 1회 실행으로 원시 이벤트 파일 생성 확인

### 작업 전 필독
- plan: Phase 1, R5(파일 비대 시 JS 분리)
- context: 종료=CLI 신호(브라우저-닫기 금지), bin→lib source 허용

### 원본 코드 참조
- bin/probe-record.sh 기존 dispatch(scaffold/compile)·usage()·PROBE_ROOT 패턴
- lib/env.sh: AB_AUTH 구현

### 구현 대상
- bin/probe-record.sh(capture 모드), 필요 시 bin/capture.js

### 검증 참조
- `bash -n bin/probe-record.sh`; capture 실행→종료→원시 JSON 존재

### 문서 반영
- Phase 1 완료 상태, context 갱신

---

## phase-2 — 로케이터 경화 + flow.json 방출 + 스키마 확장

- [ ] P2-1 캡처 JS에 in-page 로케이터 계산 추가: testid>role+name>label>text>placeholder 순, 각 후보 산출
- [ ] P2-2 호스트에서 `get count --json`==1로 유일성 검증, 최상위 유일 후보 채택
- [ ] P2-3 유일 로케이터 미달 → `needs_review:true` + candidates(≥2) step 방출(fail-loud), 녹화는 계속
- [ ] P2-4 원시 이벤트 → flows/<name>.flow.json 변환(SCHEMA.md 준수: find/wait/asserts, @eN 없음)
- [ ] P2-5 네비게이션 경계마다 `wait until:url` 자동삽입, 종료 URL `assert url` 자동추가
- [ ] P2-6 `type=password` 입력값 마스킹/생략
- [ ] P2-7 flows/SCHEMA.md에 `needs_review`+`candidates` 확장 문서화 + compile이 needs_review 거부(비0 종료)하도록 보강

### 작업 전 필독
- plan: Phase 2, R2(로케이터 품질), R3(SPA 네비)
- context: 로케이터 우선순위·유일성, needs_review fail-loud, 보안 마스킹
- flows/SCHEMA.md 현행 + seed.ontology_schema(RecordedAction 필드)

### 원본 코드 참조
- flows/SCHEMA.md 현행 스키마(find by/action, wait until, asserts kind)
- bin/probe-record.sh compile 로직(생성 flow.json이 그대로 흘러야 함)

### 구현 대상
- bin/probe-record.sh(또는 bin/capture.js), flows/SCHEMA.md

### 검증 참조
- 생성 flow.json: `jq`로 필수 필드 검증, `@eN`/password 부재 grep 0건
- needs_review 포함 flow.json을 compile → 비0 종료(거부) 확인

### 문서 반영
- Phase 2 완료, context 의사결정/스키마 변경 기록

---

## phase-3 — round-trip 검증 (clean 녹화 → compile → run.sh 그린)

- [ ] P3-1 범용 공개 사이트로 clean 녹화 1건(needs_review 0) 캡처
- [ ] P3-2 `compile flows/<name>.flow.json` → tests/<name>.test.sh
- [ ] P3-3 `bash run.sh <name>` exit 0 + report.json green(비디오/리포트 산출)
- [ ] P3-4 README에 capture 워크플로 문서화(scaffold/compile 옆에)

### 작업 전 필독
- plan: Phase 3 검증 게이트, 완료기준(round-trip)
- context: 검증=--json .success, 완료기준

### 원본 코드 참조
- README.md "Authoring a test" 섹션(capture 추가 위치)
- run.sh 실행 패턴

### 구현 대상
- README.md, (검증용) flows/tests 산출물

### 검증 참조
- `bash run.sh <name>` exit 0, report.json green = round-trip 완료

### 문서 반영
- Phase 3 완료. 전체 완료 시 dev/active 정리 + dev/process 락 삭제
