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

### Reserved (documented seams, not all wired on every path)
- `detail` (결재 enrich): `{ ready{text}, urlGlob, idLabel, fields{db_field:"rowheader label"}, bodyFromHeadingLevel }` — open each row's detail page, verify `idLabel == key` (refuse a wrong/list page), pull label→value fields + a `raw_text` body blob. Used by `bin/extract-detail.js` + `enrich-approvals.sh`.
- `summarize` / `approve` — future phases (local-model summary of `raw_text`; the human-gated approve action). Not built.

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
