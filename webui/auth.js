// webui/auth.js — list cached auth apps (read-only). The actual login is the existing
// setup/auth.sh (spawned through the serial queue, headed Chrome, human OTP). We only ever
// expose the APP NAME (the state file holds secrets and is gitignored — never its content).

import { readdir } from 'node:fs/promises';
import path from 'node:path';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const AUTH_DIR = path.join(PROBE_ROOT, 'fixtures', 'auth');
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export const validApp = (a) => typeof a === 'string' && NAME_RE.test(a);

export async function listAuthStates() {
	let entries;
	try {
		entries = await readdir(AUTH_DIR);
	} catch {
		return [];
	}
	return entries
		.filter((f) => f.endsWith('.state.json'))
		.map((f) => f.slice(0, -'.state.json'.length))
		.filter(validApp)
		.sort();
}
