// webui/redact.js - shared redaction helpers for WebUI API payloads and logs.
//
// Keep this module deterministic and dependency-free. It is used on readback
// surfaces, not as proof that raw artifacts are safe to export.

const DEFAULT_MAX = 320;
const SECRET_PATH_RE = /(?:[A-Za-z]:)?[\\/][^\s"'<>)]*(?:fixtures[\\/]auth|approve[\\/][^\\/\s"'<>)]*\.pw-state\.json|flows[\\/][^\\/\s"'<>)]*\.values\.json|data[\\/][^\\/\s"'<>)]*(?:\.(?:db|sqlite|sqlite3|jsonl|log))?|browser-profiles?|runner-work|user-data-dir)[^\s"'<>)]*/ig;
const SECRET_FILE_PATH_RE = /(?:[A-Za-z]:)?[\\/][^\s"'<>)]*\.(?:state\.json|pw-state\.json|values\.json|db|sqlite|sqlite3|cookie|cookies|env)\b/ig;
const SECRET_REL_PATH_RE = /(^|[\s"'(])((?:\.{0,2}[\\/])?(?:fixtures[\\/]auth[^\s"'<>)]*|approve[\\/][^\\/\s"'<>)]*\.pw-state\.json|flows[\\/][^\\/\s"'<>)]*\.values\.json|data[\\/][^\\/\s"'<>)]*(?:\.(?:db|sqlite|sqlite3|jsonl|log))?|browser-profiles?[^\s"'<>)]*|runner-work[^\s"'<>)]*|user-data-dir[^\s"'<>)]*))/ig;
const SECRET_REL_FILE_RE = /(^|[\s"'(])([^\s"'<>)]*\.(?:state\.json|pw-state\.json|values\.json|db|sqlite|sqlite3|cookie|cookies|env)\b)/ig;
const SECRET_WORDS = 'password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|cookie|authorization|otp|mfa|totp|auth[_-]?code|credential';
// Hoisted from redactText so the SECRET_WORDS-derived patterns are compiled once, not per call.
// Used only with String.replace, which resets a global regex's lastIndex, so module-level reuse is safe.
const SECRET_KV_RE = new RegExp(`(["']?)\\b(${SECRET_WORDS})\\1\\s*[:=]\\s*(["'])?(?!\\[redacted\\])[^"',&\\s;}{]+\\3?`, 'ig');
const SECRET_FLAG_RE = new RegExp(`(^|\\s)(--?(?:${SECRET_WORDS}))\\s+(?:"[^"]*"|'[^']*'|[^\\s]+)`, 'ig');

function stripAnsi(value) {
	return String(value == null ? '' : value).replace(/\x1b\[[0-9;]*m/g, '');
}

export function compactText(value) {
	return stripAnsi(value)
		.replace(/\s+/g, ' ')
		.trim();
}

// preserveWhitespace keeps tabs/columns intact for structured text artifacts (TSV, aligned
// logs); the default collapses whitespace so readback log lines stay compact.
export function redactText(value, fallback = '', max = DEFAULT_MAX, opts = {}) {
	let s = opts.preserveWhitespace ? stripAnsi(value) : compactText(value);
	if (!s) s = fallback;
	s = s
		.replace(SECRET_PATH_RE, '[REDACTED_SECRET_PATH]')
		.replace(SECRET_REL_PATH_RE, '$1[REDACTED_SECRET_PATH]')
		.replace(SECRET_REL_FILE_RE, '$1[REDACTED_SECRET_PATH]')
		.replace(SECRET_FILE_PATH_RE, '[REDACTED_SECRET_PATH]')
		.replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*["']?[A-Za-z0-9._~+/=-]+["']?/ig, 'authorization: [redacted]')
		.replace(/\b(cookie|set-cookie)\s*:\s*(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^,;\s]+)(?:[;,]\s*(?:"[^"]*"|'[^']*'|[^,;\s]+))*/ig, '$1: [redacted]')
		.replace(/(https?:\/\/[^\s?#]+)\?[^)\]\s"'<>]+/ig, '$1?[redacted]')
		.replace(/\b(bearer|basic)\s+["']?[A-Za-z0-9._~+/=-]+["']?/ig, '$1 [redacted]')
		.replace(SECRET_KV_RE, '$2=[redacted]')
		.replace(SECRET_FLAG_RE, '$1$2 [redacted]')
		.replace(/\b(otp|mfa|totp|2fa|one[-_ ]?time(?:[-_ ]?code)?|verification(?:[-_ ]?code)?|authenticator[-_ ]?code)\s*(?:is|:|=)?\s*["']?\d{4,10}["']?/ig, '$1 [redacted]')
		.replace(/\b(session|cookie|auth|csrf)[_-]?(id|token)?\s*[:=]\s*(?!\[redacted\])[^&,\s;]+/ig, '$1$2=[redacted]')
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[REDACTED_EMAIL]')
		.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_ID]')
		.replace(/\b\d{6}-?[1-4]\d{6}\b/g, '[REDACTED_ID]')
		.replace(/\b(?:\+?82[-.\s]?)?0?1[016789][-. \s]?\d{3,4}[-. \s]?\d{4}\b/g, '[REDACTED_PHONE]')
		.replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]');
	return max > 0 && s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

function isSensitiveKey(key) {
	return /\b(password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|credential|otp|mfa|totp|cookie|set-cookie|authorization|auth[_-]?state|storage[_-]?state|local[_-]?storage|session[_-]?storage|state[_-]?json|values[_-]?json|flow[_-]?values|auth[_-]?values)\b/i
		.test(String(key || ''));
}

export function redactObject(value, max = DEFAULT_MAX) {
	if (value == null) return value;
	if (typeof value === 'string') return redactText(value, '', max);
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value.map((item) => redactObject(item, max));
	if (typeof value === 'object') {
		const out = {};
		for (const [key, raw] of Object.entries(value)) {
			out[key] = isSensitiveKey(key) && raw != null && String(raw).trim() !== ''
				? '[redacted]'
				: redactObject(raw, max);
		}
		return out;
	}
	return redactText(value, '', max);
}
