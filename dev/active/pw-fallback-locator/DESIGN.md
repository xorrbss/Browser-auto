# Playwright 폴백 로케이터 (pw-fallback-locator)

> 워크스트림 노트 (runtime code 아님). 브랜치: `feat/pw-fallback-locator`.
> 컨텍스트 압축 대비용 — 이 파일이 작업의 단일 진실원. 진행하며 계속 갱신.

## 1. 목표
Samsung argos(jWork jGrid 기반) 여정을 **agent-qa(Playwright 엔진)에서 녹화 → 검증 → 재생**까지 되게.
풀프로덕트 동작이 목표.

## 2. 문제 / 근본 원인 (증거로 규명됨)
- argos 검색결과 행 = **jWork jGrid** (`jwork-ui-jgrid`). 행/셀이 `role`/`name`/`label`/`testid` 없는 generic `<div>`
  (`.grid-row-rendered`/`.grid-cell`/`.grid-type-cell-label`/`.underline-cell`), 가상화(보이는 행만 DOM), 캔버스 아님.
- agent-qa 레코더가 시맨틱 로케이터를 못 뽑음 → 후보 0개(`candidates:[]`) → `needs_review`.
- needs_review는 fail-closed. UI가 주는 유일 해결책 "클릭한 행 위치로 열기"(open_record)도
  `flows/<name>.snapshot.txt` 필요 → **pw-record.mjs가 snapshot 미생성**(`grep -c snapshot bin/pw-record.mjs`=0;
  agent-browser 경로 `bin/probe-record.sh:69`만 생성) → "missing snapshot" 에러 → **완전 막힘**.
- 비교: 다른 프로젝트(ibiztest = `@playwright/mcp`+크롬확장, `C:/Users/admin/playwright_test_clone/playwright_test`)는
  스텝마다 `selectorCandidates`에 **role/css/xpath/id/attr + 좌표(position)** 폴백을 기록 → 시맨틱 없는 그리드 셀도 클릭 가능.
  → **핵심 차이 = agent-qa는 시맨틱 로케이터만(css/xpath/좌표 폴백 없음).**

### 현재 녹화본 진단 (flows/guest_samsungdisplay_com_argos_main_do.flow.json, 사용자 재녹화)
- 스텝 1·2(idx 0,1): `needs_review`, `candidates:[]`, frame/by 없음 = **최상위 페이지 첫 두 클릭(출입신청 메뉴 추정)** 인데 로케이터 0개.
  → 1번=첫 클릭(`dynamicFirst`), 2번=needs_review 클릭 → 둘 다 "클릭한 행 위치로 열기"만 떠서 missing-snapshot 에러.
- "해결된" 스텝들도 깨짐: 갱신(count:2 모호), textbox/combobox(count:0 매칭없음). 다음/등록완료/검색만 count:1 정상.
  → **count≠1 전반이 문제.** 폴백을 "후보 0개"뿐 아니라 **count≠1**에도 적용해야 진짜 재생됨.

## 3. 해결 방향 = (A) 범용 폴백 로케이터
agent-qa의 **Playwright 엔진 코드를 직접 확장** (개발자 승인: "필요하면 playwright 수정해라 / 직접 수정해서 없는 기능 되게").
agent-browser는 외부 CLI 도구라 포크가 필요했지만, Playwright 엔진은 이 repo가 직접 소유 → 더 쉬움.
- **시맨틱 우선 유지.** 시맨틱 후보가 count≠1로 다 실패할 때만 **최후 폴백** 생성: `text-xpath → css` 순.
  - text-xpath: `xpath=//*[normalize-space(.)='…']` 류 (텍스트 앵커 — 그나마 덜 깨짐)
  - css: 고유 구조 경로 (최후의 최후)
- **needs_review 표시는 유지** (구조 의존 = 페이지 변경에 취약함을 사용자가 알게). CLAUDE.md "시맨틱-only" 철학 최대한 보존.

## 4. 구현 범위 (파일)
- `bin/capture.js` / `bin/pw-record.mjs`: 후보 생성에 text-xpath→css 폴백 추가 (count≠1일 때).
- `flows/SCHEMA.md`: `by: "css"`, `by: "xpath"` 추가 (시맨틱 아래 우선순위 문서화).
- `bin/play-flow.mjs`: `by:css`→`locator(css)`, `by:xpath`→`locator('xpath=…')` 해석 (frame 스코프 유지).
- (선택) `webui/flows.js` 검증/리페어 경로가 새 by 종류를 거부 안 하도록 점검.

## 5. 검증 (AI-free 결정적 — 프레임워크 핵심 규칙)
1. **로컬 jGrid 재현 픽스처** HTML (로그인 불필요) — jwork-ui-jgrid DOM 구조 모사. 현 버그(candidates:[]) 먼저 재현.
   - 후보지: `tests/fixtures/` 또는 `fixtures/rpa/` (개발자가 0273337에서 로컬 fixture 하네스 추가함 — 재사용 검토).
