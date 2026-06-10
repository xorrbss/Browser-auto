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

## 6. 별도 발견 (이 브랜치 범위 밖) — 모든 스텝이 ×2로 중복 녹화됨
- 증상: 녹화본의 모든 액션이 정확히 2회씩(갱신 ×2, textbox ×2, 검색 ×2 …).
- 추정 근본 원인: argos `menuByUserDatail`이 iframe을 동적 생성(src 로드 전 **`about:blank`** 단계).
  `about:blank`/opaque-origin 프레임은 **부모의 sessionStorage를 공유**하는데, `dedupeByOrigin`
  ([bin/pw-record.mjs:119](bin/pw-record.mjs#L119))이 opaque origin을 `null`→full-url로 **따로 키잉** →
  공유 버퍼가 rep 2개로 잡혀 **flatMap에서 두 번 concat → 모든 이벤트 ×2**.
- 확진 조건: dup 쌍의 `seq`/`timestamp_ms`가 동일하면 확정(= 동일 이벤트 중복). raw records.json 부재로
  라이브 녹화 1회 또는 frame 목록 캡처 필요.
- 제안 수정(별도 작업): `dedupeByOrigin`이 `about:blank`/srcdoc처럼 **부모 storage를 상속하는** 프레임을
  부모 파티션으로 인식(부모 origin으로 키잉)하도록. sandboxed/`data:`(독립 storage)와는 구분 필요.
- ⚠️ 폴백 로케이터 기능과 무관. 별도 커밋/브랜치 권장.

## 7. 다음 작업 메모 (마스터에서)
- 김택균 요청: **연세우유 비타민플러스 쿠팡 리뷰 "퍼오는"(스크레이프) 테스트**. 먼저 **소스 새로 pull**(개발자 추가 수정 많음).
