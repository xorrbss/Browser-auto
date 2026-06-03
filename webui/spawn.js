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
export function gitBash(scriptRel, args = []) {
	return spawn(GIT_BASH, [scriptRel, ...args], {
		cwd: PROBE_ROOT,
		env: process.env,
		windowsHide: true,
	});
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
