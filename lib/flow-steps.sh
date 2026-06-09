#!/usr/bin/env bash
# Shared compiled-flow step helpers. Leaf library: callers provide ABX/AB_JSON
# from lib/env.sh and PROBE_ROOT from the test/verify process.

_aqa_flow_recipe_path() {
	local recipe="$1"
	case "$recipe" in
		''|*[!A-Za-z0-9_-]*)
			echo "  x open_record invalid recipe '$recipe' (use [A-Za-z0-9_-])" >&2
			return 1
			;;
	esac
	printf '%s/recipes/%s.json' "${PROBE_ROOT:?PROBE_ROOT is required}" "$recipe"
}

_aqa_flow_json_ok() {
	local json="$1"
	[ "$(printf '%s' "$json" | jq -r '.success // false' 2>/dev/null || echo false)" = "true" ]
}

_aqa_open_record_try_click() {
	local desc="$1"; shift
	local out
	out="$(AB_JSON "$@" 2>/dev/null </dev/null || true)"
	if _aqa_flow_json_ok "$out"; then
		echo "  * open_record clicked via $desc" >&2
		return 0
	fi
	_AQA_OPEN_RECORD_LAST_ERR="$(printf '%s' "$out" | jq -r '.error // "unknown error"' 2>/dev/null || echo "invalid JSON envelope")"
	return 1
}

# aqa_open_record first <recipe> [field]
# aqa_open_record row_index <recipe> [field] <rowIndex>
#
# Opens a list record selected from the live page, not from a recorded literal.
# source=first is backward-compatible shorthand for rowIndex=0.
# source=row_index parses the current accessible table with recipes/<recipe>.json,
# reads the selected 0-based data row, and clicks the row's key (or the optional field).
aqa_open_record() {
	local source="${1:-}" recipe="${2:-}" field="${3:-}" row_index_arg="${4:-}"
	source="${source%$'\r'}"
	recipe="${recipe%$'\r'}"
	field="${field%$'\r'}"
	row_index_arg="${row_index_arg%$'\r'}"
	local row_index mode
	case "$source" in
		first)
			row_index=0
			mode="first"
			;;
		row_index)
			case "$row_index_arg" in
				''|*[!0-9]*)
					echo "  x open_record:row_index invalid rowIndex '$row_index_arg' (use a 0-based integer)" >&2
					return 1
					;;
			esac
			row_index="$row_index_arg"
			mode="row_index:${row_index}"
			;;
		*)
			echo "  x open_record unsupported source '$source' (expected 'first' or 'row_index')" >&2
			return 1
			;;
	esac

	local recipe_file
	recipe_file="$(_aqa_flow_recipe_path "$recipe")" || return 1
	[ -s "$recipe_file" ] || { echo "  x open_record:$mode missing recipe $recipe_file" >&2; return 1; }
	if [ -n "$field" ]; then
		case "$field" in
			*[!A-Za-z0-9_-]*)
				echo "  x open_record:$mode invalid field '$field' (use [A-Za-z0-9_-])" >&2
				return 1
				;;
		esac
	else
		field="$(jq -r '.key // empty' "$recipe_file")"
	fi
	[ -n "$field" ] || { echo "  x open_record:$mode recipe has no key field" >&2; return 1; }

	local snap rows row key click_val errf rc last_err t row_count attempts
	row=""
	last_err="list table did not become readable"
	attempts="${AQA_OPEN_RECORD_ATTEMPTS:-24}"
	case "$attempts" in ''|*[!0-9]*) attempts=24 ;; esac
	for t in $(seq 1 "$attempts"); do
		snap="$(ABX snapshot </dev/null 2>/dev/null)" || {
			last_err="snapshot failed"
			sleep 0.5
			continue
		}
		errf="$(mktemp)"
		set +e
		rows="$(printf '%s' "$snap" | jq '.data' | node "$PROBE_ROOT/bin/extract-list.js" "$recipe_file" 2>"$errf")"
		rc=$?
		set -e
		if [ "$rc" -eq 0 ]; then
			row_count="$(printf '%s' "$rows" | jq -r 'length' 2>/dev/null || echo 0)"
			row="$(printf '%s' "$rows" | jq -ec --argjson i "$row_index" '.[$i] // empty' 2>/dev/null || true)"
			if [ -n "$row" ]; then
				rm -f "$errf"
				break
			fi
			if [ "${row_count:-0}" -eq 0 ] 2>/dev/null; then
				last_err="found recipe table but no data rows"
			else
				last_err="rowIndex $row_index is out of range (rows=$row_count)"
			fi
		else
			last_err="$(tr '\n' ' ' < "$errf" | sed 's/[[:space:]]*$//')"
		fi
		rm -f "$errf"
		sleep 0.5
	done
	if [ -z "$row" ]; then
		echo "  x open_record:$mode ${last_err:-found no data rows for recipe '$recipe'}" >&2
		return 1
	fi
	key="$(printf '%s' "$row" | jq -r '.key // empty')"
	click_val="$(printf '%s' "$row" | jq -er --arg f "$field" '
		if $f == "key" then .key
		elif (.data | has($f)) then .data[$f]
		else empty end
	')" || {
		echo "  x open_record:$mode field '$field' was not present in rowIndex $row_index" >&2
		return 1
	}
	[ -n "$click_val" ] || { echo "  x open_record:$mode rowIndex $row_index field '$field' is empty" >&2; return 1; }

	echo "  * open_record:$mode recipe=$recipe field=$field key=${key:-?} value=$click_val" >&2
	_AQA_OPEN_RECORD_LAST_ERR=""
	_aqa_open_record_try_click "title exact" find title "$click_val" click --exact && return 0
	_aqa_open_record_try_click "text exact" find text "$click_val" click --exact && return 0
	# Some enterprise tables render the key inside a larger cell; exact text cannot hit that shape.
	# The downstream wait/detail gates still bind the click, so this is fail-loud rather than a blind nth-click.
	_aqa_open_record_try_click "text contains" find text "$click_val" click && return 0

	echo "  x open_record:$mode could not click rowIndex $row_index value '$click_val' (last error: ${_AQA_OPEN_RECORD_LAST_ERR:-unknown})" >&2
	return 1
}
