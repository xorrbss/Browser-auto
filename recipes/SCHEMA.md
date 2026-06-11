# recipes/&lt;app&gt;.json — extraction recipe schema

A **recipe** is the one declarative, committed file that makes a data-collection automation
site-specific — **no per-site code**. The Playwright RPA driver (`bin/pw-rpa.mjs` via
`bin/sync-system.sh` / `bin/enrich-system.sh`) runs recipes with `bin/extract-list.js` and
`bin/extract-detail.js`. Recipes hold product **structure only**: no PII, no CSS, no `@eN` refs.

A recipe is selected by the `--app` / system name (`recipes/<name>.json`), mirroring
`fixtures/auth/playwright/<name>.state.json` (the canonical Playwright auth state).

## Fields

| field | req | read by | meaning |
|-------|-----|---------|---------|
| `app` | — | bash | sanity-pin: must equal the `--app`/system name (catches a mis-copied recipe). |
| `collection.name` | ✅ | node | accessible name of the list **table** (ARIA `table`/`grid`), matched **normalized-exact** (whitespace-stripped). The extractor asserts **exactly one** such container — 0 or ≥2 fail loud. |
| `collection.role` | — | node | container role; default `"table"`. |
| `collection.row` | — | node | record role inside the container; default `"row"`. |
| `key` | ✅ | node | which `columns` field identifies a row (must be a key of `columns`). The row's identity / PK. A **non-unique** key column fails loud (it would silently collapse rows). An empty key value skips the row (never fabricated). For 결재, `key` is `doc_id`. |
| `columns` | ✅ | node | `{ db_field: "column header text" }`. Header-anchored (matched normalized-exact to the table's `columnheader`s) — a missing/duplicate header fails loud, never mis-maps. Field names are **arbitrary** on the generic path; for the 결재 system (config `GW_APP`) the sync/enrich dual-write picks the approvals vocabulary (`doc_id` key + `lib/db.js` SCRAPED_COLS) out of the synced fields, so name them accordingly. |
| `columnIndexes` | — | `play-flow` | Explicit fallback for live tables that expose rows/cells but no `columnheader` roles. Must map every `columns` field to a zero-based cell index; duplicate/missing indexes fail closed. Omit for normal header-anchored tables. |
| `strip` | — | node | `{ db_field: "literal trailing suffix" }` — remove UI noise (e.g. Hiworks appends `첨부 파일 표시` to the title cell). Literal trailing match only (no regex). |
| `ready.text` | — | driver | substring that must appear before snapshotting an async-rendered list. |
| `ready.timeout` | — | driver | seconds for the ready gate (default 15). |
| `pagination.mode` | — | driver | `"combobox"` -> drive the list's single page-number `<select>` and accumulate every page, deduped by `key`. Omit -> first page only. |

### `detail` — per-record enrichment
`{ ready{text}, urlGlob, idLabel, fields{field:"rowheader label"}, bodyFromHeadingLevel }` — open each
row's detail page, verify `idLabel == key` (refuse a wrong/list page — never store the list), pull
label→value `fields` + a `raw_text` body blob (`bin/extract-detail.js`). `bin/enrich-system.sh`
drives this with Playwright; fields are arbitrary and merge into `records.data`.

Both drivers, when `SUMMARY_MODEL` (+ a local/on-prem endpoint) is set, summarize the `raw_text` body via
`bin/summarize.js` into the `summary` column — the body **never leaves** the configured local endpoint.
`upsertRecords`/`upsertApprovals` merge so this pass accumulates onto the list sync (never clobbers it).

### `actions.approve` — the effectful auto-approve block (BUILT; driven by `approve/approve-run.mjs`)
**Canonical location: `actions.approve`** (the general-action-rpa form — `actions` is a map so a system can
declare more effectful actions later; see `dev/active/general-action-rpa/DESIGN.md`). The legacy top-level
`approve` key is still read as a 1:1 fallback. `actions` may hold MORE actions (e.g. `reject`); each is
selected by the route/leaf via a pure `resolveAction(recipe, action)` (the request's `action`, default
`"approve"`) and is **fail-closed**: an absent action, or one with `"enabled": false` (declared but not yet
per-system **captured** — a Gate-B placeholder, e.g. hiworks's `actions.reject`), is REFUSED (400). The owner
released the per-item-human gate (memory
`approve-gate-override`), so the auto-approve leaf clicks the real 확인 with **no human click**; the
deterministic guards in this block are the SOLE safety and every one **fails closed**. Read
`dev/active/phase2-guarded-approve/` before changing it.

### Generic RPA action catalog

`actions` is a catalog map, not an open-ended command surface. The built-in catalog actions are:

| action | executor | success status | required safety envelope |
|---|---|---|---|
| `approve` | `approve-modal-v1` | `approved` | reviewed target set, dry-run, human confirmation, positive completion marker, commit cap, audit. |
| `reject` | `approve-modal-v1` | `rejected` | same decision-modal shape as approve; must be captured per system/form before enabling. |
| `update` | `flow-runner` | `updated` | recorded `steps`, `irreversibleAt` unless explicitly reversible, positive completion marker, cap, audit. |
| `upload` | `flow-runner` | `uploaded` | recorded `steps`, declared file token/input, positive completion marker, cap, audit. |
| `download` | `flow-runner` | `downloaded` | recorded `steps`, artifact/download gate metadata, completion marker, cap, audit. |
| `export` | `flow-runner` | `exported` | recorded `steps`, sanitized-export/artifact policy metadata, completion marker, cap, audit. |

Unknown action names are refused unless the block declares a catalog `type`/`actionType`/`catalogAction`.
Names prefixed with `approve_` or `reject_` inherit the `approve`/`reject` schema for per-form captures.
`enabled:false` is the correct placeholder for an uncaptured action and is always fail-closed; it may appear in
committed recipes to document planned coverage, but it cannot run. A captured action must include either a
legacy `success` marker (for the decision-modal path) or a structured `completion` marker. Absence-only
completion is not sufficient for live actions.

Flow-backed actions use either inline `steps` (the `flows/*.flow.json` step model) or
`"steps": { "from": "flows/<name>.flow.json" }`. The path form is only a safe reference; a caller must load the
committed flow explicitly. Path traversal, arbitrary files, `needs_review`, malformed locators, missing
`irreversibleAt`, and non-effectful irreversible markers are refused before replay.
`approve/approve-run.mjs` currently executes only `approve-modal-v1` decision-modal actions (`approve` and
captured `reject`/`approve_*`/`reject_*` variants). Flow-backed `update`/`upload`/`download`/`export` actions are
catalog schema plus browser-free runner scaffold until a route explicitly loads their recorded steps.

| Field | Purpose |
|---|---|
| `button` `{role,name,exact}` | the approve affordance that opens the decision modal (Hiworks: `결재`). count==1 or abort. |
| `decision` `{role,name}` | the decision radio that MUST be asserted checked before 확인 (Hiworks: `승인`). |
| `amount.label` | label anchoring the amount region (e.g. `"총 금액"`); the largest KRW figure in that row is the ceiling check. **Absent ⇒ a value ceiling cannot be enforced (fail-closed when one is requested).** |
| `opinion` `{placeholder,text}` | optional 의견 to type before 확인. |
| `confirm` `{role,name,exact}` | the modal commit button — `kind:dom`, exact `확인` (never `확인 후 다음 문서`). |
| `formType` (string \| string[]) | **optional** form-type pin. When set, the live detail's form-type heading (Gate B: the **h1**) MUST match one of these names or the doc is SKIPPED — so a recipe tuned for one form family (its `amount.label`) can't be misapplied to another (e.g. a 지출 recipe on a 품의). Independently, a batch is **always kept homogeneous** (a later doc whose form differs is skipped) even without this pin. |
| `success` | the positive completion signal (Hiworks: `leftInbox` + a new today-dated 승인 stamp on the doc's own line). |
| `titleField` | **(generic systems)** the `records.data` field used as the content-binding title (default `title`). The legacy 결재 path reads the `approvals` table; a registered RPA system reads its `records` (this field). A doc with no title in either ⇒ refused. |

Pagination during the all-pages identity/completion scan is taken from `pagination.mode` and is **only
trusted for `"combobox"`** with a single contiguous `1..N` page `<select>`; a windowed/ambiguous/
non-1..N pager is treated as UNCERTAIN ⇒ the scan fails closed (never under-scans → never false "approved").

**Approve for ANY registered system (P2):** the approve route is registry-driven — it resolves the
pending-list URL from the system's `target_url` and the content-binding title from its `records`
(`approve.titleField`). To make a registered system approvable, the operator must additionally provide a
committed `recipes/<system>.json` with this `approve` block (a Gate-B capture of that site's approve UI), a
Playwright login (`fixtures/auth/playwright/<system>.state.json`; the legacy `approve/<system>.pw-state.json`
is still read as a fallback), and synced records. The 시스템 view's **✅ 검토 후 결재**
surface is **disabled (fail-closed)** until all three exist; the per-system capture is operator-accompanied.

## Portability
A recipe with `collection.name` + `key` + `columns` (and `key` ∈ `columns`) is valid for **both** the
generic path (`extract-list.js`, `webui` `saveSystem`) and the 결재 path. `recipes/hiworks.json` and
`recipes/daou.json` are committed examples (Hiworks 대기 inbox; a hypothetical Daou 결재 대기함 proving
a different vendor needs only a different recipe — exercised by `tests/extract-list-unit.test.sh`).

## Example (Hiworks 대기)

```json
{
  "app": "hiworks",
  "collection": { "name": "대기 문서 리스트" },
  "key": "doc_id",
  "columns": { "doc_id": "문서번호", "title": "제목", "drafter": "기안자", "submitted_at": "기안일" },
  "columnIndexes": { "doc_id": 1, "title": 3, "drafter": 4, "submitted_at": 5 },
  "strip": { "title": "첨부 파일 표시" },
  "pagination": { "mode": "combobox" }
}
```
