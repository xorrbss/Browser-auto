# build-agent-qa-framework — Plan

Last Updated: 2026-06-01

## 요약

agent-browser 0.27.0 위에 얹는 **하이브리드 범용 웹 테스트 자동화 프레임워크 "agent-qa"** 신규 구축.
agent-browser가 이미 엔진(선택자/검증/녹화/인증/confirm-gate)이므로 새 엔진을 만들지 않고,
agent-browser가 진짜 없는 글루(스위트 러너, 리포팅, ffmpeg preflight, footgun-safe assert, trap cleanup,
AI authoring)만 얇게 덧붙인다.

## 현재 상태 분석

- 신규 프로젝트(C:/project/agent-qa, git init 완료). 코드 0.
- 의존성 전부 설치·실측 확인됨: bash(Git Bash), jq(winget), ffmpeg(winget Gyan.FFmpeg 8.1.1),
  node, agent-browser 0.27.0.
- 이번 세션에 agent-browser end-to-end 실측 완료: open→snapshot(@e refs)→find/click→record(WebM 13.4s
  생성, ffprobe 검증)→screenshot 동작. workflow-use에서 겪은 watchdog 자멸은 agent-browser에선 없음.

## 목표 상태

- `bash run.sh` 한 번으로: preflight → tests/*.test.sh 결정적 재생 → 비디오·스크린샷 산출 →
  report.json + report.junit.xml → 하나라도 실패시 exit 1(CI 게이트).
- 테스트 1건 = 독립 실행 가능한 .sh 1개(한 사용자 여정). `bash tests/x.test.sh` 단독 실행됨.
- OTP는 setup/auth.<app>.sh에서 1회 사람 입력 → state 캐싱 → 이후 무인 재생.
- bin/probe-record.sh로 AI가 사이트를 탐색해 안정 로케이터 기반 .test.sh를 생성(생성=AI, 재생=결정적).

## Phase별 실행 지도

- **Phase 0 — Layer 1 스파인 (MVP, $0/CI):** lib 5종 + run.sh + tests/login.test.sh(간단 공개 사이트) 그린.
  → 상세: [[build-agent-qa-framework-tasks#phase-0]]
- **Phase 1 — human-loop + auth 캐싱:** setup/auth.<app>.sh(headed wait-for-human OTP → state save),
  모든 테스트가 --state로 시작. confirm-gate + Tier-3 diff baseline 추가.
  → [[build-agent-qa-framework-tasks#phase-1]]
- **Phase 2 — AI authoring (Layer 2, opt-in):** flows/*.flow.json 스키마(NO @eN field) +
  bin/probe-record.sh(snapshot+chat → 안정 로케이터 굳히기 → .flow.json + .test.sh 생성).
  → [[build-agent-qa-framework-tasks#phase-2]]
- **Phase 3 — 실전:** 삼성 내방 사이트로 auth→state→폼 테스트. (사용자 OTP 입력 필요)
  → [[build-agent-qa-framework-tasks#phase-3]]

## Acceptance Criteria

- **Phase 0:** `bash run.sh`가 example.com 대상 login.test.sh를 그린으로 통과, exit 0,
  artifacts/<run-id>/login/video.webm(비-empty, ffprobe 유효) + report.json + report.junit.xml 생성.
  ffmpeg 누락 시 preflight가 HARD-FAIL(silent green 금지).
- **Phase 1:** auth.<app>.sh가 headed로 사람 OTP 입력을 wait --url로 대기 → state save 성공,
  그 state로 시작한 테스트가 OTP 재입력 없이 무인 통과.
- **Phase 2:** AI_GATEWAY_API_KEY로 probe-record.sh가 실제 사이트 한 플로우를 .flow.json(@eN field 없음)
  + 실행 가능한 .test.sh로 산출, 그 .test.sh가 결정적으로 그린.
- **Phase 3:** 삼성 내방 폼 테스트가 캐시된 state로 자멸 없이 실행되고 비디오·리포트 산출.

## 검증 게이트

- 각 lib 파일은 standalone 실행/소스 가능해야 함(`bash -n` 구문검사 + 가능한 단독 스모크).
- preflight: 1초 record 스모크테스트로 실제 .webm 생성 확인(HARD-FAIL).
- assert: is/diff footgun contract self-test 통과(is가 false에 exit 0인지 확인 후 --json 파싱 사용).
- 파일 500라인 이내(목표 최대 ~90라인). `bash -n` 전 파일 통과.

## 리스크와 완화

- **ffmpeg/daemon PATH 결합:** preflight가 절대경로를 PATH 앞에 주입하고 daemon spawn을 run.sh가 소유.
  ad-hoc 직접 호출은 README 경고.
- **agent-browser 0.27.0 버전 드리프트(exit code/--json 형태):** preflight CONTRACT self-test가 핀 고정,
  드리프트 시 loud fail.
- **크로스오리진 iframe(OTP/SSO/결제) snapshot 미포착:** wait --url 성공게이트로 우회, 알려진 한계로 문서화.
- **daemon round-trip 간헐 flakiness:** 여정을 batch --bail 한 번에 패킹, 인프라 에러와 assert 실패 구분.
- **convention-not-structure(Layer 1):** assert.sh가 유일 경로, README가 bare is 금지, .gitignore +
  preflight gitignore self-check. Phase 2 JSON 스키마가 @eN-ref 에러 클래스를 구조적으로 제거.
- **Windows pixel-diff 폰트 AA 오탐:** 구조적 diff snapshot을 1차 게이트, diff screenshot은 임계값 튜닝.
