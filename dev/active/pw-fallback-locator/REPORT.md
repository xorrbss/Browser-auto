# 보고서 — Playwright css/xpath 폴백 로케이터 (jWork jGrid 블로커 해결)

브랜치: `feat/pw-fallback-locator` (master `0273337` 기준) · 커밋 `5c61d32`, `ae464ed`
작성: 2026-06-10

## 1. 배경 / 문제
Samsung argos 게스트 포털의 검색결과 목록은 **jWork jGrid**(`jwork-ui-jgrid`). 행/셀이
`role`/accessible-name/`label`/`testid` 없는 **generic `<div>`**(`.grid-row-rendered`/`.grid-cell`/
`.grid-type-cell-label`/`.underline-cell`, 가상화, 캔버스 아님). 그래서 클릭 시 레코더가
**시맨틱 로케이터 후보를 0개**(`candidates:[]`) 생성 → `needs_review` → UI가 주는 유일한 해결책
"클릭한 행 위치로 열기"(open_record)마저 `snapshot.txt` 부재로 깨짐 → **여정이 리뷰 단계에서 100% 막힘**.

근본 차이: 다른 도구(ibiztest=`@playwright/mcp`+크롬확장)는 시맨틱 실패 시 `css`/`xpath`/좌표 폴백을
기록해 그리드 셀도 클릭 가능. **agent-qa는 설계상 시맨틱 로케이터만** 허용 → 폴백 부재가 블로커의 본질.

## 2. 해결 (개발자 승인: "필요하면 playwright 수정 / 직접 수정해서 없는 기능 되게")
agent-qa의 Playwright 엔진 코드에 **최후 폴백 로케이터 `css`/`xpath`**를 추가. **시맨틱 우선 유지**,
폴백은 시맨틱이 모두 실패할 때만, **needs_review로 표시**(자동 primary 승격 금지)해 철학을 최대한 보존.

### Stage 1 — 런타임 + 스키마 (커밋 `5c61d32`)
- `approve/flow-runner.mjs`: `FIND_BY`에 css/xpath 추가, `buildLocator`가 `scope.locator(css)` /
  `locator('xpath=…')` 처리(frame 스코프 유지). 효과적 스텝의 **count===1 fail-closed 가드 그대로**.
- `flows/SCHEMA.md`: "Fallback locators" 섹션(semantic-first · needs_review · `@eN`과 구분 · text-xpath 권장).
- `tests/flow-runner-unit.test.sh`: css/xpath validate+dispatch+iframe+non-unique fail-closed.
- `tests/pw-fallback-locator-e2e.test.sh`(신규): 로컬 jGrid 픽스처(순수 div) — by:css/xpath가 실제 행 클릭 → ok.

### Stage 2 — 레코더 자동 폴백 (커밋 `ae464ed`)
- `bin/capture.js`:
  - `countCandidate`에 css/xpath 카운팅(querySelectorAll/evaluate, 가시성 필터 — replay와 동일 엔진).
  - `fallbackCandidates`: **text-anchored xpath**(레이아웃 변화에 강함) → unique css path 순.
  - `emit`: **시맨틱 primary가 없을 때만**, count===1·on-target일 때만 폴백을 후보 ladder에 추가.
    primary로 자동승격 안 함 → 스텝 needs_review 유지(웹UI가 선택지로 노출).
- `tests/capture-e2e.test.sh`: jGrid 케이스(13) — no-semantic 셀 클릭 → 폴백 xpath 자동생성 →
  needs_review 스텝이 후보 보유 → 그 후보로 resolve 시 validate 통과.
- `build-flow.js`/`webui/flows.js`는 by-종류 화이트리스트가 없어 **변경 불필요**(needs_review candidates로
  통과, `resolveStep`이 `step.by=cand.by`로 기록).

## 3. 검증
- **전체 스위트 35/35 통과(0 실패).** 핵심 레코더(capture.js) 변경에도 회귀 0.
- 신규/수정 테스트는 전부 AI-free·결정적(로컬 픽스처, 로그인 불필요). Playwright Chrome 없으면 graceful skip.

## 4. 사용자 체감 변화
argos 그리드 행 녹화 시: 예전 `candidates:[]` + 깨진 "행 위치로 열기"만 → 이제 **`xpath`/`css` 후보 버튼**이
뜸(예: `//div[contains(@class,'underline-cell') and normalize-space(.)='신청서 B']`). 클릭해 resolve → 컴파일·재생.

