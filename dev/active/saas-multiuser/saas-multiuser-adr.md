# ADR: agent-qa → 멀티유저 SaaS (외부 사용자 자가-녹화)

- **Status:** Proposed (방향 결정 대기 — 아직 착수 아님)
- **Date:** 2026-06-04
- **Scope:** 로컬 record→replay 도구(agent-qa)를, 외부 사용자가 *자기* 브라우저로 테스트 시나리오를
  녹화하고 클라우드에서 대규모로 재생하는 멀티유저 SaaS로 진화시키는 방안.
- **근거:** 16-에이전트 적대적 설계 워크플로(3개 아키텍처 독립 설계 → 4개 차원 적대 채점 + 선행사례
  조사). 채점 결과: **extension 13/20 · cloud-browser 11/20 · hybrid 11/20** (셋 다 13 이하 = 난도/비용
  높음의 정직한 신호). 본 ADR은 그 결과의 합성이다.

---

## 1. 문제 (Context)

현재 agent-qa는 **로컬 1인용**이다: 운영자 PC에서 `record.cmd`/web-ui 실행 → **그 PC에** 헤디드 Chrome이
뜸 → `bin/capture.js`(agent-browser `--init-script` 주입)가 DOM 이벤트를 `sessionStorage`에 버퍼 →
정지 시 `bin/build-flow.js`가 `flows/<name>.flow.json` 생성 → `compile`이 결정적 `tests/<name>.test.sh`로
변환 → `run.sh`가 agent-browser로 재생. web-ui는 `node:http`를 **127.0.0.1 전용** 바인딩, **단일 슬롯
직렬** 브라우저-잡 큐(공유 agent-browser 데몬 1개), npm 의존 0.

외부 멀티유저로 가려면 세 가지가 구조적으로 안 맞는다:
1. **캡처 표면** — 운영자 PC에 헤디드 Chrome을 띄우는 모델은 원격 사용자에게 무의미(클릭은 서버 PC
   앞 사람이 해야 함).
2. **멀티테넌시 부재** — 인증/사용자 격리/시크릿/쿼터 개념이 코드에 전혀 없음("공격자=뷰어" 전제).
3. **스케일 replay 불가** — 단일 공유 데몬 + 서버 박스에서 직접 spawn = 보안(RCE)·확장 막다른 길.

반대로, **어렵고 가치 있는 IP는 이미 존재**한다: 시맨틱 로케이터 캡처 엔진, flow.json 스키마,
record→build→compile→결정적-replay 파이프라인, 마스킹/needs_review/values-사이드카. 이 코어는 대부분
재사용 가능하다.

---

## 2. 결정 (Decision)

> **Extension 기반 캡처 + 클라우드 브라우저 풀 replay 를, 단계적(phased)으로 구축한다.**
> 캡처는 사용자 브라우저에서(서버 브라우저 0대), 돈 드는 클라우드 브라우저는 결정적 replay/스케줄
> 실행에만 쓴다.

**왜 extension-led인가**
- 채점 1위(13/20). **비용 4/5·UX 4/5**로 앞섬: 가장 비싼 자원(브라우저)을 녹화 단계에서 **0개**로
  만들어, 녹화 비용을 사용자 PC로 넘긴다.
- cloud-browser 스트리밍은 "녹화 1명당 서버 브라우저 1개를 사람 속도로 장시간 점유 + 픽셀 송출"이라
  **단위 경제가 깨지고**(녹화-분이 replay-분보다 구조적으로 비쌈), 라이브 CDP가 곧 풀-디버거라 보안
  표면이 더 크다.
- 선행사례가 분리를 강하게 지지: Playwright codegen/CRX·Chrome DevTools Recorder = 캡처는 사용자
  브라우저에서; browserless·Selenium-Moon = replay는 "잡당 컨테이너/Pod, 끝나면 폐기 + 무상태 라우터";
  Browserbase·Steel = 둘 다 rrweb(DOM 재구성)을 **버리고** 스크린캐스트로 이동(→ 영상은 보조
  아티팩트로만, flow.json 소스로 쓰지 말 것).

