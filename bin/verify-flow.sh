#!/usr/bin/env bash
# bin/verify-flow.sh — post-capture verify-repair replay (P2.6, opt-in authoring step).
#
# Re-drives flows/<name>.flow.json from the start (cached AB_AUTH state if .app) and, for each
# `find` step, NON-DESTRUCTIVELY probes its locator with `find ... hover --json`. The captured
# in-page uniqueness is only an estimate of how the engine's `find` actually resolves (design
# OPEN RISK: accname divergence / record-time-uniqueness-only), so a locator that passed capture
# can still fail at replay. When the step's locator no longer resolves, verify walks the captured
# candidate ladder (flows/<name>.candidates.json) and REPAIRS the step to the first candidate that
# resolves; if none resolve it PROMOTES the step to needs_review (compile then refuses it). After
# the walk it rewrites flow.json with the repairs/promotions.
#
# Driving the page is destructive (each action advances the journey) — exactly like replay — so
# this runs against the SAME build, headless, and re-executes any side effects the journey has.
# Fill/select values are substituted from flows/<name>.values.json (fill it first; a missing value
# is fail-loud). Reuses lib/env.sh (AB/AB_JSON/AB_AUTH) + lib/assert.sh (wait_url); bin->lib is allowed.
#
# Usage: bin/verify-flow.sh <flows/name.flow.json>
# Exit: 0 if every re-driven locator resolved (possibly after repair); non-zero if any step was
#       promoted to needs_review (resolve it, then re-run) or the re-drive could not start.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT="$DIR"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"
source "$DIR/lib/flow-steps.sh"

flow="${1:-}"
[ -s "$flow" ] || { echo "[verify] no such flow: $flow" >&2; exit 1; }
name="$(jq -r '.name' "$flow")"
app="$(jq -r '.app // empty' "$flow")"
starturl="$(jq -r '.startUrl' "$flow")"
candfile="${DIR}/flows/${name}.candidates.json"
valsfile="${DIR}/flows/${name}.values.json"
CAND_RAW="{}"; [ -s "$candfile" ] && CAND_RAW="$(cat "$candfile")"
VALS_JSON="{}"; [ -s "$valsfile" ] && VALS_JSON="$(cat "$valsfile")"

# `find` matches localized by-values exactly with --exact (mirrors compile()).
_exactflag(){ case "$1" in text|label|placeholder|alt|title|role) printf '%s' "--exact";; *) printf '';; esac; }

# _subst <string> -> substitute {{input_N}} tokens from values.json, fail loud on a missing key.
_subst(){
	local s; s="$(printf '%s' "$1" | jq -Rr --argjson v "$VALS_JSON" \
		'gsub("[{][{](?<k>[A-Za-z0-9_]+)[}][}]"; ($v[.k] // ("__AQA_MISSING__"+.k)))')"
	case "$s" in *__AQA_MISSING__*) echo "[verify] missing value in $valsfile — fill it before verify" >&2; return 1 ;; esac
	printf '%s' "$s"
}

# _hover <by> <value> <name> -> 0 if the locator resolves (non-destructive probe).
_hover(){
	local by="$1" value="$2" name="$3" ex out; ex="$(_exactflag "$by")"
	local args=(find "$by" "$value" hover)
	[ -n "$name" ] && args+=(--name "$name")
	[ -n "$ex" ] && args+=("$ex")
	out="$(AB_JSON "${args[@]}" 2>/dev/null || true)"
	[ "$(printf '%s' "$out" | jq -r '.success // false' 2>/dev/null || echo false)" = "true" ]
}

# _exec <by> <value> <name> <action> <varg?> -> 0 if the action succeeds (advances the journey).
_exec(){
	local by="$1" value="$2" name="$3" action="$4" varg="${5:-}" ex out; ex="$(_exactflag "$by")"
	local args=(find "$by" "$value" "$action")
	[ -n "$varg" ] && args+=("$varg")
	[ -n "$name" ] && args+=(--name "$name")
	[ -n "$ex" ] && args+=("$ex")
	out="$(AB_JSON "${args[@]}" 2>/dev/null || true)"
	if [ "$(printf '%s' "$out" | jq -r '.success // false' 2>/dev/null || echo false)" != "true" ]; then
		echo "[verify]   exec failed: find $by '$value' $action -> $(printf '%s' "$out" | jq -r '.error // "?"' 2>/dev/null)" >&2
		return 1
	fi
}

