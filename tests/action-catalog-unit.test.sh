#!/usr/bin/env bash
# Browser-free contract tests for the generic RPA action catalog and inline action runner.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	ACTION_CATALOG,
	actionCatalogEntry,
	actionSuccessStatus,
	resolveAction,
	validateActionBlock,
} from './approve/guards.mjs';
import { normalizeActionSteps, runActionBlock } from './approve/flow-runner.mjs';

for (const name of ['approve', 'reject', 'update', 'upload', 'download', 'export']) {
	assert.ok(ACTION_CATALOG[name], `catalog defines ${name}`);
	assert.equal(ACTION_CATALOG[name].requiresDryRun, true, `${name} requires dry-run`);
	assert.equal(ACTION_CATALOG[name].requiresCompletion, true, `${name} requires a completion marker`);
}

const approveBlock = {
	button: { role: 'button', name: 'Approve', exact: true },
	decision: { role: 'radio', name: 'Yes' },
	confirm: { role: 'button', name: 'OK', exact: true },
	success: 'leftInbox',
};
assert.equal(resolveAction({ actions: { approve: approveBlock } }, 'approve').ok, true, 'valid approve resolves');
assert.equal(resolveAction({ approve: approveBlock }, 'approve').ok, true, 'legacy approve resolves through the catalog');
assert.equal(actionCatalogEntry('approve_expense', approveBlock).id, 'approve', 'approve_* names infer approve schema');
assert.equal(resolveAction({ actions: { approve: { button: { name: 'Approve' } } } }, 'approve').ok, false, 'schema-incomplete approve is refused');
assert.match(resolveAction({ actions: { reject: { enabled: false } } }, 'reject').reason, /disabled/, 'disabled reject is fail-closed');
assert.equal(resolveAction({ actions: { frob: { enabled: true } } }, 'frob').ok, false, 'unknown action is refused');

const rejectBlock = {
	button: { role: 'button', name: 'Decide', exact: true },
	decision: { role: 'radio', name: 'Reject' },
	opinion: { placeholder: 'Reason', text: 'Not enough evidence' },
	confirm: { role: 'button', name: 'Confirm', exact: true },
	success: 'leftInbox',
};
const reject = resolveAction({ actions: { reject: rejectBlock } }, 'reject');
assert.equal(reject.ok, true, 'valid reject scaffold resolves');
assert.equal(reject.resultStatus, 'rejected', 'reject success status is distinct from approve');
assert.equal(actionSuccessStatus('reject', rejectBlock), 'rejected', 'reject status helper');

const updateSteps = [
	{ kind: 'find', by: 'label', value: 'Status', action: 'select', val: 'Done' },
	{ kind: 'find', by: 'role', value: 'button', name: 'Save', action: 'click' },
];
const updateBlock = {
	type: 'update',
	steps: updateSteps,
	irreversibleAt: 1,
	completion: { kind: 'text', value: 'Saved' },
};
const update = validateActionBlock('update_status', updateBlock);
assert.equal(update.ok, true, 'custom-named update block maps to update catalog via type');
assert.equal(update.resultStatus, 'updated', 'update success status');
assert.equal(normalizeActionSteps({ steps: { from: 'flows/update-ticket.flow.json' } }).ok, true, 'safe flow ref accepted');
assert.equal(normalizeActionSteps({ steps: { from: '../outside.flow.json' } }).ok, false, 'unsafe flow ref refused');

assert.equal(validateActionBlock('update', { type: 'update', steps: [{ kind: 'find', needs_review: true }], irreversibleAt: 0, completion: { kind: 'text', value: 'Saved' } }).ok, false, 'needs_review step refuses update');
assert.equal(validateActionBlock('update', { type: 'update', steps: [{ kind: 'wait', until: 'load' }, updateSteps[1]], irreversibleAt: 0, completion: { kind: 'text', value: 'Saved' } }).ok, false, 'irreversibleAt must point at an effectful commit step');
assert.equal(validateActionBlock('upload', { type: 'upload', steps: updateSteps, irreversibleAt: 1, completion: { kind: 'text', value: 'Uploaded' } }).ok, false, 'upload requires a file token');
assert.equal(validateActionBlock('download', { type: 'download', steps: updateSteps, irreversibleAt: 1, completion: { kind: 'text', value: 'Downloaded' } }).ok, false, 'download requires artifact gate metadata');
assert.equal(validateActionBlock('export', { type: 'export', steps: updateSteps, irreversibleAt: 1, completion: { kind: 'text', value: 'Exported' } }).ok, false, 'export requires artifact gate metadata');

function mockPage(calls) {
	const node = {
		count: async () => 1,
		first: () => node,
		selectOption: async (v) => calls.push('select:' + v),
		click: async () => calls.push('click'),
	};
	return {
		getByLabel: () => node,
		getByRole: (role, opts) => { calls.push(`role:${role}:${opts?.name || ''}`); return node; },
	};
}

{
	const calls = [];
	const result = await runActionBlock(mockPage(calls), updateBlock, { dryRun: true });
	assert.equal(result.stoppedBeforeIrreversible, true, 'dry-run stops before update commit');
	assert.deepEqual(calls, ['select:Done'], 'dry-run ran reversible setup but not Save click');
}
{
	const calls = [];
	const irreversible = [];
	const result = await runActionBlock(mockPage(calls), updateBlock, { dryRun: false, onBeforeIrreversible: (i) => irreversible.push(i) });
	assert.equal(result.stoppedBeforeIrreversible, false, 'live test double runs through');
	assert.deepEqual(irreversible, [1], 'live test double gates the commit step');
	assert.equal(calls.includes('click'), true, 'live test double clicked Save after the gate');
}

console.log('  action-catalog-unit: catalog + inline update action runner checks passed');
NODE
)
