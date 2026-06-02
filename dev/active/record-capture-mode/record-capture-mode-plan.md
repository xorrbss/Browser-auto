# record-capture-mode — Plan

Last Updated: 2026-06-02

## 요약

agent-qa에 **사용자 행위 녹화(`capture`) 모드**를 추가한다. 캐시된 로그인 state에서 시작한
브라우저에 `addinitscript`로 JS 리스너를 영구 주입해 사용자의 클릭·입력·셀렉트·Enter·이동을
캡처하고, 안정 시맨틱 로케이터로 굳혀(불가 시 `needs_review`) 기존 `flows/<name>.flow.json`을
자동 생성한다. 산출 flow.json은 기존 `compile → .test.sh → run.sh`로 결정적 재생된다.
설계 근거·전체 명세: `record-capture-mode-seed.yaml` (ouroboros seed, QA 0.92).

## 현재 상태 분석

- agent-qa는 Layer1(결정적 재생) + Layer2(저작: `scaffold`→사람/Claude가 flow.json 작성→`compile`)
  까지 완성(Phase 0/1/2 DONE). 지금은 flow.json을 **손으로** 쓴다.
- `bin/probe-record.sh`: `scaffold`/`compile` 2모드 보유. standalone leaf(아무도 import 안 함).
- `flows/SCHEMA.md`: `find`/`wait` step + `asserts[]`, **`@eN` 필드 없음**. `needs_review` 필드는 없음(확장 필요).
- agent-browser 0.27.0: `eval`, `addinitscript`, `--state`/`AB_AUTH`, `--auto-connect` 보유(실측).
- **최대 미검증 가정**: addinitscript 리스너가 실제 사용자 행위를 잡고 네비게이션을 넘어 보존되는가.

## 목표 상태

`bin/probe-record.sh capture <name> <startUrl> [--app <app>]` 한 줄로:
로그인 state open → 리스너 주입 → 사용자 조작 → CLI 신호로 종료 → flow.json 자동 생성.
clean 녹화는 `compile`→`run.sh`에서 **첫 재생에 그린**(round-trip).

## Phase별 실행 지도

- **Phase 0 — PoC (게이팅 리스크 제거).** addinitscript 리스너가 (a) 행위를 잡고 (b) `sessionStorage`로
  네비게이션을 넘어 보존되는지 `eval --json`으로 읽어 증명. agent-browser가 클릭을 구동해 self-run 가능.
  실패 시 T2를 `--auto-connect`(CDP) 경로로 재검토 → seed 갱신.
- **Phase 1 — 캡처 코어.** `capture` 모드 dispatch 추가: `AB_AUTH` open + `addinitscript` 주입 +
  CLI-신호 stop + 종료 시 `eval` flush. 이 단계 산출 = 원시 캡처 이벤트(JSON).
- **Phase 2 — 로케이터 경화 + 스키마.** in-page 로케이터 계산(testid>role+name>label>text>placeholder),
  `get count --json`==1 유일성 검증, 불가 시 `needs_review`+candidates. flow.json 방출(SCHEMA.md 준수 +
  `needs_review` 확장). 네비게이션 경계마다 `wait until:url` 자동삽입, 종료 URL `assert_url` 자동추가,
  `type=password` 마스킹.
- **Phase 3 — round-trip 검증.** clean 녹화 → `compile` → `run.sh` 그린을 범용 공개 사이트로 실증.
  `needs_review` 포함 녹화는 compile이 fail-loud로 거부됨을 함께 확인.

## Acceptance Criteria (seed에서)

- `capture` 1줄 실행 → 5종 행위 순서대로 기록, 각 행위가 유일 시맨틱 로케이터로 해석(또는 needs_review+후보).
- 캡처 이벤트가 최소 1회 네비게이션을 무손실로 넘김(sessionStorage).
- 경계마다 `wait until:url`, 종료 시 `assert_url` 자동.
- 산출 flow.json이 SCHEMA.md 검증 통과, `@eN` 없음, `type=password` 값 미포함.
- needs_review 0인 녹화는 compile→run.sh 첫 재생 그린(round-trip).

## 검증 게이트

- Phase 0: `eval --json`으로 캡처 배열에 click + (네비 후) 보존 이벤트가 모두 보이면 통과. 안 보이면 STOP→CDP 재검토.
- Phase 1: `bash -n` 구문 + capture 실행 후 종료 시 원시 이벤트 JSON이 파일로 남음.
- Phase 2: 생성 flow.json을 `jq`로 스키마 필드 검증 + `@eN`/password 부재 grep 0건.
- Phase 3: `bash run.sh <name>` exit 0 + report.json green. needs_review 포함분은 compile이 비0 종료.

## 리스크와 완화

- **R1 리스너 캡처 실패/이벤트 유실(최대)** → Phase 0 PoC로 먼저 차단. 폴백: `--auto-connect`(CDP Input/DOM).
- **R2 로케이터 품질(workflow-use 최대 난제)** → 유일성 미달은 조용한 폴백 금지, `needs_review`로 fail-loud(편법 금지 원칙).
- **R3 SPA(해시/history.pushState) 네비게이션 미감지** → popstate+pushState 패치+URL 폴링 병행. 못 잡으면 경계 누락→재생 시 wait 부족. Phase 2에서 명시 테스트.
- **R4 새탭/팝업·크로스오리진 iframe** → OUT OF SCOPE(seed). 새탭 발생 시 경고 후 캡처 종료.
- **R5 probe-record.sh 비대화** → 250라인 초과 시 캡처 JS를 `bin/` 동봉 .js 파일로 분리(의미 단위 분리 기준 명시).
