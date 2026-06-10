// webui/redact.js - shared redaction helpers for WebUI API payloads and logs.
//
// Keep this module deterministic and dependency-free. It is used on readback
// surfaces, not as proof that raw artifacts are safe to export.

const DEFAULT_MAX = 320;

export function compactText(value) {
	return String(value == null ? '' : value)
		.replace(/\x1b\[[0-9;]*m/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export function redactText(value, fallback = '', max = DEFAULT_MAX) {
	let s = compactText(value);
	if (!s) s = fallback;
	s = s
		.replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*[A-Za-z0-9._~+/=-]+/ig, 'authorization: [redacted]')
		.replace(/\b(cookie|set-cookie)\s*:\s*[^,;\s]+(?:[;,]\s*[^,;\s]+)*/ig, '$1: [redacted]')
		.replace(/(https?:\/\/[^\s?#]+)\?[^)\]\s]+/ig, '$1?[redacted]')
		.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/ig, '$1 [redacted]')
		.replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|otp|mfa|totp|code)\s*[:=]\s*[^&,\s;]+/ig, '$1=[redacted]')
		.replace(/\b(session|cookie|auth|csrf)[_-]?(id|token)?\s*[:=]\s*(?!\[redacted\])[^&,\s;]+/ig, '$1$2=[redacted]')
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[REDACTED_EMAIL]')
		.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_ID]')
		.replace(/\b\d{6}-?[1-4]\d{6}\b/g, '[REDACTED_ID]')
		.replace(/\b(?:\+?82[-.\s]?)?0?1[016789][-. \s]?\d{3,4}[-. \s]?\d{4}\b/g, '[REDACTED_PHONE]')
		.replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]');
	return max > 0 && s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

function isSensitiveKey(key) {
	return /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|otp|mfa|totp|cookie|authorization|auth[_-]?state|state[_-]?json|values[_-]?json|flow[_-]?values|auth[_-]?values)\b/i
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
