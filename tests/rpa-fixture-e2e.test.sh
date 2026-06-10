#!/usr/bin/env bash
# Local-only fixture E2E for the Playwright RPA authoring pipeline. It records a business-style
# loopback journey, lets build-flow produce the flow/values/candidates, verifies, compiles, and
# runs the compiled deterministic bash wrapper. It also pins headerless-table open_record, needs_review
# refusal, and a deterministic failure case without external auth or sites.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN=""
if [ -n "${NODE:-}" ]; then
	NODE_BIN="$(command -v "$NODE" 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
	NODE_BIN="$(command -v node 2>/dev/null || command -v node.exe 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
	echo "  rpa-fixture-e2e: node not found on PATH" >&2
	exit 127
fi
NODE_SHIM_DIR="$DIR/artifacts/.rpa-fixture-shims-$$"
rm -rf "$NODE_SHIM_DIR"
mkdir -p "$NODE_SHIM_DIR"
trap 'rm -rf "$NODE_SHIM_DIR"' EXIT
make_exe_shim() {
	local name="$1"
	local target="$2"
cat > "$NODE_SHIM_DIR/$name" <<EOF
#!/usr/bin/env bash
target="$target"
if [ ! -x "\$target" ]; then
	case "\$target" in
		/mnt/[a-zA-Z]/*)
			drive="\${target:5:1}"
			rest="\${target:7}"
			target="/\$drive/\$rest"
			;;
	esac
fi
converted=()
for arg in "\$@"; do
	case "\$arg" in
		/mnt/[a-zA-Z]/*)
			drive="\${arg:5:1}"
			rest="\${arg:7}"
			converted+=("\${drive^^}:/\$rest")
			;;
		/[a-zA-Z]/*)
			drive="\${arg:1:1}"
			rest="\${arg:3}"
			converted+=("\${drive^^}:/\$rest")
			;;
		*) converted+=("\$arg") ;;
	esac
done
exec "\$target" "\${converted[@]}"
EOF
	chmod +x "$NODE_SHIM_DIR/$name"
}
make_exe_shim node "$NODE_BIN"
cp "$NODE_SHIM_DIR/node" "$NODE_SHIM_DIR/node.exe"
chmod +x "$NODE_SHIM_DIR/node.exe"
JQ_BIN="$(command -v jq 2>/dev/null || command -v jq.exe 2>/dev/null || true)"
if [ -n "$JQ_BIN" ]; then
cat > "$NODE_SHIM_DIR/jq" <<EOF
#!/usr/bin/env bash
set -o pipefail
target="$JQ_BIN"
if [ ! -x "\$target" ]; then
	case "\$target" in
		/mnt/[a-zA-Z]/*)
			drive="\${target:5:1}"
			rest="\${target:7}"
			target="/\$drive/\$rest"
			;;
	esac
fi
converted=()
for arg in "\$@"; do
	case "\$arg" in
		/mnt/[a-zA-Z]/*)
			drive="\${arg:5:1}"
			rest="\${arg:7}"
			converted+=("\${drive^^}:/\$rest")
			;;
		/[a-zA-Z]/*)
			drive="\${arg:1:1}"
			rest="\${arg:3}"
			converted+=("\${drive^^}:/\$rest")
			;;
		*) converted+=("\$arg") ;;
	esac
done
"\$target" "\${converted[@]}" | tr -d '\r'
EOF
	chmod +x "$NODE_SHIM_DIR/jq"
	cp "$NODE_SHIM_DIR/jq" "$NODE_SHIM_DIR/jq.exe"
	chmod +x "$NODE_SHIM_DIR/jq.exe"
fi
export PATH="$NODE_SHIM_DIR:$(dirname "$NODE_BIN"):$PATH"
case "$NODE_SHIM_DIR" in
	/mnt/[a-zA-Z]/*)
		_drive="${NODE_SHIM_DIR:5:1}"
		_rest="${NODE_SHIM_DIR:7}"
		export PATH="/$_drive/$_rest:$PATH"
		;;
esac
OUT_FILE="$NODE_SHIM_DIR/rpa-fixture.out"

set +e
(cd "$DIR" && "$NODE_BIN" --input-type=module - > "$OUT_FILE" 2>&1 <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
	RPA_FIXTURE_NOTE,
	startRpaFixtureServer,
} from './tests/fixtures/rpa-fixture-server.mjs';

const ROOT = process.cwd();
const BASH_PATH = '';
const PID = process.pid;
const happyName = `rpa_fixture_happy_${PID}`;
const reviewName = `rpa_fixture_review_${PID}`;
const headerName = `rpa_fixture_headerless_${PID}`;
const failName = `rpa_fixture_failure_${PID}`;
const recipeName = `rpa_fixture_headerless_${PID}`;
const generated = [
	`flows/${happyName}.flow.json`,
	`flows/${happyName}.values.json`,
	`flows/${happyName}.candidates.json`,
	`tests/${happyName}.test.sh`,
	`flows/${reviewName}.flow.json`,
	`flows/${reviewName}.values.json`,
	`flows/${reviewName}.candidates.json`,
	`tests/${reviewName}.test.sh`,
	`flows/${headerName}.flow.json`,
	`flows/${headerName}.values.json`,
	`flows/${headerName}.candidates.json`,
	`tests/${headerName}.test.sh`,
	`flows/${failName}.flow.json`,
	`flows/${failName}.values.json`,
	`flows/${failName}.candidates.json`,
	`tests/${failName}.test.sh`,
	`recipes/${recipeName}.json`,
];

function abs(rel) {
	return path.join(ROOT, rel);
}

function cleanup() {
	for (const rel of generated) fs.rmSync(abs(rel), { force: true });
}

function readJson(rel) {
	return JSON.parse(fs.readFileSync(abs(rel), 'utf8'));
}

function writeJson(rel, value) {
	fs.writeFileSync(abs(rel), JSON.stringify(value, null, 2) + '\n');
}

function ok(condition, message) {
	if (!condition) throw new Error(message);
	console.log(`  ok ${message}`);
}

function noBrowser(out) {
	return /Executable doesn't exist|Chromium distribution|not found at/.test(out || '');
}

function shQuote(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function runProcess(label, command, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: ROOT,
			encoding: 'utf8',
			windowsHide: true,
			env: { ...process.env, ...(opts.env || {}) },
		});
		let out = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, opts.timeout || 60000);
		child.stdout.on('data', (d) => { out += d; });
		child.stderr.on('data', (d) => { out += d; });
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`${label}: ${e.message}\n${out}`));
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			const status = code == null ? 1 : code;
			if (timedOut) {
				reject(new Error(`${label}: timed out after ${opts.timeout || 60000}ms${signal ? ` (${signal})` : ''}\n${out}`));
				return;
			}
			if (!opts.allowFailure && status !== 0) {
				reject(new Error(`${label}: exit ${status}\n${out}`));
				return;
			}
			resolve({ status, out });
		});
	});
}

function runBash(label, args, opts = {}) {
	return runProcess(label, 'bash', ['-lc', args.map(shQuote).join(' ')], opts);
}

function runNode(label, args, opts = {}) {
	return runProcess(label, process.execPath, args, opts);
}

function hasStep(flow, pred) {
	return (flow.steps || []).some(pred);
}

cleanup();
const fixture = await startRpaFixtureServer();
try {
	const nodeProbe = await runBash('nested node probe', ['node', '--version'], { allowFailure: true });
	if (nodeProbe.status !== 0) {
		throw new Error(`nested bash cannot run node; BASH_PATH=${BASH_PATH || '<unset>'}\n${nodeProbe.out}`);
	}
	ok(true, `nested bash can run ${nodeProbe.out.trim()}`);

	const recordEnv = { AQA_PW_RECORD_HEADLESS: '1' };
	const happyUrl = `${fixture.origin}/journey/start/${happyName}`;
	const happyCapture = await runBash('record happy fixture', ['bin/probe-record.sh', 'capture', happyName, happyUrl, '--seconds', '5'], {
		allowFailure: true,
		timeout: 90000,
		env: recordEnv,
	});
	if (noBrowser(happyCapture.out)) {
		console.log('SKIP_NO_BROWSER');
		process.exit(0);
	}
	if (happyCapture.status !== 0) throw new Error(`happy capture exited ${happyCapture.status}\n${happyCapture.out}`);
	ok(true, `happy capture exited 0`);
	ok(happyCapture.out.includes('[build-flow] wrote'), 'happy capture invoked build-flow');
	ok(fixture.runState(happyName) === 'complete', 'happy autorun reached iframe completion');

	const happyFlowRel = `flows/${happyName}.flow.json`;
	let happyFlow = readJson(happyFlowRel);
	ok(!hasStep(happyFlow, (s) => s.needs_review), 'happy flow has no needs_review steps');
	ok(hasStep(happyFlow, (s) => s.kind === 'find' && s.action === 'select' && s.by === 'label' && s.value === 'Page'), 'happy flow captured pagination select');
	ok(hasStep(happyFlow, (s) => s.kind === 'find' && s.action === 'click' && s.value === `open-WO-2002`), 'happy flow captured detail open from list table');
	ok(hasStep(happyFlow, (s) => s.kind === 'find' && s.action === 'fill' && s.by === 'label' && s.value === 'Reviewer note' && /^\{\{input_\d+\}\}$/.test(s.text || '')), 'happy flow captured tokenized form input');
	ok(hasStep(happyFlow, (s) => s.kind === 'find' && s.action === 'click' && s.frame && s.frame.by === 'id' && s.frame.value === 'approvalFrame'), 'happy flow captured same-origin iframe action');
	ok(fs.existsSync(abs(`flows/${happyName}.values.json`)), 'happy values sidecar was generated');
	ok(!fs.readFileSync(abs(happyFlowRel), 'utf8').includes(RPA_FIXTURE_NOTE), 'happy flow does not leak raw input value');

	happyFlow.asserts = [
		...(happyFlow.asserts || []),
		{ kind: 'text', value: 'Draft saved' },
		{ kind: 'text', value: 'Frame confirmed' },
	];
	writeJson(happyFlowRel, happyFlow);
	await runBash('verify happy fixture', ['bin/probe-record.sh', 'verify', happyFlowRel], { timeout: 90000 });
	await runBash('compile happy fixture', ['bin/probe-record.sh', 'compile', happyFlowRel]);
	const happyRun = await runBash('run happy fixture', ['bash', `tests/${happyName}.test.sh`], { timeout: 90000 });
	ok(/AQA_JOB_RESULT=.*"status":"ok"/.test(happyRun.out), 'happy compiled journey ran successfully');

	const reviewUrl = `${fixture.origin}/needs-review/${reviewName}`;
	const reviewCapture = await runBash('record needs_review fixture', ['bin/probe-record.sh', 'capture', reviewName, reviewUrl, '--seconds', '3'], {
		allowFailure: true,
		timeout: 90000,
		env: recordEnv,
	});
	if (reviewCapture.status !== 0) throw new Error(`needs_review capture exited ${reviewCapture.status}\n${reviewCapture.out}`);
	ok(true, 'needs_review capture exited 0');
	const reviewFlowRel = `flows/${reviewName}.flow.json`;
	const reviewFlow = readJson(reviewFlowRel);
	ok(hasStep(reviewFlow, (s) => s.needs_review === true), 'ambiguous/long fixture produced needs_review');
	const reviewCompile = await runBash('compile needs_review fixture', ['bin/probe-record.sh', 'compile', reviewFlowRel], { allowFailure: true });
	ok(reviewCompile.status !== 0 && /needs_review/.test(reviewCompile.out), 'compile refuses needs_review flow');
	const reviewValidate = await runNode('validate needs_review fixture', ['bin/play-flow.mjs', '--flow', reviewFlowRel, '--validate-only'], { allowFailure: true });
	ok(reviewValidate.status !== 0 && /needs_review/.test(reviewValidate.out), 'play-flow refuses needs_review flow');

	writeJson(`recipes/${recipeName}.json`, {
		collection: { name: 'Headerless Work Queue' },
		key: 'id',
		columns: { id: 'Request ID', subject: 'Subject', owner: 'Owner' },
		columnIndexes: { id: 0, subject: 1, owner: 2 },
	});
	writeJson(`flows/${headerName}.flow.json`, {
		name: headerName,
		engine: 'playwright',
		environment: 'local',
		riskClass: 'read',
		startUrl: `${fixture.origin}/headerless`,
		steps: [
			{ kind: 'open_record', source: 'row_index', recipe: recipeName, rowIndex: 1, field: 'subject' },
			{ kind: 'wait', until: 'url', value: '**/headerless/detail/HL-2' },
		],
		asserts: [{ kind: 'text', value: 'Headerless Detail HL-2' }],
	});
	await runBash('compile headerless fixture', ['bin/probe-record.sh', 'compile', `flows/${headerName}.flow.json`]);
	const headerRun = await runBash('run headerless fixture', ['bash', `tests/${headerName}.test.sh`], { timeout: 90000 });
	ok(/AQA_JOB_RESULT=.*"status":"ok"/.test(headerRun.out), 'headerless open_record journey ran successfully');

	writeJson(`flows/${failName}.flow.json`, {
		name: failName,
		engine: 'playwright',
		environment: 'local',
		riskClass: 'read',
		startUrl: `${fixture.origin}/failure`,
		steps: [{ kind: 'find', by: 'text', value: 'Missing Action', action: 'click' }],
		asserts: [],
	});
	await runBash('compile failure fixture', ['bin/probe-record.sh', 'compile', `flows/${failName}.flow.json`]);
	const failRun = await runBash('run failure fixture', ['bash', `tests/${failName}.test.sh`], { allowFailure: true, timeout: 90000 });
	ok(failRun.status !== 0 && /AQA_JOB_RESULT=.*"status":"failed"/.test(failRun.out), 'broken local journey fails through compiled wrapper');

	console.log('OK_RPA_FIXTURE_E2E');
} finally {
	await fixture.close();
	cleanup();
}
NODE
)
RC=$?
OUT="$(cat "$OUT_FILE" 2>/dev/null || true)"
set -e
printf '%s\n' "$OUT" | sed 's/^/  /'
case "$OUT" in
	*SKIP_NO_BROWSER*) echo "  rpa-fixture-e2e: skipped (Playwright Chrome channel unavailable)"; exit 0 ;;
	*OK_RPA_FIXTURE_E2E*) echo "  rpa-fixture-e2e: local RPA fixture pipeline passed"; exit 0 ;;
	*) echo "  rpa-fixture-e2e: failed (rc=$RC)" >&2; exit 1 ;;
esac