---

## 3. 아키텍처

```
[사용자 브라우저]                         [SaaS 백엔드]                    [클라우드 브라우저 풀]
 ┌──────────────┐    flow.json 업로드     ┌───────────────┐   잡 enqueue   ┌─────────────────┐
 │ 확장 프로그램 │ ───────────────────────▶│ API + 멀티테넌시│ ─────────────▶│ Pod-per-job     │
 │ = capture.js │  (RecordedAction[])    │ Postgres+RLS  │  (격리 큐)     │ Playwright runner│
 │ 사용자가 클릭 │                         │ build-flow.js │◀───────────── │ (1잡=1컨테이너,  │
 └──────────────┘                         │ KMS(시크릿)   │  report+video  │  끝나면 폐기)    │
   서버 브라우저 0대                        테넌트별 격리                     replay만 과금
```

---

## 4. 재사용 / 재타깃 / 신규 (Reuse matrix)

| | 컴포넌트 | SaaS에서의 처리 |
|---|---|---|
| ✅ 재사용(왕관 보석) | `bin/capture.js` — 시맨틱 로케이터+마스킹+유니크 카운트+needs_review | **agent-browser 의존 0** → MV3 content-script로 거의 그대로 이식. 최대 재사용. |
| ✅ 재사용 | `flow.json` 스키마(`flows/SCHEMA.md`), `bin/build-flow.js`(순수 stateless 변환), `{{input_N}}` 토큰화, candidates/values 사이드카, "PII는 커밋물에 안 남김" 모델 | SaaS 표준 스키마·서버 인제스트로 그대로. |
| ✅ 재사용(로직) | `compile()`의 로케이터 우선순위 / `--exact` per by-kind / url-wait 분리 / 런타임 토큰 치환(fail-loud) | **Playwright replay 엔진의 명세**로 사용(bash emitter 자체는 폐기). |
| ✅ 재사용(개념) | `verify-flow.sh`의 재생-검증/복구(후보 사다리에서 repair 또는 needs_review 승격) | **서버 측 publish-전 검증 패스**로 매핑. |
| ✅ 재사용(UI) | web-ui `Runs/Flows/Trends` 대시보드, `report.json` 형태 | **테넌트 스코프 + 출력 이스케이프 추가 후** 재사용. |
| ♻️ 재타깃 | replay 엔진: `run.sh` + `lib/env.sh` + `lib/assert.sh`(8 assert, `_url_match`, `wait_url`) + `compile` codegen + agent-browser 0.27.0 | **Playwright 러너로 재작성.** 규칙은 이식, 코드는 폐기. |
| 🆕 신규(비싸고 못 미룸) | 멀티테넌시(인증·Postgres+RLS·KMS·쿼터), 클라우드 브라우저 풀(Pod-per-job·autoscale), 보안(SSRF/격리/egress), 빌링·메터링 | 전부 greenfield. **진짜 critical path.** agent-qa에서 재사용 0. |

> **냉정한 비율 감각:** 재사용되는 코어는 ~600줄 수준의 작은 조각이고, 전체 노력의 다수는 멀티테넌시 +
> 격리 replay 풀 + 보안이라는 신규 플랫폼 빌드다.

---

## 5. 컴포넌트별 설계

### 5.1 캡처 (확장 프로그램)
- `capture.js`를 MV3 content-script로 이식. RecordedAction[]을 사용자 브라우저에서 모아 업로드 →
  서버 `build-flow.js`가 flow.json 생성.