echo "[verify] re-driving flows/${name} from $starturl (headless) ..."
if [ -n "$app" ]; then
	AB_AUTH "$app" open "$starturl" >/dev/null 2>&1 </dev/null || { echo "[verify] FATAL: open failed (app=$app; run setup/auth.sh?)." >&2; exit 1; }
else
	AB open "$starturl" >/dev/null 2>&1 </dev/null || { echo "[verify] FATAL: open failed (is agent-browser healthy?)." >&2; exit 1; }
fi

nsteps="$(jq '.steps | length' "$flow")"
# Trust the candidate ladder for repair ONLY if the sidecar's step-count matches the current flow.
# A structural hand-edit (insert/remove/reorder a step) shifts find-step indices while the
# gitignored sidecar stays put; using a desynced ladder could "repair" a step to an unrelated
# element. On any mismatch (or no sidecar) we fall back to verify-only (no ladder repair).
LADDER="{}"; ladder_ok=0
if [ "$CAND_RAW" != "{}" ]; then
	sc="$(printf '%s' "$CAND_RAW" | jq -r '._steps // empty' 2>/dev/null || true)"
	if [ -n "$sc" ] && [ "$sc" = "$nsteps" ]; then
		LADDER="$(printf '%s' "$CAND_RAW" | jq -c '.byStep // {}')"; ladder_ok=1
	else
		echo "[verify] candidates sidecar stale/mismatched (sidecar steps='${sc:-?}' != flow steps=$nsteps) -> verify-only." >&2
	fi
else
	echo "[verify] no candidates sidecar -> verify-only (no ladder repair)." >&2
fi
declare -A REPAIR
verified=0; repaired=0; promoted=0; stopped=0; tidok=0; tidskip=0

