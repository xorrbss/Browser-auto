// webui/spawn.js — the ONE place the web layer shells out to the existing CLI.
//
// shell:false + array args => web-form input is NEVER interpreted by a shell (no injection).
// cwd is always PROBE_ROOT so the CLI resolves paths/tools exactly as it does from a terminal.
// P1 uses gitBash() only; P2 will add recordCmd() (headed Chrome via record.cmd).

import { spawn } from 'node:child_process';
import path from 'node:path';

export const PROBE_ROOT = path.resolve(import.meta.dirname, '..');

// Bash that runs the CLI. Windows: Git Bash (MINGW64) — the SAME shim record.cmd uses, NOT WSL
// bash (which breaks the CLI). Linux/macOS (e.g. the Docker recording server): the system bash.
// Override either via WEBUI_BASH.
const IS_WIN = process.platform === 'win32';
const GIT_BASH = process.env.WEBUI_BASH || (IS_WIN ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');

// gitBash(scriptRel, args): run a bash CLI script (path relative to PROBE_ROOT), e.g.
// gitBash('run.sh', ['login'])  ->  bash.exe run.sh login   (cwd = PROBE_ROOT).
export function gitBash(scriptRel, args = [], extraEnv = null) {
	return spawn(GIT_BASH, [scriptRel, ...args], {
		cwd: PROBE_ROOT,
		env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
		windowsHide: true,
		// POSIX: run the child in its OWN process group (pgid === pid) so killTree() can reap the
		// whole bash -> run.sh -> agent-browser -> Chrome tree with one group kill. We never unref()
		// — jobs.js still awaits 'close', so the parent keeps tracking it. Windows uses taskkill /T
		// and must NOT be detached (detached there spawns a stray console window).
		detached: !IS_WIN,
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

// killTree(pid): kill a process AND its whole descendant tree. child.kill() only signals the top
// process — it does NOT reap bash -> run.sh -> agent-browser -> Chrome, which would leave a wedged
// daemon. Windows: taskkill /T walks the tree, /F forces. POSIX: gitBash() spawned the child
// detached (its own process group, pgid === pid), so a negative-pid SIGKILL reaps the whole group.
// Best-effort either way — the child's own 'close' still resolves the queue slot.
export function killTree(pid) {
	if (!pid) return;
	try {
		if (IS_WIN) {
			spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		} else {
			process.kill(-pid, 'SIGKILL');
		}
	} catch {
		/* best-effort: the child's own 'close' still resolves the queue slot */
	}
}
