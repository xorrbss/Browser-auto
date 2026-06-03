// webui/spawn.js — the ONE place the web layer shells out to the existing CLI.
//
// shell:false + array args => web-form input is NEVER interpreted by a shell (no injection).
// cwd is always PROBE_ROOT so the CLI resolves paths/tools exactly as it does from a terminal.
// P1 uses gitBash() only; P2 will add recordCmd() (headed Chrome via record.cmd).

import { spawn } from 'node:child_process';
import path from 'node:path';

export const PROBE_ROOT = path.resolve(import.meta.dirname, '..');

// Git Bash (MINGW64) — the SAME shim record.cmd uses. NOT WSL bash (which breaks the CLI).
// Override only for tests/non-standard installs via WEBUI_BASH.
const GIT_BASH = process.env.WEBUI_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe';

// gitBash(scriptRel, args): run a bash CLI script (path relative to PROBE_ROOT), e.g.
// gitBash('run.sh', ['login'])  ->  bash.exe run.sh login   (cwd = PROBE_ROOT).
export function gitBash(scriptRel, args = [], extraEnv = null) {
	return spawn(GIT_BASH, [scriptRel, ...args], {
		cwd: PROBE_ROOT,
		env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
		windowsHide: true,
	});
}

// recordCmd(name, startUrl, {app, seconds}): launch the headed-Chrome recorder. We invoke
// bin/probe-record.sh capture DIRECTLY via Git-Bash (exactly what record.cmd's body does:
// `bash.exe bin/probe-record.sh capture %*`) rather than going through `cmd.exe /c record.cmd`.
// Going through cmd.exe is a COMMAND-INJECTION hole: cmd.exe re-parses its own command line, so
// a startUrl containing & | < > ^ " escapes the arg and runs arbitrary commands — defeating
// shell:false. gitBash() passes an argv array to bash.exe with no shell, so startUrl is one
// inert argument. (Chrome is still shown by agent-browser's headed mode; only the bash console
// is hidden.) --seconds is MANDATORY: capture()'s interactive /dev/tty stop is unreachable from
// a non-tty spawn, so a timed auto-stop is the only web-drivable way to end a recording.
export function recordCmd(name, startUrl, { app, seconds, stopFile } = {}) {
	const args = ['capture', name, startUrl];
	if (app) args.push('--app', app);
	args.push('--seconds', String(seconds));
	// stopFile (optional): a path the web UI touches to request a GRACEFUL early finish; capture()
	// watches AQA_CAPTURE_STOPFILE and breaks into its normal drain path (a complete flow).
	return gitBash('bin/probe-record.sh', args, stopFile ? { AQA_CAPTURE_STOPFILE: stopFile } : null);
}

// killTree(pid): kill a process AND its whole descendant tree. On Windows child.kill()
// only signals the top process — it does NOT reap bash -> run.sh -> agent-browser -> Chrome,
// which would leave a wedged daemon. taskkill /T walks the tree; /F forces. Best-effort.
export function killTree(pid) {
	if (!pid) return;
	try {
		spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
	} catch {
		/* best-effort: the child's own 'close' (below) still resolves the queue slot */
	}
}
