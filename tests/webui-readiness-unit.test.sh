#!/usr/bin/env bash
# Browser-free unit for the read-only P0 readiness summary.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import { getP0Readiness } from './webui/readiness.js';

const assert = (cond, msg) => { if (!cond) { console.error('  webui-readiness-unit: ' + msg); process.exit(1); } };

const r = await getP0Readiness();
assert(r.valid === true, 'P0 document loads');
assert(r.document === 'dev/active/productization/P0-SERVICE-OPEN.md', 'readiness exposes only relative document path');
assert(r.decision === 'No-Go', 'default decision stays No-Go while checklist is open');
assert(r.state === 'no-go', 'state is no-go, not green');
assert(r.total > 0 && r.open > 0, 'open P0 checklist items are counted');
assert(Array.isArray(r.sections) && r.sections.some((s) => s.id === 'P0-A' && s.open > 0), 'P0 sections parsed');
assert(Array.isArray(r.blockers) && r.blockers.length > 0, 'representative blockers included');
assert(r.artifactPolicy.rawExport.includes('blocked'), 'raw export is blocked until scan/redaction policy exists');
assert(!JSON.stringify(r).includes('C:\\'), 'absolute Windows paths are not exposed');

console.log('  webui-readiness-unit: P0 readiness summary is read-only and no-go by default');
NODE
)