2. **유닛 테스트**: 후보 생성이 폴백을 내는지 (시맨틱 있으면 폴백 안 냄 / 없으면 text-xpath→css).
3. **러너 테스트**: 픽스처 대상으로 `by:css`/`by:xpath` flow가 실제 클릭/재생되는지.
4. **라이브 argos e2e**: 사용자가 로그인 후 1회 end-to-end 확인.

## 6. 머지 전략
- 브랜치 `feat/pw-fallback-locator` → 커밋 → **PR로 개발자 리뷰** (설계 규칙 완화라 master 직푸시 안 함).
- 푸시는 MCP 도구(`mcp__jwork-workflow__git_push`), 커밋도 MCP(`git_commit`) — 한글 인코딩 안전.

## 7. 진행 체크리스트
- [x] 브랜치 생성
- [x] 1·2번 스텝 진단 (사용자 선확인) — 위 §2 결과
- [x] 핵심 코드 파악: 러너 `by`→로케이터는 `approve/flow-runner.mjs` `buildLocator`; 후보생성은 `bin/capture.js` `candidatesFor`(시맨틱만)
- [x] **Stage 1 (런타임 + 스키마 + 테스트) — 완료/green**
  - `approve/flow-runner.mjs`: `FIND_BY`에 css/xpath 추가, `buildLocator`에 `scope.locator(css)` / `locator('xpath=…')` (frame 스코프 유지, count===1 fail-closed 그대로)
  - `flows/SCHEMA.md`: `by:css`/`by:xpath` "Fallback locators" 섹션 추가 (semantic-first, needs_review, @eN과 구분)
  - `tests/flow-runner-unit.test.sh`: css/xpath validate+dispatch+iframe+non-unique fail-closed 단언 추가 (옛 "css 거부" 단언 → "frob 거부"로 교체)
  - `tests/pw-fallback-locator-e2e.test.sh` (신규): 로컬 jWork jGrid 픽스처(순수 div, no role/testid) — by:xpath/by:css가 실제 행 클릭 → status:ok. Playwright 없으면 graceful skip
  - 회귀 확인: flow-runner-unit / pw-fallback-locator-e2e / compile-engine-unit / build-flow-unit / webui-flows-unit / engine-unit 전부 ✓
- [x] **Stage 2 (레코더 자동 폴백) — 완료/green**
  - `bin/capture.js`: `countCandidate`에 css/xpath 카운팅(document.querySelectorAll / document.evaluate, 가시성 필터) 추가; `fallbackCandidates`(text-anchored xpath → unique css path) 헬퍼; `emit`이 **시맨틱 primary가 없을 때만** 폴백을 count===1 검증 후 후보 ladder에 추가 — **primary 자동승격 금지(needs_review 유지)**
  - `build-flow.js`/`webui/flows.js` 점검 결과: by-종류 화이트리스트 없음 — needs_review 스텝의 candidates로 그대로 통과, `resolveStep`이 `step.by=cand.by`로 기록(거부 안 함). **변경 불필요**
  - `tests/capture-e2e.test.sh`: jGrid 케이스(13) 추가 — no-semantic 셀 클릭 → 폴백 xpath 자동생성 → needs_review 스텝이 후보 보유 → resolve 시 validate 통과. 기존 12케이스 무회귀
  - **전체 스위트 35/35 통과**
- [ ] 라이브 argos e2e(사용자 로그인) → PR

### 남은 것 = 라이브 검증뿐. 코드/테스트는 Stage1+2 완료. webui 녹화→리뷰에서 jGrid 셀이 이제 css/xpath 후보를 제시(깨진 "행 위치로 열기" 대신 클릭 가능한 대안).

### 참고: Stage 1 = 런타임 절반(재생 시 css/xpath 동작). Stage 2 = 레코더가 그 후보를 자동 생성(손수 작성 불요).
### 현재: hand-authored css/xpath flow는 이미 재생됨. 자동 생성(Stage 2) 후 webui 녹화→리뷰에서 바로 선택 가능.

## 8. 참고 (file:line)
- 에러 발생점: `webui/flows.js` resolveClickedRecordStep, "missing snapshot" (현재 ~384줄)
- 행-버튼 렌더: `webui/public/app.js` `dynamicFirst`(첫 클릭) + needs_review 클릭 → `resolveAutomationClickedRecord`
- agent-browser snapshot 생성(참고 패턴): `bin/probe-record.sh:69`
- 로케이터 우선순위 규칙: `CLAUDE.md`, `flows/SCHEMA.md:76` (testid>role+name>label>text>placeholder>title)
- 사용자 녹화본: `flows/guest_samsungdisplay_com_argos_main_do.flow.json` (+ `.candidates.json`)
  - 로컬 백업: `.preMerge.localbak`, `.80step.localbak`, `.localbak` (gitignore 안 됨, 커밋 금지)

## 9. 주의
- 사용자 녹화본(flow.json은 working-tree M 상태)·`*.localbak`은 **커밋하지 말 것**. 내 변경(코드/픽스처/테스트/문서)만 커밋.
- 로그인/OTP는 사용자만 가능. 라이브 e2e는 사용자 협조 필요. 개발은 로컬 픽스처로 진행.
