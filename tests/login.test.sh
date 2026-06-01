#!/usr/bin/env bash
# tests/login.test.sh — Phase-0 spine validation against a simple public site.
#
# example.com has no auth, so this stands in for a "login journey": it exercises every
# moving part of the harness exactly as a real test would — env wrappers, video record,
# a deterministic BATCH body using ONLY semantic find locators (no @eN refs), a
# wait-for-page gate between navigations, and --json-based assertions. A test is ONE
# standalone .sh: `bash tests/login.test.sh` runs it directly; `bash run.sh login`
# runs it under the suite.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"      # S, ARTDIR, AB(), BATCH()
source "$DIR/lib/cleanup.sh"  # EXIT trap: record stop + session close
source "$DIR/lib/assert.sh"   # assert_* (all --json based)

# 1. Open + start recording the journey.
AB open "https://example.com" >/dev/null
AB record start "$ARTDIR/video.webm" >/dev/null

# 2. Landing assertions — page is the expected one.
assert_url   "example.com"
assert_text  "Example Domain"
assert_count "h1" 1

# 3. Deterministic body: one daemon round-trip, semantic locator, page-change gate.
#    find by visible link text (NOT @eN). example.com's only link reads "Learn more"
#    (-> iana.org/help/example-domains). Open it in the same tab, then gate on the
#    resulting URL so the next assertion runs against a settled page.
BATCH --bail <<'JSON'
[["find","text","Learn more","click"],
 ["wait","--url","iana.org"]]
JSON

# 4. Post-navigation assertion — the click actually navigated to the IANA page.
assert_url  "iana.org"

echo "  ✓ login.test.sh passed"
