// webui/spawn.js - the one place the web layer shells out.
//
// shell:false + array args means web-form input is never interpreted by a
// shell. Browser-driving WebUI record/auth/verify paths are Playwright-only.

import { spawn } from 'node:child_process';
import path from 'node:path';

export const PROBE_ROOT = path.resolve(import.meta.dirname, '..');

const IS_WIN = process.platform === 'win32';
const GIT_BASH = process.env.WEBUI_BASH || (IS_WIN ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');

function spawnOpts(extraEnv = null) {
	return {
		cwd: PROBE_ROOT,
		env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
		windowsHide: true,
		// POSIX: put the child in its own process group so killTree() can reap
		// the whole browser-driver tree. Windows uses taskkill /T.
		detached: !IS_WIN,
	};
}

export function gitBash(scriptRel, args = [], extraEnv = null) {
	return spawn(GIT_BASH, [scriptRel, ...args], spawnOpts(extraEnv));
}

// Compatibility wrapper for bash browser jobs. WebUI record/auth/verify use
// Playwright leaves.
export function browserBash(scriptRel, args = [], extraEnv = null) {
	return gitBash(scriptRel, args, extraEnv);
}

export function recordCmd(name, startUrl, { app, seconds, stopFile, engine } = {}) {
	if (engine && engine !== 'playwright') {
		throw new Error(`record.engine: invalid engine "${engine}" (WebUI is Playwright-only)`);
	}
	const args = ['--name', name, '--url', startUrl];
	if (app) args.push('--app', app);
	args.push('--seconds', String(seconds));
	if (stopFile) args.push('--stop-file', stopFile);
	return nodeLeaf('bin/pw-record.mjs', args, stopFile ? { AQA_CAPTURE_STOPFILE: stopFile } : null);
}

export function nodeLeaf(scriptRel, args = [], extraEnv = null) {
	return spawn(process.execPath, [scriptRel, ...args], spawnOpts(extraEnv));
}

export function killTree(pid) {
	if (!pid) return;
	try {
		if (IS_WIN) {
			spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		} else {
			process.kill(-pid, 'SIGKILL');
		}
	} catch {
		/* best-effort: the child's own close still resolves the queue slot */
	}
}