for i in $(seq 0 $((nsteps - 1)) 2>/dev/null); do
	step="$(jq -c ".steps[$i]" "$flow")"
	kind="$(printf '%s' "$step" | jq -r '.kind')"
	case "$kind" in
		find)
			if [ "$(printf '%s' "$step" | jq -r '.needs_review // false')" = "true" ]; then
				echo "[verify] step #$i is already needs_review — resolve it first (cannot re-drive past it)." >&2
				stopped=1; break
			fi
			by="$(printf '%s' "$step" | jq -r '.by')"
			value="$(printf '%s' "$step" | jq -r '.value')"
			name="$(printf '%s' "$step" | jq -r '.name // empty')"
			action="$(printf '%s' "$step" | jq -r '.action // "click"')"
			varg=""
			if [ "$action" = "select" ]; then
				raw="$(printf '%s' "$step" | jq -r '.val // .text // empty')"; [ -n "$raw" ] && { varg="$(_subst "$raw")" || exit 1; }
			elif [ "$action" = "fill" ] || [ "$action" = "type" ]; then
				raw="$(printf '%s' "$step" | jq -r '.text // .val // empty')"; [ -n "$raw" ] && { varg="$(_subst "$raw")" || exit 1; }
			fi
			# Resolve a USABLE locator NON-destructively: the step's current locator first, then a
			# capture-time-UNIQUE candidate (count==1 — the same uniqueness bar capture applied to the
			# primary; repairing to a non-unique locator could silently target the wrong element).
			use_by=""; use_val=""; use_name=""; is_repair=0
			if _hover "$by" "$value" "$name"; then
				use_by="$by"; use_val="$value"; use_name="$name"
			elif [ "$ladder_ok" = 1 ]; then
				echo "[verify] step #$i: '$by:$value' did not resolve — trying candidate ladder..." >&2
				ncand="$(printf '%s' "$LADDER" | jq -r --arg i "$i" '(.[$i] // []) | length')"
				for j in $(seq 0 $((ncand - 1)) 2>/dev/null); do
					centry="$(printf '%s' "$LADDER" | jq -c --arg i "$i" --argjson j "$j" '.[$i][$j]')"
					cby="$(printf '%s' "$centry" | jq -r '.by')"; cval="$(printf '%s' "$centry" | jq -r '.value')"
					cname="$(printf '%s' "$centry" | jq -r '.name // empty')"; ccount="$(printf '%s' "$centry" | jq -r '.count // empty')"
					{ [ "$cby" = "$by" ] && [ "$cval" = "$value" ] && [ "$cname" = "$name" ]; } && continue   # skip the failing primary
					[ "$ccount" = "1" ] || continue                                                          # capture-time-unique only
					if _hover "$cby" "$cval" "$cname"; then use_by="$cby"; use_val="$cval"; use_name="$cname"; is_repair=1; break; fi
				done
			fi
			if [ -z "$use_by" ]; then
				REPAIR[$i]="NEEDSREVIEW"; promoted=$((promoted + 1)); stopped=1
				echo "[verify] step #$i: locator did not resolve and no unique candidate worked -> needs_review." >&2
				break
			fi
			# testid uniqueness cross-check (false-green guard): capture-time uniqueness is only an
			# ESTIMATE of how replay resolves. testid is the one by-locator with a CSS equivalent, so
			# re-verify it here with `get count` BEFORE acting. The check must FAIL LOUD when it cannot
			# run, never silently pass: a result is trusted ONLY when `get count` returns success with a
			# numeric count. >= 2 -> promote needs_review (find would act on the first of several). == 1
			# -> unique (tidok). Otherwise (value skipped as unsafe, get count failed, or count 0 while
			# the locator DID resolve) uniqueness is UNVERIFIED -> tally tidskip + warn; the final verdict
			# reflects it and never claims a step was checked when it was not. NB `get count` is CSS and
			# visibility-BLIND (capture counts visible-only), so a HIDDEN duplicate testid can over-count
			# -> a conservative needs_review (false-RED) — acceptable under the prime directive (fail-loud
			# beats a guess). Non-testid by-locators have no replay-count primitive on 0.27.0 (documented).
			if [ "$use_by" = "testid" ]; then
				case "$use_val" in
					*'"'*|*'\'*)
						tidskip=$((tidskip + 1))
						echo "[verify]   #$i: testid '$use_val' has a quote/backslash -- uniqueness NOT cross-checked (cannot build a safe CSS selector); replay uniqueness UNVERIFIED for this step." >&2
						;;
					*)
						tsel="[data-testid=\"$use_val\"],[data-test-id=\"$use_val\"],[data-test=\"$use_val\"],[data-cy=\"$use_val\"]"
						tout="$(AB_JSON get count "$tsel" 2>/dev/null </dev/null || true)"
						tok="$(printf '%s' "$tout" | jq -r '.success // false' 2>/dev/null || echo false)"
						tcnt="$(printf '%s' "$tout" | jq -r '.data.count // empty' 2>/dev/null || true)"
						case "$tcnt" in ''|*[!0-9]*) tnum=0 ;; *) tnum=1 ;; esac
						if [ "$tok" = "true" ] && [ "$tnum" = "1" ] && [ "$tcnt" -ge 2 ]; then
							REPAIR[$i]="NEEDSREVIEW"; promoted=$((promoted + 1)); stopped=1
							echo "[verify] step #$i: testid '$use_val' now matches $tcnt elements at replay (capture-time uniqueness drifted) -> needs_review; find would silently act on the first." >&2
							break
						elif [ "$tok" = "true" ] && [ "$tnum" = "1" ] && [ "$tcnt" = "1" ]; then
							tidok=$((tidok + 1))
						else
							tidskip=$((tidskip + 1))
							echo "[verify]   #$i: testid '$use_val' uniqueness cross-check inconclusive (get count success=$tok count='${tcnt:-?}') -- replay uniqueness UNVERIFIED for this step." >&2
						fi
						;;
				esac
			fi
			# Execute the action. A locator that RESOLVES but whose ACTION fails (disabled /
			# intercepted / wrong element / bad value) is NOT trustworthy — never persist it as a
			# repair; promote to needs_review and fail loud (no false green).
			if _exec "$use_by" "$use_val" "$use_name" "$action" "$varg"; then
				if [ "$is_repair" = 1 ]; then
					repaired=$((repaired + 1))
					REPAIR[$i]="$(jq -nc --arg by "$use_by" --arg value "$use_val" --arg name "$use_name" '{by:$by,value:$value} + (if $name!="" then {name:$name} else {} end)')"
					echo "[verify]   repaired #$i -> $use_by:$use_val" >&2
				else
					verified=$((verified + 1))
				fi
			else
				REPAIR[$i]="NEEDSREVIEW"; promoted=$((promoted + 1)); stopped=1
				echo "[verify] step #$i: '$use_by:$use_val' resolved but its '$action' action failed -> needs_review." >&2
				break
			fi
			;;
		wait)
			until="$(printf '%s' "$step" | jq -r '.until')"; val="$(printf '%s' "$step" | jq -r '.value')"
			if [ "$until" = "url" ]; then
				if ! wait_url "$val" 15; then
					echo "[verify] navigation gate (wait url '$val') not reached — the journey diverged; stopping." >&2
					stopped=1; break
				fi
			else AB wait --"$until" "$val" >/dev/null 2>&1 || true; fi
			;;
		open_record)
			source="$(printf '%s' "$step" | jq -r '.source // "first"')"
			recipe="$(printf '%s' "$step" | jq -r '.recipe // empty')"
			field="$(printf '%s' "$step" | jq -r '.field // empty')"
			row_index="$(printf '%s' "$step" | jq -r 'if .rowIndex == null then "" else (.rowIndex|tostring) end')"
			if aqa_open_record "$source" "$recipe" "$field" "$row_index"; then
				verified=$((verified + 1))
			else
				echo "[verify] step #$i: open_record failed." >&2
				stopped=1; break
			fi
			;;
		press)
			AB press "$(printf '%s' "$step" | jq -r '.value')" >/dev/null 2>&1 || true
			;;
		scroll)
			AB scroll "$(printf '%s' "$step" | jq -r '.dir // "down"')" "$(printf '%s' "$step" | jq -r '.px // 0')" >/dev/null 2>&1 || true
			;;
		*)
			echo "[verify] step #$i: unknown kind '$kind'." >&2
			stopped=1; break
			;;
	esac