## 5. 남은 것
- **라이브 argos e2e**(사용자 로그인 필요): webui 서버 재시작 + Ctrl+F5 후 그리드 재녹화 → 후보 확인 → resolve → 재생.

## 6. 별도 발견 — 레코더 품질 버그 3건 (이 브랜치 범위 밖, dev측 수정 영역)
argos 녹화본(`flows/guest_samsungdisplay_com_argos_main_do.flow.json`)을 리뷰하며 확인. **셋 다 폴백
로케이터 기능과 무관**하나, 폴백이 스텝들을 resolve 가능하게 만들면서 기존에 숨어있던 갭이 드러남.
각각 별도 커밋/브랜치 권장.

### 6-1. needs_review fill/input 스텝이 값 토큰(`{{input_N}}`)을 잃음 → 컴파일 실패 (가장 시급)
- 증상: 검증/컴파일 시 `invalid steps: step N: fill requires a non-empty text (the recorded value/token)
  — refusing to replay an empty fill` (flow-runner.mjs:44 안전 가드).
- 확정 원인: 입력칸이 캡처 때 `role:textbox` **count:0**(고유 식별 실패) → fill 레코드가 insufficient →
  needs_review. `build-flow.js`는 값은 `values.json`에 예약(`token()`, input_1..7 = 유승현/sh.yo/날짜/Y)
  했지만, **needs_review 분기([build-flow.js:97-108](bin/build-flow.js#L97-L108))가 `extra`(text 토큰)를
  누락**(resolved 분기 113줄만 `Object.assign(step, extra)`). 이후 `resolveStep`(webui/flows.js)이 로케이터를
  resolve해도 **text는 복원 안 함** → fill 스텝에 채울 값 없음 → 컴파일 거부.
- 즉 값은 `values.json`에 고아로 남고 스텝은 그걸 못 가리킴.
- 제안 수정: `actionFind`의 needs_review 분기도 input fill에 한해 `text` 토큰을 유지(멀티셀렉트는 현행대로
  제외). select-multiple은 line 212-213에서 extra 없이 호출하므로 "extra 있으면 유지"는 안전.

### 6-2. 모든 스텝 ×2 중복 녹화
- 증상: 모든 액션이 정확히 2회씩(갱신 ×2, textbox ×2, 검색 ×2 …; `values.json`의 input_1·2 둘 다 "유승현").
- 추정 원인: argos `menuByUserDatail`이 iframe 동적 생성(src 로드 전 **`about:blank`** 단계). `about:blank`/
  opaque-origin 프레임은 **부모 sessionStorage 공유**인데 `dedupeByOrigin`([bin/pw-record.mjs:119](bin/pw-record.mjs#L119))이
  opaque origin을 `null`→full-url로 **따로 키잉** → 공유 버퍼가 rep 2개 → flatMap에서 두 번 concat → ×2.
- 확진: dup 쌍의 `seq`/`timestamp_ms` 동일하면 확정. raw records.json 필요(라이브 1회).
- 제안 수정: `dedupeByOrigin`이 `about:blank`/srcdoc(부모 storage 상속)을 부모 파티션으로 인식. sandboxed/`data:`
  (독립 storage)와는 구분.

### 6-3. 로딩 오버레이(`div.blockUI`) 오클릭 캡처
- 증상: 녹화본 step 4·5가 `by:css "div.blockUI:nth-of-type(25)"` 클릭 — blockUI는 jQuery BlockUI 로딩 오버레이.
- 원인: 페이지 전환 로딩 순간의 클릭이 오버레이에 잡힘. 재생 시 오버레이가 없거나 위치가 달라 오클릭/실패 소지.
- 제안: 레코더가 알려진 오버레이(blockUI 등) 클릭을 무시/경고하거나, 폴백 css가 휘발성 오버레이를 타깃하지
  않도록 가드(`looksAuto`류에 nth-heavy 오버레이 클래스 추가 검토).

## 7. 다음 작업 메모 (마스터에서)
- 김택균 요청: **연세우유 비타민플러스 쿠팡 리뷰 "퍼오는"(스크레이프) 테스트**. 먼저 **소스 새로 pull**(개발자 추가 수정 많음).
