#!/usr/bin/env bash
# lib/act.sh - checked action helpers shared by tests and RPA drivers.

set -euo pipefail

if ! declare -F ABX >/dev/null 2>&1; then
	echo "  ✗ act.sh: source lib/env.sh before lib/act.sh" >&2
	return 1 2>/dev/null || exit 1
fi

_act_exact_locator() {
	case "$1" in
		text|label|placeholder|alt|title|role) return 0 ;;
		*) return 1 ;;
	esac
}

_act_parse_locator() {
	_ACT_BY="$1"; _ACT_VALUE="$2"; shift 2
	_ACT_NAME=""; _ACT_EXTRA=()
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--name)
				[ "$#" -ge 2 ] || { echo "  ✗ act: --name requires a value" >&2; return 2; }
				_ACT_NAME="$2"; shift 2 ;;
			--exact)
				shift ;;
			*)
				_ACT_EXTRA+=("$1"); shift ;;
		esac
	done
}

_act_find_args() {
	local action="$1"; shift
	_act_parse_locator "$@"
	_ACT_FIND=(find "$_ACT_BY" "$_ACT_VALUE" "$action")
	[ -z "$_ACT_NAME" ] || _ACT_FIND+=(--name "$_ACT_NAME")
	if _act_exact_locator "$_ACT_BY"; then _ACT_FIND+=(--exact); fi
	[ "${#_ACT_EXTRA[@]}" -eq 0 ] || _ACT_FIND+=("${_ACT_EXTRA[@]}")
}

_act_locator_state() {
	local by="$1" value="$2" name="${3:-}" payload out
	payload="$(jq -nc --arg by "$by" --arg value "$value" --arg name "$name" '{by:$by,value:$value,name:$name}')"
	out="$(AB_JSON eval "(() => {
const q = $payload;
const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
const labelText = (el) => {
  if (!el) return '';
  if (el.labels && el.labels.length) return Array.from(el.labels).map(l => l.textContent || '').join(' ');
  if (el.id) {
    const l = document.querySelector('label[for=\"' + CSS.escape(el.id) + '\"]');
    if (l) return l.textContent || '';
  }
  const p = el.closest && el.closest('label');
  return p ? (p.textContent || '') : '';
};
const roleOf = (el) => {
  const r = el.getAttribute && el.getAttribute('role');
  if (r) return r;
  const tag = el.tagName;
  const type = (el.getAttribute && (el.getAttribute('type') || '') || '').toLowerCase();
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A' && el.hasAttribute('href')) return 'link';
  if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) return type;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return 'combobox';
  return '';
};
const nameOf = (el) => norm(el.getAttribute('aria-label') || labelText(el) || el.getAttribute('title') || el.getAttribute('alt') || el.textContent || el.value || '');
const all = Array.from(document.querySelectorAll('*'));
const labelable = (el) => el.matches && el.matches('button,input,meter,output,progress,select,textarea,[role=\"checkbox\"],[role=\"radio\"]');
let m = [];
if (q.by === 'testid') m = all.filter(el => ['data-testid','data-test-id','data-test'].some(a => el.getAttribute(a) === q.value));
else if (q.by === 'label') m = all.filter(el => labelable(el) && norm(labelText(el)) === norm(q.value));
else if (q.by === 'placeholder') m = all.filter(el => el.getAttribute('placeholder') === q.value);
else if (q.by === 'alt') m = all.filter(el => el.getAttribute('alt') === q.value);
else if (q.by === 'title') m = all.filter(el => el.getAttribute('title') === q.value);
else if (q.by === 'text') m = all.filter(el => norm(el.textContent) === norm(q.value));
else if (q.by === 'role') m = all.filter(el => roleOf(el) === q.value && (!q.name || nameOf(el) === norm(q.name)));
const el = m.length === 1 ? m[0] : null;
return { count: m.length, checked: el ? (el.checked === true || el.getAttribute('aria-checked') === 'true') : null };
})()")" || return 1
	printf '%s' "$out" | jq -c '.data.result'
}

resolve_one() {
	[ "$#" -ge 2 ] || { echo "usage: resolve_one <by> <value> [--name <name>]" >&2; return 2; }
	_act_parse_locator "$@"
	local state count
	state="$(_act_locator_state "$_ACT_BY" "$_ACT_VALUE" "$_ACT_NAME")" || return 1
	count="$(printf '%s' "$state" | jq -r '.count')"
	if [ "$count" != "1" ]; then
		echo "  ✗ resolve_one: ${_ACT_BY}:${_ACT_VALUE}${_ACT_NAME:+ name=$_ACT_NAME} matched $count element(s)" >&2
		return 1
	fi
	_act_find_args hover "$@"
	ABX "${_ACT_FIND[@]}" >/dev/null
}

set_check() {
	[ "$#" -ge 3 ] || { echo "usage: set_check <by> <value> <true|false> [--name <name>]" >&2; return 2; }
	local by="$1" value="$2" target="$3"; shift 3
	case "$target" in true|false) ;; *) echo "  ✗ set_check: target must be true or false" >&2; return 2 ;; esac
	_act_parse_locator "$by" "$value" "$@"
	local state current after
	state="$(_act_locator_state "$_ACT_BY" "$_ACT_VALUE" "$_ACT_NAME")" || return 1
	[ "$(printf '%s' "$state" | jq -r '.count')" = "1" ] || { echo "  ✗ set_check: ${_ACT_BY}:${_ACT_VALUE} is not unique" >&2; return 1; }
	current="$(printf '%s' "$state" | jq -r '.checked')"
	[ "$current" = "$target" ] && return 0

	if [ "$target" = "true" ]; then
		_act_find_args check "$by" "$value" "$@"
		ABX "${_ACT_FIND[@]}" >/dev/null
	else
		_act_find_args click "$by" "$value" "$@"
		ABX "${_ACT_FIND[@]}" >/dev/null
	fi

	after="$(_act_locator_state "$_ACT_BY" "$_ACT_VALUE" "$_ACT_NAME")" || return 1
	if [ "$(printf '%s' "$after" | jq -r '.checked')" = "$target" ]; then return 0; fi
	# A final retry covers UI handlers that race the first click.
	ABX "${_ACT_FIND[@]}" >/dev/null
	after="$(_act_locator_state "$_ACT_BY" "$_ACT_VALUE" "$_ACT_NAME")" || return 1
	if [ "$(printf '%s' "$after" | jq -r '.checked')" = "$target" ]; then return 0; fi
	echo "  ✗ set_check: ${_ACT_BY}:${_ACT_VALUE} did not reach checked=$target" >&2
	return 1
}
