# build-agent-qa-framework — Tasks

Last Updated: 2026-06-01

## Phase 상태

- Phase 0 — Layer 1 스파인: **DONE (2026-06-01, end-to-end 그린)**
- Phase 1 — human-loop + auth 캐싱: **DONE (2026-06-01, state save/load 스모크 검증)**
- Phase 2 — AI authoring(Layer 2): **DONE — compile 경로 검증, discover(chat)는 키 대기**
- Phase 3 — 삼성 실전: PENDING (사용자 OTP 입력 필요 = 대화형, 핸드오프 지점)

---

## phase-0 — Layer 1 스파인 (MVP) — DONE

- [x] P0-1 프로젝트 스캐폴드 + agent-browser.json + .gitignore + .gitattributes(LF) + README.md
- [x] P0-2 lib/preflight.sh — ffmpeg 절대경로 주입 + 1초 record 스모크(HARD-FAIL) + --json contract self-test + warm
- [x] P0-3 lib/env.sh — S/ARTDIR/AB()/AB_JSON()/BATCH()+_batch_check(.success 파싱)
- [x] P0-4 lib/cleanup.sh — EXIT trap(record stop + session close, rc 보존)
- [x] P0-5 lib/assert.sh — assert_text/url/visible/value/count/absent/no_snapshot_change(전부 --json .success 파싱)
- [x] P0-6 lib/report.sh — report.json + report.junit.xml + 콘솔 테이블(awk count로 산술버그 수정)
- [x] P0-7 run.sh — preflight→warm→tests 순회(격리 subshell)→집계→리포트→close --all, 실패시 exit 1
- [x] P0-8 tests/login.test.sh — example.com 여정(find "Learn more"→iana.org 게이트) 그린
- [x] P0-9 `bash run.sh login` end-to-end 그린: exit 0, video.webm(VP8 35.7s 191KB ffprobe유효) + report.json + junit.xml

검증 로그: 첫 실행서 find 텍스트 오타("More information")가 _batch_check로 정확히 fail 검출 →
검증 모델(exit code 아닌 .success 파싱)이 실증됨. 텍스트 수정 후 그린.

### 작업 전 필독
- plan: phase-0 acceptance/검증 게이트
- context: "중요한 의사결정(footgun)" 전체 — 위반 시 silent false-green 발생

### 원본 코드 참조
- 신규 — 기존 코드 없음. agent-browser 명령 레퍼런스: `agent-browser skills get core --full`
- 환경 절대경로: context.md "환경 절대경로"

### 구현 대상
- lib/*.sh(5), run.sh, tests/login.test.sh, 설정/문서 파일

### 검증 참조
- `bash -n <file>` 전 파일 구문검사
- preflight 단독: `bash lib/preflight.sh` → 실제 .webm 생성 확인
- `bash run.sh` → exit 0, artifacts + report.json + report.junit.xml

### 문서 반영
- 완료 시 context SESSION PROGRESS, tasks 체크박스, plan Last Updated 갱신

---

## phase-1 — human-loop + auth 캐싱 — DONE

- [x] P1-1 setup/auth.sh — 범용(APP/LOGIN_URL/SUCCESS_URL env) headed wait-for-human(OTP) → state save.
      크로스오리진 OTP iframe 우회 위해 wait --url 성공게이트 사용.
- [x] P1-2 lib/env.sh에 AB_AUTH <app> 헬퍼 추가 — fixtures/auth/<app>.state.json 자동 --state 주입,
      없으면 loud fail. state save/load 비대화형 스모크 검증 통과.
- [~] P1-3 confirm-gate: YAGNI로 보류(실제 파괴적 클릭 테스트 생길 때 추가). agent-browser --confirm-actions 네이티브 존재.
- [~] P1-4 diff baseline: assert_no_snapshot_change가 이미 lib/assert.sh에 있음(diff snapshot --json .changed).
      baseline 캡처는 실제 테스트 생길 때. README에 사용법 명시.

### 작업 전 필독
- context: 크로스오리진 iframe 한계 → wait --url 성공게이트 우회

### 구현 대상
- setup/auth.<app>.sh, baselines/, 두 번째 테스트

### 검증 참조
- auth 1회 실행 → state.json 생성 → 그 state로 무인 재생 그린

### 문서 반영
- Phase 0→1 상태 전환, context 갱신

---

## phase-2 — AI authoring (Layer 2, opt-in) — DONE (compile 검증, discover 키 대기)

- [x] P2-1 flows/SCHEMA.md — flow.json 스키마(NO @eN field, find/wait step + assert kinds). 로케이터 우선순위 명시.
- [x] P2-2 bin/probe-record.sh — 2모드: `compile <flow.json>`(결정적, 키 불요, 핵심) + `discover`(chat, 키 필요).
      compile은 flow.json→하네스 호환 .test.sh 생성. standalone leaf(back-import 없음).
- [x] P2-3 검증: 손으로 쓴 login.flow.json → compile → 생성된 .test.sh가 run.sh서 실제 그린(exit 0). codegen 실증.
- [BLOCKED] discover(AI chat) 실동작: AI_GATEWAY_API_KEY가 현재 셸에 없음.
      설계상 정직하게 처리: chat trace 저장 후 사람이 flow.json 확정→compile에서 멈춤(잘못된 flow silent 생성 방지).
      키 생기면: chat --json -v trace 형태 실측 → 자동 변환(harden) 추가. 그 전엔 추측 변환 금지(문제은폐 회피).

### 작업 전 필독
- context: 로케이터 우선순위 testid>role+name>label>text>placeholder>title>css, get count --json==1

### 구현 대상
- bin/probe-record.sh, flows/ 스키마, 샘플 flow.json

### 검증 참조
- 생성된 .test.sh가 결정적 그린, .flow.json에 @eN field 없음

### 문서 반영
- Phase 2 상태, context 의사결정 갱신

---

## phase-3 — 삼성 실전

- [ ] P3-1 setup/auth.samsung.sh — 사용자 OTP 입력 → state 캐싱
- [ ] P3-2 tests/samsung-visit.test.sh — 내방신청 폼(캐시 state)
- [ ] P3-3 자멸 없이 실행 + 비디오/리포트 산출 확인

### 작업 전 필독
- context: 삼성 사이트 alert→창닫기 이력(workflow-use 자멸 원인). agent-browser는 자멸 클래스 없음.

### 구현 대상
- setup/auth.samsung.sh, tests/samsung-visit.test.sh

### 검증 참조
- 캐시 state로 OTP 재입력 없이 폼 테스트 그린

### 문서 반영
- Phase 3 완료, 전체 작업 완료 시 dev/active → 정리