done

# Apply repairs/promotions back to flow.json. (Guard on the counters, not ${#REPAIR[@]}, which
# errors as an unbound variable on an empty associative array under `set -u`.)
if [ $((repaired + promoted)) -gt 0 ]; then
	repairs="{}"
	for i in "${!REPAIR[@]}"; do
		if [ "${REPAIR[$i]}" = "NEEDSREVIEW" ]; then repairs="$(printf '%s' "$repairs" | jq --arg i "$i" '.[$i]="NEEDSREVIEW"')"
		else repairs="$(printf '%s' "$repairs" | jq --arg i "$i" --argjson loc "${REPAIR[$i]}" '.[$i]=$loc')"; fi
	done
	tmp="$(mktemp "${flow}.tmp.XXXXXX")"
	# On promotion: prefer the captured ladder for candidates; if absent, PRESERVE the step's own
	# locator as a candidate so the resolver always has something to work from (never empty []).
	jq --argjson r "$repairs" --argjson lad "$LADDER" '
		.steps |= [ to_entries[] | .key as $i | .value as $s | ($r[($i|tostring)]) as $rep |
			if $rep == null then $s
			elif $rep == "NEEDSREVIEW" then
				({kind:"find", needs_review:true,
				  candidates: ( ($lad[($i|tostring)] // [])
				                | if length > 0 then .
				                  else [ ({by:$s.by, value:$s.value} + (if $s.name then {name:$s.name} else {} end)) | select(.by != null) ] end ) }
					+ (if $s.action then {action:$s.action} else {} end)
					+ (if $s.text then {text:$s.text} else {} end)
					+ (if $s.val then {val:$s.val} else {} end))
			else (($s | del(.by, .value, .name)) + $rep) end ]
	' "$flow" > "$tmp" && mv "$tmp" "$flow"
	echo "[verify] rewrote $flow with repairs/promotions."
fi

echo "[verify] verified=$verified repaired=$repaired promoted=$promoted testid-unique=$tidok$([ "$stopped" = 1 ] && echo ' (stopped early; later steps unverified)')"
if [ "$promoted" -gt 0 ] || [ "$stopped" = 1 ]; then
	echo "[verify] FATAL: flow NOT fully verified (promoted=$promoted, stopped=$stopped) — a locator failed to resolve/act, a nav gate was missed, or an unresolved needs_review remains. Fix and re-run verify; compile will refuse needs_review." >&2
	exit 1
fi
echo "[verify] OK: every step's locator resolved and its action succeeded (repaired=$repaired, testid-unique=$tidok$([ "$tidskip" -gt 0 ] && echo ", testid-unchecked=$tidskip"))."
[ "$tidskip" -gt 0 ] && echo "[verify] NOTE: $tidskip testid step(s) could NOT be uniqueness-cross-checked (unsafe value, get count failed, or CSS count 0 while the locator resolved) -- their replay uniqueness is UNVERIFIED (see warnings above)."
echo "[verify] Scope: verifies each locator RESOLVES + its ACTION succeeds + (for testid) replay UNIQUENESS via get count. Non-testid by-locators (text/label/role/...) have no replay-count primitive on 0.27.0, so their uniqueness is a capture-time estimate only - review ambiguous semantic steps. Ready to compile."
