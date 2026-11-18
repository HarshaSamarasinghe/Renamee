# Smart Bulk File Renamer — Detailed Test Matrix (`T01` – `T40`)

All automated tests run strictly against in-memory structures or disposable temporary directories (`tempfile::tempdir()` in Rust and Vitest in TypeScript).

## 1. Parser & Formatter Tests (`T01` – `T15`)
- **T01**: `Trigger.S01E01.x265.720p.WEB-EDITH.mkv` → `Trigger S01E01.mkv`
- **T02**: `Trigger.S01E02.x265.720p.jshbsdkh-webrip.mkv` & `Trigger.S01_E03.x265.720p.wefi-helman.mkv` → `Trigger S01E02.mkv`, `Trigger S01E03.mkv`
- **T03**: `Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv` → `Trigger S01E10.mkv`
- **T04**: `Trigger.S1E2.1080p.mp4` → `Trigger S01E02.mp4`
- **T05**: `Trigger.1x03.HDTV.avi` → `Trigger S01E03.avi`
- **T06**: `My.Show.Name.S03E12.mkv` → `My Show Name S03E12.mkv`
- **T07**: `My.Show.S02E107.WEBRip.MKV` → `My Show S02E107.MKV` (3-digit episode & uppercase `.MKV` preserved)
- **T08**: `filename_without_episode.mkv` → `Needs Review` (`proposedName: null`)
- **T09**: `Show.S01E01.S02E05.mkv` → `Needs Review` (multiple conflicting episode tokens)
- **T10**: `Show.S01E01.mkv` and `Show.S01E03.mkv` → preserves `E01` and `E03` without renumbering
- **T11**: `Show.S01E01.mkv` and `Show.S02E01.mkv` → distinct seasons preserved
- **T12**: `Other.Show.S01E01.mkv` → independent series preserved
- **T13**: Unicode titles (`進撃の巨人.S04E28.1080p.WEB-DL.mkv`) and titles containing `"Web"` (`Charlotte's.Web.S01E02.720p.mkv`) preserved intact
- **T14**: Empty name, hidden dotfile (`.gitignore`), missing extension handled safely as `Needs Review`
- **T15**: Movie with release year (`Dune.Part.Two.2024.1080p.WEB-DL.x265.mkv`) → `Needs Review` (year never mistaken for episode)

## 2. Preflight Validation Tests (`T16` – `T27`, `T40`)
- **T16**: Two files in the same folder producing `Trigger S01E01.mkv` → `Conflict`
- **T17**: Existing untouched file `Trigger S01E02.mkv` in folder → `Conflict`
- **T18**: Exact no-op rename (`Trigger S01E01.mkv` → `Trigger S01E01.mkv`) → `Skipped` (unchanged)
- **T19**: Case-only rename (`trigger.s01e01.mkv` → `Trigger.S01E01.mkv`) → `Ready` (handled via staging)
- **T20**: Two-file swap (`A -> B` and `B -> A`) → `Ready` (handled via staging)
- **T21**: Invalid Windows characters (`: * ? < > |`) and reserved DOS names (`CON.mkv`) → `Conflict`
- **T22**: Trailing dot or space (`Trigger S01E01.mkv.`) → `Conflict`
- **T23 & T24**: Source file deleted or modified (`size_bytes` / `modified_at_ms` snapshot mismatch) since scan → blocked in `validator.rs`
- **T25**: Destination appears between preview and execution → Stage 2 pre-check aborts and rolls back without overwriting
- **T26**: Cross-directory target or `..` traversal → rejected
- **T27**: Same basename with distinct extensions (`.mkv` and `.mp4`) → valid distinct targets
- **T40**: Filename exceeding 255 characters → rejected

## 3. Execution, Performance & Crash Recovery Tests (`T28` – `T39`)
- **T28 & T29**: 10-file, 100-file (`renamer.rs`), 1,000-file, and 10,000-file (`preview.test.ts`) batch verification with exact byte preservation
- **T31 & T32**: Interrupted `"incomplete_staged"` journal recovery (`recover_incomplete_journals` in `journal.rs`) restores `.sbfr_tmp_*` files on startup
- **T33**: Safe Undo restores all renamed files to original paths
- **T34 & T35**: Undo blocks safely if the renamed file was modified externally or if the original path is now occupied by another file
- **T36**: Synchronous `executingLockRef` prevents duplicate concurrent executions on rapid clicks
- **T38**: Recursive scan with identical filenames in separate subdirectories (`FolderA` vs `FolderB`) validates and renames independently
- **T39**: Non-ASCII characters and mixed-case extension (`.MkV`) preserved
