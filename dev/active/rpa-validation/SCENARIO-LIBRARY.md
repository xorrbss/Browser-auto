# External-Free RPA Scenario Library

This library validates RPA behavior with deterministic fixtures before any real system is touched.
Use synthetic ARIA snapshots for extractors, mock pages for step dispatch, file or localhost HTML for
recorder/replay, and temporary SQLite via `AQA_DB_PATH` for command-plan checks. No API key, LLM,
SSO state, external app, or third-party network is required. Browser-backed fixture tests may skip
only when the Playwright Chrome channel is unavailable.

## Method

1. Prove parser and guard rules with browser-free tests: `extract-list`, `extract-detail`,
   `pw-rpa-pagination`, `approve-guards`, `flow-runner`, and command-plan units.
2. Prove recorder/replay integration with disposable local pages: `play-flow-smoke`, `capture-e2e`,
   `rpa-fixture-e2e`, and `rpa-local-fixture-e2e`.
3. Run live `analyze/sync/enrich` only after the fixture gate is green and the system has a committed
   recipe plus `fixtures/auth/playwright/<system>.state.json`.

## Representative Scenarios

| Scenario | Validates | External-free gate | Live CLI counterpart |
|---|---|---|---|
| `basic-form` | Label fill, role button click, `{{input_N}}` value sidecar, final text/value asserts. | `bash tests/play-flow-smoke.test.sh` | `node bin/play-flow.mjs --flow flows/<name>.flow.json` or compiled `bash tests/<name>.test.sh` |
| `paginated-list` | Header or `columnIndexes` mapping, unique key guard, trusted `combobox` pager, change-then-stable pagination settling. | `bash tests/extract-list-unit.test.sh`; `bash tests/pw-rpa-pagination-unit.test.sh`; `bash tests/pw-rpa-orchestration-unit.test.sh`; `bash tests/rpa-local-fixture-e2e.test.sh` | `bash bin/sync-system.sh --system <system>` |
| `detail-open` | Open one row by key, require `detail.idLabel == key`, extract configured fields and `raw_text`, refuse wrong/list pages. | `bash tests/extract-detail-unit.test.sh`; `bash tests/flow-runner-unit.test.sh`; `bash tests/pw-rpa-orchestration-unit.test.sh`; `bash tests/rpa-local-fixture-e2e.test.sh` | `bash bin/enrich-system.sh --system <system> --key <id>` or `--limit N` |
| `iframe-form` | Same-origin iframe capture emits a `frame` locator and remains replay-valid. | `bash tests/capture-e2e.test.sh`; `bash tests/flow-runner-unit.test.sh` | `node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only` then replay/compile |
| `needs-review-cross-origin` | Cross-origin iframe actions become non-runnable `needs_review` steps with no guessed locator. | `bash tests/capture-e2e.test.sh`; `bash tests/rpa-local-fixture-e2e.test.sh` | Resolve the step by human edit or re-record before `verify`, `compile`, or replay |
| `approval-dry-run` | Target review/hash gates, pure approval guards, dry-run default, and stop-before-commit behavior. | `bash tests/approve-guards-unit.test.sh`; `bash tests/flow-runner-unit.test.sh`; `bash tests/agent-plan-unit.test.sh`; `bash tests/approve-resolve-unit.test.sh` | `node approve/approve-run.mjs --recipe recipes/<system>.json --state fixtures/auth/playwright/<system>.state.json --list-url <url> --targets-file <targets.json>` |

`approval-dry-run` is intentionally dry unless `--live --max N` is added. Scheduler-driven runs export
`AQA_SCHEDULED_NO_LIVE=1`, so unattended live approve remains fail-closed.

## Fixture Rules

- Keep fixture names stable: `basic-form`, `paginated-list`, `detail-open`, `iframe-form`,
  `needs-review-cross-origin`, and `approval-dry-run`.
- Fixture flows use semantic locators only and never contain `@eN` refs.
- Sensitive values stay as `{{input_N}}` tokens; local values belong in gitignored `.values.json` files.
- Any ambiguous locator, cross-origin frame action, unsupported multi-select, or uncertain pager must
  fail closed or become `needs_review`, never silently downgrade to a guessed replay step.
