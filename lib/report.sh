#!/usr/bin/env bash
# lib/report.sh — result aggregation. Sourced by run.sh (not by tests).
#
# run.sh appends one TSV line per test to $REPORT_TSV as it goes
# (name<TAB>status<TAB>duration_ms<TAB>artifact_dir); at the end it calls
# report_emit to turn that into report.json + report.junit.xml + a console table.
# Kept as pure jq + a here-doc so the only dependency is jq (already required).
# JUnit XML is emitted alongside JSON so CI test reporters ingest results natively.

# report_emit <tsv-file> <out-dir>: write report.json, report.junit.xml, console table.
report_emit() {
	local tsv="$1" out="$2"
	local total passed failed
	# Count non-empty lines robustly: grep -c can emit multi-line/whitespace under
	# set -e+pipefail, so coerce to a single integer with awk (defaults to 0 on empty).
	total="$(awk 'NF{n++} END{print n+0}' "$tsv")"
	passed="$(awk -F'\t' '$2=="pass"{n++} END{print n+0}' "$tsv")"
	failed=$(( total - passed ))

	# report.json — array of {name,status,durationMs,artifacts}
	jq -R -s 'split("\n") | map(select(length>0) | split("\t") |
		{name: .[0], status: .[1], durationMs: (.[2]|tonumber? // 0), artifacts: .[3]})' \
		"$tsv" > "$out/report.json"

	# report.junit.xml — one <testcase> per test; failures carry a <failure> node.
	{
		printf '<?xml version="1.0" encoding="UTF-8"?>\n'
		printf '<testsuite name="agent-qa" tests="%s" failures="%s">\n' "$total" "$failed"
		while IFS=$'\t' read -r name status dur _art; do
			[ -z "$name" ] && continue
			local secs; secs="$(awk "BEGIN{printf \"%.3f\", ${dur:-0}/1000}")"
			if [ "$status" = "pass" ]; then
				printf '  <testcase name="%s" time="%s"/>\n' "$name" "$secs"
			else
				printf '  <testcase name="%s" time="%s"><failure message="%s"/></testcase>\n' \
					"$name" "$secs" "$status"
			fi
		done < "$tsv"
		printf '</testsuite>\n'
	} > "$out/report.junit.xml"

	# Console table.
	echo ""
	echo "  RESULT  TEST                          DURATION"
	echo "  ------  ----------------------------  --------"
	while IFS=$'\t' read -r name status dur _art; do
		[ -z "$name" ] && continue
		local mark; [ "$status" = "pass" ] && mark="  PASS " || mark="  FAIL "
		printf '%s  %-28s  %sms\n' "$mark" "$name" "${dur:-0}"
	done < "$tsv"
	echo "  ------  ----------------------------  --------"
	printf '  %s/%s passed (%s failed)\n' "$passed" "$total" "$failed"
	echo "  report: $out/report.json | $out/report.junit.xml"
}
