# build-agent-qa-framework — Context

Last Updated: 2026-06-01

## SESSION PROGRESS

- 2026-06-01: 프로젝트 부트스트랩(git init, dev/ 구조). 설계 워크플로 완료 → 2-레이어 하네스 확정.
  Dev Docs 3파일 작성. 키 결정 확정(agent-qa, AI키 있음, 간단사이트→삼성 순차).
- 2026-06-01: agent-browser --json 형태 정밀 실측 → 검증모델 정정(개별명령 실패=exit1, batch래퍼=exit0, .success 파싱이 토대).
- 2026-06-01: **Phase 0 완료**. lib 5종 + run.sh + tests/login.test.sh 작성, end-to-end 그린(exit 0,
  video VP8 35.7s, report.json+junit.xml). 검증모델이 실패 케이스를 정확히 잡음을 실증.
  버그 2건 수정: preflight $USER unbound(set -u) → LOCALAPPDATA 유도; report.sh grep -c 산술에러 → awk count.
- **다음 active: Phase 1** — setup/auth.<app>.sh(headed wait-for-human OTP → state save) + --state 패턴.

## Current Execution Contract

- 언어: 순수 bash, Git Bash(C:/Program Files/Git/usr/bin/bash)에서 실행. PowerShell 테스트 스크립트 금지.
- 의존 단방향: tests/*.test.sh → lib/*(leaf). run.sh가 오케스트레이션. bin/* standalone(back-import 금지).
- 파일 500라인 이내(목표 ~90). 새 추상화 전 기존 확장 검토. 임시방편/하드코딩/문제은폐 금지.
- agent-browser가 엔진 — 그것이 이미 하는 일(선택자/검증/녹화/인증/confirm)은 래핑하지 않는다.
- 검증된 footgun을 반드시 준수(아래 "중요한 의사결정" 참조).

## 현재 Active Task

**Phase 0 — Layer 1 스파인 구축.** lib 5종(env/cleanup/preflight/assert/report) + run.sh + 첫 테스트.
다음 단계: lib/preflight.sh를 가장 먼저(가장 위험한 가정=비디오 실제 녹화를 단독 증명).

## 다음 세션 읽기 순서

1. `build-agent-qa-framework-plan.md` (phase 지도, acceptance)
2. `build-agent-qa-framework-tasks.md` (체크박스 + 참조 블록)
3. 이 파일(context) — execution contract, footgun, 의사결정
4. 구현된 `lib/*.sh`, `run.sh`, `tests/*.test.sh`

## 핵심 파일과 역할

- `lib/env.sh` — per-test boilerplate: S(격리세션 "<name>-$$"), ARTDIR, AB()=`agent-browser --session "$S"`,
  BATCH()=stdin-JSON 안전인용 래퍼.
- `lib/cleanup.sh` — EXIT trap: `record stop`(실패해도 비디오 보존) + session close. 모든 테스트가 source.
- `lib/preflight.sh` — ffmpeg 절대경로 주입 + PATH prepend(daemon 상속) + 1초 record 스모크(HARD-FAIL)
  + is/diff footgun contract self-test + install/warm/close-all.
- `lib/assert.sh` — assert_text/url/visible/value/count/absent/no_snapshot_change. is/diff는 --json 파싱.
- `lib/report.sh` — report.json + report.junit.xml + 콘솔 테이블(jq + here-doc).
- `run.sh` — preflight→prewarm→tests/*.test.sh 순회→exit 집계→리포트→close --all. 실패시 exit 1.
- `tests/*.test.sh` — 테스트 1건. find 시맨틱 로케이터만, 전환마다 wait 게이트, BATCH --bail body.
- `setup/auth.<app>.sh` — 1회 headed wait-for-human(OTP) → state save(Phase 1).
- `bin/probe-record.sh` — AI authoring(Phase 2, PROBE_AI/AI_GATEWAY_API_KEY).

## 중요한 의사결정 (실측 footgun — 위반 금지)

> ⚠️ **검증 모델의 토대(2026-06-01 정밀 실측, 1차 측정 정정):**
> - **개별 명령**(`is`/`find`/`get`)은 실패 시 **exit 1** + `{"success":false,...}`. (set -e로 잡힘 — 1차 측정의 "exit 0"은 오류였음)
> - **`batch --bail` 래퍼**는 내부 명령이 실패해도 **자체 exit 0**(개별 실패를 결과 배열에 담고 삼킴). `BATCH_BAIL_EXIT=0` 확인.
> → 그래서 **두 shape 모두에 portable한 신호 = `.success` 필드**다. exit code만 믿으면 batch 경로에서 false-green.
> → assert.sh는 단일명령도 `.success`로 판정(일관성), BATCH()는 결과배열의 각 `.success`를 `_batch_check`로 검사.

- **exit code 요약:** 단일 명령 실패=exit 1(잡힘), batch 래퍼=exit 0(안 잡힘). 판정은 항상 `--json .success`로 통일.
- **--json envelope 형태(실측):**
  - 단일 명령: `{"success":bool,"data":{...}|null,"error":str|null}`
  - `is visible --json` → `.data.visible`(bool). 요소 부재 시 `.success=false, .data=null, .error="Element not found"`.
  - `get count --json` → `.data.count`(num), `.data.selector`
  - `get text --json` → `.data.text`(str)
  - `get url --json` → `.data.url`(str)
  - `batch --json` → 배열 `[{"command":[...],"success":bool,"result":{...}|null,"error":str|null}, ...]`
    (단일 명령의 `.data`가 batch에선 `.result`임에 주의)
  - `batch --bail`: 첫 실패 후 나머지 명령은 실행 안 됨(결과 배열에서 누락) — 동작은 하지만 exit는 0.
- **assert 판정 규칙:** 모든 assert_*는 해당 명령을 `--json`으로 호출 → jq로 `.success==true` AND 기대값 비교.
  실패 시 helper가 명시적으로 `return 1` → 그래야 test의 set -e가 동작.
  단계 진행(BATCH body)도 결과 JSON에서 각 `.success`를 검사해 첫 false면 test 실패시켜야 함(--bail의 exit에 의존 금지).
- **diff snapshot:** 변화 있어도 exit 0. `--json .data.changed` 파싱.
- **assert_absent:** `get count --json == 0`(즉시). `wait`로 부재 검증 금지(25s 타임아웃 소모).
- **Windows ffmpeg PATH:** `record start`는 ffmpeg 없어도 성공 출력 → `record stop`서 .webm 조용히 미생성.
  user PATH만으론 부족(daemon이 stale PATH면 평생 blind). preflight가 절대경로를 PATH 앞에 주입 + 스모크테스트.
- **@eN ref 금지:** 페이지 변하면 stale. tests/flows에 ref 저장 절대 금지, find 로케이터만.
  페이지 전환마다 `wait --url|--text|--load networkidle` 게이트로 안정된 페이지 보장.
- **find 시그니처(실측):** `find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> <action> [args]`.
  요소 없으면 `✗ Element not found` + exit 0 → BATCH 결과 JSON의 `.success`로 판정.
- **wait 조건(실측):** `--url <pattern>` / `--text <substr>` / `--load <load|domcontentloaded|networkidle>` / `--fn <js>` / `--timeout <ms>`.
- **BATCH stdin-JSON:** 공백/따옴표 값은 inner-array JSON으로 전달(토큰 분할 트랩 회피). `[["find","text","Checkout","click"],...]`.
- **daemon:** 첫 기동 ~12s, 이후 ~2s, 명령간 persist. run.sh가 warm + close --all 소유.
- **크로스오리진 iframe(OTP/SSO/결제):** snapshot 미포착(엔진 한계). wait --url 성공게이트로 우회.

## 환경 절대경로 (실측)

- bash: C:/Program Files/Git/usr/bin/bash
- ffmpeg: C:/Users/dream/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin/ffmpeg.exe
- agent-browser: C:/Users/dream/AppData/Roaming/npm/agent-browser (전역, 0.27.0)
- Chrome for Testing: C:/Users/dream/.agent-browser/browsers/chrome-149.0.7827.54

## 빠른 재개

`cd C:/project/agent-qa && bash run.sh` (Phase 0 완료 후). 구현 중이면 plan→tasks 순으로 active task 확인 후 이어서.
