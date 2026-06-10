# 보고서 — 비(非)테이블 카드형 목록 추출 갭 (쿠팡·네이버 리뷰)

- 날짜: 2026-06-10
- 환경: 최신 master `94572ca`
- 요청(김택균): "연세우유 비타민플러스 쿠팡 리뷰 퍼오는(스크레이프) 테스트"

## 1. 결론
agent-qa의 데이터 수집(`bin/extract-list.js`)은 **ARIA table 전용**이라, 쿠팡·네이버 리뷰처럼
**카드형 목록은 추출 불가**. 데이터 자체는 구조적으로 식별 가능하므로, 필요한 것은 *사이트별 코드*가
아니라 **"구조 전략(table / card-list) + 안정-앵커 필드매핑"을 recipe로 선언**하는 일반화.

## 2. 테스트 & 로그 (쿠팡, 실제 실행)
webui 연결시스템에 `coupang_review` 등록(target URL + recipe) → 인증(쿠키 storageState 저장) → 동기화(j18):
```
[sync-system] 'coupang_review' -> launching Playwright (cached auth)...
[sync-system] navigating to target...
[sync-system] landed: https://www.coupang.com/vp/products/7492501123...#sdpReview
extract-list: table "리뷰 목록" not found        (×24, pagination settle 재시도)
[pw-rpa] FATAL: sync pagination page 1 did not settle
  (extract-list failed: extract-list: table "리뷰 목록" not found);
  refusing to store partial pagination results (fail-closed)
```
→ auth·네비게이션은 통과, **추출 단계에서 "ARIA 테이블 0개"로 fail-closed**.

## 3. 원인
`bin/extract-list.js` = *"GENERIC recipe-driven **aria-table** list extractor"*. ARIA table/grid 컨테이너 +
row + cell + columnheader(또는 `columnIndexes` 셀인덱스)를 요구. 카드형엔 셀/헤더가 없어 → 컨테이너 0개.

## 4. 세 사이트 비교 — 같은 갭의 세 얼굴
| 사이트 | 목록 구조 | 마크업 안정성 | 현재 추출기 |
|---|---|---|---|
| Hiworks / Daou (기존) | ARIA table (행·셀·헤더) | 안정 | ✅ 됨 |
| **jGrid** (Samsung argos) | div 그리드 (role 없는 div 셀) | 클래스 안정(`.grid-*`) | ❌ (로케이터는 `feat/pw-fallback-locator` PR로 일부 해결) |
| **쿠팡 리뷰** | `<article>` 카드 | Tailwind `twc-*` (비교적 안정) | ❌ |
| **네이버 리뷰** | `<li><a>` 카드 | **해시 클래스(휘발성)** | ❌ |

→ "ARIA table 전제"가 핵심 한계. 네이버는 클래스가 난독화돼 **클래스 셀렉터 자체가 못 미더움**(휘발성).

## 5. 데이터는 추출 가능 — 안정 앵커 기반 필드맵
### 쿠팡 (`<article>` 카드)
| 필드 | 앵커 | 예시 |
|---|---|---|
| review_id | `[data-review-id]` | 883403898 |
| author | 첫 굵은 span(16px) | 호두와자두 |
| rating | `i.twc-bg-full-star` 개수 | 5 |
| date | 날짜형 텍스트 | 2026.04.25 |
| title | 굵은 div(`.twc-mb-[8px]`) | 화장실 잘가기… |
| body | `.twc-break-all span[translate="no"]` | (본문) |
| helpful | `[data-count]` | 2 |

### 네이버 (`<li><a>` 카드 — 해시 클래스 → data-attr·라벨·패턴으로)
| 필드 | 안정 앵커 | 예시 |
|---|---|---|
| review_id | `a[data-shp-contents-id]` | 4991096437 ✅ |
| rating | `span.blind`="평점" 다음 텍스트 | 5 ✅ (라벨 앵커) |
| 맛 만족도/포장/유통기한/거주인원 | 라벨 텍스트 → 인접 값 | 맛있어요 … ✅ (extract-detail식 라벨→값) |
| date | 날짜 패턴 | 26.06.04. △ |
| author | 마스킹 패턴/위치 | asd3**** △ |
| body | 카드 내 최장 텍스트/위치 | (본문) △ |

→ **해시 클래스(`ajq1FpKeRA`)로는 불가** — capture.js의 `looksAuto`가 거부하는 그 종류. 안정 앵커는
**`data-*` 속성 / 라벨텍스트→값 / 텍스트패턴(날짜·평점)** 이다.

## 6. 부수 발견 (전제조건/페이지네이션)
- RPA sync는 **공개 사이트도 시스템별 Playwright auth state를 먼저 요구**:
  `[pw-rpa] FATAL: missing Playwright auth state for 'coupang_review' (... run setup/auth.sh first)`.
  → 인증 버튼(`#sys-auth`)으로 쿠키 storageState 저장 후에야 동기화 진입(성공 URL을 도메인 부분문자열로
  주면 페이지 로드 즉시 저장).
- pagination은 `recipe.pagination.mode: "combobox"`(페이지번호 `<select>`)만 지원. 쿠팡/네이버는
  번호버튼·더보기·무한스크롤이라 미지원.

## 7. 제안 (dev 아키텍처 결정 영역)
1. **구조 전략 추가**: recipe의 `collection`이 table이 아닐 때 **card-list 전략** 선택 —
   "반복 컨테이너 셀렉터 + 카드당 필드 추출".
2. **안정-앵커 필드매핑**: 카드 내 필드를 *클래스가 아니라* `라벨텍스트→값` / `data-*` / `role` /
   `텍스트패턴`으로. (네이버 같은 휘발성 마크업 대응 필수) — 이미 있는 `extract-detail.js`(라벨→값) +
   `looksAuto`(해시 거부) 철학과 정확히 일치. 즉 card-list = "카드당 미니 detail 추출".
3. **비-combobox 페이지네이션**: 번호버튼 / 더보기 / 무한스크롤 지원.
4. 원칙 유지: **사이트별 코드 없음**. 새 사이트 = recipe(설정) 한 장. 구조 전략·앵커 종류는 범용.

## 8. 관련 / 큰 그림
- jGrid(로케이터 측면)는 `feat/pw-fallback-locator` 브랜치/PR에서 css/xpath 폴백으로 일부 해결 — 같은
  뿌리("ARIA table / 시맨틱 로케이터 과전제")의 다른 단면.
- 셋 다 결국: **프레임워크가 'ARIA table + 시맨틱 로케이터'를 전제 → 비테이블·휘발성 마크업 사이트를
  못 다룸.** 구조 전략 + 안정 앵커로 일반화하면 "사이트마다 다른 구조"를 코드 없이 흡수 가능.

## 9. 이번 작업으로 생긴 로컬 흔적 (정리 대상, 커밋엔 영향 없음)
- 등록된 시스템 `coupang_review` (DB `data/approvals.db`)
- `fixtures/auth/playwright/coupang_review.state.json` (쿠팡 쿠키, gitignored)
- 둘 다 로컬/gitignore — 재테스트 안 하면 삭제 가능.
