#!/usr/bin/env bash
# Browser-free checks for the WebUI automation auth controls.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  webui-automation-auth-ui-unit: $1" >&2; exit 1; }

node --check "$DIR/webui/public/app.js" || fail "app syntax failed"

( cd "$DIR" && node --input-type=module - <<'NODE' ) || fail "automation auth UI contract failed"
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync('webui/public/app.js', 'utf8');
const indexHtml = fs.readFileSync('webui/public/index.html', 'utf8');
const appCss = fs.readFileSync('webui/public/app.css', 'utf8');
const utilJs = fs.readFileSync('webui/public/util.js', 'utf8');
const serverJs = fs.readFileSync('webui/server.js', 'utf8');
const authPw = fs.readFileSync('approve/auth-pw.mjs', 'utf8');

assert.match(appJs, /MANUAL_AUTH_SAVE_NEEDLE = '__AQA_MANUAL_AUTH_SAVE_ONLY__'/, 'login-url-only auth uses a manual-save sentinel');
assert.match(
	appJs,
	/const app = manualApp \|\| autoApp \|\| matchedApp;/,
	'automatic app id is based on the current URLs before saved-auth matches',
);
assert.doesNotMatch(
	appJs,
	/authBtn\.disabled\s*=\s*loggedIn\s*\|\|/,
	'saved auth must not disable the login/refresh button',
);
assert.doesNotMatch(
	appJs,
	/if \(automationLoggedIn\(form\)\) return alert/,
	'login handler must allow refreshing an existing saved login',
);
assert.doesNotMatch(
	appJs,
	/node\.disabled\s*=\s*loggedIn/,
	'saved auth must not lock login URL or success URL inputs',
);
assert.match(appJs, /loggedIn \? '로그인 갱신'/, 'saved auth presents a refresh action');
assert.match(appJs, /저장된 로그인 있음/, 'saved auth badge is descriptive rather than a hard block');
assert.match(authPw, /const initialUrl = page\.url\(\);/, 'auth driver records the initial login URL');
assert.match(authPw, /currentUrl !== initialUrl && currentUrl\.includes\(successNeedle\)/, 'auth driver does not accept the initial login URL as success');
assert.match(appJs, /function isClickedRecordReview\(item\)/, 'flow review UI distinguishes clicked-record reviews');
assert.match(appJs, /item\?\.kind === 'find' && \(item\.action \|\| 'click'\) === 'click'/, 'clicked-row open button is only for find/click review steps');
assert.match(appJs, /function isContainerScrollReview\(item\)/, 'flow review UI recognizes container-scroll review steps');
assert.doesNotMatch(appJs, /omitAutomationContainerScrolls/, 'unsupported container-scroll review steps must not be silently omitted');
assert.doesNotMatch(appJs, /omit-review-step/, 'WebUI must not expose a route that ignores needs_review steps');
assert.match(appJs, /function automationBlockedReason\(flow\)/, 'automation UI has a visible blocked reason helper');
assert.match(appJs, /새 녹화는 안정 locator 또는 휠 위치로 자동 재생/, 'automation blocked reason points old container-scroll recordings to the new fallback');
assert.match(appJs, /function flowSummaryState\(flow\)/, 'flow summary uses a short status label helper');
assert.match(appJs, /metric\('상태', flowSummaryState\(flow\), flowSummaryDetail\(flow\), \{ compact: true \}\)/, 'status metric always renders compact text');
assert.match(appJs, /const compact = options\.compact === true \|\| text\.length > 24 \|\| \/\\s\/\.test\(text\) && text\.length > 16;/, 'long metric values are compacted defensively');
assert.match(appCss, /\.metric strong\.compact\s*\{[\s\S]*font-size: 14px;/, 'compact metric values use smaller text');
assert.doesNotMatch(appJs, /el\('strong', \{ class: `scenario-reason/, 'long scenario reasons are not rendered as strong metric-like text');
assert.match(appCss, /\.scenario-status-item\.wide \.scenario-reason\s*\{[\s\S]*font-size: 12px;/, 'wide scenario reasons use compact text');
assert.match(appJs, /function updateAutomationLogPlaceholder\(flow\)/, 'execution log shows a placeholder before jobs start');
assert.match(appJs, /아직 검증\/컴파일\/실행이 시작되지 않았습니다/, 'execution log placeholder explains why no log has appeared yet');
assert.match(appJs, /verifyBtn\.disabled = !flow \|\| activeRecord \|\| activeVerify \|\| activeRun \|\| busy \|\| !verifyAccess\.allowed;/, 'verify button remains clickable for needs_review preflight explanations');
assert.match(appJs, /compileBtn\.title = accessTitle\(compileAccess, flow && !flow\.compilable \? automationBlockedReason\(flow\) : ''\)/, 'compile button title exposes blocked reason');
assert.match(appJs, /runBtn\.title = accessTitle\(runAccess, flow && !flow\.compilable \? automationBlockedReason\(flow\) : ''\)/, 'run button title exposes blocked reason');
assert.match(appJs, /컴파일 대기: \$\{reason\}/, 'programmatic compile attempts surface the blocked reason');
assert.match(appJs, /\[실행 대기\]/, 'programmatic run attempts surface the blocked reason');
assert.match(appJs, /log\.textContent = '컴파일 요청 중/, 'compile action writes to the execution log');
assert.match(appJs, /startBtn\.disabled = activeRecord \|\| activeVerify \|\| activeRun \|\| busy \|\| !form\.recordUrl \|\| !recordAccess\.allowed;/, 'record start stays disabled until a real record URL is entered');
assert.match(appJs, /!form\.recordUrl\s*\?\s*'URL 입력 필요'/, 'empty record URL changes the button label to an explicit blocked state');
assert.match(appJs, /녹화 URL이 비어 있어 녹화 시작이 꺼져 있습니다/, 'record hint explains why recording is disabled');
assert.match(indexHtml, /id="auto-onboarding"/, 'automation view includes a development onboarding status panel');
assert.match(indexHtml, /id="auto-auth-action-reason"/, 'auth controls have a visible action reason slot');
assert.match(indexHtml, /id="auto-record-action-reason"/, 'record controls have a visible action reason slot');
assert.match(indexHtml, /id="auto-flow-action-reason"/, 'verify/compile/run controls have a visible action reason slot');
assert.match(appJs, /function renderAutomationOnboarding\(form, flow, \{ loggedIn, activeRecord, activeVerify, activeRun, busy \}\)/, 'automation onboarding panel is rendered from current form and flow state');
assert.match(appJs, /owner approval\/evidence pack은 production open에서만 필요합니다/, 'development read-only copy keeps production approval separate');
assert.match(appJs, /postJson\('\/api\/dev-integration-readonly', \{ name: flow\.name, allowlist, validateOnly: false \}\)/, 'automation run uses the development read-only endpoint for eligible flows');
assert.match(appJs, /runBtn\.textContent = !runAccess\.allowed \? '권한 제한' : flow && isDevelopmentReadonlyFlow\(flow\) \? '개발 실행'/, 'run button labels development read-only replay explicitly');
assert.match(utilJs, /streamJob\(jobId, logEl, onEnd, options = \{\}\)/, 'job stream supports log preservation options');
assert.match(utilJs, /if \(options\.clearOnOpen !== false\) logEl\.textContent = '';/, 'job stream can preserve pre-stream log headers');
assert.match(serverJs, /function developmentReadonlyCompileContext\(flow\)/, 'WebUI compile derives a development read-only context for eligible flows');
assert.match(serverJs, /AQA_DEV_INTEGRATION_READONLY: '1'/, 'WebUI compile uses the development read-only env instead of production evidence requirements');
assert.doesNotMatch(indexHtml, /id="auto-record-url"[^>]*placeholder="https:\/\/app\.example\.com\/dashboard"/, 'record URL placeholder must not look like a filled real URL');
assert.match(indexHtml, /id="auto-record-url"[^>]*placeholder="로그인 후 열린 실제 업무 화면 URL을 붙여넣으세요"/, 'record URL placeholder tells the operator to paste the post-login screen URL');
assert.match(appCss, /\.btn:disabled,\s*\.btn\.primary:disabled,\s*\.btn\.danger:disabled\s*\{[\s\S]*background: var\(--surface-3\);/, 'disabled primary buttons render as neutral, not teal');
assert.match(appCss, /\.onboarding-grid\s*\{[\s\S]*grid-template-columns: repeat\(4, minmax\(150px, 1fr\)\);/, 'onboarding status uses a stable responsive grid');
assert.match(appCss, /\.control-reason\s*\{[\s\S]*overflow-wrap: anywhere;/, 'visible control reasons wrap long policy messages');
NODE

echo "  webui-automation-auth-ui-unit: auth controls remain refreshable"
