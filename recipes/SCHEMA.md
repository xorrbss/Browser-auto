# recipes/&lt;app&gt;.json — extraction recipe schema

A **recipe** is the one declarative, committed file that makes a data-collection automation
site-specific — **no per-site code**. The same engine (`bin/extract-list.js` for the generic RPA
path, `bin/extract-approvals.js` for the legacy 결재 path; `bin/sync-system.sh` / `fetch-approvals.sh`
for driving) runs any recipe. Recipes hold product **structure only**: no PII, no CSS, no `@eN` refs.

A recipe is selected by the `--app` / system name (`recipes/<name>.json`), mirroring
`fixtures/auth/<name>.state.json`.

## Fields

| field | req | read by | meaning |
|-------|-----|---------|---------|
| `app` | — | bash | sanity-pin: must equal the `--app`/system name (catches a mis-copied recipe). |
| `collection.name` | ✅ | node | accessible name of the list **table** (ARIA `table`/`grid`), matched **normalized-exact** (whitespace-stripped). The extractor asserts **exactly one** such container — 0 or ≥2 fail loud. |
| `collection.role` | — | node | container role; default `"table"`. |
| `collection.row` | — | node | record role inside the container; default `"row"`. |
| `key` | ✅ | node | which `columns` field identifies a row (must be a key of `columns`). The row's identity / PK. A **non-unique** key column fails loud (it would silently collapse rows). An empty key value skips the row (never fabricated). For 결재, `key` is `doc_id`. |
| `columns` | ✅ | node | `{ db_field: "column header text" }`. Header-anchored (matched normalized-exact to the table's `columnheader`s) — a missing/duplicate header fails loud, never mis-maps. Field names are **arbitrary** on the generic path; the legacy 결재 path restricts them to the DB vocabulary (`doc_id` + `lib/db.js` SCRAPED_COLS). |
| `strip` | — | node | `{ db_field: "literal trailing suffix" }` — remove UI noise (e.g. Hiworks appends `첨부 파일 표시` to the title cell). Literal trailing match only (no regex). |
| `ready.text` | — | bash | substring that must appear before snapshotting an async-rendered list (an in-batch `wait --text` gate; **never** `wait --url`, broken for globs on 0.27.0). |
| `ready.timeout` | — | bash | seconds for the ready gate (default 15). |
| `pagination.mode` | — | bash | `"combobox"` → drive the list's single page-number `<select>` (via its transient `@ref`, read fresh per page — never stored) and accumulate every page, deduped by `key`. Omit ⇒ first page only. |

### `detail` — per-record enrichment (wired on BOTH paths)
`{ ready{text}, urlGlob, idLabel, fields{field:"rowheader label"}, bodyFromHeadingLevel }` — open each
row's detail page, verify `idLabel == key` (refuse a wrong/list page — never store the list), pull
label→value `fields` + a `raw_text` body blob (`bin/extract-detail.js`). Drivers:
- **결재 path** — `bin/enrich-approvals.sh`: `fields` restricted to the approvals DB vocabulary
  (`doc_id` + `lib/db.js` SCRAPED_COLS); writes the `approvals` table.
- **generic records path** — `bin/enrich-system.sh` (`extract-detail.js --generic`): `fields` are
  ARBITRARY (they merge into `records.data`; `raw_text` lands in `data` too); writes the `records` table.

Both drivers, when `SUMMARY_MODEL` (+ a local/on-prem endpoint) is set, summarize the `raw_text` body via
`bin/summarize.js` into the `summary` column — the body **never leaves** the configured local endpoint.
`upsertRecords`/`upsertApprovals` merge so this pass accumulates onto the list sync (never clobbers it).

### `approve` — the effectful auto-approve block (BUILT; driven by `approve/approve-run.mjs`)
The owner released the per-item-human gate (memory `approve-gate-override`), so the auto-approve leaf
clicks the real 확인 with **no human click**; the deterministic guards in this block are the SOLE safety
and every one **fails closed**. Read `dev/active/phase2-guarded-approve/` before changing it.

| Field | Purpose |
|---|---|
| `button` `{role,name,exact}` | the approve affordance that opens the decision modal (Hiworks: `결재`). count==1 or abort. |
| `decision` `{role,name}` | the decision radio that MUST be asserted checked before 확인 (Hiworks: `승인`). |
| `amount.label` | label anchoring the amount region (e.g. `"총 금액"`); the largest KRW figure in that row is the ceiling check. **Absent ⇒ a value ceiling cannot be enforced (fail-closed when one is requested).** |
| `opinion` `{placeholder,text}` | optional 의견 to type before 확인. |
| `confirm` `{role,name,exact}` | the modal commit button — `kind:dom`, exact `확인` (never `확인 후 다음 문서`). |
| `formType` (string \| string[]) | **optional** form-type pin. When set, the live detail's form-type heading (Gate B: the **h1**) MUST match one of these names or the doc is SKIPPED — so a recipe tuned for one form family (its `amount.label`) can't be misapplied to another (e.g. a 지출 recipe on a 품의). Independently, a batch is **always kept homogeneous** (a later doc whose form differs is skipped) even without this pin. |
| `success` | the positive completion signal (Hiworks: `leftInbox` + a new today-dated 승인 stamp on the doc's own line). |

Pagination during the all-pages identity/completion scan is taken from `pagination.mode` and is **only
trusted for `"combobox"`** with a single contiguous `1..N` page `<select>`; a windowed/ambiguous/
non-1..N pager is treated as UNCERTAIN ⇒ the scan fails closed (never under-scans → never false "approved").

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
  "strip": { "title": "첨부 파일 표시" },
  "pagination": { "mode": "combobox" }
}
```