- **반드시 고칠 2가지(현재 로컬 한계 → SaaS v1 블로커):**
  - **크로스오리진/SSO 캡처**: 현재 `sessionStorage` per-origin 버퍼라 오리진을 넘는 top-level nav에서
    이벤트 유실. SSO/OAuth/OTP 로그인이 정확히 이 케이스(고객이 가장 테스트하고 싶어하는 흐름) →
    **확장 background에 오리진-넘는 누적기** 필요. 실패 모드가 "알람 없는 누락 이벤트"라 더 위험.
  - **`document_start` 주입 타이밍**: 동적 주입은 페이지 JS보다 늦게 떠 `history.pushState` 래핑/SPA nav
    경계를 **조용히 놓칠** 수 있음 → static-manifest 주입 필요(대신 `<all_urls>`급 권한 → 스토어 심사·신뢰
    프롬프트 부담).

### 5.2 Replay (Playwright 풀)
- `compile()` 규칙을 Playwright 러너로 재구현. **잡 1개 = 컨테이너/Pod 1개, 끝나면 폐기**(Moon 패턴) →
  테넌트 격리가 토폴로지에서 "공짜로" 따라옴. 앞단은 **무상태 라우터**.
- **로케이터 패리티 재튜닝(최대 기술 미지수):** `WKIND` 점수·`countCandidate`는 agent-browser 0.27.0
  quirk(role 강등·text 승격·`--exact`)에 보정돼 있음. Playwright `getByRole/getByText`는 매칭이 다름 →
  **재보정 + 재검증 전엔 needs_review/오매칭률을 알 수 없음.** `ianatour.candidates.json`(role count=1인데
  primary=text) 같은 사례가 "엔진 가정이 다르면 깨질 수 있음"을 증명. `verify-flow` 재생-복구를 서버 측
  publish-전 패스로 이식해 완화(단, 이 패스 자체가 flow당 브라우저-컨텍스트 1개를 더 소비 → 비용).
- **결정성:** 로컬은 Chrome-for-Testing 버전을 고정(preflight가 엔진 변화에 hard-fail)해 flake를 막음.
  멀티테넌트 오토스케일 풀도 **Chrome 버전+flag를 플릿 전역 핀** 필요 — 단, 이건 CVE 패치와 충돌(아래 위험 #4).

### 5.3 멀티테넌시 & 시크릿
- Postgres + Row-Level Security, 테넌트별 KMS 봉투 암호화.
- `auth-state`(`*.state.json`)는 **bearer급 쿠키+스토리지 덩어리** → 저장 시 암호화, replay 시에만 격리
  Pod에 복호화. 복호화 holder와 "신뢰 못 할 페이지를 구동하는" 드라이버를 **같은 트러스트 존에 두지 말 것**.
- `values` 사이드카는 TLS-종단 edge에서만 평문, 로그 redaction, 메모리 위생.

---

## 6. Killer risks (전 방안 공통, 미루기 불가) + 대응

| # | 위험 | 대응 |
|---|---|---|
| 1 | **인증 컨텍스트 탈취** — 테넌트 실서비스 세션 쿠키를 푼 Playwright가 *공격자가 만든 flow*를 실행 → 임의 URL로 세션 유출. blast radius = 테넌트의 진짜 앱 세션 | flow.json을 **신뢰 입력으로 보지 말 것**: 스텝 화이트리스트, egress 도메인 핀, 아티팩트(영상/trace)에 세션 토큰 마스킹, 서버 스키마 검증(크기/형태 한계) |
| 2 | **SSRF / IMDS** — 원격 브라우저는 열린 egress 프리미티브. `169.254.169.254`·내부망 피벗 → 플랫폼 크레덴셜 탈취 | 네트워크 정책으로 RFC1918+IMDS 차단. *단 내부/스테이징 앱 테스트엔 풀어야 함* → 테넌트별 명시 allowlist + DNS 핀 |
| 3 | **클라이언트 마스킹은 통제수단이 아님** — `sensitive()`는 사용자가 제어하는 코드에서 돌고 영문 OTP·붙여넣은 토큰·contenteditable·보안질문을 놓침. 비활성화도 가능 | **서버 인제스트에서 재스캔/재마스킹.** "업로드된 모든 값은 민감하다" 전제 |
| 4 | **확장 공급망** — 스토어 계정 탈취/악성 업데이트 = 전 사용자 페이지에 심는 플릿 전역 임플란트(세션 토큰 탈취) | 코드 서명·업데이트 핀·최소 권한. 광범위 host 권한 심사 2~4주 지연 감수. (참고: 결정성용 Chrome 버전 핀 ↔ CVE 패치 충돌도 같이 관리) |
| 5 | **비용 DoS / 시끄러운 이웃** — 한 테넌트가 수백 동시 replay로 풀 고갈 + replay-분 과금 폭증. enqueue 쿼터는 *이미 도는* 잡의 wall-clock/egress를 못 막음 | 테넌트별 동시성 쿼터 + 잡당 **하드 타임아웃 + kill-on-overrun** + fair-share + per-job egress 상한 |

부가 위험: 재사용한 대시보드의 **stored XSS**(attacker-controlled candidate/name/URL 텍스트, 테넌트
스코프·이스케이프 없으면 세션 탈취로 테넌트 간 피벗) — 출력 이스케이프 + 테넌트 스코프 렌더 필수.

---

## 7. 단계별 로드맵

| 단계 | 범위 | 노력 | 완료 기준 |
|---|---|---|---|
| **P0 — 확장 캡처 MVP** | capture.js→MV3 확장, flow.json 업로드, **크로스오리진 누적기 수정**. replay는 아직 로컬/단일 테넌트 | M | "내 브라우저에서 녹화 → flow.json" 작동. 보안 표면 최소 |
| **P1 — Playwright replay 재타깃** | compile 규칙 이식, **로케이터 패리티 재튜닝+재검증**, verify-repair 이식 | **L** | 결정적 replay가 새 엔진에서 GREEN(기존 flow들 재-드라이브 통과) |
| **P2 — 멀티테넌시 코어** | 인증·Postgres+RLS·KMS·테넌트 스코프 대시보드(+XSS 이스케이프)·빌링 메터링 | **XL** | 진짜 다중 사용자, 시크릿 격리 |
| **P3 — 격리 replay 풀** | Pod-per-job, egress/SSRF 정책, 쿼터·하드 타임아웃, autoscale, warm-pool 전략 | **XL** | 스케일·보안. **초기엔 browserless/Browserbase 렌트가 저렴** → 자체 풀은 볼륨 붙은 뒤 |

> **권고:** 초기엔 자체 브라우저 풀을 짓지 말고 **상용(browserless/Browserbase)을 렌트**해 P3을 늦춰라.
> 캡처 코어가 차별점이고, 풀 인프라는 commodity다.

---

## 8. 비용 / 규모 모델

- **브라우저 = 비용.** extension 방식이 녹화 비용을 사용자 PC로 넘겨 여기서 이김.
- replay: 관리형 풀 ~$0.10–0.12/브라우저-시 + 대역폭. **콜드스타트(지연·유료 spin-up) vs idle 워밍(유료
  유휴)** 은 트레이드오프 — 둘 다 공짜 없음. 이 선택이 곧 사업.
- **영상/trace 보존 + egress가 숨은 지배 비용** — 하루 수천 run이면 컴퓨트보다 스토리지/egress가 큼.
  Playwright video+trace는 run당 크고 선형 증가. 보존 정책·다운로드 egress 과금 필수.
- 컨텍스트당 메모리: "0.5–1GB" 낙관적, 실제 SPA+video+trace면 1.5–2GB peak. 마진 산정에 반영.

---

## 9. 검토했으나 채택 안 한 대안 (Alternatives)

- **Cloud-browser 스트리밍(11/20):** 캡처·replay 엔진 동일이 장점이나, 녹화 1명당 서버 브라우저
  장시간 점유 + 픽셀 egress로 **단위 경제 붕괴**, 라이브 CDP 데이터플레인이 테넌트 간 풀-디버거 노출(IDOR
  하나로 타 테넌트 라이브 세션 읽힘), 스트리밍 입력 지연이 capture.js seq 헬스체크를 "녹화 실패, 재시도"로
  바꿔 UX 악화. 단 — **OTP/SSO를 서버에서 시연**해야 하거나(브라우저를 사용자에게 안 깔리고 싶을 때),
  비개발자 대상으로 "설치 없는 즉시 녹화"가 절대 우선이면 재고 가치.
- **rrweb 세션 리플레이를 flow 소스로:** **트랩.** 구체 노드 ref·값을 기록 → 결정적 테스트가 아닌 영상.
  Browserbase·Steel 둘 다 fidelity 발산으로 폐기. rrweb은 "사용자가 한 행동" 보조 시각 아티팩트로만.
- **지금 도구를 LAN/0.0.0.0 노출:** 인증 없음 + 버튼=서버 박스 프로세스 spawn = RCE. **금지.**

---

## 10. 미해결 결정 (Open decisions — 착수 전 확정 필요)

1. **목표/시점** — "유료 첫 1명까지 최단" MVP인가, 본격 플랫폼인가? (P0만 vs P0–P3)
2. **렌트 vs 자체호스팅** — 초기 replay를 browserless/Browserbase 렌트(권장)로 갈지 자체 Pod 풀을 지을지
   → 노력 등급이 한 단계 갈림.
3. **대상 사용자** — 개발자(확장 설치·needs_review 해결 OK) vs 비개발자(친화적 후보 피커 UX가 critical).
4. **엔진** — replay를 Playwright로 갈지(권장: 클라우드·병렬·견고) 확정 → P1 패리티 작업의 전제.

---

## 부록 A. 선행사례 (근거)

- **Playwright codegen / Trace Viewer / CRX** — 클라이언트-측 캡처가 role/text/testid 우선 유니크 로케이터를
  생성(= agent-qa capture.js와 같은 발상). **CRX는 동일 레코더가 사용자 브라우저 탭 안에서 돌 수 있음을 증명** →
  서버 헤디드 Chrome 대신 확장 전달 표면.
- **Chrome DevTools Recorder** — 사용자 브라우저에서 순수 클라이언트 녹화, 스텝당 **fallback 셀렉터 사다리**
  + shadow-DOM `pierce/`(= agent-qa open-shadow walk). → agent-qa는 candidate 사다리를 replay fallback으로
  컴파일하면 needs_review/flake를 줄일 여지(단 silently-wrong 매치 가드 필요).
- **browserless** — 컨테이너 Chrome을 WS로 노출 + 큐/동시성/타임아웃. 자체 Chrome은 "스케일에서 깨진다"고
  경고(메모리 누수·좀비·버전 드리프트) → warm pool·affinity 라우팅 = 스케줄러 필요. **replay 티어 청사진.**
- **Selenium-Moon** — **세션당 Pod 1개 생성→종료 시 삭제**, 무상태(세션 id = Service 이름) → 무제한 복제.
  멀티테넌트 격리·blast radius 한정의 canonical 패턴.
- **Browserbase / Steel** — 둘 다 rrweb→스크린캐스트(WebRTC/MP4)로 이동(DOM 재구성 발산). 관찰성은
  서버 스크린캐스트로, **테스트 소스로 쓰지 말 것.** 초기엔 렌트가 저렴.
- **rrweb (PostHog/OpenReplay/Sentry)** — fidelity용 세션 리플레이. 결정적 테스트 아님. 보조 아티팩트로만.

## 부록 B. 채점 요약

| 아키텍처 | feasibility | security | cost | ux | 합계 |
|---|---|---|---|---|---|
| **extension** | 3 | 2 | 4 | 4 | **13/20** |
| cloud-browser | 2 | 3 | 3 | 3 | 11/20 |
| hybrid | 3 | 2 | 3 | 3 | 11/20 |

(security가 전반적으로 낮음 = 어느 방안이든 인증-컨텍스트 격리·SSRF·시크릿 처리가 비-선택적 난제임을
의미. 본 ADR §6이 그 대응을 담는다.)
